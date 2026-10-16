//! Session supervisor: keeps one live [`RpcSession`] against an environment,
//! reconnecting with backoff. The connection half of
//! `packages/client-runtime/src/connection/supervisor.ts` for the local
//! driver — the multi-connection catalog and remote drivers come with M5.
//!
//! There is deliberately no transport-level retry of individual requests
//! (mirroring the TS client): a lost session simply publishes `None`, and
//! durable subscribers re-issue their subscriptions with `afterSequence`
//! resume cursors when the next session appears (`subscribeDynamic`
//! semantics — see the projections in `vitre-state`).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::{Notify, watch};
use vitre_contracts::ServerConfig;
use vitre_contracts::methods::ServerGetConfig;

use crate::error::RpcError;
use crate::http::EnvironmentHttp;
use crate::session::RpcSession;
use crate::typed::TypedError;

/// Consecutive-failure backoff schedule (`RETRY_DELAYS_MS` in supervisor.ts).
const RETRY_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(16),
];
/// A connection that survived this long resets the backoff streak
/// (`BACKOFF_RESET_AFTER_MS`).
const BACKOFF_RESET_AFTER: Duration = Duration::from_secs(30);
/// Keepalive cadence (the TS session pings every 5s)…
const PING_INTERVAL: Duration = Duration::from_secs(5);
/// …with the probe timeout from supervisor.ts (`CONNECTION_PROBE_TIMEOUT`).
const PING_TIMEOUT: Duration = Duration::from_secs(15);

/// Where to connect and how to authenticate, re-resolved on every attempt so
/// a restarted sidecar (new port and/or bootstrap token) is picked up
/// automatically.
#[derive(Debug, Clone)]
pub struct PreparedTarget {
    /// e.g. `http://127.0.0.1:3773` — always 127.0.0.1, never localhost.
    pub base_url: String,
    pub access_token: String,
    /// Optional session-bound ticket returned alongside the bootstrap token.
    /// Consumed before publishing the connected target, never cached for reuse.
    pub initial_websocket_ticket: Option<String>,
}

type PrepareFuture = Pin<Box<dyn Future<Output = Result<PreparedTarget, RpcError>> + Send>>;
/// Async factory invoked before each connection attempt.
pub type PrepareFn = Box<dyn FnMut() -> PrepareFuture + Send>;

/// One established session, published to consumers via a watch channel.
#[derive(Clone)]
pub struct SessionHandle {
    /// Increments per (re)connect; consumers use it to notice replacement.
    pub generation: u64,
    pub session: Arc<RpcSession>,
    /// The target the session was built from — same credentials work for the
    /// HTTP snapshot endpoints ([`EnvironmentHttp::shell_snapshot`]).
    pub target: PreparedTarget,
    /// The initial-sync `server.getConfig` (the TS client performs it before
    /// any subscription); carries the resume-completion-marker capability
    /// flags the durable subscriptions key off.
    pub config: Arc<ServerConfig>,
}

pub struct EnvironmentSupervisor {
    session_rx: watch::Receiver<Option<SessionHandle>>,
    session_tx: watch::Sender<Option<SessionHandle>>,
    retired: Arc<AtomicBool>,
    retry_now: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}

impl EnvironmentSupervisor {
    /// Spawn the supervision loop. It runs until retired or the handle drops.
    pub fn spawn(prepare: PrepareFn) -> Self {
        let (session_tx, session_rx) = watch::channel(None);
        let retry_now = Arc::new(Notify::new());
        let retired = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn(run(
            prepare,
            session_tx.clone(),
            retry_now.clone(),
            retired.clone(),
        ));
        Self {
            session_rx,
            session_tx,
            retired,
            retry_now,
            task,
        }
    }

    /// Current-session channel: `None` while disconnected/backing off.
    pub fn sessions(&self) -> watch::Receiver<Option<SessionHandle>> {
        self.session_rx.clone()
    }

    /// Skip any pending backoff and re-prepare immediately. Also tears down a
    /// live session — call it when the sidecar restarts under the supervisor.
    pub fn retry_now(&self) {
        self.retry_now.notify_waiters();
    }

    /// Permanently release an environment whose authoritative owner has stopped
    /// or changed. Retained panels may still hold this handle for cached data.
    pub fn retire(&self) {
        self.retired.store(true, Ordering::Release);
        self.task.abort();
        self.session_tx.send_replace(None);
    }
}

impl Drop for EnvironmentSupervisor {
    fn drop(&mut self) {
        self.retire();
    }
}

/// Wait until the channel holds a session, returning `None` only if the
/// supervisor is gone.
pub async fn wait_for_session(
    rx: &mut watch::Receiver<Option<SessionHandle>>,
) -> Option<SessionHandle> {
    loop {
        if let Some(handle) = rx.borrow_and_update().clone() {
            return Some(handle);
        }
        rx.changed().await.ok()?;
    }
}

async fn run(
    mut prepare: PrepareFn,
    session_tx: watch::Sender<Option<SessionHandle>>,
    retry_now: Arc<Notify>,
    retired: Arc<AtomicBool>,
) {
    let mut failure_streak: usize = 0;
    let mut generation: u64 = 0;
    loop {
        match connect_once(&mut prepare).await {
            Ok((session, target, config)) => {
                generation += 1;
                let connected_at = Instant::now();
                let session = Arc::new(session);
                let handle = SessionHandle {
                    generation,
                    session: session.clone(),
                    target,
                    config: Arc::new(config),
                };
                // Serialize publication with retirement's channel update. A
                // completed connection must not republish after retirement.
                session_tx.send_if_modified(|current| {
                    if retired.load(Ordering::Acquire) {
                        return false;
                    }
                    *current = Some(handle);
                    true
                });
                let teardown = keepalive(&session, &retry_now).await;
                let _ = session_tx.send(None);
                if connected_at.elapsed() >= BACKOFF_RESET_AFTER {
                    failure_streak = 0;
                } else {
                    failure_streak += 1;
                }
                if teardown == Teardown::RetryRequested {
                    // An explicit retry (e.g. sidecar restarted) skips the
                    // backoff sleep entirely.
                    failure_streak = 0;
                    continue;
                }
            }
            Err(error) => {
                eprintln!("[vitre-rpc] connection attempt failed: {error}");
                failure_streak += 1;
            }
        }
        // failure_streak == 0 here means the session outlived the reset
        // window; reconnect after the base delay rather than instantly.
        let delay = RETRY_DELAYS[failure_streak.saturating_sub(1).min(RETRY_DELAYS.len() - 1)];
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = retry_now.notified() => {}
        }
    }
}

async fn connect_once(
    prepare: &mut PrepareFn,
) -> Result<(RpcSession, PreparedTarget, ServerConfig), RpcError> {
    static NEXT_ATTEMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let attempt_id = Some(NEXT_ATTEMPT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let started = Instant::now();
    crate::cloud::trace_connection_phase("prepare_start", None, attempt_id, started.elapsed());
    let mut target = prepare().await?;
    crate::cloud::trace_connection_phase("prepare_ready", None, attempt_id, started.elapsed());
    let http = EnvironmentHttp::new(target.base_url.clone());
    let started = Instant::now();
    let ticket = http
        .initial_websocket_ticket(&target.access_token, &mut target.initial_websocket_ticket)
        .await?;
    crate::cloud::trace_connection_phase(
        "websocket_ticket_ready",
        None,
        attempt_id,
        started.elapsed(),
    );
    let started = Instant::now();
    let session = RpcSession::connect(&http.ws_url(&ticket)).await?;
    crate::cloud::trace_connection_phase(
        "websocket_connected",
        None,
        attempt_id,
        started.elapsed(),
    );
    let started = Instant::now();
    let config = session
        .call_typed::<ServerGetConfig>(&serde_json::Value::Object(Default::default()))
        .await
        .map_err(|error| match error {
            TypedError::Rpc(error) => error,
            TypedError::Failed(typed) => {
                RpcError::Transport(format!("server.getConfig failed: {typed:?}"))
            }
        })?;
    crate::cloud::trace_connection_phase(
        "session_config_ready",
        None,
        attempt_id,
        started.elapsed(),
    );
    Ok((session, target, config))
}

#[derive(Debug, PartialEq, Eq)]
enum Teardown {
    Died,
    RetryRequested,
}

/// Ping until the session dies or a retry is requested.
async fn keepalive(session: &RpcSession, retry_now: &Notify) -> Teardown {
    loop {
        tokio::select! {
            _ = tokio::time::sleep(PING_INTERVAL) => {}
            _ = retry_now.notified() => return Teardown::RetryRequested,
        }
        if let Err(error) = session.ping(PING_TIMEOUT).await {
            eprintln!("[vitre-rpc] keepalive failed, reconnecting: {error}");
            return Teardown::Died;
        }
    }
}

#[cfg(test)]
mod retirement_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test]
    async fn retained_supervisor_cannot_retry_after_authoritative_retirement() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(Notify::new());
        let supervisor = Arc::new(EnvironmentSupervisor::spawn(Box::new({
            let attempts = attempts.clone();
            let entered = entered.clone();
            move || {
                attempts.fetch_add(1, Ordering::SeqCst);
                entered.notify_one();
                Box::pin(std::future::pending())
            }
        })));
        entered.notified().await;
        let retained_panel = supervisor.clone();
        let mut sessions = retained_panel.sessions();
        sessions.borrow_and_update();
        supervisor.retire();
        drop(supervisor);
        assert!(sessions.has_changed().unwrap());
        assert!(sessions.borrow_and_update().is_none());
        // Abort completion is deterministic; no wall-clock retry delay needed.
        while !retained_panel.task.is_finished() {
            tokio::task::yield_now().await;
        }
        retained_panel.retry_now();
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert!(retained_panel.sessions().borrow().is_none());
    }
}
