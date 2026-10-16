//! The one place cloud state lives. Shared conversations, sidebar rows and
//! the Settings → Cloud page all read this entity, so a
//! task created in one place shows up everywhere on the next frame.
//!
//! Every request carries its own in-flight key instead of a single `busy`
//! flag: cancelling one task must not grey out the composer, and a background
//! poll never blocks a click.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use gpui::{App, AppContext as _, Context, Entity, EventEmitter, Global};
use gpui_tokio::Tokio;
use vitre_client::cloud::CloudClient;
use vitre_client::{EnvironmentClient, ThreadHandle};
use vitre_contracts::{
    ApprovalRequestId, ClientOrchestrationCommand, CloudCommand, CloudCommandPublicationCreateKind,
    CloudLoginStatus, CloudLoginStatusState, CloudOverview, CloudProvider, CloudRepository,
    CloudSavedResult, CloudTask, CloudTaskEvent, CloudTaskState, CloudWorkerState, CommandId,
    OrchestrationThread, ProviderApprovalDecision, ProviderUserInputAnswers, TrimmedNonEmptyString,
};

/// Overview refresh cadence while nothing watched is changing.
const IDLE_POLL: Duration = Duration::from_secs(5);
/// Cadence while the watched task is queued, preparing or its worker is starting.
const WARMING_POLL: Duration = Duration::from_millis(250);

/// Keep the socket and thread subscription alive across sidebar navigation.
/// A replaced attempt must never inherit a connection to the previous worker.
#[derive(Clone)]
pub(crate) struct LiveConversation {
    pub identity: String,
    pub client: Arc<EnvironmentClient>,
    pub thread: Arc<ThreadHandle>,
}

pub(crate) fn connection_identity(task: &CloudTask) -> Option<String> {
    let worker = task.worker.as_ref()?;
    if !crate::chat::cloud_thread::worker_is_up(task) {
        return None;
    }
    Some(format!(
        "{}:{}:{}:{}",
        worker.id,
        worker.environment_id,
        task.attempt
            .as_ref()
            .map_or("", |attempt| attempt.id.as_str()),
        task.attempt
            .as_ref()
            .map_or(0, |attempt| attempt.generation)
    ))
}

/// Where the account stands. `Unknown` until the first session probe answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    Unknown,
    /// The sidecar has no cloud deployment configured or the feature flag is
    /// off; nothing here can work.
    Disabled,
    SignedOut,
    SigningIn,
    SignedIn,
}

/// Everything fetched for one task beyond what the overview carries.
#[derive(Default, Clone)]
pub struct TaskDetail {
    pub conversation: Option<Arc<OrchestrationThread>>,
    pub result: Option<CloudSavedResult>,
    pub events: Vec<CloudTaskEvent>,
    /// `true` until the first feed response for this task lands.
    pub loading: bool,
    pub error: Option<String>,
}

fn merge_detail_snapshot(
    detail: &mut TaskDetail,
    feed: vitre_contracts::CloudTaskFeed,
    result: Option<CloudSavedResult>,
) {
    detail.error = None;
    detail.events = feed.events;
    let fresh = serde_json::from_value::<OrchestrationThread>(feed.conversation).ok();
    if let Some(result) = result {
        detail.result = Some(result);
    }
    let conversation = fresh
        .or_else(|| detail.conversation.as_ref().map(|view| (**view).clone()))
        .or_else(|| {
            detail
                .result
                .as_ref()
                .and_then(|result| serde_json::from_value(result.result.conversation.clone()).ok())
        });
    if let Some(conversation) = conversation {
        detail.conversation = Some(Arc::new(conversation));
    }
}

/// What a request was for, so views can show a spinner on exactly the control
/// that started it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Op {
    Session,
    SignIn,
    Overview,
    Repositories,
    SaveRepository(String),
    CreateTask,
    Task(String, &'static str),
    Provider(CloudProvider),
    Publish(String),
    Limits,
    Respond(String),
}

pub enum CloudEvent {
    /// Something changed; views that cache derived state should rebuild.
    Changed,
    /// Legacy surface fixture; production creates settle through keyed outcomes.
    #[cfg(test)]
    TaskCreated(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeliveryOutcome {
    Accepted,
    Unknown(String),
    Rejected(String),
}

#[derive(Clone, Debug)]
pub enum CreationOutcome {
    Accepted(String),
    Unknown(String),
    Rejected(String),
}
#[derive(Clone, Debug)]
pub struct CreationResult {
    pub project_id: String,
    pub outcome: CreationOutcome,
}

fn session_identity(session: &vitre_contracts::CloudDesktopSession) -> Option<String> {
    use base64::Engine as _;
    let payload = session.access_token.as_ref()?.0.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    Some(format!(
        "{}|{}",
        session.relay_url.as_ref()?.0,
        claims.get("sub")?.as_str()?
    ))
}

pub struct CloudStore {
    client: Option<CloudClient>,
    live_conversations: HashMap<String, LiveConversation>,
    pub session: SessionState,
    account_identity: Option<String>,
    pub creation_outcomes: HashMap<String, CreationResult>,
    pub overview: Option<CloudOverview>,
    /// GitHub-App repositories that are installed but not yet configured.
    pub available: Option<Vec<CloudRepository>>,
    pub login: Option<CloudLoginStatus>,
    pub details: HashMap<String, TaskDetail>,
    /// The task whose feed the poll loop keeps fresh.
    pub watching: Option<String>,
    pub pending: HashSet<Op>,
    /// The last failure a foreground action produced, shown until the next
    /// action replaces or clears it.
    pub error: Option<String>,
    pub operation_errors: HashMap<Op, String>,
    pub delivery_outcomes: HashMap<String, DeliveryOutcome>,
    delivery_requests: HashSet<String>,
    pub stop_outcomes: HashMap<String, DeliveryOutcome>,
    stop_requests: HashMap<String, String>,
    binding_revisions: HashMap<String, i64>,
    polling: bool,
    signin_generation: u64,
    pub cancelling_signin: bool,
    pub creation_progress: Option<String>,
    pub creation_status: Option<vitre_contracts::CloudStartProgress>,
    creation_key: Option<String>,
}

struct StoreHandle(Entity<CloudStore>);
impl Global for StoreHandle {}

impl EventEmitter<CloudEvent> for CloudStore {}

/// Micro-dollars as a short dollar string.
pub fn dollars(micro: i64) -> String {
    format!("${:.2}", micro as f64 / 1_000_000.)
}

fn key() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "native-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

fn continue_has_receipt(
    overview: &CloudOverview,
    feed: Option<&vitre_contracts::CloudTaskFeed>,
    input: &vitre_contracts::CloudContinueConversationInput,
) -> bool {
    overview.tasks.iter().any(|task| {
        task.id == input.task_id
            && task.turn_request_id.as_deref() == Some(input.idempotency_key.as_str())
    }) || feed
        .and_then(|feed| {
            serde_json::from_value::<OrchestrationThread>(feed.conversation.clone()).ok()
        })
        .is_some_and(|thread| {
            thread.messages.iter().any(|message| {
                message.role == vitre_contracts::OrchestrationMessageRole::User
                    && message.id.0 == format!("{}-message", input.idempotency_key)
                    && crate::chat::cloud_thread::cloud_message_matches_prompt(
                        &message.text.0,
                        &input.prompt,
                    )
            })
        })
}

impl CloudStore {
    /// The process-wide store, created on first use. Tests get one with no
    /// client and feed it fixture overviews.
    pub fn global(cx: &mut App) -> Entity<CloudStore> {
        if let Some(handle) = cx.try_global::<StoreHandle>() {
            return handle.0.clone();
        }
        let store = cx.new(|cx| CloudStore::new(None, cx));
        cx.set_global(StoreHandle(store.clone()));
        store
    }

    pub fn new(client: Option<Arc<EnvironmentClient>>, cx: &mut Context<Self>) -> Self {
        cx.spawn(async move |this, cx| {
            let mut last_poll = std::time::Instant::now();
            loop {
                // Re-evaluate after a send changes the cadence; a five-second
                // idle timer must not delay noticing the first ready response.
                cx.background_executor().timer(WARMING_POLL).await;
                let interval = this
                    .read_with(cx, |store, _| store.poll_interval())
                    .unwrap_or(IDLE_POLL);
                if last_poll.elapsed() < interval {
                    continue;
                }
                if this.update(cx, |store, cx| store.poll(cx)).is_err() {
                    break;
                }
                last_poll = std::time::Instant::now();
            }
        })
        .detach();
        let mut store = Self {
            client: None,
            live_conversations: HashMap::new(),
            session: SessionState::Unknown,
            account_identity: None,
            creation_outcomes: HashMap::new(),
            overview: None,
            available: None,
            login: None,
            details: HashMap::new(),
            watching: None,
            pending: HashSet::new(),
            error: None,
            operation_errors: HashMap::new(),
            delivery_outcomes: HashMap::new(),
            delivery_requests: HashSet::new(),
            stop_outcomes: HashMap::new(),
            stop_requests: HashMap::new(),
            binding_revisions: HashMap::new(),
            polling: false,
            signin_generation: 0,
            cancelling_signin: false,
            creation_progress: None,
            creation_status: None,
            creation_key: None,
        };
        if let Some(client) = client {
            store.attach(client, cx);
        }
        store
    }

    fn retire_live_conversations(&mut self) {
        for (_, connection) in self.live_conversations.drain() {
            connection.client.retire();
        }
    }

    fn begin_account_session(&mut self) {
        self.signin_generation += 1;
        self.account_identity = None;
        self.creation_outcomes.clear();
        self.creation_key = None;
        self.overview = None;
        self.binding_revisions.clear();
        self.details.clear();
        self.retire_live_conversations();
        self.available = None;
        self.login = None;
        self.delivery_requests.clear();
        self.delivery_outcomes.clear();
        self.stop_requests.clear();
        self.stop_outcomes.clear();
        self.pending.clear();
        self.polling = false;
    }

    pub fn account_identity(&self) -> Option<&str> {
        self.account_identity.as_deref()
    }

    pub fn account_generation(&self) -> u64 {
        self.signin_generation
    }

    pub fn has_client(&self) -> bool {
        self.client.is_some()
    }

    /// Follow readiness and the worker's idle acknowledgement without adding
    /// a multi-second delay before the composer becomes available.
    pub(crate) fn poll_interval(&self) -> Duration {
        let watched = self.watching.as_deref().and_then(|id| self.task(id));
        let warming = watched.is_some_and(|task| {
            matches!(
                task.state,
                CloudTaskState::Queued | CloudTaskState::Preparing
            ) || (task.state == CloudTaskState::Running && task.idle != Some(true))
                || task.worker.as_ref().is_some_and(|worker| {
                    matches!(
                        worker.state,
                        CloudWorkerState::Provisioning | CloudWorkerState::Starting
                    )
                })
        });
        if warming { WARMING_POLL } else { IDLE_POLL }
    }

    pub fn is_pending(&self, op: &Op) -> bool {
        self.pending.contains(op)
    }

    pub fn task(&self, id: &str) -> Option<&CloudTask> {
        self.overview
            .as_ref()
            .and_then(|o| o.tasks.iter().find(|t| t.id == id))
    }

    pub fn detail(&self, id: &str) -> Option<&TaskDetail> {
        self.details.get(id)
    }

    pub fn repositories(&self) -> &[CloudRepository] {
        self.overview
            .as_ref()
            .map(|o| o.repositories.as_slice())
            .unwrap_or_default()
    }

    pub fn account_state(
        &self,
        provider: &CloudProvider,
    ) -> Option<&vitre_contracts::CloudProviderAccountState> {
        self.overview
            .as_ref()?
            .accounts
            .iter()
            .find(|a| &a.provider == provider)
            .map(|a| &a.state)
    }

    /// Wire the local sidecar in and find out whether a session already exists,
    /// so a returning user sees their tasks without clicking anything.
    pub(crate) fn client(&self) -> Option<CloudClient> {
        self.client.clone()
    }

    pub(crate) fn live_conversation(&self, task_id: &str) -> Option<LiveConversation> {
        if self.session != SessionState::SignedIn {
            return None;
        }
        let cached = self.live_conversations.get(task_id)?;
        (connection_identity(self.task(task_id)?).as_ref() == Some(&cached.identity))
            .then(|| cached.clone())
    }

    pub(crate) fn retain_live_conversation(
        &mut self,
        task_id: String,
        connection: LiveConversation,
    ) -> bool {
        if self.session != SessionState::SignedIn
            || self.task(&task_id).and_then(connection_identity).as_ref()
                != Some(&connection.identity)
        {
            connection.client.retire();
            return false;
        }
        if let Some(previous) = self.live_conversations.insert(task_id, connection.clone())
            && !Arc::ptr_eq(&previous.client, &connection.client)
        {
            previous.client.retire();
        }
        true
    }

    pub fn attach(&mut self, client: Arc<EnvironmentClient>, cx: &mut Context<Self>) {
        if self.client.is_some() {
            return;
        }
        self.client = Some(CloudClient::new(client));
        self.probe_session(cx);
    }

    fn probe_session(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        self.run(
            Op::Session,
            async move { Ok(client.session(false).await?) },
            |store, response, cx| match response {
                Ok(session) if !session.enabled => store.session = SessionState::Disabled,
                Ok(session) if session.access_token.is_some() => {
                    store.account_identity = session_identity(&session);
                    store.session = SessionState::SignedIn;
                    store.refresh(cx);
                }
                Ok(_) => store.session = SessionState::SignedOut,
                Err(error) => {
                    store.session = SessionState::SignedOut;
                    store.error = Some(error.to_string());
                }
            },
            cx,
        );
    }

    /// Explicit sign-in: the only path allowed to open a browser.
    pub fn sign_in(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            self.error = Some("Waiting for the local account service.".into());
            cx.notify();
            return;
        };
        if self.cancelling_signin {
            return;
        }
        if self.session == SessionState::SigningIn {
            self.cancel_sign_in_then(true, cx);
            return;
        }
        self.begin_account_session();
        self.session = SessionState::SigningIn;
        self.error = None;
        self.run(
            Op::SignIn,
            async move {
                let session = client.session(true).await?;
                anyhow::ensure!(
                    session.enabled,
                    "Cloud is disabled for this desktop deployment"
                );
                anyhow::ensure!(
                    session.access_token.is_some(),
                    "Sign-in did not produce a session"
                );
                Ok(session)
            },
            |store, response, cx| match response {
                Ok(session) => {
                    store.account_identity = session_identity(&session);
                    store.session = SessionState::SignedIn;
                    store.refresh(cx);
                }
                Err(error) => {
                    // A cancelled sign-in already reported itself.
                    if store.session == SessionState::SigningIn {
                        store.session = SessionState::SignedOut;
                        store.error = Some(error.to_string());
                    }
                }
            },
            cx,
        );
    }

    pub fn cancel_sign_in(&mut self, cx: &mut Context<Self>) {
        self.cancel_sign_in_then(false, cx);
    }

    fn cancel_sign_in_then(&mut self, retry: bool, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.cancelling_signin {
            return;
        }
        self.begin_account_session();
        let generation = self.signin_generation;
        self.cancelling_signin = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .update(|cx| {
                    Tokio::spawn_result(cx, async move {
                        client.cancel_signin().await.map_err(anyhow::Error::from)
                    })
                })
                .await;
            let _ = this.update(cx, |store, cx| {
                if generation != store.signin_generation {
                    return;
                }
                store.cancelling_signin = false;
                store.session = SessionState::SignedOut;
                store.retire_live_conversations();
                store.pending.remove(&Op::SignIn);
                if let Err(error) = result {
                    store.error = Some(format!("Could not cancel sign-in: {error}"));
                } else if retry {
                    store.sign_in(cx);
                }
                cx.emit(CloudEvent::Changed);
                cx.notify();
            });
        })
        .detach();
    }

    /// Reload the overview and, if a task is being watched, its feed.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.is_pending(&Op::Overview) {
            return;
        }
        self.run(
            Op::Overview,
            async move { Ok(client.overview().await?) },
            |store, response, cx| match response {
                Ok(overview) => store.apply_overview(overview, cx),
                Err(error) => {
                    let text = error.to_string();
                    if text.contains("Sign into") {
                        store.session = SessionState::SignedOut;
                    }
                    store.error = Some(text);
                }
            },
            cx,
        );
    }

    pub(crate) fn accepts_account_revision(&self, revision: Option<i64>) -> bool {
        self.overview
            .as_ref()
            .and_then(|value| value.revision)
            .into_iter()
            .chain(self.binding_revisions.values().copied())
            .max()
            .is_none_or(|current| revision.is_some_and(|next| next >= current))
    }

    pub(crate) fn apply_overview(&mut self, mut overview: CloudOverview, cx: &mut Context<Self>) {
        if !self.accepts_account_revision(overview.revision) {
            return;
        }
        // A handoff response can be newer than the last full account snapshot.
        if let Some(previous) = self
            .overview
            .as_ref()
            .and_then(|value| value.bindings.as_ref())
        {
            for binding in previous {
                if self
                    .binding_revisions
                    .get(&binding.conversation_id)
                    .is_some_and(|revision| {
                        overview
                            .revision
                            .is_none_or(|incoming| incoming < *revision)
                    })
                {
                    let bindings = overview.bindings.get_or_insert_with(Vec::new);
                    bindings.retain(|entry| entry.conversation_id != binding.conversation_id);
                    bindings.push(binding.clone());
                }
            }
        }
        self.session = SessionState::SignedIn;
        // A repository-less account needs the installable list straight away:
        // connecting one is the first thing a cloud draft will ask for.
        let needs_available = overview.repositories.is_empty() && self.available.is_none();
        self.details
            .retain(|id, _| overview.tasks.iter().any(|t| &t.id == id));
        self.live_conversations.retain(|id, connection| {
            let current = overview.tasks.iter().any(|task| {
                &task.id == id && connection_identity(task).as_ref() == Some(&connection.identity)
            });
            if !current {
                connection.client.retire();
            }
            current
        });
        self.overview = Some(overview);
        if needs_available {
            self.load_available(cx);
        }
        if let Some(id) = self.watching.clone() {
            self.fetch_detail(id, cx);
        }
    }

    /// Background tick: cheap, silent, and skipped while a refresh is already
    /// in flight.
    fn poll(&mut self, cx: &mut Context<Self>) {
        if self.client.is_none() || self.session != SessionState::SignedIn || self.polling {
            return;
        }
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.is_pending(&Op::Overview) {
            return;
        }
        self.polling = true;
        let session_generation = self.signin_generation;
        let login_id = self.login.as_ref().and_then(|l| {
            matches!(
                l.state,
                CloudLoginStatusState::Starting | CloudLoginStatusState::Running
            )
            .then(|| l.id.clone())
        });
        cx.spawn(async move |this, cx| {
            let response = cx
                .update(|cx| {
                    Tokio::spawn_result(cx, async move {
                        let overview = client.overview().await?;
                        let login = match login_id {
                            Some(id) => Some(client.login_status(&id).await?),
                            None => None,
                        };
                        Ok::<_, anyhow::Error>((overview, login))
                    })
                })
                .await;
            let _ = this.update(cx, |store, cx| {
                if store.signin_generation != session_generation {
                    return;
                }
                store.polling = false;
                if let Ok((overview, login)) = response {
                    if login.is_some() {
                        store.login = login;
                    }
                    store.apply_overview(overview, cx);
                    cx.emit(CloudEvent::Changed);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Follow one task: its feed loads now and refreshes with every poll.
    pub fn watch(&mut self, task: Option<String>, cx: &mut Context<Self>) {
        if self.watching == task {
            return;
        }
        self.watching = task.clone();
        if let Some(id) = task {
            self.details
                .entry(id.clone())
                .or_insert_with(|| TaskDetail {
                    loading: true,
                    ..Default::default()
                });
            self.fetch_detail(id, cx);
        }
        cx.notify();
    }

    fn fetch_detail(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let Some(task) = self.task(&id).cloned() else {
            return;
        };
        let op = Op::Task(id.clone(), "detail");
        if self.is_pending(&op) {
            return;
        }
        // Results are immutable per revision; only fetch one we have not seen.
        let want_result = task.result.as_ref().map(|r| r.id.clone()).filter(|rid| {
            self.details
                .get(&id)
                .and_then(|d| d.result.as_ref())
                .and_then(|r| r.revision.as_ref())
                .is_none_or(|r| &r.id != rid)
        });
        let fetch_id = id.clone();
        let attempt = task
            .attempt
            .as_ref()
            .map(|attempt| (attempt.id.clone(), attempt.generation));
        self.run(
            op,
            async move {
                let feed = client.events(&fetch_id, 0).await?;
                let result = match want_result {
                    Some(_) => Some(client.result(&fetch_id).await?),
                    None => None,
                };
                Ok::<_, anyhow::Error>((feed, result))
            },
            move |store, response, _| {
                if store
                    .task(&id)
                    .and_then(|task| task.attempt.as_ref())
                    .map(|value| (value.id.clone(), value.generation))
                    != attempt
                {
                    return;
                }
                let detail = store.details.entry(id).or_default();
                detail.loading = false;
                match response {
                    Ok((feed, result)) => {
                        merge_detail_snapshot(detail, feed, result);
                    }
                    Err(error) => detail.error = Some(error.to_string()),
                }
            },
            cx,
        );
    }

    pub fn load_available(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        if self.is_pending(&Op::Repositories) {
            return;
        }
        self.run(
            Op::Repositories,
            async move { Ok(client.repositories().await?) },
            |store, response, _| match response {
                Ok(repos) => {
                    let configured: HashSet<String> =
                        store.repositories().iter().map(|r| r.id.clone()).collect();
                    store.available = Some(
                        repos
                            .into_iter()
                            .filter(|r| !configured.contains(&r.id))
                            .collect(),
                    );
                }
                Err(error) => store.error = Some(error.to_string()),
            },
            cx,
        );
    }

    pub fn save_repository(&mut self, repository: CloudRepository, cx: &mut Context<Self>) {
        let id = repository.id.clone();
        self.command(
            Op::SaveRepository(id.clone()),
            CloudCommand::RepositorySave {
                idempotency_key: key(),
                repository,
            },
            move |store, _| {
                if let Some(available) = &mut store.available {
                    available.retain(|r| r.id != id);
                }
                None
            },
            cx,
        );
    }

    pub fn create_workspace(
        &mut self,
        input: vitre_contracts::CloudStartConversationInput,
        cx: &mut Context<Self>,
    ) {
        self.dispatch_creation(input, false, cx);
    }
    pub fn retry_creation(
        &mut self,
        input: vitre_contracts::CloudStartConversationInput,
        cx: &mut Context<Self>,
    ) {
        self.dispatch_creation(input, true, cx);
    }
    fn dispatch_creation(
        &mut self,
        input: vitre_contracts::CloudStartConversationInput,
        reconcile: bool,
        cx: &mut Context<Self>,
    ) {
        if self.is_pending(&Op::CreateTask) {
            return;
        }
        let Some(client) = self.client.clone() else {
            return;
        };
        self.error = None;
        let request_key = input.idempotency_key.clone();
        self.creation_status = None;
        self.creation_key = Some(request_key.clone());
        self.creation_progress = Some("Preparing workspace…".into());
        let progress_client = client.clone();
        let completion_key = request_key.clone();
        let project_id = input.project_id.clone().unwrap_or_default();
        let session_generation = self.signin_generation;
        self.creation_outcomes.remove(&request_key);
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(500))
                    .await;
                if !this
                    .read_with(cx, |store, _| {
                        store.signin_generation == session_generation
                            && store.creation_key.as_ref() == Some(&request_key)
                    })
                    .unwrap_or(false)
                {
                    break;
                }
                let key = request_key.clone();
                let client = progress_client.clone();
                let result = cx
                    .update(|cx| {
                        Tokio::spawn_result(cx, async move {
                            Ok(client.start_progress(key, false).await?)
                        })
                    })
                    .await;
                let _ = this.update(cx, |store, cx| {
                    if store.signin_generation == session_generation
                        && store.creation_key.as_ref() == Some(&request_key)
                        && let Ok(progress) = result
                        && progress
                            .request_id
                            .as_deref()
                            .is_none_or(|id| id == request_key)
                        && store
                            .creation_status
                            .as_ref()
                            .and_then(|value| value.sequence)
                            .is_none_or(|sequence| {
                                progress
                                    .sequence
                                    .is_some_and(|incoming| incoming >= sequence)
                            })
                    {
                        store.creation_progress = Some(progress.message.0.clone());
                        store.creation_status = Some(progress);
                        cx.notify();
                    }
                });
            }
        })
        .detach();
        self.run(
            Op::CreateTask,
            async move {
                if reconcile {
                    client
                        .start_progress(input.idempotency_key.clone(), false)
                        .await?;
                }
                // The server first returns the retained result or the recorded
                // immutable create command, deduplicated by this same key.
                Ok(client.start_workspace(&input).await?)
            },
            move |store, response, cx| {
                store.creation_key = None;
                store.creation_progress = None;
                match response {
                    Ok(result) => {
                        store.apply_overview(result.overview, cx);
                        store.creation_outcomes.insert(
                            completion_key.clone(),
                            CreationResult {
                                project_id: project_id.clone(),
                                outcome: CreationOutcome::Accepted(result.entity_id),
                            },
                        );
                    }
                    Err(error) => {
                        let rejected = matches!(
                            error.downcast_ref::<vitre_rpc::RpcError>(),
                            Some(vitre_rpc::RpcError::CloudRequest { rejected: true, .. })
                        );
                        store.creation_outcomes.insert(
                            completion_key.clone(),
                            CreationResult {
                                project_id: project_id.clone(),
                                outcome: if rejected {
                                    CreationOutcome::Rejected(error.to_string())
                                } else {
                                    CreationOutcome::Unknown(error.to_string())
                                },
                            },
                        );
                    }
                }
            },
            cx,
        );
    }

    pub fn cancel_creation(&mut self, cx: &mut Context<Self>) {
        let (Some(client), Some(key)) = (self.client.clone(), self.creation_key.clone()) else {
            return;
        };
        self.creation_progress = Some("Cancelling upload…".into());
        cx.spawn(async move |_, cx| {
            let _ = cx
                .update(|cx| {
                    Tokio::spawn_result(
                        cx,
                        async move { Ok(client.start_progress(key, true).await?) },
                    )
                })
                .await;
        })
        .detach();
        cx.notify();
    }

    pub fn retry_task(&mut self, task: CloudTask, cx: &mut Context<Self>) {
        match retry_command(&task, key()) {
            Ok(command) => {
                self.command(Op::Task(task.id.clone(), "retry"), command, |_, _| None, cx)
            }
            Err(error) => {
                self.error = Some(format!("Cannot retry this task: {error}"));
                cx.notify();
            }
        }
    }

    pub fn cancel_task_request(
        &mut self,
        id: String,
        request_key: String,
        expected: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.is_pending(&Op::Task(id.clone(), "cancel")) {
            return;
        }
        if let Some(previous) = self.stop_requests.insert(id.clone(), request_key.clone()) {
            self.stop_outcomes.remove(&previous);
        }
        let Some(client) = self.client.clone() else {
            self.stop_outcomes.insert(
                request_key,
                DeliveryOutcome::Unknown("The local service is reconnecting.".into()),
            );
            cx.emit(CloudEvent::Changed);
            cx.notify();
            return;
        };
        let command = CloudCommand::TaskCancel {
            idempotency_key: request_key.clone(),
            task_id: id.clone(),
            expected_turn_request_id: Some(expected),
        };
        self.run(
            Op::Task(id.clone(), "cancel"),
            async move { Ok(client.command(&command).await?) },
            move |store, response, cx| {
                if store.stop_requests.get(&id) != Some(&request_key) {
                    return;
                }
                let outcome = match response {
                    Ok(result) => {
                        store.apply_overview(result.overview, cx);
                        DeliveryOutcome::Accepted
                    }
                    Err(error) => {
                        if matches!(
                            error.downcast_ref::<vitre_rpc::RpcError>(),
                            Some(vitre_rpc::RpcError::CloudRequest { rejected: true, .. })
                        ) {
                            DeliveryOutcome::Rejected(error.to_string())
                        } else {
                            DeliveryOutcome::Unknown(error.to_string())
                        }
                    }
                };
                store.stop_outcomes.insert(request_key, outcome);
            },
            cx,
        );
    }

    pub fn finish_stop(&mut self, task_id: &str, request_key: &str) {
        if self
            .stop_requests
            .get(task_id)
            .is_some_and(|key| key == request_key)
        {
            self.stop_requests.remove(task_id);
        }
        self.stop_outcomes.remove(request_key);
    }

    pub fn update_task(
        &mut self,
        id: String,
        title: Option<String>,
        archived: Option<bool>,
        cx: &mut Context<Self>,
    ) {
        self.command(
            Op::Task(id.clone(), "update"),
            CloudCommand::TaskUpdate {
                idempotency_key: key(),
                task_id: id,
                title,
                archived,
            },
            |_, _| None,
            cx,
        );
    }

    pub fn delete_task(&mut self, id: String, cx: &mut Context<Self>) {
        let removed = id.clone();
        self.command(
            Op::Task(id.clone(), "delete"),
            CloudCommand::TaskDelete {
                idempotency_key: key(),
                task_id: id,
            },
            move |store, _| {
                store.details.remove(&removed);
                if store.watching.as_deref() == Some(removed.as_str()) {
                    store.watching = None;
                }
                None
            },
            cx,
        );
    }

    pub fn continue_workspace(
        &mut self,
        input: vitre_contracts::CloudContinueConversationInput,
        cx: &mut Context<Self>,
    ) {
        self.dispatch_workspace(input, false, cx);
    }

    pub fn retry_workspace(
        &mut self,
        input: vitre_contracts::CloudContinueConversationInput,
        cx: &mut Context<Self>,
    ) {
        self.dispatch_workspace(input, true, cx);
    }

    pub fn finish_delivery(&mut self, request_key: &str) {
        self.delivery_requests.remove(request_key);
        self.delivery_outcomes.remove(request_key);
    }

    fn dispatch_workspace(
        &mut self,
        input: vitre_contracts::CloudContinueConversationInput,
        reconcile: bool,
        cx: &mut Context<Self>,
    ) {
        let request_key = input.idempotency_key.clone();
        let Some(client) = self.client.clone() else {
            self.delivery_outcomes.insert(
                request_key,
                DeliveryOutcome::Unknown("The local service is reconnecting.".into()),
            );
            cx.emit(CloudEvent::Changed);
            cx.notify();
            return;
        };
        let op = Op::Task(input.task_id.clone(), "continue");
        if self.is_pending(&op) {
            return;
        }
        self.delivery_outcomes.remove(&request_key);
        self.delivery_requests.insert(request_key.clone());
        self.run(
            op,
            async move {
                if reconcile {
                    let overview = client.overview().await?;
                    if continue_has_receipt(&overview, None, &input) {
                        return Ok(vitre_contracts::CloudStartConversationResult {
                            entity_id: input.task_id.clone(),
                            overview,
                        });
                    }
                    // A failed reconciliation is not permission to resend. Keep the
                    // immutable outbox and let the user check again after reconnect.
                    let feed = client.events(&input.task_id, 0).await?;
                    if continue_has_receipt(&overview, Some(&feed), &input) {
                        return Ok(vitre_contracts::CloudStartConversationResult {
                            entity_id: input.task_id.clone(),
                            overview,
                        });
                    }
                }
                Ok(client.continue_workspace(&input).await?)
            },
            move |store, response, cx| {
                if !store.delivery_requests.contains(&request_key) {
                    return;
                }
                match response {
                    Ok(result) => {
                        store
                            .delivery_outcomes
                            .insert(request_key, DeliveryOutcome::Accepted);
                        store.apply_overview(result.overview, cx);
                    }
                    Err(error) => {
                        let rejected = matches!(
                            error.downcast_ref::<vitre_rpc::RpcError>(),
                            Some(vitre_rpc::RpcError::CloudRequest { rejected: true, .. })
                        );
                        let outcome = if rejected {
                            DeliveryOutcome::Rejected(error.to_string())
                        } else {
                            DeliveryOutcome::Unknown(error.to_string())
                        };
                        store.delivery_outcomes.insert(request_key, outcome);
                    }
                }
            },
            cx,
        );
    }

    pub fn task_error(&self, task_id: &str) -> Option<&str> {
        self.operation_errors
            .iter()
            .find_map(|(op, error)| match op {
                Op::Task(id, action) if id == task_id && *action != "detail" => {
                    Some(error.as_str())
                }
                Op::Publish(id) | Op::Respond(id) if id == task_id => Some(error.as_str()),
                _ => None,
            })
    }

    pub(crate) fn apply_binding(
        &mut self,
        binding: vitre_contracts::CloudConversationBinding,
        revision: Option<i64>,
    ) -> bool {
        let current = self
            .binding_revisions
            .get(&binding.conversation_id)
            .copied()
            .max(
                self.overview
                    .as_ref()
                    .and_then(|overview| overview.revision),
            );
        if current.is_some_and(|current| revision.is_none_or(|incoming| incoming < current)) {
            return false;
        }
        if let Some(revision) = revision {
            self.binding_revisions
                .insert(binding.conversation_id.clone(), revision);
        }
        if let Some(overview) = self.overview.as_mut() {
            let bindings = overview.bindings.get_or_insert_with(Vec::new);
            bindings.retain(|entry| entry.conversation_id != binding.conversation_id);
            bindings.push(binding);
        }
        true
    }

    pub fn disconnect_provider(&mut self, provider: CloudProvider, cx: &mut Context<Self>) {
        self.command(
            Op::Provider(provider.clone()),
            CloudCommand::ProviderDisconnect {
                idempotency_key: key(),
                provider,
            },
            |_, _| None,
            cx,
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub fn publish(
        &mut self,
        task_id: String,
        result_id: String,
        result_sha256: String,
        kind: CloudCommandPublicationCreateKind,
        title: String,
        body: String,
        cx: &mut Context<Self>,
    ) {
        self.command(
            Op::Publish(task_id.clone()),
            CloudCommand::PublicationCreate {
                body,
                idempotency_key: key(),
                kind,
                result_id,
                result_sha256,
                task_id,
                title,
            },
            |_, _| None,
            cx,
        );
    }

    pub fn retry_publication(&mut self, task_id: String, id: String, cx: &mut Context<Self>) {
        self.command(
            Op::Publish(task_id),
            CloudCommand::PublicationRetry {
                idempotency_key: key(),
                publication_id: id,
            },
            |_, _| None,
            cx,
        );
    }

    pub fn update_limit(&mut self, micro_dollars: i64, cx: &mut Context<Self>) {
        self.command(
            Op::Limits,
            CloudCommand::LimitsUpdate {
                idempotency_key: key(),
                monthly_compute_micro_dollars: micro_dollars,
            },
            |_, _| None,
            cx,
        );
    }

    /// Codex signs in with a device code; the login record is polled until it
    /// completes and the overview then shows the account connected.
    pub fn start_codex_login(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let op = Op::Provider(CloudProvider::Codex);
        if self.is_pending(&op) {
            return;
        }
        self.run(
            op,
            async move {
                let started = client.start_login(&key()).await?;
                let id = started["id"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Codex login did not start"))?;
                Ok(client.login_status(id).await?)
            },
            |store, response, _| match response {
                Ok(login) => store.login = Some(login),
                Err(error) => store.error = Some(error.to_string()),
            },
            cx,
        );
    }

    pub fn dismiss_login(&mut self, cx: &mut Context<Self>) {
        self.login = None;
        cx.notify();
    }

    pub fn save_claude_credential(&mut self, credential: String, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let version = self
            .overview
            .as_ref()
            .and_then(|o| {
                o.accounts
                    .iter()
                    .find(|a| a.provider == CloudProvider::Claude)
                    .map(|a| a.credential_version.max(0) as u64)
            })
            .unwrap_or(0);
        self.run(
            Op::Provider(CloudProvider::Claude),
            async move {
                client
                    .save_credential("claude", &credential, version, &key())
                    .await?;
                Ok(client.overview().await?)
            },
            |store, response, cx| match response {
                Ok(overview) => store.apply_overview(overview, cx),
                Err(error) => store.error = Some(error.to_string()),
            },
            cx,
        );
    }

    pub fn respond_approval(
        &mut self,
        task_id: String,
        request_id: String,
        decision: ProviderApprovalDecision,
        cx: &mut Context<Self>,
    ) {
        let command = ClientOrchestrationCommand::ThreadApprovalRespond {
            command_id: CommandId(key()),
            created_at: TrimmedNonEmptyString(chrono::Utc::now().to_rfc3339()),
            decision,
            request_id: ApprovalRequestId(request_id.clone()),
            thread_id: crate::chat::cloud_thread::cloud_thread_id(&task_id),
            r#type: Default::default(),
        };
        self.respond(task_id, request_id, command, cx);
    }

    pub fn respond_user_input(
        &mut self,
        task_id: String,
        request_id: String,
        answers: ProviderUserInputAnswers,
        cx: &mut Context<Self>,
    ) {
        let command = ClientOrchestrationCommand::ThreadUserInputRespond {
            answers,
            command_id: CommandId(key()),
            created_at: TrimmedNonEmptyString(chrono::Utc::now().to_rfc3339()),
            request_id: ApprovalRequestId(request_id.clone()),
            thread_id: crate::chat::cloud_thread::cloud_thread_id(&task_id),
            r#type: Default::default(),
        };
        self.respond(task_id, request_id, command, cx);
    }

    fn respond(
        &mut self,
        task_id: String,
        request_id: String,
        command: ClientOrchestrationCommand,
        cx: &mut Context<Self>,
    ) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let watched = task_id.clone();
        let live = self.live_conversation(&task_id);
        self.run(
            Op::Respond(request_id),
            async move {
                if let Some(live) = live.filter(|live| live.client.sessions().borrow().is_some()) {
                    live.client.dispatch(&command).await.map_err(|error| {
                        anyhow::anyhow!("Cloud response failed: {}", error.user_message())
                    })?;
                } else {
                    client.respond(task_id, command).await?;
                }
                Ok(())
            },
            move |store, response, cx| match response {
                Ok(()) => store.fetch_detail(watched, cx),
                Err(error) => store.error = Some(error.to_string()),
            },
            cx,
        );
    }

    pub fn clear_error(&mut self, cx: &mut Context<Self>) {
        self.error = None;
        cx.notify();
    }

    fn command(
        &mut self,
        op: Op,
        command: CloudCommand,
        after: impl FnOnce(&mut Self, String) -> Option<CloudEvent> + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(client) = self.client.clone() else {
            self.error = Some("Waiting for the local account service.".into());
            cx.notify();
            return;
        };
        if self.is_pending(&op) {
            return;
        }
        self.error = None;
        self.run(
            op,
            async move { Ok(client.command(&command).await?) },
            move |store, response, cx| match response {
                Ok(result) => {
                    store.apply_overview(result.overview, cx);
                    if let Some(event) = after(store, result.entity_id) {
                        cx.emit(event);
                    }
                }
                Err(error) => store.error = Some(error.to_string()),
            },
            cx,
        );
    }

    fn finish_operation<T>(
        &mut self,
        op: Op,
        signin_generation: u64,
        response: anyhow::Result<T>,
        apply: impl FnOnce(&mut Self, anyhow::Result<T>, &mut Context<Self>),
        cx: &mut Context<Self>,
    ) {
        // Cancelled requests can finish after a retry has already started.
        if signin_generation != self.signin_generation {
            return;
        }
        self.pending.remove(&op);
        match &response {
            Ok(_) => {
                self.operation_errors.remove(&op);
            }
            Err(error) => {
                // Sends and Stops have request-scoped outcomes. A late transport
                // error must not resurrect an error after its receipt settled.
                if !matches!(&op, Op::CreateTask | Op::Task(_, "continue" | "cancel")) {
                    self.operation_errors.insert(op.clone(), error.to_string());
                }
            }
        }
        apply(self, response, cx);
        if self.session != SessionState::SignedIn {
            self.retire_live_conversations();
        }
        cx.emit(CloudEvent::Changed);
        cx.notify();
    }

    fn run<T: Send + 'static>(
        &mut self,
        op: Op,
        work: impl std::future::Future<Output = anyhow::Result<T>> + Send + 'static,
        apply: impl FnOnce(&mut Self, anyhow::Result<T>, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let signin_generation = self.signin_generation;
        self.operation_errors.remove(&op);
        self.pending.insert(op.clone());
        cx.notify();
        cx.spawn(async move |this, cx| {
            let response = cx.update(|cx| Tokio::spawn_result(cx, work)).await;
            let _ = this.update(cx, |store, cx| {
                store.finish_operation(op, signin_generation, response, apply, cx);
            });
        })
        .detach();
    }
}

/// `repository.save` payloads: the form edits three fields of an existing
/// record and must carry the server's revision for optimistic concurrency.
pub fn repository_with_setup(
    base: &CloudRepository,
    default_branch: String,
    setup_command: String,
    test_command: String,
) -> CloudRepository {
    CloudRepository {
        default_branch,
        setup_command,
        test_command,
        ..base.clone()
    }
}

/// Preserve portable workspace and provider metadata when retrying a failed start.
/// The wire task and creation command use separate generated Rust enums.
pub(super) fn retry_command(
    task: &CloudTask,
    idempotency_key: String,
) -> serde_json::Result<CloudCommand> {
    let mut payload = serde_json::to_value(task)?;
    let object = payload
        .as_object_mut()
        .expect("CloudTask serializes as an object");
    object.insert("type".into(), serde_json::json!("task.continue"));
    object.insert("idempotencyKey".into(), serde_json::json!(idempotency_key));
    object.insert("taskId".into(), serde_json::json!(task.id));
    serde_json::from_value(payload)
}

#[cfg(test)]
mod signin_tests {
    use super::*;
    use crate::cloud::tests::fixtures::{overview, repository, saved_result, task, thread};

    fn ready_task() -> CloudTask {
        let mut task = task("warm-task", CloudTaskState::Running, false);
        task.worker = Some(
            serde_json::from_value(serde_json::json!({
                "cpu": 2, "diskGiB": 10, "memoryGiB": 4,
                "environmentId": "environment", "id": "worker", "sandboxId": null,
                "state": "ready", "stoppedAt": null
            }))
            .unwrap(),
        );
        task
    }

    fn connection(task: &CloudTask) -> LiveConversation {
        let client = Arc::new(EnvironmentClient::start_remote(Box::new(|| {
            Box::pin(std::future::pending())
        })));
        let thread =
            Arc::new(client.open_thread(crate::chat::cloud_thread::cloud_thread_id(&task.id)));
        LiveConversation {
            identity: connection_identity(task).unwrap(),
            client,
            thread,
        }
    }

    #[gpui::test]
    fn warm_connection_survives_navigation_and_evicts_replaced_workers(
        cx: &mut gpui::TestAppContext,
    ) {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _runtime = runtime.enter();
        let store = cx.new(|cx| CloudStore::new(None, cx));
        store.update(cx, |store, cx| {
            let mut task = ready_task();
            store.apply_overview(overview(vec![repository()], vec![task.clone()]), cx);
            let connection = connection(&task);
            assert!(store.retain_live_conversation(task.id.clone(), connection.clone()));
            store.watch(Some(task.id.clone()), cx);
            store.watch(None, cx);
            store.apply_overview(overview(vec![repository()], vec![task.clone()]), cx);
            let retained = store.live_conversation(&task.id).unwrap();
            assert!(Arc::ptr_eq(&retained.client, &connection.client));
            assert!(Arc::ptr_eq(&retained.thread, &connection.thread));
            task.worker.as_mut().unwrap().environment_id = "replacement".into();
            store.apply_overview(overview(vec![repository()], vec![task.clone()]), cx);
            assert!(store.live_conversation(&task.id).is_none());
            assert!(store.live_conversations.is_empty());
            assert!(!store.retain_live_conversation(task.id.clone(), connection));
        });
    }

    #[gpui::test]
    fn stopped_deleted_and_signed_out_tasks_release_warm_connections(
        cx: &mut gpui::TestAppContext,
    ) {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _runtime = runtime.enter();
        let store = cx.new(|cx| CloudStore::new(None, cx));
        store.update(cx, |store, cx| {
            for replacement in [
                Some(CloudWorkerState::Stopped),
                Some(CloudWorkerState::Deleted),
                None,
            ] {
                let mut task = ready_task();
                store.apply_overview(overview(vec![repository()], vec![task.clone()]), cx);
                let retained_panel = connection(&task);
                let mut sessions = retained_panel.client.sessions();
                sessions.borrow_and_update();
                assert!(store.retain_live_conversation(task.id.clone(), retained_panel.clone()));
                let tasks = if let Some(state) = replacement {
                    task.worker.as_mut().unwrap().state = state;
                    vec![task]
                } else {
                    vec![]
                };
                store.apply_overview(overview(vec![repository()], tasks), cx);
                assert!(store.live_conversations.is_empty());
                assert!(sessions.has_changed().unwrap());
                assert!(sessions.borrow_and_update().is_none());
            }
            let task = ready_task();
            store.apply_overview(overview(vec![repository()], vec![task.clone()]), cx);
            assert!(store.retain_live_conversation(task.id.clone(), connection(&task)));
            store.finish_operation(
                Op::Session,
                0,
                Ok(()),
                |store, _, _| {
                    store.session = SessionState::SignedOut;
                },
                cx,
            );
            assert!(store.live_conversations.is_empty());
            assert!(!store.retain_live_conversation(task.id.clone(), connection(&task)));
        });
    }

    #[gpui::test]
    fn running_task_polls_until_idle_acknowledgement(cx: &mut gpui::TestAppContext) {
        let store = cx.new(|cx| CloudStore::new(None, cx));
        store.update(cx, |store, cx| {
            let mut task = ready_task();
            store.watching = Some(task.id.clone());
            store.apply_overview(overview(vec![repository()], vec![task.clone()]), cx);
            assert_eq!(store.poll_interval(), WARMING_POLL);
            task.idle = Some(true);
            store.apply_overview(overview(vec![repository()], vec![task]), cx);
            assert_eq!(store.poll_interval(), IDLE_POLL);
        });
    }

    #[gpui::test]
    fn cancelled_cloud_signin_cannot_overwrite_retry(cx: &mut gpui::TestAppContext) {
        let store = cx.new(|cx| CloudStore::new(None, cx));
        store.update(cx, |store, cx| {
            store.session = SessionState::SigningIn;
            store.signin_generation = 2;
            store.pending.insert(Op::SignIn);
            for old_response in [Ok(()), Err(anyhow::anyhow!("cancelled"))] {
                store.finish_operation(
                    Op::SignIn,
                    1,
                    old_response,
                    |store, _, _| {
                        store.session = SessionState::SignedOut;
                        store.error = Some("stale response".into());
                    },
                    cx,
                );
                assert_eq!(store.session, SessionState::SigningIn);
                assert!(store.pending.contains(&Op::SignIn));
                assert!(store.error.is_none());
            }
            store.finish_operation(
                Op::SignIn,
                2,
                Ok(()),
                |store, _, _| {
                    store.session = SessionState::SignedIn;
                },
                cx,
            );
            assert_eq!(store.session, SessionState::SignedIn);
            assert!(!store.pending.contains(&Op::SignIn));
        });
    }
    #[gpui::test]
    fn older_overview_cannot_evict_a_newer_connection(cx: &mut gpui::TestAppContext) {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _runtime = runtime.enter();
        let store = cx.new(|cx| CloudStore::new(None, cx));
        store.update(cx, |store, cx| {
            let task = ready_task();
            let mut latest = overview(vec![repository()], vec![task.clone()]);
            latest.revision = Some(11);
            store.apply_overview(latest, cx);
            let connection = connection(&task);
            store.retain_live_conversation(task.id.clone(), connection.clone());
            let mut stale = overview(vec![], vec![]);
            stale.revision = Some(10);
            store.apply_overview(stale, cx);
            assert_eq!(store.overview.as_ref().unwrap().revision, Some(11));
            assert!(Arc::ptr_eq(
                &store.live_conversation(&task.id).unwrap().client,
                &connection.client
            ));
            store.apply_overview(overview(vec![], vec![]), cx);
            assert!(
                store.task(&task.id).is_some(),
                "unversioned snapshots cannot replace versioned state"
            );
        });
    }

    #[gpui::test]
    fn newer_binding_revision_fences_the_entire_account_snapshot(cx: &mut gpui::TestAppContext) {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _runtime = runtime.enter();
        let store = cx.new(|cx| CloudStore::new(None, cx));
        store.update(cx, |store, cx| {
            let task = ready_task();
            let mut latest = overview(vec![repository()], vec![task.clone()]);
            latest.revision = Some(10);
            store.apply_overview(latest, cx);
            let retained = connection(&task);
            store.retain_live_conversation(task.id.clone(), retained.clone());
            let binding = serde_json::from_value(serde_json::json!({
                "conversationId": "conversation", "localThreadId": "local-thread",
                "cloudTaskId": task.id, "target": "cloud-local", "generation": 1,
                "leaseOwner": null, "leaseExpiresAt": null
            }))
            .unwrap();
            assert!(store.apply_binding(binding, Some(12)));
            let mut stale = overview(vec![], vec![]);
            stale.revision = Some(11);
            store.apply_overview(stale, cx);
            assert!(store.task(&task.id).is_some());
            assert!(Arc::ptr_eq(
                &store.live_conversation(&task.id).unwrap().client,
                &retained.client
            ));
            assert_eq!(
                store.overview.as_ref().unwrap().bindings.as_ref().unwrap()[0].generation,
                1
            );
        });
    }

    #[test]
    fn creation_account_identity_uses_subject_and_relay_not_rotating_token() {
        use base64::Engine as _;
        let session = |sub: &str, expiry: i64| {
            serde_json::from_value(serde_json::json!({
            "accessToken": format!("header.{}.signature", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({"sub":sub,"exp":expiry})).unwrap())),
            "enabled": true, "expiresAtEpochMs": null, "relayUrl": "https://cloud.example.test"
        })).unwrap()
        };
        assert_eq!(
            session_identity(&session("account-a", 1)),
            session_identity(&session("account-a", 2))
        );
        assert_ne!(
            session_identity(&session("account-a", 1)),
            session_identity(&session("account-b", 1))
        );
    }

    #[test]
    fn retry_receipt_requires_the_same_request_or_authoritative_message() {
        let input = vitre_contracts::CloudContinueConversationInput {
            idempotency_key: "send-1".into(),
            task_id: "task-1".into(),
            prompt: "same prompt".into(),
            attachments: vec![],
        };
        let mut task = task("task-1", CloudTaskState::Running, false);
        let mut account = overview(vec![], vec![task.clone()]);
        assert!(!continue_has_receipt(&account, None, &input));
        task.turn_request_id = Some("send-1".into());
        account.tasks = vec![task];
        assert!(continue_has_receipt(&account, None, &input));
        account.tasks[0].turn_request_id = Some("newer-request".into());
        let mut history = thread();
        history.messages[0].role = vitre_contracts::OrchestrationMessageRole::User;
        history.messages[0].id = vitre_contracts::MessageId("send-1-message".into());
        history.messages[0].text = vitre_contracts::TrimmedNonEmptyString("same prompt".into());
        let feed = |history: &OrchestrationThread| {
            serde_json::from_value(serde_json::json!({
                "conversation": history, "cursor": 2, "events": [], "reset": false
            }))
            .unwrap()
        };
        assert!(continue_has_receipt(
            &account,
            Some(&feed(&history)),
            &input
        ));
        history.messages[0].id = vitre_contracts::MessageId("other-message".into());
        assert!(!continue_has_receipt(
            &account,
            Some(&feed(&history)),
            &input
        ));
        history.messages[0].id = vitre_contracts::MessageId("send-1-message".into());
        history.messages[0].text =
            vitre_contracts::TrimmedNonEmptyString("different payload".into());
        assert!(!continue_has_receipt(
            &account,
            Some(&feed(&history)),
            &input
        ));
    }

    #[gpui::test]
    fn late_send_and_stop_errors_stay_scoped_to_their_request(cx: &mut gpui::TestAppContext) {
        let store = cx.new(|cx| CloudStore::new(None, cx));
        store.update(cx, |store, cx| {
            store.session = SessionState::SignedIn;
            for action in ["continue", "cancel"] {
                let operation = Op::Task("task-1".into(), action);
                store.finish_operation::<()>(
                    operation.clone(),
                    0,
                    Err(anyhow::anyhow!("late response after confirmed receipt")),
                    |_, _, _| {},
                    cx,
                );
                assert!(!store.operation_errors.contains_key(&operation));
            }
            assert!(store.task_error("task-1").is_none());
        });
    }

    #[gpui::test]
    fn new_account_session_resets_its_revision_watermark(cx: &mut gpui::TestAppContext) {
        let store = cx.new(|cx| CloudStore::new(None, cx));
        store.update(cx, |store, cx| {
            let mut previous = overview(vec![repository()], vec![ready_task()]);
            previous.revision = Some(100);
            store.apply_overview(previous, cx);
            store
                .binding_revisions
                .insert("old-conversation".into(), 101);
            store.begin_account_session();
            assert!(store.overview.is_none());
            let mut fresh = overview(vec![], vec![]);
            fresh.revision = Some(1);
            store.apply_overview(fresh, cx);
            assert_eq!(store.overview.as_ref().unwrap().revision, Some(1));
            assert!(store.binding_revisions.is_empty());
        });
    }

    #[gpui::test]
    fn old_account_response_cannot_apply_after_session_change(cx: &mut gpui::TestAppContext) {
        let store = cx.new(|cx| CloudStore::new(None, cx));
        store.update(cx, |store, cx| {
            store.signin_generation = 3;
            store.finish_operation(
                Op::Overview,
                2,
                Ok(()),
                |_, _, _| panic!("stale account response applied"),
                cx,
            );
            assert!(store.overview.is_none());
        });
    }

    #[test]
    fn saved_result_never_replaces_fresher_feed_history() {
        let mut latest = thread();
        latest.messages[0].text = vitre_contracts::TrimmedNonEmptyString("latest message".into());
        let mut detail = TaskDetail::default();
        merge_detail_snapshot(
            &mut detail,
            serde_json::from_value(serde_json::json!({
                "conversation": latest, "cursor": 10, "events": [], "reset": false
            }))
            .unwrap(),
            Some(saved_result()),
        );
        assert_eq!(
            detail.conversation.as_ref().unwrap().messages[0].text.0,
            "latest message"
        );
        merge_detail_snapshot(
            &mut detail,
            serde_json::from_value(serde_json::json!({
                "conversation": null, "cursor": 10, "events": [], "reset": false
            }))
            .unwrap(),
            None,
        );
        // Missing feed must keep the latest known transcript, not roll back to a checkpoint.
        assert_eq!(
            detail.conversation.as_ref().unwrap().messages[0].text.0,
            "latest message"
        );
    }
}
