//! Conversation presentation is derived from facts, never from animation or log copy.
use super::*;
use std::borrow::Cow;
use std::time::Instant;
use vitre_contracts::{CloudHandoffPhase, CloudTaskState};
use vitre_state::sidebar::ThreadStatus;

pub(super) const STATUS_HEIGHT: f32 = 28.;
pub(super) const FADE: Duration = Duration::from_millis(120);
pub(super) const BUSY_DELAY: Duration = Duration::from_millis(150);

pub(super) struct LocalStop {
    pub turn_id: vitre_contracts::TurnId,
    pub command_id: CommandId,
    pub acknowledged: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Connection {
    #[default]
    Dormant,
    Connecting,
    Synchronizing,
    Live,
    Disconnected,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Transcript {
    #[default]
    Empty,
    Cached,
    Current,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Delivery {
    #[default]
    None,
    Submitting,
    Accepted,
    Uncertain,
    Rejected,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Turn {
    #[default]
    Idle,
    Preparing,
    Working,
    Approval,
    Input,
    Stopping,
    Finished,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) enum Transfer {
    #[default]
    None,
    Moving(String),
    Cancelling,
    WaitingForTurn,
    Conflict,
    Recovering,
    Failed,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Attention {
    #[default]
    None,
    Error,
    Auth,
    Limit,
    Interrupted,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Art {
    #[default]
    None,
    Connecting,
    Working,
    Approval,
    Input,
    Warning,
    Error,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Action {
    #[default]
    None,
    Retry,
    CheckDelivery,
    Reconnect,
    RetryConnection,
    Account,
    Conflicts,
    RetryTransfer,
    CancelCreation,
}

impl Action {
    fn label(self, cloud: bool) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Retry if cloud => Some("Retry request"),
            Self::Retry => Some("Dismiss"),
            Self::RetryTransfer => Some("Retry"),
            Self::CheckDelivery => Some("Check delivery"),
            Self::Reconnect | Self::RetryConnection => Some("Reconnect"),
            Self::Account => Some("Account"),
            Self::Conflicts => Some("Resolve"),
            Self::CancelCreation => Some("Cancel"),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct Facts {
    pub identity: String,
    pub connection: Connection,
    pub transcript: Transcript,
    pub delivery: Delivery,
    pub turn: Turn,
    pub transfer: Transfer,
    pub attention: Attention,
    pub detail: Option<String>,
    pub preparation: Option<String>,
    pub started_at: Option<String>,
    pub can_cancel_transfer: bool,
    pub execution_available: bool,
    pub supports_steering: bool,
    pub execution_invalidated: bool,
    pub execution_stale: bool,
    pub cancellable_preparation: bool,
    pub ownership_fenced: bool,
    pub stop_error: bool,
    pub editable_after_error: bool,
}
#[derive(Clone, Debug, Default)]
pub(super) struct ConversationStatus {
    pub facts: Facts,
    pub label: String,
    pub art: Art,
    pub action: Action,
    pub can_send: bool,
    pub can_stop: bool,
    pub can_respond: bool,
    pub show_requests: bool,
}
impl ConversationStatus {
    pub(super) fn derive(facts: Facts) -> Self {
        let (mut label, mut art, mut action) = match &facts.transfer {
            Transfer::Conflict => (
                "Resolve file conflicts".into(),
                Art::Warning,
                Action::Conflicts,
            ),
            Transfer::Failed => (
                "Could not move this conversation".into(),
                Art::Error,
                Action::RetryTransfer,
            ),
            Transfer::Recovering => (
                "Confirming where this conversation runs…".into(),
                Art::Warning,
                Action::None,
            ),
            Transfer::Cancelling => ("Cancelling move…".into(), Art::Connecting, Action::None),
            Transfer::WaitingForTurn => (
                "Waiting for the current turn before moving…".into(),
                Art::Connecting,
                Action::None,
            ),
            Transfer::Moving(destination) => (
                format!("Moving to {destination}…"),
                Art::Connecting,
                Action::None,
            ),
            Transfer::None if facts.delivery == Delivery::Uncertain => (
                "Checking whether your message was received…".into(),
                Art::Warning,
                Action::CheckDelivery,
            ),
            Transfer::None if facts.delivery == Delivery::Rejected => (
                facts
                    .detail
                    .clone()
                    .unwrap_or_else(|| "Message was not sent".into()),
                Art::Error,
                Action::None,
            ),
            Transfer::None if facts.stop_error => (
                "Stop not confirmed".into(),
                Art::Warning,
                Action::RetryConnection,
            ),
            Transfer::None => match facts.attention {
                Attention::Auth => (
                    "Reconnect your provider to continue".into(),
                    Art::Warning,
                    Action::Reconnect,
                ),
                Attention::Limit => (
                    "Provider usage limit reached".into(),
                    Art::Warning,
                    Action::Account,
                ),
                Attention::Interrupted => (
                    "Conversation interrupted".into(),
                    Art::Warning,
                    Action::Retry,
                ),
                Attention::Error => (
                    facts
                        .detail
                        .clone()
                        .unwrap_or_else(|| "Conversation needs attention".into()),
                    Art::Error,
                    Action::Retry,
                ),
                Attention::None => match facts.turn {
                    Turn::Stopping => ("Stopping…".into(), Art::Connecting, Action::None),
                    Turn::Approval => ("Approval required".into(), Art::Approval, Action::None),
                    Turn::Input => ("Waiting for your answer".into(), Art::Input, Action::None),
                    Turn::Preparing => (
                        facts
                            .preparation
                            .clone()
                            .unwrap_or_else(|| "Preparing cloud workspace…".into()),
                        Art::Connecting,
                        Action::None,
                    ),
                    Turn::Idle | Turn::Finished if facts.delivery == Delivery::Accepted => (
                        "Starting your request…".into(),
                        Art::Connecting,
                        Action::None,
                    ),
                    _ if facts.delivery == Delivery::Submitting => {
                        ("Sending message…".into(), Art::Connecting, Action::None)
                    }
                    _ => match facts.connection {
                        Connection::Connecting => {
                            ("Connecting…".into(), Art::Connecting, Action::None)
                        }
                        Connection::Synchronizing => (
                            "Synchronizing conversation…".into(),
                            Art::Connecting,
                            Action::None,
                        ),
                        Connection::Disconnected => (
                            "Connection lost · reconnecting…".into(),
                            Art::Warning,
                            Action::RetryConnection,
                        ),
                        _ if facts.turn == Turn::Working => {
                            ("Working on your request".into(), Art::Working, Action::None)
                        }
                        _ => (String::new(), Art::None, Action::None),
                    },
                },
            },
        };
        if facts.transfer == Transfer::None
            && facts.attention == Attention::None
            && !facts.stop_error
            && !matches!(facts.delivery, Delivery::Uncertain | Delivery::Rejected)
            && matches!(
                facts.connection,
                Connection::Disconnected | Connection::Synchronizing
            )
        {
            let disconnected = facts.connection == Connection::Disconnected;
            let connection = if disconnected {
                "Connection lost"
            } else {
                "Synchronizing"
            };
            (label, art) = match facts.turn {
                Turn::Approval => (format!("{connection} · approval is waiting"), Art::Approval),
                Turn::Input => (format!("{connection} · your answer is waiting"), Art::Input),
                Turn::Stopping => (
                    format!(
                        "Stopping… · {}",
                        if disconnected {
                            "connection lost"
                        } else {
                            "synchronizing"
                        }
                    ),
                    if disconnected {
                        Art::Warning
                    } else {
                        Art::Connecting
                    },
                ),
                _ if facts.delivery == Delivery::Accepted => (
                    format!(
                        "Request accepted · {}",
                        if disconnected {
                            "reconnecting…"
                        } else {
                            "synchronizing…"
                        }
                    ),
                    if disconnected {
                        Art::Warning
                    } else {
                        Art::Connecting
                    },
                ),
                _ => (
                    if disconnected {
                        "Connection lost · reconnecting…"
                    } else {
                        "Synchronizing conversation…"
                    }
                    .into(),
                    if disconnected {
                        Art::Warning
                    } else {
                        Art::Connecting
                    },
                ),
            };
            action = if disconnected {
                Action::RetryConnection
            } else {
                Action::None
            };
        }
        let can_send = facts.transfer == Transfer::None
            && !facts.ownership_fenced
            && (facts.attention == Attention::None
                || (facts.editable_after_error && facts.attention == Attention::Error))
            && matches!(facts.delivery, Delivery::None | Delivery::Rejected)
            && (matches!(facts.turn, Turn::Idle | Turn::Finished)
                || (facts.turn == Turn::Working
                    && facts.supports_steering
                    && facts.execution_available
                    && !facts.execution_stale
                    && !facts.execution_invalidated))
            && (facts.execution_available || facts.connection == Connection::Dormant);
        let execution_interrupted = facts.execution_invalidated
            || matches!(
                facts.attention,
                Attention::Interrupted | Attention::Auth | Attention::Limit
            );
        let can_stop = !execution_interrupted
            && !facts.ownership_fenced
            && (facts.execution_available || facts.cancellable_preparation)
            && matches!(
                facts.turn,
                Turn::Working | Turn::Approval | Turn::Input | Turn::Preparing
            )
            && facts.delivery != Delivery::Uncertain;
        let can_respond = !execution_interrupted
            && !facts.execution_stale
            && facts.execution_available
            && !facts.ownership_fenced
            && matches!(facts.turn, Turn::Approval | Turn::Input);
        let show_requests = !execution_interrupted
            && !facts.execution_stale
            && matches!(facts.turn, Turn::Approval | Turn::Input);
        Self {
            facts,
            label,
            art,
            action,
            can_send,
            can_stop,
            can_respond,
            show_requests,
        }
    }
    pub(super) fn busy(&self) -> bool {
        matches!(self.art, Art::Connecting | Art::Working)
    }
    pub(super) fn sidebar(&self) -> Option<ThreadStatus> {
        match self.art {
            Art::Approval => Some(ThreadStatus::PendingApproval),
            Art::Input => Some(ThreadStatus::AwaitingInput),
            Art::Warning | Art::Error => Some(ThreadStatus::NeedsAttention),
            Art::Working => Some(ThreadStatus::Working),
            Art::Connecting => Some(ThreadStatus::Connecting),
            Art::None => None,
        }
    }
}

#[derive(Default)]
pub(super) struct StatusMotion {
    key: Option<String>,
    busy_since: Option<Instant>,
}
impl StatusMotion {
    fn update(&mut self, key: &str, busy: bool, visible: bool, now: Instant) -> bool {
        if !visible || !busy {
            self.key = None;
            self.busy_since = None;
            return false;
        }
        if self.key.as_deref() != Some(key) {
            self.key = Some(key.into());
            self.busy_since = Some(now);
            return true;
        }
        false
    }
    fn ready(&self, now: Instant, reduced: bool) -> bool {
        !reduced
            && self
                .busy_since
                .is_some_and(|since| now.saturating_duration_since(since) >= BUSY_DELAY)
    }
}

pub(super) fn infrastructure_activity(kind: &str) -> bool {
    matches!(kind, "thread.execution.changed" | "thread.history.imported")
}
fn active_turn(view: &vitre_contracts::OrchestrationThread) -> bool {
    view.latest_turn.as_ref().is_some_and(|turn| {
        turn.state == OrchestrationLatestTurnState::Running
            && view
                .session
                .as_ref()
                .is_some_and(|session| session.active_turn_id.as_ref() == Some(&turn.turn_id))
    })
}
fn execution_turn(view: &vitre_contracts::OrchestrationThread) -> Option<Turn> {
    view.latest_turn
        .as_ref()
        .filter(|turn| turn.state == OrchestrationLatestTurnState::Running)
        .map(|_| {
            if active_turn(view) {
                Turn::Working
            } else {
                Turn::Preparing
            }
        })
}
fn phase_connection(phase: SyncPhase) -> Connection {
    match phase {
        SyncPhase::Live => Connection::Live,
        SyncPhase::Synchronizing => Connection::Synchronizing,
        SyncPhase::Disconnected => Connection::Disconnected,
    }
}
fn cloud_connection(
    phase: SyncPhase,
    source: cloud_thread::CloudSource,
    connecting: bool,
    dormant: bool,
) -> Connection {
    match phase {
        SyncPhase::Live => Connection::Live,
        SyncPhase::Synchronizing => Connection::Synchronizing,
        SyncPhase::Disconnected if source == cloud_thread::CloudSource::Live => {
            Connection::Disconnected
        }
        SyncPhase::Disconnected if connecting => Connection::Connecting,
        SyncPhase::Disconnected if dormant => Connection::Dormant,
        SyncPhase::Disconnected => Connection::Disconnected,
    }
}
fn task_attention(state: &CloudTaskState) -> Attention {
    match state {
        CloudTaskState::NeedsAuth => Attention::Auth,
        CloudTaskState::UsageLimited => Attention::Limit,
        CloudTaskState::Failed => Attention::Error,
        CloudTaskState::Interrupted => Attention::Interrupted,
        _ => Attention::None,
    }
}
fn task_execution_invalidated(state: &CloudTaskState) -> bool {
    matches!(
        state,
        CloudTaskState::Failed
            | CloudTaskState::Interrupted
            | CloudTaskState::NeedsAuth
            | CloudTaskState::UsageLimited
    )
}

fn task_preparation_label(task: &vitre_contracts::CloudTask) -> Option<&'static str> {
    if task.state == CloudTaskState::Queued {
        return Some("Waiting for a cloud computer…");
    }
    let preparation = task
        .preparation
        .as_ref()
        .filter(|p| task.attempt.as_ref().is_some_and(|a| a.id == p.attempt_id))?;
    use vitre_contracts::CloudTaskPreparationPhase as P;
    Some(match preparation.phase {
        P::Restoring => "Restoring workspace…",
        P::Cloning => "Cloning repository…",
        P::Dependencies => "Installing dependencies…",
        P::Backend => "Starting conversation service…",
        P::Provider => "Connecting provider…",
        P::Ready => "Connecting…",
        P::Failed => "Workspace preparation failed",
        P::Unknown(_) => "Preparing cloud workspace…",
    })
}

fn cloud_execution_is_current(
    task: &vitre_contracts::CloudTask,
    view: &OrchestrationThread,
) -> bool {
    if task_is_idle_restore(task, Some(view)) {
        return true;
    }
    // Older workers without a request identity keep their existing behavior.
    let Some(request) = task.turn_request_id.as_ref() else {
        return true;
    };
    let Some(message) = view.messages.iter().find(|message| {
        message.role == OrchestrationMessageRole::User
            && message.id.0 == format!("{request}-message")
    }) else {
        return false;
    };
    view.latest_turn.as_ref().is_some_and(|latest| {
        message.turn_id.as_ref() == Some(&latest.turn_id)
            || chrono::DateTime::parse_from_rfc3339(&latest.requested_at.0)
                .ok()
                .zip(chrono::DateTime::parse_from_rfc3339(&message.created_at.0).ok())
                .is_some_and(|(requested, created)| requested >= created)
    })
}

fn task_is_idle_restore(
    task: &vitre_contracts::CloudTask,
    view: Option<&OrchestrationThread>,
) -> bool {
    task.state == CloudTaskState::Running
        && task.idle == Some(true)
        && (task.wake_only == Some(true) || task.handoff.is_some())
        && view
            .and_then(|view| view.latest_turn.as_ref())
            .is_none_or(|turn| turn.state != OrchestrationLatestTurnState::Running)
}

pub(super) fn current_request_activities(
    view: &OrchestrationThread,
) -> Cow<'_, [vitre_contracts::OrchestrationThreadActivity]> {
    let Some(latest) = view.latest_turn.as_ref() else {
        return Cow::Borrowed(&view.activities);
    };
    let requested_at = chrono::DateTime::parse_from_rfc3339(&latest.requested_at.0).ok();
    Cow::Owned(
        view.activities
            .iter()
            .filter(|activity| {
                activity.kind.0 == "thread.history.imported"
                    || match activity.turn_id.as_ref() {
                        Some(turn) => turn == &latest.turn_id,
                        None => requested_at.is_some_and(|requested| {
                            chrono::DateTime::parse_from_rfc3339(&activity.created_at.0)
                                .is_ok_and(|created| created >= requested)
                        }),
                    }
            })
            .cloned()
            .collect(),
    )
}
fn task_turn(task: &vitre_contracts::CloudTask) -> Turn {
    if task.idle == Some(true)
        && !matches!(
            task.state,
            CloudTaskState::Queued | CloudTaskState::Preparing
        )
    {
        return Turn::Finished;
    }
    match task.state {
        CloudTaskState::Queued | CloudTaskState::Preparing => Turn::Preparing,
        CloudTaskState::Running => Turn::Working,
        CloudTaskState::WaitingForInput => Turn::Input,
        CloudTaskState::Completed | CloudTaskState::Cancelled => Turn::Finished,
        _ => Turn::Idle,
    }
}

fn transfer_state(operation: &vitre_contracts::CloudHandoffOperation, conflicts: bool) -> Transfer {
    use vitre_contracts::{
        CloudHandoffOperationErrorDisposition as E, CloudHandoffOperationWaitReason as W,
    };
    if matches!(
        operation.phase,
        CloudHandoffPhase::Completed | CloudHandoffPhase::Cancelled
    ) {
        return Transfer::None;
    }
    if operation.phase == CloudHandoffPhase::Failed {
        return if matches!(
            operation.error_disposition,
            Some(E::Terminal | E::Retryable)
        ) {
            Transfer::Failed
        } else {
            Transfer::Recovering
        };
    }
    if operation.cancel_requested == Some(true) {
        return Transfer::Cancelling;
    }
    if conflicts || operation.wait_reason == Some(W::Conflict) {
        return Transfer::Conflict;
    }
    if operation.wait_reason == Some(W::ActiveTurn) {
        return Transfer::WaitingForTurn;
    }
    if operation.wait_reason == Some(W::OwnershipConfirmation) {
        return Transfer::Recovering;
    }
    if operation.error.is_some()
        && matches!(
            operation.error_disposition,
            Some(E::Terminal | E::Retryable)
        )
        && !matches!(
            operation.phase,
            CloudHandoffPhase::Activating | CloudHandoffPhase::Releasing
        )
    {
        return Transfer::Failed;
    }
    Transfer::Moving(
        match operation.to {
            vitre_contracts::CloudExecutionTarget::Local => "Local",
            vitre_contracts::CloudExecutionTarget::CloudGithub => "Cloud: GitHub",
            _ => "Cloud: Local",
        }
        .into(),
    )
}
fn transfer_can_cancel(operation: &vitre_contracts::CloudHandoffOperation) -> bool {
    let synthetic = operation.revision.is_none()
        && operation.wait_reason
            == Some(vitre_contracts::CloudHandoffOperationWaitReason::OwnershipConfirmation);
    !synthetic
        && operation.cancel_requested != Some(true)
        && !matches!(
            operation.phase,
            CloudHandoffPhase::Completed
                | CloudHandoffPhase::Cancelled
                | CloudHandoffPhase::Failed
                | CloudHandoffPhase::Activating
                | CloudHandoffPhase::Releasing
        )
}

fn dependency_detail(
    task: Option<&vitre_contracts::CloudTask>,
    events: &[vitre_contracts::CloudTaskEvent],
) -> Option<(String, bool)> {
    if let Some(setup) = task.and_then(|task| task.dependency_setup.as_ref()) {
        use vitre_contracts::CloudTaskDependencySetupOutcome as O;
        let label = match setup.outcome {
            O::Running => "running",
            O::Succeeded => "succeeded",
            O::Reused => "reused",
            O::Unnecessary => "not required",
            O::Failed => "failed",
            O::Unknown(_) => "unknown",
        };
        return Some((
            format!(
                "Dependency setup: {label}{}",
                setup
                    .detail
                    .as_ref()
                    .map(|detail| format!(" · {detail}"))
                    .unwrap_or_default()
            ),
            setup.outcome == O::Failed,
        ));
    }
    // Compatibility for workers predating structured setup outcomes. Only disclosure uses legacy copy.
    events
        .iter()
        .rev()
        .find(|event| {
            event.phase.0 == "task.warning"
                || event
                    .detail
                    .0
                    .starts_with("Dependency setup needs attention:")
        })
        .map(|event| (event.detail.0.clone(), true))
}

fn status_frame() -> gpui::Stateful<gpui::Div> {
    h_flex()
        .id("conversation-status")
        .debug_selector(|| "conversation-status".into())
        .w_full()
        .max_w(px(768.))
        .mx_auto()
        .px_3()
        .h(px(STATUS_HEIGHT))
        .flex_shrink_0()
        .gap_2()
}
fn status_opacity(
    identity: &str,
    channel: &'static str,
    target: f32,
    visible: bool,
    window: &mut Window,
    cx: &mut gpui::App,
) -> f32 {
    gpui_base::motion::transition(
        (SharedString::from(identity.to_string()), channel),
        target,
        gpui_base::motion::Transition::new(if visible { FADE } else { Duration::ZERO }),
        window,
        cx,
    )
}

fn status_elapsed(started_at: &str, now: chrono::DateTime<chrono::Utc>) -> Option<String> {
    let started_at = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    let seconds = now.signed_duration_since(started_at).num_seconds().max(0);
    Some(if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    })
}

fn creation_status(
    progress: Option<&vitre_contracts::CloudStartProgress>,
    active: bool,
    identity: &str,
) -> ConversationStatus {
    use vitre_contracts::CloudStartProgressPhase as P;
    let mut status = ConversationStatus::derive(Facts {
        identity: format!("draft:{identity}"),
        ..Facts::default()
    });
    if !active
        && progress.is_none_or(|progress| !matches!(progress.phase, Some(P::Failed | P::Cancelled)))
    {
        return status;
    }
    let phase = progress.and_then(|progress| progress.phase.as_ref());
    let (label, busy) = match phase {
        Some(P::Collection) => ("Collecting workspace files…", true),
        Some(P::Upload) => ("Uploading workspace…", true),
        Some(P::Creation) => ("Creating cloud conversation…", true),
        Some(P::Cancelling) => ("Cancelling workspace upload…", true),
        Some(P::Cancelled) => ("Workspace upload cancelled", false),
        Some(P::Completed) => ("Opening cloud conversation…", false),
        Some(P::Failed) => ("Could not create cloud conversation", false),
        _ if active => ("Checking workspace creation…", false),
        _ => ("", false),
    };
    status.label = label.into();
    status.art = if busy {
        Art::Connecting
    } else if phase == Some(&P::Failed) {
        Art::Error
    } else if active {
        Art::Warning
    } else {
        Art::None
    };
    status.facts.started_at = progress.and_then(|progress| progress.started_at.clone());
    status.facts.turn = if busy { Turn::Preparing } else { Turn::Idle };
    if matches!(phase, Some(P::Collection | P::Upload | P::Creation)) {
        status.action = Action::CancelCreation;
    }
    if let Some(progress) = progress.filter(|progress| progress.phase == Some(P::Upload))
        && let (Some(completed), Some(total)) = (progress.completed_bytes, progress.total_bytes)
        && total > 0
        && completed >= 0
        && completed <= total
    {
        status.label = format!(
            "Uploading workspace… {}%",
            completed.saturating_mul(100) / total
        );
    }
    status
}

impl ChatApp {
    pub(super) fn conversation_status(&self, cx: &gpui::App) -> ConversationStatus {
        let Some(open) = self.thread.as_ref() else {
            return self.draft_conversation_status(cx);
        };
        let view = open.state.view.as_deref();
        let task = self.cloud_task(cx);
        let idle_restore = task
            .as_ref()
            .is_some_and(|task| task_is_idle_restore(task, view));
        let execution_stale = task
            .as_ref()
            .zip(view)
            .is_some_and(|(task, view)| !cloud_execution_is_current(task, view));
        let connection = match &open.feed {
            ThreadFeed::Local { .. } => phase_connection(open.state.phase),
            ThreadFeed::Cloud(feed) => cloud_connection(
                feed.connection_phase,
                feed.source,
                feed.live_task.is_some()
                    || task.as_ref().is_some_and(|task| {
                        matches!(
                            task.state,
                            CloudTaskState::Queued | CloudTaskState::Preparing
                        )
                    }),
                task.as_ref().is_some_and(|task| {
                    task.idle == Some(true)
                        || matches!(
                            task.state,
                            CloudTaskState::Completed | CloudTaskState::Cancelled
                        )
                }),
            ),
        };
        let mut facts = Facts {
            identity: format!(
                "{}:{}",
                open.id.0,
                task.as_ref()
                    .and_then(|task| task.turn_request_id.as_deref())
                    .or_else(|| view
                        .and_then(|v| v.latest_turn.as_ref())
                        .map(|turn| turn.turn_id.0.as_str()))
                    .or_else(|| task
                        .as_ref()
                        .and_then(|t| t.attempt.as_ref())
                        .map(|a| a.id.as_str()))
                    .unwrap_or("idle")
            ),
            connection,
            transcript: if view.is_none() {
                Transcript::Empty
            } else if connection == Connection::Live && !execution_stale {
                Transcript::Current
            } else {
                Transcript::Cached
            },
            execution_available: connection == Connection::Live && !execution_stale,
            supports_steering: matches!(open.feed, ThreadFeed::Local { .. }),
            execution_stale,
            execution_invalidated: task
                .as_ref()
                .is_some_and(|task| task_execution_invalidated(&task.state)),
            cancellable_preparation: task.as_ref().is_some_and(|task| {
                matches!(
                    task.state,
                    CloudTaskState::Preparing | CloudTaskState::Queued
                )
            }),
            turn: task.as_ref().map(task_turn).unwrap_or_default(),
            attention: task
                .as_ref()
                .map(|t| task_attention(&t.state))
                .unwrap_or_default(),
            detail: self
                .last_error
                .as_ref()
                .map(ToString::to_string)
                .or_else(|| {
                    task.as_ref()
                        .and_then(|t| t.error.as_ref())
                        .map(|e| e.0.clone())
                }),
            ownership_fenced: self.location_switch_blocks_turn(),
            editable_after_error: task.is_none(),
            ..Facts::default()
        };
        let cleanup_pending = task.as_ref().is_some_and(|task| {
            task.state == CloudTaskState::Cancelled
                && task.idle != Some(true)
                && task.worker.as_ref().is_some_and(|worker| {
                    !matches!(
                        worker.state,
                        vitre_contracts::CloudWorkerState::Stopped
                            | vitre_contracts::CloudWorkerState::Deleted
                    )
                })
        });
        if let Some(view) = view {
            if connection == Connection::Live && !execution_stale && !idle_restore {
                if let Some(turn) = execution_turn(view) {
                    facts.turn = turn;
                    if turn == Turn::Preparing {
                        facts.preparation = Some("Starting your request…".into());
                    }
                } else if facts.turn != Turn::Preparing {
                    facts.turn = Turn::Finished;
                }
            }
            if execution_stale {
                if matches!(facts.turn, Turn::Working | Turn::Input | Turn::Preparing) {
                    facts.turn = Turn::Preparing;
                    facts.preparation = Some("Starting your request…".into());
                    facts.cancellable_preparation = true;
                }
            } else if !idle_restore
                && task
                    .as_ref()
                    .is_none_or(|task| task.state != CloudTaskState::Queued)
            {
                let activities = current_request_activities(view);
                if !derive_pending_approvals(&activities).is_empty() {
                    facts.turn = Turn::Approval;
                } else if !derive_pending_user_inputs(&activities).is_empty() {
                    facts.turn = Turn::Input;
                }
            }
            if facts.turn == Turn::Working {
                facts.started_at = view.latest_turn.as_ref().map(|turn| {
                    turn.started_at
                        .as_ref()
                        .unwrap_or(&turn.requested_at)
                        .0
                        .clone()
                });
            }
            if facts.detail.is_none() && !execution_stale && !idle_restore {
                facts.detail = view
                    .session
                    .as_ref()
                    .and_then(|s| s.last_error.as_ref())
                    .map(|e| e.0.clone());
            }
        }
        if cleanup_pending {
            facts.turn = Turn::Stopping;
        }
        if let Some(pending) = self.local_outbox.get(&open.id) {
            facts.identity = format!("{}:{}", open.id.0, pending.command_id());
            facts.started_at = Some(pending.optimistic.created_at.0.clone());
            facts.delivery = match pending.delivery {
                local_delivery::LocalDelivery::Submitting => Delivery::Submitting,
                local_delivery::LocalDelivery::Accepted => Delivery::Accepted,
                local_delivery::LocalDelivery::Unknown => Delivery::Uncertain,
                local_delivery::LocalDelivery::Rejected => Delivery::Rejected,
            };
            // A prior session error does not describe this new immutable request.
            facts.detail = pending.error.clone();
            facts.attention = Attention::None;
        }
        if let Some(pending) = self
            .cloud_pending_send
            .as_ref()
            .filter(|pending| task.as_ref().is_some_and(|task| task.id == pending.task_id))
        {
            facts.identity = format!("{}:{}", open.id.0, pending.request_key);
            facts.started_at = Some(pending.requested_at.0.clone());
        }
        if let Some(delivery) = self.cloud_delivery_status(cx) {
            use cloud_thread::CloudDeliveryState;
            facts.delivery = match delivery {
                CloudDeliveryState::Submitting => Delivery::Submitting,
                CloudDeliveryState::Accepted => Delivery::Accepted,
                CloudDeliveryState::Unknown => Delivery::Uncertain,
                CloudDeliveryState::Rejected => Delivery::Rejected,
            };
        }
        if let Some(stop) = self.local_stops.get(&open.id).filter(|stop| {
            view.and_then(|view| view.latest_turn.as_ref())
                .is_some_and(|turn| {
                    turn.turn_id == stop.turn_id
                        && turn.state == OrchestrationLatestTurnState::Running
                })
        }) {
            facts.turn = Turn::Stopping;
            if stop.error.is_some() {
                facts.detail = stop.error.clone();
                facts.stop_error = true;
            }
        }
        if let Some(error) = self
            .open_cloud_task_id()
            .as_ref()
            .and_then(|id| self.cloud_stops.get(id))
            .and_then(|stop| stop.error.as_ref())
        {
            facts.detail = Some(error.clone());
            facts.stop_error = true;
        }
        if self.cloud_stop_pending() {
            facts.turn = Turn::Stopping;
        }
        if let Some(task) = task.as_ref() {
            if let Some(error) = self.cloud_store.read(cx).task_error(&task.id) {
                facts.detail = Some(error.into());
            }
            if facts.turn == Turn::Preparing && task.state != CloudTaskState::Queued {
                facts.started_at = task
                    .preparation
                    .as_ref()
                    .filter(|p| task.attempt.as_ref().is_some_and(|a| a.id == p.attempt_id))
                    .map(|p| p.started_at.0.clone());
            }
            facts.preparation = task_preparation_label(task)
                .map(str::to_owned)
                .or(facts.preparation);
        }
        if let Some(operation) = self
            .cloud_switch
            .as_ref()
            .and_then(|s| s.operation.as_ref())
        {
            let terminal = matches!(
                operation.phase,
                CloudHandoffPhase::Completed | CloudHandoffPhase::Cancelled
            );
            facts.can_cancel_transfer = transfer_can_cancel(operation);
            facts.transfer = transfer_state(
                operation,
                self.cloud_switch
                    .as_ref()
                    .is_some_and(|status| !status.conflicts.is_empty()),
            );
            if !terminal {
                facts.identity = format!("{}:{}", open.id.0, operation.id);
                facts.started_at = operation.started_at.clone();
                facts.detail = operation.error.as_ref().map(|e| e.0.clone());
            }
        } else if self.cloud_switch_saving {
            facts.transfer = Transfer::Moving("the selected location".into());
        }
        if task.is_none()
            && let Some(provider) = self.selected_provider()
            && provider.auth.status == vitre_contracts::ServerProviderAuthStatus::Unauthenticated
        {
            facts.attention = Attention::Auth;
            facts.detail = provider.message.clone().flatten().map(|message| message.0);
        }
        // Operation-specific error details belong in the disclosure, never a second banner.
        if facts.attention == Attention::None
            && !facts.stop_error
            && facts.detail.is_some()
            && facts.turn != Turn::Working
            && facts.transfer == Transfer::None
        {
            facts.attention = Attention::Error;
        }
        let provider_connected = task.as_ref().is_some_and(|task| {
            self.cloud_store.read(cx).account_state(&task.provider)
                == Some(&vitre_contracts::CloudProviderAccountState::Connected)
        });
        let mut status = ConversationStatus::derive(facts);
        if status.action == Action::Reconnect && provider_connected {
            status.label = "Provider connected · retry this conversation".into();
            status.action = Action::Retry;
        }
        status
    }

    fn draft_conversation_status(&self, cx: &gpui::App) -> ConversationStatus {
        let active = self.draft_creating && self.cloud_creating_project == self.draft_project;
        if self.draft_creating && !self.draft_work_location.is_cloud() {
            return ConversationStatus::derive(Facts {
                identity: format!("draft-local:{:?}", self.draft_project),
                delivery: Delivery::Submitting,
                ..Facts::default()
            });
        }
        if let Some(pending) = self.cloud_draft.pending_start.as_ref() {
            use cloud_thread::CloudDeliveryState as D;
            if matches!(pending.delivery, D::Unknown | D::Accepted) {
                let mut status = ConversationStatus::derive(Facts {
                    identity: format!("draft:{}", pending.input.idempotency_key),
                    delivery: Delivery::Uncertain,
                    detail: pending.error.clone(),
                    started_at: Some(pending.requested_at.clone()),
                    ..Facts::default()
                });
                status.label = if pending.delivery == D::Accepted {
                    "Confirming cloud conversation…"
                } else {
                    "Checking whether your cloud request was received…"
                }
                .into();
                return status;
            }
        }
        let store = self.cloud_store.read(cx);
        let request_key = self
            .cloud_draft
            .pending_start
            .as_ref()
            .map(|pending| &pending.input.idempotency_key)
            .or(self.cloud_draft.request_key.as_ref());
        let progress = store.creation_status.as_ref().filter(|progress| {
            progress.request_id.as_ref() == request_key && progress.request_id.is_some()
        });
        let mut status = creation_status(
            progress,
            active,
            request_key.map(String::as_str).unwrap_or("draft"),
        );
        status.facts.detail = self.last_error.as_ref().map(ToString::to_string);
        if status.facts.detail.is_some() && status.label.is_empty() {
            status.label = "Could not start this conversation".into();
            status.art = Art::Error;
        }
        if self.draft_work_location.is_cloud()
            && !active
            && status.label.is_empty()
            && (!self.composer.read(cx).value().trim().is_empty()
                || !self.pending_attachments.is_empty())
            && let Some(blocker) = self.cloud_start_blocker(cx)
        {
            status.label = blocker.into();
            status.art = Art::Warning;
            if store.session != crate::cloud::SessionState::SignedIn {
                status.action = Action::Account;
            }
        }
        status
    }

    pub(super) fn sidebar_conversation_status(
        &self,
        thread: &OrchestrationThreadShell,
        visited: Option<&str>,
    ) -> Option<ThreadStatus> {
        let task = self
            .thread_location(&thread.id)
            .task_id()
            .and_then(|id| self.cloud_tasks.get(id));
        if let Some(task) = task {
            let mut facts = Facts {
                turn: task_turn(task),
                attention: task_attention(&task.state),
                connection: Connection::Dormant,
                ..Facts::default()
            };
            if facts.turn != Turn::Preparing && thread.has_pending_approvals {
                facts.turn = Turn::Approval;
            } else if facts.turn != Turn::Preparing && thread.has_pending_user_input {
                facts.turn = Turn::Input;
            }
            let status = ConversationStatus::derive(facts).sidebar();
            return status.or_else(|| {
                vitre_state::sidebar::resolve_thread_status(thread, visited).filter(|status| {
                    !matches!(status, ThreadStatus::Working | ThreadStatus::Connecting)
                })
            });
        }
        vitre_state::sidebar::resolve_thread_status(thread, visited)
    }

    pub(super) fn sync_status_motion(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let status = self.conversation_status(cx);
        let debug_key = format!(
            "{}:{:?}:{:?}:{:?}:{:?}",
            status.facts.identity,
            status.facts.connection,
            status.facts.delivery,
            status.facts.turn,
            status.facts.transfer
        );
        if self.status_debug_key.as_ref() != Some(&debug_key) {
            if std::env::var("VITRE_CLOUD_TIMING")
                .is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "on"))
            {
                eprintln!(
                    "[vitre-conversation-state] epoch_ms={} identity={} connection={:?} transcript={:?} delivery={:?} turn={:?} transfer={:?}",
                    chrono::Utc::now().timestamp_millis(),
                    status.facts.identity,
                    status.facts.connection,
                    status.facts.transcript,
                    status.facts.delivery,
                    status.facts.turn,
                    status.facts.transfer
                );
            }
            self.status_debug_key = Some(debug_key);
        }
        if let Some(open) = self
            .thread
            .as_ref()
            .filter(|open| open.state.phase == SyncPhase::Live)
            && let Some(stop) = self.local_stops.get(&open.id)
            && open
                .state
                .view
                .as_ref()
                .and_then(|view| view.latest_turn.as_ref())
                .is_some_and(|turn| {
                    turn.turn_id != stop.turn_id
                        || turn.state != OrchestrationLatestTurnState::Running
                })
        {
            self.local_stops.remove(&open.id);
        }
        let visible = self.settings.is_none()
            && (self.thread.is_some() || self.draft_project.is_some())
            && window.is_window_active();
        self.status_surface_visible = visible;
        let now = cx.background_executor().now();
        if self
            .status_motion
            .update(&status.facts.identity, status.busy(), visible, now)
            && !cx.reduce_motion()
        {
            self.status_art_timer = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(BUSY_DELAY).await;
                let _ = this.update(cx, |_, cx| cx.notify());
            }));
        } else if !visible || !status.busy() || cx.reduce_motion() {
            self.status_art_timer = None;
        }
        let artwork = visible && status.busy() && self.status_motion.ready(now, cx.reduce_motion());
        self.activity_orb.update(cx, |orb, cx| {
            orb.set_state(vitre_bezel_orbs::orbs::OrbState::Working, cx);
            orb.set_paused(!artwork, cx);
            orb.set_visible(artwork && status.art == Art::Working, cx);
        });
        let ticking = visible && status.busy() && status.facts.started_at.is_some();
        if ticking && self.working_tick.is_none() {
            self.working_tick = Some(cx.spawn_in(window, async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    let keep = this
                        .update_in(cx, |app, window, cx| {
                            let status = app.conversation_status(cx);
                            let keep = app.settings.is_none()
                                && window.is_window_active()
                                && status.busy()
                                && status.facts.started_at.is_some();
                            if keep {
                                cx.notify();
                            } else {
                                app.working_tick = None;
                            }
                            keep
                        })
                        .unwrap_or(false);
                    if !keep {
                        break;
                    }
                }
            }));
        } else if !ticking {
            self.working_tick = None;
        }
    }

    pub(super) fn render_conversation_status(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let status = self.conversation_status(cx);
        let active = !status.label.is_empty();
        let opacity = status_opacity(
            &status.facts.identity,
            "status-opacity",
            if active { 1. } else { 0. },
            self.status_surface_visible,
            window,
            cx,
        );
        let artwork = self.status_surface_visible
            && self
                .status_motion
                .ready(cx.background_executor().now(), cx.reduce_motion());
        let art_opacity = status_opacity(
            &status.facts.identity,
            "busy-art-opacity",
            if artwork { 1. } else { 0. },
            self.status_surface_visible,
            window,
            cx,
        );
        let art_color = match status.art {
            Art::Error => cx.theme().danger,
            Art::Warning | Art::Approval => cx.theme().warning,
            Art::Input => cx.theme().info,
            _ => cx.theme().muted_foreground,
        };
        let icon = match status.art {
            Art::Error => IconName::CircleX,
            Art::Warning => IconName::TriangleAlert,
            Art::Approval => IconName::Settings,
            Art::Input => IconName::Info,
            Art::Working | Art::Connecting => IconName::LoaderCircle,
            _ => IconName::CircleCheck,
        };
        let icon = if artwork && status.art == Art::Working {
            div()
                .opacity(art_opacity)
                .child(self.activity_orb.clone())
                .into_any_element()
        } else if artwork && status.art == Art::Connecting {
            div()
                .opacity(art_opacity)
                .child(
                    ProgressCircle::new(SharedString::from(format!(
                        "conversation-connecting:{}",
                        status.facts.identity
                    )))
                    .loading(true)
                    .small(),
                )
                .into_any_element()
        } else {
            Icon::new(icon).size_3p5().into_any_element()
        };
        let elapsed = status
            .facts
            .started_at
            .as_ref()
            .filter(|_| status.busy())
            .and_then(|at| status_elapsed(at, chrono::Utc::now()));
        let action_label = status.action.label(self.is_cloud_thread());
        let dependency_warning = dependency_detail(
            self.cloud_task(cx).as_ref(),
            &self
                .cloud_detail(cx)
                .map(|detail| detail.events)
                .unwrap_or_default(),
        )
        .is_some_and(|(_, warning)| warning);
        let action = status.action;
        let primary = status_frame()
            .text_xs()
            .text_color(cx.theme().muted_foreground)
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_2()
                    .opacity(opacity)
                    .when(active, |row| {
                        row.child(
                            div()
                                .size(px(16.))
                                .flex_shrink_0()
                                .text_color(art_color)
                                .child(icon),
                        )
                    })
                    .child(div().flex_1().min_w_0().truncate().child(status.label))
                    .children(elapsed.map(|elapsed| {
                        div()
                            .font_family(cx.theme().mono_font_family.clone())
                            .child(elapsed)
                    })),
            )
            .when_some(action_label, |row, label| {
                row.child(
                    Button::new("conversation-recovery")
                        .ghost()
                        .xsmall()
                        .label(label)
                        .on_click(cx.listener(move |app, _, window, cx| {
                            match action {
                                Action::Retry => {
                                    if app.is_cloud_thread() {
                                        app.retry_cloud_task(cx);
                                    } else {
                                        app.last_error = None;
                                        cx.notify();
                                    }
                                }
                                Action::CheckDelivery => {
                                    if app.thread.is_none() {
                                        app.retry_pending_cloud_start(cx);
                                    } else if app.is_cloud_thread() {
                                        app.retry_pending_cloud_send(cx);
                                    } else {
                                        app.retry_pending_local_send(window, cx);
                                    }
                                }
                                Action::RetryConnection => {
                                    if let Some(client) = app.workspace_client() {
                                        client.retry_connection();
                                    }
                                    if app.is_cloud_thread() {
                                        app.sync_cloud_thread(cx);
                                        app.cloud_store.update(cx, |store, cx| store.refresh(cx));
                                    }
                                    cx.notify();
                                }
                                Action::Reconnect => {
                                    if let Some(task) = app.cloud_task(cx) {
                                        app.connect_cloud_provider(task.provider, window, cx);
                                    } else {
                                        app.toggle_settings(window, cx);
                                    }
                                }
                                Action::Account => app.toggle_settings(window, cx),
                                Action::Conflicts => app.open_location_conflicts(window, cx),
                                Action::RetryTransfer => app.retry_location_switch(window, cx),
                                Action::CancelCreation => app
                                    .cloud_store
                                    .update(cx, |store, cx| store.cancel_creation(cx)),
                                Action::None => {}
                            }
                        })),
                )
            })
            .when(status.facts.can_cancel_transfer, |row| {
                row.child(
                    Button::new("status-cancel-transfer")
                        .ghost()
                        .xsmall()
                        .label("Cancel")
                        .on_click(cx.listener(|app, _, _, cx| app.cancel_location_switch(cx))),
                )
            })
            .child(
                Button::new("conversation-details")
                    .ghost()
                    .xsmall()
                    .icon(if dependency_warning {
                        IconName::TriangleAlert
                    } else {
                        IconName::Info
                    })
                    .when(dependency_warning, |button| {
                        button.text_color(cx.theme().warning)
                    })
                    .tooltip(if dependency_warning {
                        "Dependency setup needs attention · open details"
                    } else {
                        "Conversation details and activity"
                    })
                    .on_click(
                        cx.listener(|app, _, window, cx| app.open_conversation_details(window, cx)),
                    ),
            )
            .into_any_element();
        let login = self
            .cloud_store
            .read(cx)
            .login
            .clone()
            .filter(|_| self.is_cloud_thread());
        v_flex()
            .child(primary)
            .children(login.map(|login| {
                div()
                    .mx_auto()
                    .w_full()
                    .max_w(px(768.))
                    .px_3()
                    .py_2()
                    .child(crate::cloud::render_codex_login(&login, cx))
            }))
            .into_any_element()
    }

    pub(super) fn open_location_conflicts(&self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(thread_id) = self.thread.as_ref().map(|thread| thread.id.clone()) else {
            return;
        };
        let Some(status) = self.cloud_switch.as_ref() else {
            return;
        };
        let Some(operation) = status.operation.as_ref() else {
            return;
        };
        let operation_id = operation.id.clone();
        let conflicts = status.conflicts.clone();
        let owner = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, _| {
            let owner = owner.clone();
            let thread_id = thread_id.clone();
            let operation_id = operation_id.clone();
            let conflicts = conflicts.clone();
            dialog
                .title("Resolve file conflicts")
                .w(px(560.))
                .content(move |content, _, _cx| {
                    let mut body = v_flex().gap_3().child(
                        div()
                            .text_sm()
                            .child("Choose which files to keep before moving this conversation."),
                    );
                    for conflict in &conflicts {
                        let path = conflict.0.clone();
                        let owner = owner.clone();
                        let thread_id = thread_id.clone();
                        let operation_id = operation_id.clone();
                        body = body.child(
                            Button::new(SharedString::from(format!("conflict-{path}")))
                                .ghost()
                                .small()
                                .label(path.clone())
                                .on_click(move |_, window, cx| {
                                    let _ = owner.update(cx, |app, cx| {
                                        if app
                                            .thread
                                            .as_ref()
                                            .is_some_and(|thread| thread.id == thread_id)
                                            && app
                                                .cloud_switch
                                                .as_ref()
                                                .and_then(|status| status.operation.as_ref())
                                                .is_some_and(|operation| {
                                                    operation.id == operation_id
                                                })
                                        {
                                            window.close_dialog(cx);
                                            app.edit_switch_conflict(&path, window, cx);
                                        }
                                    });
                                }),
                        );
                    }
                    let mut actions = h_flex().gap_2().flex_wrap();
                    for (label, choice) in [
                        (
                            "Use edited files",
                            vitre_contracts::CloudSwitchResolveInputChoice::Edited,
                        ),
                        (
                            "Keep local files",
                            vitre_contracts::CloudSwitchResolveInputChoice::Local,
                        ),
                        (
                            "Keep cloud files",
                            vitre_contracts::CloudSwitchResolveInputChoice::Cloud,
                        ),
                    ] {
                        let owner = owner.clone();
                        let thread_id = thread_id.clone();
                        let operation_id = operation_id.clone();
                        actions = actions.child(
                            Button::new(SharedString::from(label))
                                .small()
                                .label(label)
                                .on_click(move |_, window, cx| {
                                    let _ = owner.update(cx, |app, cx| {
                                        if app
                                            .thread
                                            .as_ref()
                                            .is_some_and(|thread| thread.id == thread_id)
                                            && app
                                                .cloud_switch
                                                .as_ref()
                                                .and_then(|status| status.operation.as_ref())
                                                .is_some_and(|operation| {
                                                    operation.id == operation_id
                                                })
                                        {
                                            window.close_dialog(cx);
                                            app.resolve_switch_conflicts(
                                                choice.clone(),
                                                window,
                                                cx,
                                            );
                                        }
                                    });
                                }),
                        );
                    }
                    content.child(body.child(actions))
                })
        });
    }

    pub(super) fn open_conversation_details(&self, window: &mut Window, cx: &mut Context<Self>) {
        let status = self.conversation_status(cx);
        let mut lines = Vec::new();
        lines.push(format!(
            "Connection: {:?} · History: {:?}",
            status.facts.connection, status.facts.transcript
        ));
        if let Some((dependency, _)) = dependency_detail(
            self.cloud_task(cx).as_ref(),
            &self
                .cloud_detail(cx)
                .map(|detail| detail.events)
                .unwrap_or_default(),
        ) {
            lines.push(dependency);
        }
        if let Some(detail) = status.facts.detail {
            lines.push(detail);
        }
        if let Some(root) = self.open_project_root() {
            lines.push(format!("Workspace: {root}"));
        }
        if let Some(view) = self.thread.as_ref().and_then(|t| t.state.view.as_ref()) {
            for activity in &view.activities {
                if infrastructure_activity(&activity.kind.0) {
                    lines.push(format!(
                        "{} · {}",
                        activity.created_at.0, activity.summary.0
                    ));
                }
            }
        }
        if let Some(detail) = self.cloud_detail(cx) {
            for event in detail.events {
                lines.push(format!("{} · {}", event.created_at.0, event.detail.0));
            }
        }
        window.open_dialog(cx, move |dialog, _, _| {
            let lines = lines.clone();
            dialog
                .title("Conversation details")
                .w(px(560.))
                .content(move |content, _, cx| {
                    content.child(
                        v_flex()
                            .gap_3()
                            .max_h(px(420.))
                            .overflow_y_scrollbar()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .children(lines.iter().map(|line| div().child(line.clone()))),
                    )
                })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn working() -> Facts {
        Facts {
            identity: "conversation:turn-1".into(),
            turn: Turn::Working,
            connection: Connection::Live,
            transcript: Transcript::Current,
            execution_available: true,
            supports_steering: true,
            ..Facts::default()
        }
    }
    #[test]
    fn running_local_turn_allows_followups_and_stop_independently() {
        let status = ConversationStatus::derive(working());
        assert!(status.can_send);
        assert!(status.can_stop);
        for delivery in [
            Delivery::Submitting,
            Delivery::Accepted,
            Delivery::Uncertain,
        ] {
            assert!(
                !ConversationStatus::derive(Facts {
                    delivery,
                    ..working()
                })
                .can_send
            );
        }
        for facts in [
            Facts {
                supports_steering: false,
                ..working()
            },
            Facts {
                execution_available: false,
                ..working()
            },
            Facts {
                execution_stale: true,
                ..working()
            },
            Facts {
                execution_invalidated: true,
                ..working()
            },
            Facts {
                ownership_fenced: true,
                ..working()
            },
        ] {
            assert!(!ConversationStatus::derive(facts).can_send);
        }
    }
    #[test]
    fn primary_elapsed_label_changes_only_at_whole_seconds() {
        let started_at = "2026-10-16T10:00:00Z";
        let start = chrono::DateTime::parse_from_rfc3339(started_at)
            .unwrap()
            .with_timezone(&chrono::Utc);
        for (milliseconds, expected) in [
            (-1, "0s"),
            (0, "0s"),
            (427, "0s"),
            (999, "0s"),
            (1_000, "1s"),
            (1_999, "1s"),
            (59_999, "59s"),
            (60_000, "1m 00s"),
            (61_999, "1m 01s"),
        ] {
            assert_eq!(
                status_elapsed(
                    started_at,
                    start + chrono::Duration::milliseconds(milliseconds)
                )
                .as_deref(),
                Some(expected)
            );
        }
        assert_eq!(status_elapsed("invalid", start), None);
    }
    #[test]
    fn running_projection_fences_send_before_provider_session_arrives() {
        let mut view = crate::cloud::tests::fixtures::thread();
        view.latest_turn = Some(serde_json::from_value(serde_json::json!({
            "turnId":"turn-starting", "state":"running", "requestedAt":"2026-10-16T10:00:00Z",
            "startedAt":null, "completedAt":null, "assistantMessageId":null, "sourceProposedPlan":null
        })).unwrap());
        if let Some(session) = view.session.as_mut() {
            session.active_turn_id = None;
        }
        assert_eq!(execution_turn(&view), Some(Turn::Preparing));
        let status = ConversationStatus::derive(Facts {
            turn: execution_turn(&view).unwrap(),
            ..working()
        });
        assert!(!status.can_send);
        assert_ne!(status.art, Art::Working);
    }
    #[test]
    fn queued_task_reports_waiting_without_inventing_worker_preparation() {
        let mut task = crate::cloud::tests::fixtures::task("queued", CloudTaskState::Queued, false);
        let status = ConversationStatus::derive(Facts {
            turn: task_turn(&task),
            preparation: task_preparation_label(&task).map(str::to_owned),
            ..Facts::default()
        });
        assert_eq!(status.label, "Waiting for a cloud computer…");
        assert_ne!(status.art, Art::Working);
        task.state = CloudTaskState::Preparing;
        let older_worker = ConversationStatus::derive(Facts {
            turn: task_turn(&task),
            preparation: task_preparation_label(&task).map(str::to_owned),
            ..Facts::default()
        });
        assert_eq!(older_worker.label, "Preparing cloud workspace…");
    }
    #[test]
    fn idle_restore_does_not_override_a_new_running_projection() {
        let mut task =
            crate::cloud::tests::fixtures::task("restore", CloudTaskState::Running, false);
        task.idle = Some(true);
        task.wake_only = Some(true);
        task.turn_request_id = Some("restore-request".into());
        let mut view = crate::cloud::tests::fixtures::thread();
        assert!(task_is_idle_restore(&task, Some(&view)));
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId":"new-execution", "state":"running", "requestedAt":"2026-10-16T11:00:00Z",
                "startedAt":"2026-10-16T11:00:00Z", "completedAt":null,
                "assistantMessageId":null, "sourceProposedPlan":null
            }))
            .unwrap(),
        );
        assert!(!task_is_idle_restore(&task, Some(&view)));
        assert!(!cloud_execution_is_current(&task, &view));
    }
    #[test]
    fn current_request_scope_excludes_old_questions_including_untagged_legacy_events() {
        let mut view = crate::cloud::tests::fixtures::thread();
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId":"current", "state":"running", "requestedAt":"2026-10-16T11:00:00Z",
                "startedAt":"2026-10-16T11:00:00Z", "completedAt":null,
                "assistantMessageId":null, "sourceProposedPlan":null
            }))
            .unwrap(),
        );
        view.activities = [
            ("old", Some("previous"), "2026-10-16T10:00:01Z"),
            ("legacy-old", None, "2026-10-16T10:00:02Z"),
            ("late-old", Some("previous"), "2026-10-16T11:00:01Z"),
            ("current", Some("current"), "2026-10-16T11:00:01Z"),
            ("legacy-current", None, "2026-10-16T11:00:02Z"),
        ].into_iter().map(|(id, turn, created)| {
            serde_json::from_value(serde_json::json!({
                "id":id, "kind":"user-input.requested", "createdAt":created,
                "summary":"Choose an option", "tone":"info", "turnId":turn,
                "payload":{"requestId":id, "questions":[{"id":"choice", "header":"Choose", "question":"Which option?", "options":[]}]}
            })).unwrap()
        }).collect();
        let requests = derive_pending_user_inputs(&current_request_activities(&view));
        assert_eq!(
            requests
                .iter()
                .map(|request| request.request_id.as_str())
                .collect::<Vec<_>>(),
            ["current", "legacy-current"]
        );
        assert_eq!(view.activities.len(), 5);
    }
    #[test]
    fn current_request_scope_retains_import_markers_that_fence_historical_actions() {
        let mut view = crate::cloud::tests::fixtures::thread();
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId":"restored-turn", "state":"running", "requestedAt":"2026-10-16T11:00:00Z",
                "startedAt":"2026-10-16T11:00:00Z", "completedAt":null,
                "assistantMessageId":null, "sourceProposedPlan":null
            }))
            .unwrap(),
        );
        view.activities = vec![
            serde_json::from_value(serde_json::json!({
                "id":"historical-approval", "kind":"approval.requested", "createdAt":"2026-10-16T11:00:01Z",
                "summary":"Command approval requested", "tone":"tool", "turnId":"restored-turn",
                "payload":{"requestId":"reused", "requestKind":"command"}
            })).unwrap(),
            serde_json::from_value(serde_json::json!({
                "id":"import", "kind":"thread.history.imported", "createdAt":"2026-10-16T10:00:00Z",
                "summary":"History restored", "tone":"info", "turnId":null,
                "payload":{"historicalActivityIds":["historical-approval"]}
            })).unwrap(),
        ];
        assert!(derive_pending_approvals(&current_request_activities(&view)).is_empty());
        let mut current = view.activities[0].clone();
        current.id = vitre_contracts::EventId("current-approval".into());
        current.created_at = tnes("2026-10-16T11:00:02Z");
        view.activities.push(current);
        assert_eq!(
            derive_pending_approvals(&current_request_activities(&view)).len(),
            1
        );
        assert_eq!(view.activities.len(), 3);
    }
    #[test]
    fn terminal_transfer_failure_stops_motion_at_the_recoverable_phase() {
        let operation: vitre_contracts::CloudHandoffOperation = serde_json::from_value(serde_json::json!({
            "id":"move", "conversationId":"conversation", "generation":1,
            "from":"local", "to":"cloud-local", "phase":"verifying", "error":"Verification failed",
            "checkpoint":null, "errorDisposition":"retryable"
        })).unwrap();
        assert_eq!(transfer_state(&operation, false), Transfer::Failed);
        assert!(transfer_can_cancel(&operation));
        let status = ConversationStatus::derive(Facts {
            transfer: transfer_state(&operation, false),
            ..working()
        });
        assert!(!status.busy());
        assert_eq!(status.action, Action::RetryTransfer);
    }
    #[test]
    fn dependency_failure_survives_ready_idle_and_empty_reconnect_history() {
        let mut task =
            crate::cloud::tests::fixtures::task("setup", CloudTaskState::Preparing, false);
        task.dependency_setup = Some(serde_json::from_value(serde_json::json!({
            "attemptId":"attempt", "sequence":2, "outcome":"failed", "updatedAt":"2026-10-16T10:00:00Z", "detail":"pnpm installation timed out"
        })).unwrap());
        for state in [CloudTaskState::Running, CloudTaskState::Completed] {
            task.state = state;
            task.idle = Some(true);
            let (line, warning) = dependency_detail(Some(&task), &[]).unwrap();
            assert!(warning);
            assert!(line.contains("pnpm installation timed out"));
        }
        task.dependency_setup.as_mut().unwrap().outcome =
            vitre_contracts::CloudTaskDependencySetupOutcome::Reused;
        assert!(!dependency_detail(Some(&task), &[]).unwrap().1);
        let event: vitre_contracts::CloudTaskEvent = serde_json::from_value(serde_json::json!({
            "attemptId":"old-worker", "createdAt":"2026-10-16T10:00:00Z", "cursor":1, "sequence":1, "phase":"task.warning", "detail":"Dependency setup needs attention: installation did not finish."
        })).unwrap();
        assert!(dependency_detail(None, &[event]).unwrap().1);
    }
    #[test]
    fn reconnect_reports_disconnect_before_synchronizing_again() {
        use cloud_thread::CloudSource;
        assert_eq!(
            cloud_connection(SyncPhase::Disconnected, CloudSource::Mirror, true, false),
            Connection::Connecting
        );
        assert_eq!(
            cloud_connection(SyncPhase::Live, CloudSource::Live, true, false),
            Connection::Live
        );
        assert_eq!(
            cloud_connection(SyncPhase::Disconnected, CloudSource::Live, true, false),
            Connection::Disconnected
        );
        assert_eq!(
            cloud_connection(SyncPhase::Synchronizing, CloudSource::Live, true, false),
            Connection::Synchronizing
        );
        assert_eq!(
            cloud_connection(SyncPhase::Live, CloudSource::Live, true, false),
            Connection::Live
        );
        assert_eq!(
            cloud_connection(SyncPhase::Disconnected, CloudSource::Mirror, false, true),
            Connection::Dormant
        );
    }
    #[test]
    fn disconnect_and_sync_are_visible_even_while_waiting_for_approval_or_startup() {
        for turn in [Turn::Approval, Turn::Input, Turn::Preparing, Turn::Stopping] {
            for connection in [Connection::Disconnected, Connection::Synchronizing] {
                let status = ConversationStatus::derive(Facts {
                    turn,
                    connection,
                    execution_available: false,
                    ..working()
                });
                assert!(!status.can_send);
                assert!(!status.can_stop);
                assert!(status.label.to_lowercase().contains(
                    if connection == Connection::Disconnected {
                        "connection lost"
                    } else {
                        "synchronizing"
                    }
                ));
                if matches!(turn, Turn::Approval | Turn::Input) {
                    assert!(!status.busy());
                }
            }
        }
    }
    #[test]
    fn accepted_delivery_stays_pending_until_the_execution_feed_confirms_it() {
        let status = ConversationStatus::derive(Facts {
            delivery: Delivery::Accepted,
            turn: Turn::Finished,
            ..working()
        });
        assert_eq!(status.label, "Starting your request…");
        assert!(!status.can_send);
        assert!(status.busy());
    }
    #[test]
    fn cached_history_never_makes_a_connection_live() {
        let status = ConversationStatus::derive(Facts {
            connection: Connection::Disconnected,
            transcript: Transcript::Cached,
            turn: Turn::Working,
            ..Facts::default()
        });
        assert_eq!(status.facts.transcript, Transcript::Cached);
        assert_eq!(status.art, Art::Warning);
        assert!(!status.busy());
        assert!(!status.can_send);
        assert!(!status.can_stop);
        let synchronized = ConversationStatus::derive(Facts {
            connection: Connection::Synchronizing,
            transcript: Transcript::Cached,
            ..Facts::default()
        });
        assert_eq!(synchronized.label, "Synchronizing conversation…");
    }
    #[test]
    fn idle_resident_computer_is_not_a_working_turn() {
        let status = ConversationStatus::derive(Facts {
            connection: Connection::Live,
            transcript: Transcript::Current,
            execution_available: true,
            turn: Turn::Finished,
            ..Facts::default()
        });
        assert_eq!(status.art, Art::None);
        assert_eq!(status.sidebar(), None);
        assert!(status.can_send);
        assert!(!status.can_stop);
    }
    #[test]
    fn pending_transfer_blocks_new_turns_without_blocking_source_turn_actions() {
        for transfer in [
            Transfer::Moving("Local".into()),
            Transfer::WaitingForTurn,
            Transfer::Cancelling,
        ] {
            let idle = ConversationStatus::derive(Facts {
                transfer: transfer.clone(),
                turn: Turn::Finished,
                ..working()
            });
            assert!(!idle.can_send);
            let active = ConversationStatus::derive(Facts {
                transfer: transfer.clone(),
                ..working()
            });
            assert!(active.can_stop);
            let approval = ConversationStatus::derive(Facts {
                transfer,
                turn: Turn::Approval,
                ..working()
            });
            assert!(approval.can_respond);
            assert!(approval.can_stop);
        }
    }

    #[test]
    fn required_user_actions_stop_busy_motion_immediately() {
        for (turn, art) in [(Turn::Approval, Art::Approval), (Turn::Input, Art::Input)] {
            let status = ConversationStatus::derive(Facts { turn, ..working() });
            assert_eq!(status.art, art);
            assert!(!status.busy());
            assert!(!status.can_send);
            assert!(status.show_requests);
        }
        for attention in [Attention::Auth, Attention::Limit, Attention::Error] {
            let status = ConversationStatus::derive(Facts {
                attention,
                ..working()
            });
            assert!(!status.busy());
        }
    }
    #[test]
    fn interrupted_cached_approval_requires_attention_and_an_explicit_request_retry() {
        let status = ConversationStatus::derive(Facts {
            connection: Connection::Disconnected,
            transcript: Transcript::Cached,
            attention: Attention::Interrupted,
            turn: Turn::Approval,
            ..Facts::default()
        });
        assert_eq!(status.label, "Conversation interrupted");
        assert_eq!(status.art, Art::Warning);
        assert_eq!(status.sidebar(), Some(ThreadStatus::NeedsAttention));
        assert!(!status.busy());
        assert!(!status.can_respond);
        assert!(!status.can_stop);
        assert_eq!(status.action, Action::Retry);
        assert_eq!(status.action.label(true), Some("Retry request"));
        assert_eq!(Action::RetryConnection.label(true), Some("Reconnect"));
        assert_eq!(Action::CheckDelivery.label(true), Some("Check delivery"));
    }

    #[test]
    fn sidebar_keeps_user_questions_distinct_from_warnings_and_errors() {
        let input = ConversationStatus::derive(Facts {
            turn: Turn::Input,
            ..working()
        });
        assert_eq!(input.sidebar(), Some(ThreadStatus::AwaitingInput));
        for attention in [Attention::Auth, Attention::Limit, Attention::Error] {
            let status = ConversationStatus::derive(Facts {
                attention,
                ..working()
            });
            assert_eq!(status.sidebar(), Some(ThreadStatus::NeedsAttention));
            assert!(!status.busy());
        }
    }
    #[test]
    fn authoritative_interruption_fences_actions_even_with_a_stale_live_approval() {
        for attention in [Attention::Interrupted, Attention::Auth, Attention::Limit] {
            let status = ConversationStatus::derive(Facts {
                attention,
                turn: Turn::Approval,
                ..working()
            });
            assert!(!status.can_respond);
            assert!(!status.can_stop);
            assert!(!status.can_send);
            assert!(!status.show_requests);
        }
        for state in [
            CloudTaskState::Failed,
            CloudTaskState::Interrupted,
            CloudTaskState::NeedsAuth,
            CloudTaskState::UsageLimited,
        ] {
            let status = ConversationStatus::derive(Facts {
                attention: task_attention(&state),
                execution_invalidated: task_execution_invalidated(&state),
                turn: Turn::Approval,
                ..working()
            });
            assert!(!status.can_respond);
            assert!(!status.can_stop);
            assert!(!status.show_requests);
        }
        // A notification error does not establish that live execution has stopped.
        let notification_error = ConversationStatus::derive(Facts {
            attention: Attention::Error,
            ..working()
        });
        assert!(notification_error.can_stop);
    }
    #[test]
    fn uncertain_delivery_is_preserved_and_does_not_offer_a_new_send() {
        let status = ConversationStatus::derive(Facts {
            delivery: Delivery::Uncertain,
            ..working()
        });
        assert_eq!(status.action, Action::CheckDelivery);
        assert!(!status.can_send);
        assert!(!status.can_stop);
        assert!(!status.busy());
    }
    #[test]
    fn uncertain_delivery_wins_over_a_transport_error_and_never_retries_a_new_turn() {
        let status = ConversationStatus::derive(Facts {
            delivery: Delivery::Uncertain,
            attention: Attention::Error,
            detail: Some("The connection timed out".into()),
            ..working()
        });
        assert_eq!(status.action, Action::CheckDelivery);
        assert!(!status.can_send);
        let rejected = ConversationStatus::derive(Facts {
            delivery: Delivery::Rejected,
            attention: Attention::Error,
            detail: Some("Message attachment was rejected".into()),
            ..working()
        });
        assert_eq!(rejected.action, Action::None);
        assert_eq!(rejected.label, "Message attachment was rejected");
    }
    #[test]
    fn stop_acknowledgement_is_not_turn_completion() {
        for _acknowledged in [false, true] {
            let status = ConversationStatus::derive(Facts {
                turn: Turn::Stopping,
                ..working()
            });
            assert_eq!(status.label, "Stopping…");
            assert!(!status.can_send);
            assert!(!status.can_stop);
        }
        let settled = ConversationStatus::derive(Facts {
            turn: Turn::Finished,
            ..working()
        });
        assert!(settled.can_send);
        assert!(!settled.busy());
    }
    #[test]
    fn transfer_cancel_and_wait_states_follow_typed_journal_fields() {
        let mut operation: vitre_contracts::CloudHandoffOperation =
            serde_json::from_value(serde_json::json!({
                "id":"move-1", "conversationId":"conversation", "generation":1,
                "from":"cloud-local", "to":"local", "phase":"waiting", "error":null,
                "checkpoint":null, "waitReason":"active-turn"
            }))
            .unwrap();
        assert_eq!(transfer_state(&operation, false), Transfer::WaitingForTurn);
        assert!(transfer_can_cancel(&operation));
        operation.wait_reason =
            Some(vitre_contracts::CloudHandoffOperationWaitReason::OwnershipConfirmation);
        assert!(!transfer_can_cancel(&operation));
        operation.revision = Some(1);
        assert!(transfer_can_cancel(&operation));
        operation.cancel_requested = Some(true);
        assert_eq!(transfer_state(&operation, false), Transfer::Cancelling);
        assert!(!transfer_can_cancel(&operation));
        operation.phase = CloudHandoffPhase::Cancelled;
        assert_eq!(transfer_state(&operation, false), Transfer::None);
        operation.phase = CloudHandoffPhase::Failed;
        assert_eq!(transfer_state(&operation, false), Transfer::Recovering);
        operation.error_disposition =
            Some(vitre_contracts::CloudHandoffOperationErrorDisposition::Terminal);
        assert_eq!(transfer_state(&operation, false), Transfer::Failed);
    }
    #[test]
    fn conflict_and_unknown_ownership_are_static_and_fenced() {
        for (transfer, action) in [
            (Transfer::Conflict, Action::Conflicts),
            (Transfer::Recovering, Action::None),
            (Transfer::Failed, Action::RetryTransfer),
        ] {
            let status = ConversationStatus::derive(Facts {
                transfer,
                ownership_fenced: true,
                ..working()
            });
            assert_eq!(status.action, action);
            assert!(!status.busy());
            assert!(!status.can_send);
            assert!(!status.can_stop);
        }
    }
    #[test]
    fn busy_art_starts_at_150ms_but_state_and_actions_are_immediate() {
        let mut motion = StatusMotion::default();
        let now = Instant::now();
        let status = ConversationStatus::derive(working());
        assert!(status.can_stop);
        assert_eq!(status.label, "Working on your request");
        assert!(motion.update(&status.facts.identity, true, true, now));
        assert!(!motion.ready(now + Duration::from_millis(149), false));
        assert!(motion.ready(now + BUSY_DELAY, false));
        // Polls and elapsed updates retain the same clock.
        assert!(!motion.update(
            &status.facts.identity,
            true,
            true,
            now + Duration::from_secs(1)
        ));
        assert!(motion.ready(now + Duration::from_secs(1), false));
        assert!(!motion.ready(now + Duration::from_secs(1), true));
    }
    #[test]
    fn hidden_completed_and_replaced_operations_discard_busy_clock() {
        let now = Instant::now();
        for (busy, visible) in [(false, true), (true, false)] {
            let mut motion = StatusMotion::default();
            motion.update("first", true, true, now);
            motion.update("first", busy, visible, now + BUSY_DELAY);
            assert!(!motion.ready(now + Duration::from_secs(10), false));
            assert!(motion.key.is_none());
        }
        let mut motion = StatusMotion::default();
        motion.update("first", true, true, now);
        motion.update("second", true, true, now + Duration::from_secs(1));
        assert!(!motion.ready(now + Duration::from_secs(1), false));
        assert!(motion.ready(now + Duration::from_secs(1) + BUSY_DELAY, false));
    }
    #[test]
    fn only_infrastructure_events_move_out_of_the_timeline() {
        assert!(infrastructure_activity("thread.execution.changed"));
        assert!(infrastructure_activity("thread.history.imported"));
        for kind in [
            "thread.execution.failed",
            "tool.started",
            "approval.requested",
            "reasoning.delta",
            "message.created",
        ] {
            assert!(!infrastructure_activity(kind));
        }
    }
    #[test]
    fn creation_progress_is_typed_and_percent_requires_a_real_total() {
        let progress = |phase: &str, completed: Option<i64>, total: Option<i64>| {
            serde_json::from_value::<vitre_contracts::CloudStartProgress>(serde_json::json!({
                "message": "arbitrary diagnostic text", "requestId": "request", "phase": phase,
                "completedBytes": completed, "totalBytes": total
            }))
            .unwrap()
        };
        let unknown = creation_status(Some(&progress("unknown", None, None)), true, "request");
        assert_eq!(unknown.label, "Checking workspace creation…");
        assert!(!unknown.busy());
        let upload = creation_status(
            Some(&progress("upload", Some(50), Some(200))),
            true,
            "request",
        );
        assert_eq!(upload.label, "Uploading workspace… 25%");
        assert_eq!(upload.action, Action::CancelCreation);
        assert_eq!(
            creation_status(Some(&progress("upload", Some(50), None)), true, "request").label,
            "Uploading workspace…"
        );
        assert!(
            creation_status(
                Some(&progress("upload", Some(50), Some(200))),
                false,
                "request"
            )
            .label
            .is_empty()
        );
        assert!(!creation_status(Some(&progress("failed", None, None)), false, "request").busy());
    }

    struct StatusProbe {
        target: f32,
        visible: bool,
        sampled: f32,
        label: &'static str,
    }
    impl Render for StatusProbe {
        fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            self.sampled = status_opacity("probe", "fade", self.target, self.visible, window, cx);
            v_flex()
                .w(px(400.))
                .child(status_frame().opacity(self.sampled).child(self.label))
                .child(div().debug_selector(|| "probe-composer".into()).h(px(100.)))
        }
    }
    #[gpui::test]
    fn status_fades_retarget_without_moving_the_composer(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (probe, cx) = cx.add_window_view(|_, _| StatusProbe {
            target: 0.,
            visible: true,
            sampled: 0.,
            label: "",
        });
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let before = cx.debug_bounds("probe-composer").unwrap();
        assert_eq!(
            cx.debug_bounds("conversation-status").unwrap().size.height,
            px(STATUS_HEIGHT)
        );
        probe.update(cx, |probe, cx| {
            probe.target = 1.;
            probe.label = "Working";
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.executor().advance_clock(Duration::from_millis(60));
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        let halfway = probe.read_with(cx, |probe, _| probe.sampled);
        assert!(halfway > 0. && halfway < 1.);
        probe.update(cx, |probe, cx| {
            probe.target = 0.;
            probe.label = "";
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(probe.read_with(cx, |probe, _| probe.sampled), halfway);
        cx.executor().advance_clock(FADE);
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        assert_eq!(probe.read_with(cx, |probe, _| probe.sampled), 0.);
        assert_eq!(cx.debug_bounds("probe-composer").unwrap(), before);
        cx.update(|_, cx| cx.set_reduce_motion(true));
        probe.update(cx, |probe, cx| {
            probe.target = 1.;
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(probe.read_with(cx, |probe, _| probe.sampled), 1.);
        cx.update(|_, cx| cx.set_reduce_motion(false));
        probe.update(cx, |probe, cx| {
            probe.target = 0.;
            probe.visible = false;
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(probe.read_with(cx, |probe, _| probe.sampled), 0.);
    }
}
