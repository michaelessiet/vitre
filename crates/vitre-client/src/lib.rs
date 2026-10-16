//! Environment client: the IO half of the sync machinery. Combines the
//! sidecar supervisor (`vitre-sidecar`), the RPC session supervisor
//! (`vitre-rpc`), and the pure projections (`vitre-state`) into long-running
//! tokio tasks that publish render-ready state over watch channels — the
//! Rust counterpart of `packages/client-runtime/src/state/{shell,threads}.ts`
//! with the UI (gpui) kept out of this crate entirely.
//!
//! Durable-subscription semantics (`subscribeDynamic` in the TS client):
//! a lost transport is not retried at the request level — the loop waits for
//! the supervisor to publish the next session, then re-issues the
//! subscription with the projection's `afterSequence` resume cursor.

pub mod cloud;
mod requests;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use vitre_contracts::methods::{
    OrchestrationDispatchCommand, OrchestrationDispatchCommandErrorX, OrchestrationSubscribeShell,
    OrchestrationSubscribeThread,
};
use vitre_contracts::support::RpcMethod;
use vitre_contracts::{
    ClientOrchestrationCommand, DispatchResult, OrchestrationShellSnapshot, OrchestrationThread,
    ThreadId,
};
use vitre_rpc::supervisor::PrepareFn;
use vitre_rpc::{
    EnvironmentHttp, EnvironmentSupervisor, PreparedTarget, RpcError, SessionHandle, TypedError,
    TypedStreamEvent, TypedSubscription, wait_for_session,
};
use vitre_sidecar::SupervisorStatus;
use vitre_state::{ShellApplyOutcome, ShellProjection, ThreadProjection};

/// Where a durable subscription is in its replay→live lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SyncPhase {
    /// No session, or the subscription is between sessions.
    #[default]
    Disconnected,
    /// Subscribed; replaying events up to the completion marker.
    Synchronizing,
    /// Caught up to live (or the server does not support the marker).
    Live,
}

#[derive(Debug, Clone, Default)]
pub struct ShellState {
    pub snapshot: Option<Arc<OrchestrationShellSnapshot>>,
    pub phase: SyncPhase,
}

#[derive(Debug, Clone, Default)]
pub struct ThreadState {
    /// The overlaid render view ([`ThreadProjection::view`]).
    pub view: Option<Arc<OrchestrationThread>>,
    pub phase: SyncPhase,
    pub deleted: bool,
}

/// A stream completion that was not a transport loss: the server ended the
/// subscription (typed failure or normal exit). Resubscribing immediately
/// would hot-loop, so the loops sleep this long first (the TS client's
/// `retryExpectedFailureAfter` base).
const RESUBSCRIBE_AFTER_COMPLETION: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, PartialEq, Eq)]
enum InitialThreadSnapshot {
    Http,
    Subscription,
}

pub struct EnvironmentClient {
    requests: Arc<requests::Requests>,
    supervisor: Arc<EnvironmentSupervisor>,
    shell_rx: watch::Receiver<ShellState>,
    /// Sync tasks spawn through this handle so [`Self::open_thread`] works
    /// from non-runtime threads (e.g. the gpui main thread).
    runtime: tokio::runtime::Handle,
    initial_thread_snapshot: InitialThreadSnapshot,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl EnvironmentClient {
    /// Independent remote environment state. The supplied preparation function
    /// resolves fresh cloud credentials on reconnect; no local sidecar is used.
    pub fn start_remote(prepare: PrepareFn) -> Self {
        let runtime = tokio::runtime::Handle::current();
        let supervisor = Arc::new(EnvironmentSupervisor::spawn(prepare));
        let (shell_tx, shell_rx) = watch::channel(ShellState::default());
        let shell = runtime.spawn(run_shell(supervisor.sessions(), shell_tx));
        Self {
            requests: Arc::new(requests::Requests::default()),
            supervisor,
            shell_rx,
            runtime,
            initial_thread_snapshot: InitialThreadSnapshot::Subscription,
            tasks: vec![shell],
        }
    }

    /// Start against a supervised local sidecar. Credentials re-resolve from
    /// the sidecar's status channel on every connection attempt, so restarts
    /// (new port and/or bootstrap token) reconnect automatically.
    ///
    /// Must be called within a tokio runtime context (panics otherwise); the
    /// returned client itself may then be used from any thread.
    pub fn start(sidecar_status: watch::Receiver<SupervisorStatus>) -> Self {
        let runtime = tokio::runtime::Handle::current();
        let prepare: PrepareFn = Box::new({
            let status = sidecar_status.clone();
            move || {
                let mut status = status.clone();
                Box::pin(async move {
                    let info = loop {
                        let ready = match &*status.borrow_and_update() {
                            SupervisorStatus::Ready { info } => Some(info.clone()),
                            _ => None,
                        };
                        if let Some(info) = ready {
                            break info;
                        }
                        status.changed().await.map_err(|_| {
                            RpcError::Transport("sidecar supervisor shut down".into())
                        })?;
                    };
                    let http = EnvironmentHttp::new(info.http_base_url());
                    let token = http.exchange_bootstrap_token(&info.bootstrap_token).await?;
                    Ok(PreparedTarget {
                        base_url: info.http_base_url(),
                        access_token: token.access_token,
                        initial_websocket_ticket: token
                            .websocket_ticket
                            .map(|ticket| ticket.ticket),
                    })
                })
            }
        });
        let supervisor = Arc::new(EnvironmentSupervisor::spawn(prepare));

        // Sidecar status transitions (crash, restart) invalidate the live
        // session immediately instead of waiting for keepalive to notice.
        let nudge = runtime.spawn({
            let supervisor = supervisor.clone();
            let mut status = sidecar_status;
            async move {
                loop {
                    if status.changed().await.is_err() {
                        return;
                    }
                    supervisor.retry_now();
                }
            }
        });

        let (shell_tx, shell_rx) = watch::channel(ShellState::default());
        let shell = runtime.spawn(run_shell(supervisor.sessions(), shell_tx));

        Self {
            requests: Arc::new(requests::Requests::default()),
            supervisor,
            shell_rx,
            runtime,
            initial_thread_snapshot: InitialThreadSnapshot::Http,
            tasks: vec![nudge, shell],
        }
    }

    /// Current-session channel (`None` while disconnected/backing off).
    pub fn sessions(&self) -> watch::Receiver<Option<SessionHandle>> {
        self.supervisor.sessions()
    }

    /// Retry only the transport; pending commands retain their own delivery state.
    pub fn retry_connection(&self) {
        self.supervisor.retry_now();
    }

    /// Stop reconnecting an obsolete environment while preserving subscriber
    /// history for any panels that still retain this client.
    pub fn retire(&self) {
        self.supervisor.retire();
    }

    /// The environment shell (projects + thread shells), kept synchronized.
    pub fn shell(&self) -> watch::Receiver<ShellState> {
        self.shell_rx.clone()
    }

    /// Open a durable subscription to one thread. Dropping the handle ends it.
    pub fn open_thread(&self, thread_id: ThreadId) -> ThreadHandle {
        let (tx, rx) = watch::channel(ThreadState::default());
        let task = self.runtime.spawn(run_thread(
            self.supervisor.sessions(),
            thread_id,
            tx,
            self.initial_thread_snapshot,
        ));
        ThreadHandle { state: rx, task }
    }

    /// Dispatch an orchestration command on the current session.
    pub async fn dispatch(
        &self,
        command: &ClientOrchestrationCommand,
    ) -> Result<DispatchResult, TypedError<OrchestrationDispatchCommandErrorX>> {
        self.call::<OrchestrationDispatchCommand>(command).await
    }

    /// Call any typed (non-stream) RPC method on the current session.
    pub async fn call<M: RpcMethod>(
        &self,
        payload: &M::Payload,
    ) -> Result<M::Success, TypedError<M::Error>> {
        let _request = self.requests.start(M::TAG);
        let handle = self.supervisor.sessions().borrow().clone();
        let Some(handle) = handle else {
            return Err(TypedError::Rpc(RpcError::ConnectionClosed));
        };
        handle.session.call_typed::<M>(payload).await
    }

    /// Method names only; never exposes command payloads, prompts or tokens.
    pub fn slow_requests(&self, threshold: Duration) -> Vec<String> {
        self.requests.slow(threshold)
    }

    /// Open a typed stream on the current session. The subscription ends when
    /// the session drops (reconnect resubscription is the caller's concern —
    /// domain loops resubscribe by watching [`Self::sessions`]).
    pub fn subscribe<M: RpcMethod>(
        &self,
        payload: &M::Payload,
    ) -> Result<vitre_rpc::TypedSubscription<M>, RpcError> {
        let handle = self.supervisor.sessions().borrow().clone();
        let Some(handle) = handle else {
            return Err(RpcError::ConnectionClosed);
        };
        handle.session.subscribe_typed::<M>(payload)
    }
}

impl Drop for EnvironmentClient {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

pub struct ThreadHandle {
    state: watch::Receiver<ThreadState>,
    task: tokio::task::JoinHandle<()>,
}

impl ThreadHandle {
    pub fn state(&self) -> watch::Receiver<ThreadState> {
        self.state.clone()
    }
}

impl Drop for ThreadHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Why one subscription attempt ended.
enum SubscriptionEnd {
    /// Transport loss or session replacement: wait for the next session.
    SessionLost,
    /// The server completed the stream (typed failure or normal exit).
    Completed,
}

/// Drive one subscription until it ends, applying every value through
/// `apply`. Selects on the session channel so a replaced/dropped session
/// unblocks the loop even though the dead subscription would never yield
/// (its router entry is gone once the reader task exits).
async fn drain<M, F>(
    subscription: &mut TypedSubscription<M>,
    sessions: &mut watch::Receiver<Option<SessionHandle>>,
    generation: u64,
    mut apply: F,
) -> SubscriptionEnd
where
    M: RpcMethod,
    F: FnMut(Option<Vec<M::Success>>) -> bool,
{
    let mut cadence = tokio::time::interval(Duration::from_millis(16));
    cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut pending = false;
    loop {
        tokio::select! {
            _ = cadence.tick(), if pending => {
                apply(None);
                pending = false;
            }
            event = subscription.next() => match event {
                Some(TypedStreamEvent::Values(values)) => {
                    pending |= apply(Some(values));
                    if subscription.ack().is_err() {
                        return SubscriptionEnd::SessionLost;
                    }
                }
                Some(TypedStreamEvent::Completed(result)) => {
                    return match result {
                        Err(error) if error.is_transport() => SubscriptionEnd::SessionLost,
                        Err(error) => {
                            eprintln!("[vitre-client] {} completed with error: {error:?}", M::TAG);
                            SubscriptionEnd::Completed
                        }
                        Ok(()) => SubscriptionEnd::Completed,
                    };
                }
                None => return SubscriptionEnd::SessionLost,
            },
            changed = sessions.changed() => {
                if changed.is_err() {
                    return SubscriptionEnd::SessionLost;
                }
                let replaced = sessions
                    .borrow()
                    .as_ref()
                    .is_none_or(|handle| handle.generation != generation);
                if replaced {
                    return SubscriptionEnd::SessionLost;
                }
            }
        }
    }
}

/// A reader can discover a dead transport before the supervisor's keepalive.
/// Do not resubscribe to that same published handle or call it synchronizing.
async fn wait_for_replacement(
    sessions: &mut watch::Receiver<Option<SessionHandle>>,
    generation: u64,
) -> bool {
    while sessions
        .borrow_and_update()
        .as_ref()
        .is_some_and(|session| session.generation == generation)
    {
        if sessions.changed().await.is_err() {
            return false;
        }
    }
    true
}

/// The shell sync loop (`shell.ts` `makeEnvironmentShellState`): on every
/// (re)subscription, re-fetch the HTTP snapshot and resume from its sequence.
async fn run_shell(
    mut sessions: watch::Receiver<Option<SessionHandle>>,
    state_tx: watch::Sender<ShellState>,
) {
    let mut projection = ShellProjection::new();
    let started = std::time::Instant::now();
    loop {
        let Some(handle) = wait_for_session(&mut sessions).await else {
            return;
        };
        let http = EnvironmentHttp::new(handle.target.base_url.clone());
        match http.shell_snapshot(&handle.target.access_token).await {
            Ok(snapshot) => {
                projection.apply_snapshot(snapshot);
                if std::env::var_os("VITRE_PROFILE").is_some() {
                    eprintln!(
                        "[vitre-perf] shell snapshot ready after {} ms",
                        started.elapsed().as_millis()
                    );
                }
            }
            // Fall back to the socket-embedded snapshot (no afterSequence →
            // the server sends a fresh one as the first stream item).
            Err(error) => {
                eprintln!("[vitre-client] shell snapshot over HTTP failed: {error}");
            }
        }
        projection.begin_subscription(handle.config.shell_resume_completion_marker == Some(true));

        let mut subscription = match handle
            .session
            .subscribe_typed::<OrchestrationSubscribeShell>(&projection.resume_input())
        {
            Ok(subscription) => subscription,
            // Send failed: the published session is already dead. Wait for
            // the supervisor to replace it instead of spinning on it.
            Err(_) => {
                if !wait_for_replacement(&mut sessions, handle.generation).await {
                    return;
                }
                continue;
            }
        };
        publish_shell(&state_tx, &projection);
        let end = drain(
            &mut subscription,
            &mut sessions,
            handle.generation,
            |items| {
                let mut changed = false;
                for item in items.unwrap_or_default() {
                    changed |= projection.apply_item(&item) != ShellApplyOutcome::Unchanged;
                }
                if changed {
                    publish_shell(&state_tx, &projection);
                }
                false
            },
        )
        .await;
        state_tx.send_modify(|state| state.phase = SyncPhase::Disconnected);
        if matches!(end, SubscriptionEnd::Completed) {
            tokio::time::sleep(RESUBSCRIBE_AFTER_COMPLETION).await;
        } else if !wait_for_replacement(&mut sessions, handle.generation).await {
            return;
        }
    }
}

fn publish_shell(state_tx: &watch::Sender<ShellState>, projection: &ShellProjection) {
    let _ = state_tx.send(ShellState {
        snapshot: projection.snapshot().cloned().map(Arc::new),
        phase: if projection.awaiting_completion() {
            SyncPhase::Synchronizing
        } else {
            SyncPhase::Live
        },
    });
}

/// The thread sync loop (`threads.ts` subscribe flow, minus the disk cache):
/// local clients seed once over HTTP; remote clients use the subscription's
/// buffered snapshot to avoid an extra serial network round trip. Both resume
/// via `afterSequence` once they have a snapshot.
async fn run_thread(
    mut sessions: watch::Receiver<Option<SessionHandle>>,
    thread_id: ThreadId,
    state_tx: watch::Sender<ThreadState>,
    initial_snapshot: InitialThreadSnapshot,
) {
    let mut projection = ThreadProjection::new();
    let started = std::time::Instant::now();
    loop {
        let Some(handle) = wait_for_session(&mut sessions).await else {
            return;
        };
        if initial_snapshot == InitialThreadSnapshot::Http
            && projection.persisted().is_none()
            && !projection.is_deleted()
        {
            let http = EnvironmentHttp::new(handle.target.base_url.clone());
            match http
                .thread_snapshot(&handle.target.access_token, &thread_id)
                .await
            {
                Ok(Some(snapshot)) => {
                    projection.seed(&snapshot);
                    if std::env::var_os("VITRE_PROFILE").is_some() {
                        eprintln!(
                            "[vitre-perf] thread snapshot ready after {} ms",
                            started.elapsed().as_millis()
                        );
                    }
                }
                // 404: the socket subscription is the source of truth for
                // existence; it sends a snapshot (or the deletion) itself.
                Ok(None) => {}
                Err(error) => {
                    eprintln!("[vitre-client] thread snapshot over HTTP failed: {error}");
                }
            }
        }
        projection.begin_subscription(handle.config.thread_resume_completion_marker == Some(true));

        let mut subscription = match handle
            .session
            .subscribe_typed::<OrchestrationSubscribeThread>(&projection.resume_input(&thread_id))
        {
            Ok(subscription) => subscription,
            // Send failed: the published session is already dead. Wait for
            // the supervisor to replace it instead of spinning on it.
            Err(_) => {
                if !wait_for_replacement(&mut sessions, handle.generation).await {
                    return;
                }
                continue;
            }
        };
        publish_thread(&state_tx, &projection);
        let end = drain(
            &mut subscription,
            &mut sessions,
            handle.generation,
            |items| {
                let Some(items) = items else {
                    publish_thread(&state_tx, &projection);
                    return false;
                };
                projection.apply_batch(&items)
            },
        )
        .await;
        // Flush the final batch even when the stream closes before the next frame.
        publish_thread(&state_tx, &projection);
        state_tx.send_modify(|state| state.phase = SyncPhase::Disconnected);
        if matches!(end, SubscriptionEnd::Completed) {
            tokio::time::sleep(RESUBSCRIBE_AFTER_COMPLETION).await;
        } else if !wait_for_replacement(&mut sessions, handle.generation).await {
            return;
        }
    }
}

fn publish_thread(state_tx: &watch::Sender<ThreadState>, projection: &ThreadProjection) {
    let _ = state_tx.send(ThreadState {
        view: projection.shared_view(),
        phase: if projection.awaiting_completion() {
            SyncPhase::Synchronizing
        } else {
            SyncPhase::Live
        },
        deleted: projection.is_deleted(),
    });
}

#[cfg(test)]
mod thread_connection_tests {
    use super::*;
    use futures::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

    type Peer = WebSocketStream<TcpStream>;

    fn snapshot(sequence: u64) -> Value {
        json!({
            "snapshotSequence": sequence,
            "thread": {
                "id": "thread-1", "projectId": "project-1", "title": "Test",
                "modelSelection": {"model": "test"}, "runtimeMode": "full-access",
                "branch": null, "worktreePath": null, "latestTurn": null,
                "createdAt": "2026-10-15T00:00:00Z", "updatedAt": "2026-10-15T00:00:00Z",
                "deletedAt": null, "messages": [], "proposedPlans": [],
                "activities": [], "checkpoints": [], "session": null
            }
        })
    }

    fn message_event(sequence: u64, message_id: &str) -> Value {
        json!({"kind": "event", "event": {
            "type": "thread.message-sent", "eventId": format!("event-{sequence}"),
            "commandId": null, "causationEventId": null, "correlationId": null,
            "metadata": {}, "sequence": sequence, "occurredAt": "2026-10-15T00:00:01Z",
            "aggregateKind": "thread", "aggregateId": "thread-1",
            "payload": {
                "threadId": "thread-1", "messageId": message_id, "role": "assistant",
                "text": message_id, "turnId": "turn-1", "streaming": false,
                "createdAt": "2026-10-15T00:00:01Z", "updatedAt": "2026-10-15T00:00:01Z"
            }
        }})
    }

    async fn session(base_url: String, generation: u64) -> (SessionHandle, Peer) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}", listener.local_addr().unwrap());
        let (client, peer) = tokio::join!(vitre_rpc::RpcSession::connect(&ws_url), async {
            let (stream, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(stream).await.unwrap()
        });
        let config = serde_json::from_value(json!({
            "auth": {"bootstrapMethods": [], "policy": "required", "sessionCookieName": "test", "sessionMethods": []},
            "availableEditors": [], "cwd": "/test", "issues": [], "keybindings": [],
            "keybindingsConfigPath": "/test/keybindings", "providers": [], "settings": {},
            "environment": {"capabilities": {}, "environmentId": "test", "label": "Test", "platform": {"os": "linux", "arch": "x64"}, "serverVersion": "test"},
            "observability": {"localTracingEnabled": false, "logsDirectoryPath": "/test/logs", "otlpMetricsEnabled": false, "otlpTracesEnabled": false},
            "threadResumeCompletionMarker": true
        })).unwrap();
        (
            SessionHandle {
                generation,
                session: Arc::new(client.unwrap()),
                target: PreparedTarget {
                    base_url,
                    access_token: "test-access".into(),
                    initial_websocket_ticket: None,
                },
                config: Arc::new(config),
            },
            peer,
        )
    }

    async fn next_request(peer: &mut Peer) -> Value {
        loop {
            let frame = peer.next().await.unwrap().unwrap();
            if let Message::Text(text) = frame {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["_tag"] == "Request" {
                    assert_eq!(value["tag"], OrchestrationSubscribeThread::TAG);
                    return value;
                }
            }
        }
    }

    async fn chunk(peer: &mut Peer, request: &Value, values: Vec<Value>) {
        peer.send(Message::Text(
            json!({"_tag": "Chunk", "requestId": request["id"], "values": values})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    }

    async fn wait_state(
        states: &mut watch::Receiver<ThreadState>,
        ready: impl Fn(&ThreadState) -> bool,
    ) -> ThreadState {
        loop {
            let state = states.borrow_and_update().clone();
            if ready(&state) {
                return state;
            }
            states.changed().await.unwrap();
        }
    }

    #[tokio::test]
    async fn remote_snapshot_buffers_events_and_resumes_without_http() {
        tokio::time::timeout(Duration::from_secs(3), async {
            // An HTTP snapshot request here would stall; the socket must be
            // subscribed immediately, without waiting for this listener.
            let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base_url = format!("http://{}", http.local_addr().unwrap());
            let (handle, mut peer) = session(base_url.clone(), 1).await;
            let (sessions, rx) = watch::channel(Some(handle));
            let (state_tx, mut states) = watch::channel(ThreadState::default());
            let task = tokio::spawn(run_thread(
                rx,
                ThreadId("thread-1".into()),
                state_tx,
                InitialThreadSnapshot::Subscription,
            ));
            let request = next_request(&mut peer).await;
            assert!(request["payload"].get("afterSequence").is_none());
            assert_eq!(request["payload"]["requestCompletionMarker"], true);
            chunk(
                &mut peer,
                &request,
                vec![json!({"kind": "snapshot", "snapshot": snapshot(7)})],
            )
            .await;
            let initial = wait_state(&mut states, |s| s.view.is_some()).await;
            assert_eq!(initial.phase, SyncPhase::Synchronizing);
            chunk(
                &mut peer,
                &request,
                vec![message_event(8, "first"), json!({"kind": "synchronized"})],
            )
            .await;
            let ready = wait_state(&mut states, |s| s.phase == SyncPhase::Live).await;
            assert_eq!(ready.view.unwrap().messages[0].text.0, "first");

            let (replacement, mut replacement_peer) = session(base_url, 2).await;
            sessions.send(Some(replacement)).unwrap();
            let resumed = next_request(&mut replacement_peer).await;
            assert_eq!(resumed["payload"]["afterSequence"], 8);
            assert_eq!(resumed["payload"]["requestCompletionMarker"], true);
            chunk(
                &mut replacement_peer,
                &resumed,
                vec![
                    message_event(8, "first"),
                    message_event(9, "second"),
                    json!({"kind": "synchronized"}),
                ],
            )
            .await;
            let ready = wait_state(&mut states, |s| {
                s.phase == SyncPhase::Live && s.view.as_ref().is_some_and(|v| v.messages.len() == 2)
            })
            .await;
            assert_eq!(ready.view.unwrap().messages[1].text.0, "second");
            assert!(
                tokio::time::timeout(Duration::from_millis(20), http.accept())
                    .await
                    .is_err()
            );
            task.abort();
        })
        .await
        .expect("remote thread must synchronize without an HTTP snapshot");
    }

    #[tokio::test]
    async fn authoritative_session_removal_preserves_cached_history() {
        tokio::time::timeout(Duration::from_secs(3), async {
            let (handle, mut peer) = session("http://127.0.0.1:1".into(), 1).await;
            let (sessions, rx) = watch::channel(Some(handle));
            let (state_tx, mut states) = watch::channel(ThreadState::default());
            let task = tokio::spawn(run_thread(
                rx,
                ThreadId("thread-1".into()),
                state_tx,
                InitialThreadSnapshot::Subscription,
            ));
            let request = next_request(&mut peer).await;
            chunk(
                &mut peer,
                &request,
                vec![
                    json!({"kind": "snapshot", "snapshot": snapshot(7)}),
                    message_event(8, "cached after retirement"),
                    json!({"kind": "synchronized"}),
                ],
            )
            .await;
            wait_state(&mut states, |state| state.phase == SyncPhase::Live).await;
            // Authoritative retirement clears the session while the socket and
            // retained panel are still alive; transport failure is not required.
            sessions.send_replace(None);
            let retired =
                wait_state(&mut states, |state| state.phase == SyncPhase::Disconnected).await;
            assert_eq!(
                retired.view.unwrap().messages[0].text.0,
                "cached after retirement"
            );
            assert!(!retired.deleted);
            task.abort();
        })
        .await
        .expect("retirement must disconnect without deleting cached history");
    }

    #[tokio::test]
    async fn dead_transport_stays_disconnected_until_session_replacement() {
        tokio::time::timeout(Duration::from_secs(3), async {
            let (handle, mut peer) = session("http://127.0.0.1:1".into(), 1).await;
            let (sessions, rx) = watch::channel(Some(handle));
            let (state_tx, mut states) = watch::channel(ThreadState::default());
            let task = tokio::spawn(run_thread(
                rx,
                ThreadId("thread-1".into()),
                state_tx,
                InitialThreadSnapshot::Subscription,
            ));
            let request = next_request(&mut peer).await;
            chunk(
                &mut peer,
                &request,
                vec![
                    json!({"kind": "snapshot", "snapshot": snapshot(7)}),
                    message_event(8, "preserved"),
                    json!({"kind": "synchronized"}),
                ],
            )
            .await;
            wait_state(&mut states, |s| s.phase == SyncPhase::Live).await;
            // Keep the supervisor's old handle published after the reader sees
            // the socket close, reproducing the real keepalive delay.
            peer.close(None).await.unwrap();
            let lost = wait_state(&mut states, |s| s.phase == SyncPhase::Disconnected).await;
            assert_eq!(lost.view.unwrap().messages[0].text.0, "preserved");
            assert!(
                tokio::time::timeout(Duration::from_millis(100), states.changed())
                    .await
                    .is_err()
            );
            assert_eq!(states.borrow().phase, SyncPhase::Disconnected);
            let (replacement, mut replacement_peer) = session("http://127.0.0.1:1".into(), 2).await;
            sessions.send(Some(replacement)).unwrap();
            let resumed = next_request(&mut replacement_peer).await;
            assert_eq!(resumed["payload"]["afterSequence"], 8);
            assert_eq!(states.borrow().phase, SyncPhase::Synchronizing);
            chunk(
                &mut replacement_peer,
                &resumed,
                vec![json!({"kind": "synchronized"})],
            )
            .await;
            let live = wait_state(&mut states, |s| s.phase == SyncPhase::Live).await;
            assert_eq!(live.view.unwrap().messages[0].text.0, "preserved");
            task.abort();
        })
        .await
        .expect("transport closure must remain disconnected until a fresh session exists");
    }

    #[tokio::test]
    async fn remote_missing_thread_stays_disconnected_without_a_fabricated_view() {
        tokio::time::timeout(Duration::from_secs(3), async {
            let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (handle, mut peer) = session(format!("http://{}", http.local_addr().unwrap()), 1).await;
            let (_sessions, rx) = watch::channel(Some(handle));
            let (state_tx, mut states) = watch::channel(ThreadState::default());
            let task = tokio::spawn(run_thread(rx, ThreadId("thread-1".into()), state_tx, InitialThreadSnapshot::Subscription));
            let request = next_request(&mut peer).await;
            wait_state(&mut states, |s| s.phase == SyncPhase::Synchronizing).await;
            peer.send(Message::Text(json!({
                "_tag": "Exit", "requestId": request["id"],
                "exit": {"_tag": "Failure", "cause": [{"_tag": "Fail", "error": {
                    "_tag": "OrchestrationGetSnapshotError", "message": "Thread was not found", "cause": "thread-1"
                }}]}
            }).to_string().into())).await.unwrap();
            let failed = wait_state(&mut states, |s| s.phase == SyncPhase::Disconnected).await;
            assert!(failed.view.is_none());
            assert!(!failed.deleted);
            assert!(tokio::time::timeout(Duration::from_millis(20), http.accept()).await.is_err());
            task.abort();
        }).await.expect("typed missing-thread failure must finish the subscription");
    }

    #[tokio::test]
    async fn local_thread_still_seeds_http_snapshot_before_resuming() {
        tokio::time::timeout(Duration::from_secs(3), async {
            let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (handle, mut peer) = session(format!("http://{}", http.local_addr().unwrap()), 1).await;
            let http_task = tokio::spawn(async move {
                let (mut stream, _) = http.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {request.push(stream.read_u8().await.unwrap());}
                assert!(String::from_utf8(request).unwrap().starts_with("GET /api/orchestration/threads/thread%2D1 "));
                let body = snapshot(7).to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            let (_sessions, rx) = watch::channel(Some(handle));
            let (state_tx, mut states) = watch::channel(ThreadState::default());
            let task = tokio::spawn(run_thread(rx, ThreadId("thread-1".into()), state_tx, InitialThreadSnapshot::Http));
            let request = next_request(&mut peer).await;
            assert_eq!(request["payload"]["afterSequence"], 7);
            chunk(&mut peer, &request, vec![json!({"kind": "synchronized"})]).await;
            let ready = wait_state(&mut states, |s| s.phase == SyncPhase::Live).await;
            assert_eq!(ready.view.unwrap().title.0, "Test");
            http_task.await.unwrap();
            task.abort();
        }).await.expect("local HTTP snapshot path must remain available");
    }
}
