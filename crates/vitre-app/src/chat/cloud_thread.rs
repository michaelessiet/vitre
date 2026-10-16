//! Cloud tasks adapted to the shared conversation shell and timeline.
use super::*;
use crate::cloud::{
    self, Op, SessionState,
    store::{LiveConversation, TaskDetail, connection_identity},
};
use cloud::{Sheet, onboarding_card, provider_icon, provider_label, render_codex_login};
use gpui::App;
use serde::{Deserialize, Serialize};
use vitre_contracts::CloudProviderAccountState;
use vitre_contracts::{
    CloudCommandTaskCreateKind, CloudProvider, CloudTask, CloudTaskState, CloudWorkerState,
    RepositoryIdentity,
};

pub(crate) const CLOUD_THREAD_PREFIX: &str = "cloud-";

fn log_cloud_timing(event: &'static str, task_id: &str, cached: bool) {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *ENABLED.get_or_init(|| {
        std::env::var("VITRE_CLOUD_TIMING")
            .is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "on"))
    }) {
        eprintln!(
            "[vitre-cloud-timing] epoch_ms={} task_id={task_id} event={event} cached={cached}",
            chrono::Utc::now().timestamp_millis()
        );
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ThreadLocation {
    Local,
    Cloud { task_id: String },
}
impl ThreadLocation {
    pub(crate) fn of(id: &ThreadId) -> Self {
        match id
            .0
            .strip_prefix(CLOUD_THREAD_PREFIX)
            .filter(|id| !id.is_empty())
        {
            Some(id) => Self::Cloud { task_id: id.into() },
            None => Self::Local,
        }
    }
    pub(crate) fn is_cloud(&self) -> bool {
        matches!(self, Self::Cloud { .. })
    }
    pub(crate) fn task_id(&self) -> Option<&str> {
        match self {
            Self::Cloud { task_id } => Some(task_id),
            Self::Local => None,
        }
    }
}
pub(crate) fn cloud_thread_id(task_id: &str) -> ThreadId {
    ThreadId(format!("{CLOUD_THREAD_PREFIX}{task_id}"))
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum WorkLocation {
    #[default]
    Local,
    Cloud,
    CloudLocal,
}
impl WorkLocation {
    pub(crate) fn is_cloud(self) -> bool {
        self != Self::Local
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct CloudPromptRecovery {
    pub request_key: String,
    pub prompt: String,
    pub raw_prompt: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct CloudDraft {
    pub repository: Option<String>,
    pub base_branch: Option<String>,
    pub provider: CloudProvider,
    pub kind: CloudCommandTaskCreateKind,
    pub issue_number: Option<u64>,
    pub request_key: Option<String>,
    pub request_identity: Option<String>,
    pub prompt_recovery: Option<CloudPromptRecovery>,
    pub(super) pending_start: Option<CloudPendingStart>,
}
impl Default for CloudDraft {
    fn default() -> Self {
        Self {
            repository: None,
            base_branch: None,
            provider: CloudProvider::Codex,
            kind: CloudCommandTaskCreateKind::Build,
            issue_number: None,
            request_key: None,
            request_identity: None,
            prompt_recovery: None,
            pending_start: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct CloudPendingStart {
    pub input: vitre_contracts::CloudStartConversationInput,
    pub raw_prompt: String,
    pub attachments: Vec<PendingAttachment>,
    pub review_comments: Vec<ReviewCommentContext>,
    pub terminal_contexts: Vec<terminal_contexts::PendingTerminalContext>,
    pub delivery: CloudDeliveryState,
    pub error: Option<String>,
    pub requested_at: String,
    pub account_identity: Option<String>,
}

pub(crate) fn cloud_message_matches_prompt(message: &str, prompt: &str) -> bool {
    if message == prompt {
        return true;
    }
    message.strip_prefix(prompt).is_some_and(|suffix| {
        (suffix.starts_with("\n\n<vitre_cloud_context>\n")
            && suffix.ends_with("\n</vitre_cloud_context>"))
            || suffix.starts_with("\n\nThis is a cloud ")
    })
}
pub(crate) enum ThreadFeed {
    Local { _handle: ThreadHandle },
    Cloud(CloudThreadFeed),
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloudSource {
    Mirror,
    Live,
}

fn cloud_turn_to_interrupt(
    source: CloudSource,
    state: &ThreadState,
) -> Option<vitre_contracts::TurnId> {
    if source != CloudSource::Live || state.phase != SyncPhase::Live {
        return None;
    }
    let view = state.view.as_ref()?;
    let latest = view.latest_turn.as_ref()?;
    let session = view.session.as_ref()?;
    (latest.state == OrchestrationLatestTurnState::Running
        && session.active_turn_id.as_ref() == Some(&latest.turn_id))
    .then(|| latest.turn_id.clone())
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum CloudDeliveryState {
    Submitting,
    Accepted,
    #[default]
    Unknown,
    Rejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CloudStopPhase {
    Requested,
    Acknowledged,
}

#[derive(Clone, Debug)]
pub(super) struct CloudStopState {
    pub turn_id: Option<vitre_contracts::TurnId>,
    pub command_id: String,
    pub request_id: Option<String>,
    pub task_updated_at: Option<String>,
    pub phase: CloudStopPhase,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct CloudPendingSend {
    pub task_id: String,
    pub message_id: MessageId,
    pub requested_at: TrimmedNonEmptyString,
    pub prompt: String,
    pub attachments: Vec<PendingAttachment>,
    pub raw_prompt: String,
    pub review_comments: Vec<ReviewCommentContext>,
    pub terminal_contexts: Vec<terminal_contexts::PendingTerminalContext>,
    pub baseline_ids: HashSet<MessageId>,
    pub accepted: bool,
    #[serde(default)]
    pub request_key: String,
    #[serde(default)]
    pub delivery: CloudDeliveryState,
    #[serde(default)]
    pub input: Option<vitre_contracts::CloudContinueConversationInput>,
}
impl CloudPendingSend {
    fn matches_message(&self, message: &OrchestrationMessage) -> bool {
        message.role == OrchestrationMessageRole::User
            && message.id.0 == format!("{}-message", self.request_key)
            && cloud_message_matches_prompt(&message.text.0, &self.prompt)
    }

    fn execution_projected(&self, view: &OrchestrationThread, task: Option<&CloudTask>) -> bool {
        let Some(message) = view
            .messages
            .iter()
            .find(|message| self.matches_message(message))
        else {
            return false;
        };
        // User-message events can precede the new turn projection. Receipt
        // confirms delivery, but the previous finished turn must not unlock Send.
        let projected = view.latest_turn.as_ref().is_some_and(|latest| {
            message.turn_id.as_ref() == Some(&latest.turn_id)
                || chrono::DateTime::parse_from_rfc3339(&latest.requested_at.0)
                    .ok()
                    .zip(chrono::DateTime::parse_from_rfc3339(&message.created_at.0).ok())
                    .is_some_and(|(requested, created)| requested >= created)
        });
        projected
            || task.is_some_and(|task| {
                task.turn_request_id.as_deref() == Some(&self.request_key)
                    && (task.idle == Some(true)
                        || matches!(
                            task.state,
                            CloudTaskState::Completed
                                | CloudTaskState::Cancelled
                                | CloudTaskState::Failed
                        ) && task.worker.as_ref().is_none_or(|worker| {
                            matches!(
                                worker.state,
                                CloudWorkerState::Stopped | CloudWorkerState::Deleted
                            )
                        }))
            })
    }
}

fn cloud_stop_is_settled(
    stop: &CloudStopState,
    state: Option<&ThreadState>,
    task: Option<&CloudTask>,
) -> bool {
    if state.is_some_and(|state| state.deleted) {
        return true;
    }
    let live_settled = state
        .filter(|state| state.phase == SyncPhase::Live)
        .and_then(|state| state.view.as_ref())
        .is_some_and(|view| {
            stop.turn_id.as_ref().is_some_and(|turn| {
                view.latest_turn.as_ref().is_some_and(|latest| {
                    latest.turn_id != *turn || latest.state != OrchestrationLatestTurnState::Running
                })
            })
        });
    let relay_settled = task.is_some_and(|task| {
        let newer_request = task
            .turn_request_id
            .as_ref()
            .is_some_and(|id| Some(id) != stop.request_id.as_ref());
        let fresh_terminal = stop
            .task_updated_at
            .as_ref()
            .is_some_and(|baseline| baseline != &task.updated_at.0)
            && matches!(
                task.state,
                CloudTaskState::Cancelled | CloudTaskState::Completed | CloudTaskState::Failed
            )
            && task.worker.as_ref().is_none_or(|worker| {
                matches!(
                    worker.state,
                    CloudWorkerState::Stopped | CloudWorkerState::Deleted
                )
            });
        newer_request
            || fresh_terminal
            || stop.phase == CloudStopPhase::Acknowledged
                && (task.idle == Some(true)
                    || matches!(
                        task.state,
                        CloudTaskState::Cancelled
                            | CloudTaskState::Completed
                            | CloudTaskState::Failed
                    ) && task.worker.as_ref().is_none_or(|worker| {
                        matches!(
                            worker.state,
                            CloudWorkerState::Stopped | CloudWorkerState::Deleted
                        )
                    }))
    });
    live_settled || relay_settled
}

fn switch_status_is_stale(
    current: Option<&vitre_contracts::CloudSwitchStatus>,
    incoming: &vitre_contracts::CloudSwitchStatus,
) -> bool {
    let Some(current) = current.and_then(|status| status.operation.as_ref()) else {
        return false;
    };
    let Some(next) = incoming.operation.as_ref() else {
        return true;
    };
    if current.id == next.id {
        if current
            .revision
            .is_some_and(|revision| next.revision.is_none_or(|next| next <= revision))
        {
            return true;
        }
        return matches!(
            current.phase,
            vitre_contracts::CloudHandoffPhase::Completed
                | vitre_contracts::CloudHandoffPhase::Cancelled
        ) && !matches!(
            next.phase,
            vitre_contracts::CloudHandoffPhase::Completed
                | vitre_contracts::CloudHandoffPhase::Cancelled
        );
    }
    if next.generation != current.generation {
        return next.generation < current.generation;
    }
    // Retried operations can share ownership generation. Their durable start time
    // distinguishes a superseded cancelled operation from the active replacement.
    match (&current.started_at, &next.started_at) {
        (Some(current), Some(next)) => next <= current,
        (Some(_), None) => true,
        _ => true,
    }
}

fn switch_ownership_fenced(operation: &vitre_contracts::CloudHandoffOperation) -> bool {
    use vitre_contracts::{CloudHandoffOperationWaitReason as W, CloudHandoffPhase as P};
    if matches!(operation.phase, P::Completed | P::Cancelled) {
        return false;
    }
    operation.wait_reason == Some(W::OwnershipConfirmation)
        || !matches!(operation.phase, P::Waiting | P::Preparing)
}

pub(crate) struct CloudThreadFeed {
    pub task_id: String,
    pub source: CloudSource,
    pub live: Option<(Arc<EnvironmentClient>, Arc<ThreadHandle>)>,
    pub live_task: Option<Task<()>>,
    pub connect_seq: u64,
    pub connection_identity: Option<String>,
    pub connection_phase: SyncPhase,
}
pub(crate) fn mirror_state(detail: Option<&TaskDetail>) -> ThreadState {
    let view = detail.and_then(|d| d.conversation.clone());
    ThreadState {
        phase: SyncPhase::Disconnected,
        view,
        deleted: false,
    }
}
fn initial_cloud_state(detail: Option<&TaskDetail>, task: Option<&CloudTask>) -> ThreadState {
    let mut state = mirror_state(detail);
    if state.view.is_some() {
        return state;
    }
    let Some(task) = task else {
        return state;
    };
    let shell = synthesize_cloud_shell(task, detail, None);
    let Ok(mut value) = serde_json::to_value(shell) else {
        return state;
    };
    let Some(object) = value.as_object_mut() else {
        return state;
    };
    object.insert("messages".into(), serde_json::json!([{
        "id": format!("cloud-initial-{}", task.id), "role": "user", "text": task.prompt,
        "createdAt": task.created_at, "updatedAt": task.created_at, "streaming": false, "turnId": null
    }]));
    for field in ["activities", "checkpoints"] {
        object.insert(field.into(), serde_json::json!([]));
    }
    object.insert("deletedAt".into(), serde_json::Value::Null);
    state.view = serde_json::from_value::<vitre_contracts::OrchestrationThread>(value)
        .ok()
        .map(Arc::new);
    state
}

fn transcript_timestamp(
    view: &OrchestrationThread,
) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    let messages = view
        .messages
        .iter()
        .flat_map(|message| [message.created_at.0.as_str(), message.updated_at.0.as_str()]);
    let activities = view
        .activities
        .iter()
        .filter(|activity| !conversation_status::infrastructure_activity(&activity.kind.0))
        .map(|activity| activity.created_at.0.as_str());
    let turns = view.latest_turn.iter().flat_map(|turn| {
        std::iter::once(turn.requested_at.0.as_str())
            .chain(turn.started_at.as_ref().map(|at| at.0.as_str()))
            .chain(turn.completed_at.as_ref().map(|at| at.0.as_str()))
    });
    // Thread/session timestamps can be synthesized from relay heartbeats. Only
    // actual transcript content establishes that a mirrored history is newer.
    messages
        .chain(activities)
        .chain(turns)
        .filter_map(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .max()
}

fn preserve_fresher_cloud_history(
    state: &mut ThreadState,
    current: Option<&Arc<OrchestrationThread>>,
) {
    if state.deleted
        || state
            .view
            .as_ref()
            .is_some_and(|view| view.deleted_at.is_some())
    {
        state.deleted = true;
        return;
    }
    let Some(current) = current else { return };
    let newer = state.view.as_ref().is_some_and(|incoming| {
        transcript_timestamp(incoming).is_some_and(|incoming| {
            transcript_timestamp(current).is_none_or(|current| incoming > current)
        }) || (transcript_timestamp(incoming) == transcript_timestamp(current)
            && current
                .messages
                .iter()
                .all(|message| incoming.messages.contains(message))
            && current
                .activities
                .iter()
                .all(|activity| incoming.activities.contains(activity))
            && (incoming.messages.len() > current.messages.len()
                || incoming.activities.len() > current.activities.len()
                || incoming.latest_turn.as_ref().is_some_and(|incoming| {
                    chrono::DateTime::parse_from_rfc3339(&incoming.requested_at.0)
                        .ok()
                        .is_some_and(|incoming| {
                            current
                                .latest_turn
                                .as_ref()
                                .and_then(|current| {
                                    chrono::DateTime::parse_from_rfc3339(&current.requested_at.0)
                                        .ok()
                                })
                                .is_none_or(|current| incoming > current)
                        })
                })))
    });
    if !newer {
        state.view = Some(current.clone());
    }
}
pub(crate) fn worker_is_up(task: &CloudTask) -> bool {
    task.worker
        .as_ref()
        .is_some_and(|worker| worker.state == CloudWorkerState::Ready)
        && cloud::is_active(&task.state)
}
pub(crate) fn repository_matches(identity: &RepositoryIdentity, task: &CloudTask) -> bool {
    if identity
        .provider
        .as_ref()
        .is_some_and(|p| !p.0.eq_ignore_ascii_case("github"))
    {
        return false;
    }
    if identity
        .provider
        .as_ref()
        .is_some_and(|p| p.0.eq_ignore_ascii_case("github"))
        && let (Some(owner), Some(name)) = (&identity.owner, &identity.name)
    {
        return owner.0.eq_ignore_ascii_case(&task.repository.owner)
            && name.0.eq_ignore_ascii_case(&task.repository.name);
    }
    identity.canonical_key.0.eq_ignore_ascii_case(&format!(
        "github.com/{}/{}",
        task.repository.owner, task.repository.name
    ))
}
pub(crate) fn cloud_group_key(task: &CloudTask) -> String {
    format!("cloud:{}", cloud_group_display_name(task).to_lowercase())
}
pub(crate) fn cloud_group_display_name(task: &CloudTask) -> String {
    cloud::repo_label(task)
}
pub(crate) fn synthesize_cloud_shell(
    task: &CloudTask,
    detail: Option<&TaskDetail>,
    project_id: Option<&ProjectId>,
) -> OrchestrationThreadShell {
    let view = detail.and_then(|d| d.conversation.as_deref());
    let latest_turn = view.and_then(|v| v.latest_turn.as_ref());
    OrchestrationThreadShell {
        id: cloud_thread_id(&task.id),
        project_id: project_id
            .cloned()
            .unwrap_or_else(|| ProjectId(cloud_group_key(task))),
        title: tnes(cloud::task_title(task, 120)),
        created_at: task.created_at.clone(),
        updated_at: task.updated_at.clone(),
        branch: Some(tnes(task.branch.clone())),
        worktree_path: None,
        additional_roots: None,
        resolved_additional_roots: None,
        archived_at: task
            .archived_at
            .as_ref()
            .and_then(|value| value.as_ref())
            .map(|value| Some(Some(value.clone()))),
        settled_at: None,
        settled_override: None,
        snoozed_at: None,
        snoozed_until: None,
        has_actionable_proposed_plan: false,
        has_pending_approvals: view
            .is_some_and(|v| !derive_pending_approvals(&v.activities).is_empty()),
        has_pending_user_input: view
            .is_some_and(|v| !derive_pending_user_inputs(&v.activities).is_empty())
            || task.state == CloudTaskState::WaitingForInput
                && view.is_none_or(|v| derive_pending_approvals(&v.activities).is_empty()),
        interaction_mode: Some(Some(
            view.and_then(|v| v.interaction_mode.clone().flatten())
                .unwrap_or(ProviderInteractionMode::Default),
        )),
        runtime_mode: view
            .map(|v| v.runtime_mode.clone())
            .or_else(|| {
                task.runtime_mode
                    .as_ref()
                    .and_then(|mode| serde_json::from_value(serde_json::to_value(mode).ok()?).ok())
            })
            .unwrap_or(RuntimeMode::FullAccess),
        model_selection: view.map(|v| v.model_selection.clone()).unwrap_or_else(|| {
            ModelSelection {
                model: serde_json::json!(
                    task.model
                        .as_deref()
                        .unwrap_or(cloud::provider_label(&task.provider))
                ),
                instance_id: Some(Some(serde_json::json!(match task.provider {
                    CloudProvider::Claude => "claudeAgent",
                    _ => "codex",
                }))),
                options: task.model_options.clone().map(Some),
                provider: None,
            }
        }),
        latest_turn: Some(vitre_contracts::OrchestrationLatestTurn {
            assistant_message_id: view
                .and_then(|v| v.latest_turn.as_ref())
                .and_then(|t| t.assistant_message_id.clone()),
            requested_at: latest_turn
                .map(|turn| turn.requested_at.clone())
                .unwrap_or_else(|| task.created_at.clone()),
            started_at: latest_turn.map_or_else(
                || Some(task.created_at.clone()),
                |turn| turn.started_at.clone(),
            ),
            completed_at: latest_turn.map_or_else(
                || {
                    (task.state == CloudTaskState::Completed || task.idle == Some(true))
                        .then(|| task.updated_at.clone())
                },
                |turn| turn.completed_at.clone(),
            ),
            source_proposed_plan: None,
            state: match task.state {
                _ if task.idle == Some(true) => OrchestrationLatestTurnState::Completed,
                CloudTaskState::Completed => OrchestrationLatestTurnState::Completed,
                CloudTaskState::Failed => OrchestrationLatestTurnState::Error,
                CloudTaskState::Cancelled
                | CloudTaskState::Interrupted
                | CloudTaskState::NeedsAuth
                | CloudTaskState::UsageLimited => OrchestrationLatestTurnState::Interrupted,
                _ => OrchestrationLatestTurnState::Running,
            },
            turn_id: view
                .and_then(|v| v.latest_turn.as_ref())
                .map(|t| t.turn_id.clone())
                .unwrap_or_else(|| vitre_contracts::TurnId(task.id.clone())),
        }),
        latest_user_message_at: view.and_then(|v| {
            v.messages
                .iter()
                .rev()
                .find(|m| m.role == OrchestrationMessageRole::User)
                .map(|m| m.created_at.clone())
        }),
        session: Some(vitre_contracts::OrchestrationSession {
            active_turn_id: None,
            last_error: task.error.clone(),
            provider_instance_id: None,
            provider_name: Some(tnes(cloud::provider_label(&task.provider))),
            runtime_mode: None,
            status: match task.state {
                _ if task.idle == Some(true) => OrchestrationSessionStatus::Ready,
                CloudTaskState::Running => OrchestrationSessionStatus::Running,
                CloudTaskState::Queued | CloudTaskState::Preparing => {
                    OrchestrationSessionStatus::Starting
                }
                _ => OrchestrationSessionStatus::Stopped,
            },
            thread_id: cloud_thread_id(&task.id),
            updated_at: task.updated_at.clone(),
        }),
    }
}
impl ChatApp {
    pub(super) fn thread_location(&self, id: &ThreadId) -> ThreadLocation {
        if let Some(binding) = self.cloud_bindings.get(id) {
            return if binding.target == vitre_contracts::CloudExecutionTarget::Local {
                ThreadLocation::Local
            } else if let Some(task_id) = &binding.cloud_task_id {
                ThreadLocation::Cloud {
                    task_id: task_id.clone(),
                }
            } else {
                ThreadLocation::Local
            };
        }
        ThreadLocation::of(id)
    }
    pub(super) fn execution_thread_id(&self) -> Option<ThreadId> {
        match self.thread.as_ref()?.feed {
            ThreadFeed::Cloud(ref feed) => Some(cloud_thread_id(&feed.task_id)),
            _ => self.thread.as_ref().map(|thread| thread.id.clone()),
        }
    }
    pub(super) fn open_location(&self) -> ThreadLocation {
        self.thread
            .as_ref()
            .map(|t| match &t.feed {
                ThreadFeed::Cloud(feed) => ThreadLocation::Cloud {
                    task_id: feed.task_id.clone(),
                },
                _ => ThreadLocation::Local,
            })
            .unwrap_or(ThreadLocation::Local)
    }
    pub(super) fn open_cloud_task_id(&self) -> Option<String> {
        self.open_location().task_id().map(str::to_owned)
    }
    pub(super) fn is_cloud_thread(&self) -> bool {
        self.open_location().is_cloud()
    }
    pub(super) fn cloud_task(&self, cx: &App) -> Option<CloudTask> {
        self.cloud_store
            .read(cx)
            .task(&self.open_cloud_task_id()?)
            .cloned()
    }
    pub(super) fn cloud_detail(&self, cx: &App) -> Option<TaskDetail> {
        self.cloud_store
            .read(cx)
            .detail(&self.open_cloud_task_id()?)
            .cloned()
    }
    pub(super) fn rebuild_cloud_shells(&mut self, cx: &mut Context<Self>) {
        let store = self.cloud_store.read(cx);
        self.cloud_bindings.clear();
        for binding in store
            .overview
            .as_ref()
            .and_then(|overview| overview.bindings.as_ref())
            .into_iter()
            .flatten()
        {
            self.cloud_bindings
                .insert(ThreadId(binding.local_thread_id.clone()), binding.clone());
            if let Some(task) = &binding.cloud_task_id {
                self.cloud_bindings
                    .insert(cloud_thread_id(task), binding.clone());
            }
            for task in binding.aliases.iter().flatten() {
                self.cloud_bindings
                    .insert(cloud_thread_id(task), binding.clone());
            }
        }
        let tasks = store
            .overview
            .as_ref()
            .map(|o| o.tasks.as_slice())
            .unwrap_or_default();
        let projects = self
            .shell
            .snapshot
            .as_ref()
            .map(|s| s.projects.as_slice())
            .unwrap_or_default();
        let physical_keys: Vec<_> = projects
            .iter()
            .map(vitre_state::project_grouping::derive_physical_project_key)
            .collect();
        let row_order = self.sidebar_project_ids();
        let ordered: Vec<_> = row_order
            .iter()
            .filter_map(|id| projects.iter().find(|p| &p.id == id))
            .chain(
                self.sidebar
                    .order_projects(&physical_keys)
                    .into_iter()
                    .map(|i| &projects[i]),
            )
            .collect();
        self.cloud_project_for_task.clear();
        self.cloud_tasks = tasks.iter().map(|t| (t.id.clone(), t.clone())).collect();
        self.cloud_shells = tasks
            .iter()
            .filter(|task| {
                if let Some(binding) = self.cloud_bindings.get(&cloud_thread_id(&task.id)) {
                    return binding.target != vitre_contracts::CloudExecutionTarget::Local
                        && binding.cloud_task_id.as_ref() == Some(&task.id);
                }
                task.handoff.is_none()
            })
            .map(|task| {
                let project = ordered
                    .iter()
                    .find(|p| task.project_id.as_deref() == Some(&p.id.0))
                    .or_else(|| {
                        ordered.iter().find(|p| {
                            vitre_state::wire_opt::defined3(&p.repository_identity)
                                .flatten()
                                .is_some_and(|identity| repository_matches(identity, task))
                        })
                    });
                let id = project
                    .map(|p| p.id.clone())
                    .unwrap_or_else(|| ProjectId(cloud_group_key(task)));
                self.cloud_project_for_task
                    .insert(task.id.clone(), id.clone());
                let mut shell =
                    synthesize_cloud_shell(task, store.details.get(&task.id), Some(&id));
                if let Some(binding) = self.cloud_bindings.get(&cloud_thread_id(&task.id)) {
                    shell.id = ThreadId(binding.local_thread_id.clone());
                    if let Some(local) = self.shell.snapshot.as_ref().and_then(|snapshot| {
                        snapshot.threads.iter().find(|thread| thread.id == shell.id)
                    }) {
                        shell.project_id = local.project_id.clone();
                    }
                }
                shell
            })
            .collect();
        self.cloud_shell_index = self
            .cloud_shells
            .iter()
            .enumerate()
            .map(|(i, t)| (t.id.clone(), i))
            .collect();
    }
    /// Resolve workspace operations only through the conversation's execution environment.
    /// A disconnected cloud task must never fall back to the desktop sidecar.
    pub(super) fn workspace_client(&self) -> Option<Arc<EnvironmentClient>> {
        match self.thread.as_ref().map(|thread| &thread.feed) {
            Some(ThreadFeed::Cloud(feed)) => feed.live.as_ref().map(|(client, _)| client.clone()),
            _ => self.client.clone(),
        }
    }

    pub(super) fn workspace_cache_key(&self, root: &str) -> Option<String> {
        self.workspace_client()
            .map(|client| format!("{:p}:{root}", Arc::as_ptr(&client)))
    }

    pub(super) fn remote_workspace_roots(&self) -> Vec<String> {
        let Some(client) = self.workspace_client().filter(|_| self.is_cloud_thread()) else {
            return Vec::new();
        };
        let shell = client.shell().borrow().clone();
        let Some(snapshot) = shell.snapshot else {
            return Vec::new();
        };
        let Some(thread) = snapshot
            .threads
            .iter()
            .find(|thread| Some(&thread.id) == self.execution_thread_id().as_ref())
        else {
            return Vec::new();
        };
        let primary = thread
            .worktree_path
            .as_ref()
            .map(|path| path.0.clone())
            .or_else(|| {
                snapshot
                    .projects
                    .iter()
                    .find(|project| project.id == thread.project_id)
                    .map(|project| project.workspace_root.0.clone())
            });
        let mut roots: Vec<String> = primary.into_iter().collect();
        for root in thread
            .resolved_additional_roots
            .as_ref()
            .and_then(|roots| roots.as_ref())
            .into_iter()
            .flatten()
        {
            if let Some(path) = root.path.as_ref().and_then(|path| path.as_ref())
                && !roots.contains(&path.0)
            {
                roots.push(path.0.clone());
            }
        }
        roots
    }

    pub(super) fn open_cloud_thread(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        let Some(task_id) = self.thread_location(&id).task_id().map(str::to_owned) else {
            return;
        };
        log_cloud_timing(
            "open",
            &task_id,
            self.cloud_store
                .read(cx)
                .live_conversation(&task_id)
                .is_some(),
        );
        self.cloud_store
            .update(cx, |store, cx| store.watch(Some(task_id.clone()), cx));
        let state = initial_cloud_state(
            self.cloud_store.read(cx).details.get(&task_id),
            self.cloud_store.read(cx).task(&task_id),
        );
        self.thread = Some(OpenThread {
            id,
            state,
            feed: ThreadFeed::Cloud(CloudThreadFeed {
                task_id,
                source: CloudSource::Mirror,
                live: None,
                live_task: None,
                connect_seq: 0,
                connection_identity: None,
                connection_phase: SyncPhase::Disconnected,
            }),
        });
        // Viewing a finished conversation only mirrors its saved transcript.
        // Waking the worker here would take the provider lease away from
        // conversations that are actually running; the next send wakes it.
        self.sync_cloud_thread(cx);
    }
    pub(super) fn sync_cloud_thread(&mut self, cx: &mut Context<Self>) {
        self.reconcile_cloud_stop(cx);
        let Some(task_id) = self.open_cloud_task_id() else {
            return;
        };
        let identity = (self.cloud_store.read(cx).session == SessionState::SignedIn)
            .then(|| self.cloud_task(cx).as_ref().and_then(connection_identity))
            .flatten();
        let ready = identity.is_some();
        let detail = self.cloud_store.read(cx).details.get(&task_id);
        let mirror = initial_cloud_state(detail, self.cloud_store.read(cx).task(&task_id));
        if let Some(result) = detail.and_then(|d| d.result.as_ref()) {
            let revision = result
                .revision
                .as_ref()
                .map(|r| r.id.clone())
                .unwrap_or_else(|| result.result.diff.0.clone());
            let key = format!("{task_id}:{revision}");
            if self
                .cloud_diff_cache
                .as_ref()
                .is_none_or(|(id, _)| id != &key)
            {
                self.cloud_diff_cache = Some((
                    key,
                    vitre_state::diff_patch::parse_unified_patch(&result.result.diff.0),
                ));
            }
        } else {
            self.cloud_diff_cache = None;
        }
        let Some(OpenThread {
            feed: ThreadFeed::Cloud(feed),
            ..
        }) = &mut self.thread
        else {
            return;
        };
        if !ready || feed.connection_identity != identity {
            feed.connect_seq += 1;
            feed.live_task = None;
            feed.live = None;
            feed.source = CloudSource::Mirror;
            feed.connection_phase = SyncPhase::Disconnected;
            feed.connection_identity = identity;
        }
        let connect = ready && feed.live.is_none() && feed.live_task.is_none();
        if feed.source == CloudSource::Mirror {
            self.apply_cloud_mirror_state(mirror, cx);
        }
        if connect {
            self.connect_cloud_live(task_id, cx);
        }
    }
    fn connect_cloud_live(&mut self, task_id: String, cx: &mut Context<Self>) {
        let Some(client) = self.cloud_store.read(cx).client() else {
            return;
        };
        let cached = self.cloud_store.read(cx).live_conversation(&task_id);
        let Some(OpenThread {
            feed: ThreadFeed::Cloud(feed),
            ..
        }) = &mut self.thread
        else {
            return;
        };
        feed.connect_seq += 1;
        let seq = feed.connect_seq;
        let Some(identity) = feed.connection_identity.clone() else {
            return;
        };
        let is_cached = cached.is_some();
        log_cloud_timing("connect", &task_id, is_cached);
        feed.live_task = Some(cx.spawn(async move |this, cx| {
            let connection = match cached {
                Some(connection) => connection,
                None => {
                    let connect_id = task_id.clone();
                    let result = cx
                        .update(|cx| {
                            Tokio::spawn_result(cx, async move {
                                let remote = Arc::new(client.connect(connect_id.clone()));
                                let thread =
                                    Arc::new(remote.open_thread(cloud_thread_id(&connect_id)));
                                Ok(LiveConversation {
                                    identity,
                                    client: remote,
                                    thread,
                                })
                            })
                        })
                        .await;
                    let Ok(connection) = result else {
                        return;
                    };
                    connection
                }
            };
            let client = connection.client.clone();
            let handle = connection.thread.clone();
            let mut rx = handle.state();
            let mut shell_rx = client.shell();
            let accepted = this
                .update(cx, |app, cx| {
                    if !app.cloud_store.update(cx, |store, _| {
                        store.retain_live_conversation(task_id.clone(), connection)
                    }) {
                        return false;
                    }
                    let Some(OpenThread {
                        feed: ThreadFeed::Cloud(feed),
                        ..
                    }) = &mut app.thread
                    else {
                        return false;
                    };
                    if feed.task_id != task_id || feed.connect_seq != seq {
                        return false;
                    }
                    feed.live = Some((client, handle));
                    true
                })
                .unwrap_or(false);
            if !accepted {
                return;
            }
            let mut logged_live = false;
            loop {
                let state = rx.borrow_and_update().clone();
                let stop = this
                    .update(cx, |app, cx| {
                        let Some(OpenThread {
                            feed: ThreadFeed::Cloud(feed),
                            ..
                        }) = &mut app.thread
                        else {
                            return true;
                        };
                        if feed.task_id != task_id || feed.connect_seq != seq {
                            return true;
                        }
                        feed.connection_phase = state.phase;
                        if state.view.is_some() && state.phase == SyncPhase::Live && !state.deleted
                        {
                            if !logged_live {
                                log_cloud_timing("live", &task_id, is_cached);
                                logged_live = true;
                            }
                            feed.source = CloudSource::Live;
                        }
                        app.apply_cloud_state(state, cx);
                        false
                    })
                    .unwrap_or(true);
                if stop {
                    return;
                }
                let changed = tokio::select! {
                    changed = rx.changed() => changed,
                    changed = shell_rx.changed() => changed,
                };
                if changed.is_err() {
                    return;
                }
            }
        }));
    }
    pub(super) fn apply_cloud_mirror_state(
        &mut self,
        mut state: ThreadState,
        cx: &mut Context<Self>,
    ) {
        preserve_fresher_cloud_history(
            &mut state,
            self.thread
                .as_ref()
                .and_then(|open| open.state.view.as_ref()),
        );
        self.apply_cloud_state(state, cx);
    }

    pub(super) fn apply_cloud_state(&mut self, mut state: ThreadState, cx: &mut Context<Self>) {
        if let Some(open) = &mut self.thread {
            if state.view.is_none() && !state.deleted {
                state.view = open.state.view.clone();
            }
            open.state = state;
        }
        self.reconcile_cloud_stop(cx);
        self.reconcile_cloud_receipt(cx);
        self.reconcile_local_dispatch();
        self.rebuild_timeline(cx);
        self.sync_source_plan_thread(cx);
        cx.notify();
    }
}

impl ChatApp {
    pub(super) fn render_cloud_onboarding(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let store = self.cloud_store.read(cx);
        if !store.has_client() {
            return onboarding_card(
                IconName::LoaderCircle,
                "Connecting to the local service",
                "The desktop backend is still starting. Cloud tasks will be available in a moment.",
                None,
                cx,
            );
        }
        match store.session {
            SessionState::Unknown => {
                return onboarding_card(
                    IconName::LoaderCircle,
                    "Checking your cloud session",
                    "Looking for an existing sign-in…",
                    None,
                    cx,
                );
            }
            SessionState::Disabled => {
                return onboarding_card(
                    IconName::Info,
                    "Cloud is not enabled on this install",
                    "Cloud is not available on this installation yet.",
                    None,
                    cx,
                );
            }
            SessionState::SignedOut | SessionState::SigningIn => {
                let signing_in = store.session == SessionState::SigningIn;
                let actions: AnyElement = h_flex()
                    .gap_2()
                    .child(
                        Button::new("cloud-signin")
                            .primary()
                            .small()
                            .label(if signing_in { "Try again" } else { "Sign in" })
                            .disabled(store.cancelling_signin)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.cloud_store.update(cx, |store, cx| store.sign_in(cx))
                            })),
                    )
                    .when(signing_in, |row| {
                        row.child(
                            Button::new("cloud-signin-cancel")
                                .ghost()
                                .small()
                                .label("Cancel")
                                .disabled(store.cancelling_signin)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.cloud_store
                                        .update(cx, |store, cx| store.cancel_sign_in(cx))
                                })),
                        )
                    })
                    .into_any_element();
                return onboarding_card(
                    IconName::Globe,
                    "Sign in to your cloud deployment",
                    if signing_in {
                        "Finish signing in in the browser window that just opened."
                    } else {
                        "Your browser opens once to authorize this device. Tasks, repositories and usage all live in your own deployment."
                    },
                    Some(actions),
                    cx,
                );
            }
            SessionState::SignedIn => {}
        }
        let Some(overview) = store.overview.as_ref() else {
            return onboarding_card(
                IconName::LoaderCircle,
                "Loading your cloud workspace",
                "Fetching repositories and tasks…",
                None,
                cx,
            );
        };
        if !overview.enabled {
            return onboarding_card(
                IconName::Info,
                "Cloud execution is paused on this deployment",
                "Existing conversations are still available.",
                None,
                cx,
            );
        }
        let _ = window;
        let provider_notice = self.render_provider_notice(cx);
        v_flex()
            .gap_3()
            .children(provider_notice)
            .into_any_element()
    }

    /// Repositories the GitHub App can see but the deployment has not set up
    /// yet. As a blocking card when there are none configured; as a compact
    /// list otherwise.
    fn render_provider_notice(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let store = self.cloud_store.read(cx);
        let provider = self.selected_cloud_provider(cx)?;
        let state = store.account_state(&provider).cloned();
        if state == Some(CloudProviderAccountState::Connected) {
            return None;
        }
        let pending = store.is_pending(&Op::Provider(provider.clone()));
        let login = store
            .login
            .clone()
            .filter(|_| provider == CloudProvider::Codex);
        let label = provider_label(&provider);
        let reason = match state {
            Some(CloudProviderAccountState::NeedsAuth) => {
                format!("{label} needs to be signed in again.")
            }
            Some(CloudProviderAccountState::UsageLimited) => {
                format!("{label} hit its usage limit; reconnect or switch provider.")
            }
            _ => format!("{label} isn't connected to your cloud deployment yet."),
        };
        let connect = provider.clone();
        let mut card = v_flex()
            .gap_2()
            .px_3()
            .py_2p5()
            .rounded_lg()
            .border_1()
            .border_color(cx.theme().warning.opacity(0.35))
            .bg(cx.theme().warning.opacity(0.07))
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(provider_icon(&provider, cx).size_4())
                    .child(div().flex_1().min_w_0().text_sm().child(reason))
                    .child(
                        Button::new("cloud-connect-provider")
                            .outline()
                            .xsmall()
                            .label(match provider {
                                CloudProvider::Claude => "Paste token",
                                _ => "Connect",
                            })
                            .loading(pending)
                            .disabled(pending)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.connect_cloud_provider(connect.clone(), window, cx)
                            })),
                    ),
            );
        if let Some(login) = login {
            card = card.child(render_codex_login(&login, cx));
        }
        Some(card.into_any_element())
    }

    pub(super) fn select_cloud_repository(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.cloud_draft.repository = Some(id.clone());
        if let Some(repo) = self
            .cloud_store
            .read(cx)
            .repositories()
            .iter()
            .find(|r| r.id == id)
        {
            let branch = repo.default_branch.clone();
            self.cloud_branch
                .update(cx, |b, cx| b.set_value(branch, window, cx));
        }
        self.schedule_draft_save(cx);
        cx.notify();
    }

    fn selected_cloud_provider(&self, cx: &App) -> Option<CloudProvider> {
        let selection = self
            .draft_model
            .clone()
            .or_else(|| {
                self.draft_project.as_ref().and_then(|id| {
                    self.shell
                        .snapshot
                        .as_ref()?
                        .projects
                        .iter()
                        .find(|p| &p.id == id)?
                        .default_model_selection
                        .clone()
                })
            })
            .or_else(|| default_model_selection(&self.provider_snapshots, cx))?;
        let (instance, _) = model_selection_identity(&selection)?;
        match instance.as_str() {
            "codex" => Some(CloudProvider::Codex),
            "claudeAgent" | "claude" => Some(CloudProvider::Claude),
            _ => None,
        }
    }

    /// Why the Start button is disabled, if it is.
    pub(super) fn cloud_start_blocker(&self, cx: &App) -> Option<&'static str> {
        if self.cloud_draft.pending_start.is_some() {
            return Some("Check delivery of the pending cloud conversation");
        }
        if self.has_unmapped_cloud_context() {
            return Some("Cloud tasks cannot include unmapped workspace context");
        }
        let store = self.cloud_store.read(cx);
        if store.is_pending(&Op::CreateTask) {
            return Some("Starting cloud task…");
        }
        if !store.has_client() && store.session == SessionState::Unknown {
            return Some("Connecting to the local service…");
        }
        if store.session != SessionState::SignedIn {
            return Some("Sign in to start cloud tasks");
        }
        if store.overview.as_ref().is_some_and(|o| !o.enabled) {
            return Some("Cloud execution is disabled on this deployment");
        }
        if self.draft_project.is_none() {
            return Some("Choose a project first");
        }
        let Some(provider) = self.selected_cloud_provider(cx) else {
            return Some("This provider is not supported by your cloud worker");
        };
        if store.account_state(&provider) != Some(&CloudProviderAccountState::Connected) {
            return Some("Connect the provider account first");
        }
        if self.composer.read(cx).value().trim().is_empty() && self.pending_attachments.is_empty() {
            return Some("Describe the task to start");
        }
        None
    }

    pub(super) fn create_cloud_task(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.cloud_start_blocker(cx).is_some() {
            return;
        }
        let Some(project) = self.draft_project.as_ref().and_then(|id| {
            self.shell
                .snapshot
                .as_ref()?
                .projects
                .iter()
                .find(|p| &p.id == id)
        }) else {
            return;
        };
        let Some(selection) = self
            .draft_model
            .clone()
            .or_else(|| project.default_model_selection.clone())
            .or_else(|| default_model_selection(&self.provider_snapshots, cx))
        else {
            return;
        };
        let Some((instance, model)) = model_selection_identity(&selection) else {
            return;
        };
        let provider = match instance.as_str() {
            "codex" => CloudProvider::Codex,
            "claudeAgent" | "claude" => CloudProvider::Claude,
            _ => {
                self.last_error =
                    Some("This provider is not supported by your cloud worker.".into());
                cx.notify();
                return;
            }
        };
        if project
            .resolved_additional_roots
            .iter()
            .flatten()
            .flatten()
            .any(|root| root.path.as_ref().and_then(|path| path.as_ref()).is_none())
        {
            self.last_error = Some("An additional workspace folder is unavailable. Restore access before moving to Cloud.".into());
            cx.notify();
            return;
        }
        let input = vitre_contracts::CloudStartConversationInput {
            project_id: Some(project.id.0.clone()),
            handoff: None,
            attachments: Some(self.cloud_upload_attachments()),
            idempotency_key: fresh_id("cloud"),
            target: if self.draft_work_location == WorkLocation::CloudLocal {
                vitre_contracts::CloudStartConversationInputTarget::CloudLocal
            } else {
                vitre_contracts::CloudStartConversationInputTarget::CloudGithub
            },
            roots: std::iter::once(vitre_contracts::CloudStartConversationInputRoots {
                id: "primary".into(),
                path: project.workspace_root.0.clone(),
            })
            .chain(
                project
                    .resolved_additional_roots
                    .iter()
                    .flatten()
                    .flatten()
                    .enumerate()
                    .filter_map(|(index, root)| {
                        root.path
                            .as_ref()
                            .and_then(|path| path.as_ref())
                            .map(|path| vitre_contracts::CloudStartConversationInputRoots {
                                id: format!("root-{}", index + 1),
                                path: path.0.clone(),
                            })
                    }),
            )
            .collect(),
            model_options: selection.options.clone().flatten(),
            runtime_mode: Some(
                serde_json::from_value(
                    serde_json::to_value(&self.draft_runtime_mode)
                        .expect("serializable runtime mode"),
                )
                .expect("matching runtime mode schema"),
            ),
            interaction_mode: Some(if self.draft_mode == Some(ProviderInteractionMode::Plan) {
                vitre_contracts::CloudStartConversationInputInteractionMode::Plan
            } else {
                vitre_contracts::CloudStartConversationInputInteractionMode::Default
            }),
            prompt: self.cloud_prompt(cx),
            provider,
            model,
        };
        // The immutable first send is separate from the editable draft.
        self.cloud_draft.request_key = None;
        self.cloud_draft.request_identity = None;
        self.cloud_draft.pending_start = Some(CloudPendingStart {
            input: input.clone(),
            raw_prompt: self.composer.read(cx).value().to_string(),
            attachments: std::mem::take(&mut self.pending_attachments),
            review_comments: std::mem::take(&mut self.pending_review_comments),
            terminal_contexts: std::mem::take(&mut self.pending_terminal_contexts),
            delivery: CloudDeliveryState::Submitting,
            error: None,
            requested_at: now_iso(),
            account_identity: self
                .cloud_store
                .read(cx)
                .account_identity()
                .map(str::to_string),
        });
        self.composer
            .update(cx, |composer, cx| composer.set_value("", window, cx));
        self.cloud_creating_project = self.draft_project.clone();
        self.last_error = None;
        self.dispatch_pending_cloud_start(false, cx);
    }

    pub(super) fn retry_pending_cloud_start(&mut self, cx: &mut Context<Self>) {
        if self.thread.is_some() {
            return;
        }
        let Some(pending) = self.cloud_draft.pending_start.as_ref() else {
            return;
        };
        if self.cloud_store.read(cx).is_pending(&Op::CreateTask) {
            return;
        }
        if pending
            .account_identity
            .as_deref()
            .is_none_or(|account| self.cloud_store.read(cx).account_identity() != Some(account))
        {
            let message = "Sign in to the original cloud account before checking this message.";
            self.last_error = Some(message.into());
            self.cloud_draft.pending_start.as_mut().unwrap().error = Some(message.into());
            self.save_composer_draft(cx);
            cx.notify();
            return;
        }
        self.cloud_draft.pending_start.as_mut().unwrap().delivery = CloudDeliveryState::Submitting;
        self.cloud_creating_project = self.draft_project.clone();
        self.dispatch_pending_cloud_start(true, cx);
    }

    fn dispatch_pending_cloud_start(&mut self, retry: bool, cx: &mut Context<Self>) {
        let Some(pending) = self.cloud_draft.pending_start.as_ref() else {
            return;
        };
        let input = pending.input.clone();
        let Some(project) = input.project_id.clone() else {
            return;
        };
        self.cloud_pending_starts
            .insert(project.clone(), pending.clone());
        let durable = self.drafts.save_confirmed(
            &format!("project:{project}"),
            &self.capture_composer_draft(cx),
        );
        let generation = self.cloud_store.read(cx).account_generation();
        let store = self.cloud_store.clone();
        self.draft_creating = true;
        cx.spawn(async move |_, cx| {
            let saved = durable
                .await
                .unwrap_or_else(|_| Err("The draft writer stopped.".into()));
            store.update(cx, |store, cx| {
                if store.account_generation() != generation {
                    return;
                }
                match saved {
                    Ok(()) if retry => store.retry_creation(input, cx),
                    Ok(()) => store.create_workspace(input, cx),
                    Err(error) => {
                        store.creation_outcomes.insert(
                            input.idempotency_key,
                            crate::cloud::store::CreationResult {
                                project_id: project,
                                outcome: if retry {
                                    crate::cloud::store::CreationOutcome::Unknown(format!(
                                        "Could not save retry: {error}"
                                    ))
                                } else {
                                    crate::cloud::store::CreationOutcome::Rejected(format!(
                                        "Could not save your message: {error}"
                                    ))
                                },
                            },
                        );
                        cx.emit(crate::cloud::store::CloudEvent::Changed);
                        cx.notify();
                    }
                }
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn reconcile_cloud_start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let outcomes = self.cloud_store.read(cx).creation_outcomes.clone();
        for (request, result) in outcomes {
            let current = self.thread.is_none()
                && self
                    .draft_project
                    .as_ref()
                    .is_some_and(|id| id.0 == result.project_id);
            if current {
                self.save_composer_draft(cx);
            }
            let key = format!("project:{}", result.project_id);
            let fallback = self.cloud_pending_starts.get(&result.project_id).cloned();
            let Some(draft) =
                self.drafts
                    .finish_cloud_start(&key, &request, &result.outcome, fallback)
            else {
                continue;
            };
            if let crate::cloud::store::CreationOutcome::Unknown(error) = &result.outcome {
                if let Some(pending) = self.cloud_pending_starts.get_mut(&result.project_id) {
                    pending.delivery = CloudDeliveryState::Unknown;
                    pending.error = Some(error.clone());
                }
            } else {
                self.cloud_pending_starts.remove(&result.project_id);
            }
            if current
                && let crate::cloud::store::CreationOutcome::Rejected(error) = &result.outcome
            {
                self.last_error = Some(error.clone().into());
            }
            self.cloud_store.update(cx, |store, _| {
                store.creation_outcomes.remove(&request);
            });
            let created = match result.outcome {
                crate::cloud::store::CreationOutcome::Accepted(id) => Some(id),
                _ => None,
            };
            if self
                .cloud_creating_project
                .as_ref()
                .is_some_and(|project| project.0 == result.project_id)
            {
                self.draft_creating = false;
                self.cloud_creating_project = None;
            }
            if current {
                self.draft_creating = false;
                self.draft_restore = Some(draft);
                self.restore_composer_draft(window, cx);
            }
            if let Some(id) = created {
                let _ = self.drafts.copy_preferences(&key, &cloud_thread_id(&id).0);
                if current
                    && self.composer.read(cx).value().is_empty()
                    && self.pending_attachments.is_empty()
                {
                    self.select_thread(cloud_thread_id(&id), cx);
                }
            }
            cx.notify();
        }
    }

    pub(super) fn connect_cloud_provider(
        &mut self,
        provider: CloudProvider,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match provider {
            CloudProvider::Claude => {
                let sheet = Sheet::claude_token(window, cx);
                self.open_cloud_sheet(sheet, cx);
            }
            _ => self
                .cloud_store
                .update(cx, |store, cx| store.start_codex_login(cx)),
        }
    }
}

impl ChatApp {
    fn cloud_prompt(&self, cx: &App) -> String {
        let text = self.composer.read(cx).value().trim().to_string();
        let text = if text.is_empty() && !self.pending_attachments.is_empty() {
            "Please review the attached files.".into()
        } else {
            text
        };
        ask_mode_prompt(self.ask_mode, &text)
    }
    fn cloud_upload_attachments(&self) -> Vec<vitre_contracts::UploadChatAttachment> {
        self.pending_attachments
            .iter()
            .map(|attachment| {
                if attachment.is_image {
                    vitre_contracts::UploadChatAttachment::Image {
                        data_url: tnes(&attachment.data_url),
                        mime_type: tnes(&attachment.mime_type),
                        name: tnes(&attachment.name),
                        size_bytes: attachment.size_bytes,
                    }
                } else {
                    vitre_contracts::UploadChatAttachment::File {
                        data_url: tnes(&attachment.data_url),
                        mime_type: tnes(&attachment.mime_type),
                        name: tnes(&attachment.name),
                        size_bytes: attachment.size_bytes,
                    }
                }
            })
            .collect()
    }
    fn has_unmapped_cloud_context(&self) -> bool {
        !self.pending_review_comments.is_empty() || !self.pending_terminal_contexts.is_empty()
    }
    pub(super) fn cloud_send_blocker(&self, cx: &App) -> Option<&'static str> {
        let Some(task) = self.cloud_task(cx) else {
            return Some("This task is no longer available");
        };
        if !self.conversation_status(cx).can_send {
            return Some("This conversation is not ready to send");
        }
        if self
            .cloud_store
            .read(cx)
            .is_pending(&Op::Task(task.id, "continue"))
        {
            return Some("Sending follow-up…");
        }
        None
    }
    pub(super) fn send_cloud(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.cloud_send_blocker(cx).is_some() {
            return;
        }
        let Some(id) = self.open_cloud_task_id() else {
            return;
        };
        if !self.cloud_store.read(cx).has_client() {
            return;
        }
        let raw_prompt = self.composer.read(cx).value().to_string();
        let selections: Vec<_> = self
            .pending_terminal_contexts
            .iter()
            .map(|context| context.selection.clone())
            .collect();
        let prompt = append_review_comments_to_prompt(
            &append_terminal_contexts_to_prompt(&self.cloud_prompt(cx), &selections),
            &self.pending_review_comments,
        );
        if prompt.is_empty() {
            return;
        }
        log_cloud_timing(
            "send",
            &id,
            self.cloud_store.read(cx).live_conversation(&id).is_some(),
        );
        let mut input = vitre_contracts::CloudContinueConversationInput {
            idempotency_key: String::new(),
            task_id: id.clone(),
            prompt: prompt.clone(),
            attachments: self.cloud_upload_attachments(),
        };
        let identity = serde_json::to_string(&input).unwrap_or_default();
        input.idempotency_key = if self.cloud_draft.request_identity.as_deref() == Some(&identity) {
            self.cloud_draft
                .request_key
                .clone()
                .unwrap_or_else(|| fresh_id("cloud-follow-up"))
        } else {
            fresh_id("cloud-follow-up")
        };
        self.cloud_draft.request_identity = Some(identity);
        self.cloud_draft.request_key = Some(input.idempotency_key.clone());
        self.cloud_draft.prompt_recovery = None;
        let at = tnes(now_iso());
        let message_id = MessageId(format!("{}-message", input.idempotency_key));
        self.cloud_pending_send = Some(CloudPendingSend {
            task_id: id.clone(),
            message_id: message_id.clone(),
            requested_at: at.clone(),
            prompt: prompt.clone(),
            attachments: std::mem::take(&mut self.pending_attachments),
            raw_prompt,
            review_comments: std::mem::take(&mut self.pending_review_comments),
            terminal_contexts: std::mem::take(&mut self.pending_terminal_contexts),
            accepted: false,
            request_key: input.idempotency_key.clone(),
            delivery: CloudDeliveryState::Submitting,
            input: Some(input.clone()),
            baseline_ids: self
                .thread
                .as_ref()
                .and_then(|t| t.state.view.as_ref())
                .map(|v| v.messages.iter().map(|m| m.id.clone()).collect())
                .unwrap_or_default(),
        });
        self.optimistic_user_messages.push(OrchestrationMessage {
            attachments: None,
            created_at: at.clone(),
            updated_at: at,
            id: message_id,
            role: OrchestrationMessageRole::User,
            streaming: false,
            text: tnes(prompt.clone()),
            turn_id: None,
        });
        self.rebuild_timeline(cx);
        self.composer
            .update(cx, |s, cx| s.set_value("", window, cx));
        self.save_composer_draft(cx);
        let draft = self.capture_composer_draft(cx);
        let Some(conversation_id) = self.thread.as_ref().map(|thread| thread.id.0.clone()) else {
            return;
        };
        let durable = self.drafts.save_confirmed(&conversation_id, &draft);
        let account_generation = self.cloud_store.read(cx).account_generation();
        let store = self.cloud_store.clone();
        cx.spawn(async move |_, cx| {
            let saved = durable
                .await
                .unwrap_or_else(|_| Err("The draft writer stopped.".into()));
            store.update(cx, |store, cx| {
                if store.account_generation() != account_generation {
                    return;
                }
                match saved {
                    Ok(()) => store.continue_workspace(input, cx),
                    Err(error) => {
                        store.delivery_outcomes.insert(
                            input.idempotency_key,
                            crate::cloud::store::DeliveryOutcome::Rejected(format!(
                                "Could not save your message: {error}"
                            )),
                        );
                        cx.emit(crate::cloud::store::CloudEvent::Changed);
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }
    pub(super) fn cloud_stop_pending(&self) -> bool {
        self.open_cloud_task_id()
            .as_ref()
            .and_then(|id| self.cloud_stops.get(id))
            .is_some()
    }

    fn reconcile_cloud_stop(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.open_cloud_task_id() else {
            return;
        };
        if let Some(stop) = self.cloud_stops.get(&id)
            && let Some(crate::cloud::store::DeliveryOutcome::Rejected(error)) = self
                .cloud_store
                .read(cx)
                .stop_outcomes
                .get(&stop.command_id)
        {
            self.last_error = Some(format!("Stop was rejected: {error}").into());
            let stop = self.cloud_stops.remove(&id).unwrap();
            self.cloud_store
                .update(cx, |store, _| store.finish_stop(&id, &stop.command_id));
            return;
        }
        let Some(stop) = self.cloud_stops.get_mut(&id) else {
            return;
        };
        if let Some(outcome) = self
            .cloud_store
            .read(cx)
            .stop_outcomes
            .get(&stop.command_id)
        {
            match outcome {
                crate::cloud::store::DeliveryOutcome::Accepted => {
                    stop.phase = CloudStopPhase::Acknowledged
                }
                crate::cloud::store::DeliveryOutcome::Unknown(error)
                | crate::cloud::store::DeliveryOutcome::Rejected(error) => {
                    stop.error = Some(format!("Stop could not be confirmed: {error}"));
                }
            }
        }
        let stop = self.cloud_stops.get(&id).unwrap();
        if cloud_stop_is_settled(
            stop,
            self.thread.as_ref().map(|open| &open.state),
            self.cloud_task(cx).as_ref(),
        ) {
            let stop = self.cloud_stops.remove(&id).unwrap();
            self.cloud_store
                .update(cx, |store, _| store.finish_stop(&id, &stop.command_id));
        }
    }

    pub(super) fn cancel_cloud_task(&mut self, cx: &mut Context<Self>) {
        if self.cloud_stop_pending() {
            return;
        }
        let Some(id) = self.open_cloud_task_id() else {
            return;
        };
        let execution_stale = self.conversation_status(cx).facts.execution_stale;
        let active_turn = self
            .thread
            .as_ref()
            .filter(|_| !execution_stale)
            .and_then(|open| {
                let ThreadFeed::Cloud(feed) = &open.feed else {
                    return None;
                };
                cloud_turn_to_interrupt(feed.source, &open.state)
            });
        let command_id = fresh_id("vitre-cloud-stop");
        let task = self.cloud_task(cx);
        let task_updated_at = task.as_ref().map(|task| task.updated_at.0.clone());
        let request_id = task.and_then(|task| task.turn_request_id);
        if let Some(previous) = self.cloud_stops.remove(&id) {
            self.cloud_store
                .update(cx, |store, _| store.finish_stop(&id, &previous.command_id));
        }
        self.cloud_stops.insert(
            id.clone(),
            CloudStopState {
                turn_id: active_turn.clone(),
                command_id: command_id.clone(),
                request_id: request_id.clone(),
                task_updated_at,
                phase: CloudStopPhase::Requested,
                error: None,
            },
        );
        if let (Some(turn_id), Some(client)) = (
            active_turn,
            self.workspace_client()
                .filter(|client| client.sessions().borrow().is_some()),
        ) {
            let command = ClientOrchestrationCommand::ThreadTurnInterrupt {
                command_id: CommandId(command_id.clone()),
                created_at: tnes(now_iso()),
                thread_id: cloud_thread_id(&id),
                turn_id: Some(Some(turn_id)),
                r#type: Default::default(),
            };
            cx.spawn(async move |this, cx| {
                let result = client.dispatch(&command).await;
                let _ = this.update(cx, |app, cx| {
                    if let Some(stop) = app
                        .cloud_stops
                        .get_mut(&id)
                        .filter(|stop| stop.command_id == command_id)
                    {
                        match result {
                            Ok(_) => stop.phase = CloudStopPhase::Acknowledged,
                            Err(error) => {
                                stop.error = Some(format!(
                                    "Stop could not be confirmed: {}",
                                    error.user_message()
                                ))
                            }
                        }
                    }
                    app.cloud_store.update(cx, |store, cx| store.refresh(cx));
                    app.reconcile_cloud_stop(cx);
                    cx.notify();
                });
            })
            .detach();
        } else {
            self.cloud_store.update(cx, |store, cx| {
                store.cancel_task_request(id, command_id, request_id, cx)
            });
        }
        cx.notify();
    }
    fn has_pending_conversation_delivery(&self) -> bool {
        self.thread.is_none() && self.cloud_draft.pending_start.is_some()
            || self
                .thread
                .as_ref()
                .is_some_and(|open| self.local_outbox.contains_key(&open.id))
            || self.open_cloud_task_id().is_some_and(|id| {
                self.cloud_pending_send
                    .as_ref()
                    .is_some_and(|pending| pending.task_id == id)
                    || self.cloud_pending_sends.contains_key(&id)
            })
    }

    pub(super) fn can_switch_work_location(&self) -> bool {
        !self.draft_creating
            && !self.cloud_switch_saving
            && !self.location_switch_pending()
            && !self.has_pending_conversation_delivery()
    }
    pub(super) fn location_switch_pending(&self) -> bool {
        self.cloud_switch
            .as_ref()
            .and_then(|status| status.operation.as_ref())
            .is_some_and(|op| {
                !matches!(
                    op.phase,
                    vitre_contracts::CloudHandoffPhase::Completed
                        | vitre_contracts::CloudHandoffPhase::Cancelled
                )
            })
    }
    pub(super) fn location_switch_blocks_turn(&self) -> bool {
        self.cloud_switch_saving
            || self
                .cloud_switch
                .as_ref()
                .and_then(|status| status.operation.as_ref())
                .is_some_and(switch_ownership_fenced)
    }
    pub(super) fn apply_location_status(
        &mut self,
        status: vitre_contracts::CloudSwitchStatus,
        cx: &mut Context<Self>,
    ) {
        if switch_status_is_stale(self.cloud_switch.as_ref(), &status)
            || !self
                .cloud_store
                .read(cx)
                .accepts_account_revision(status.account_revision)
        {
            return;
        }
        let was_completed = self
            .cloud_switch
            .as_ref()
            .and_then(|status| status.operation.as_ref())
            .is_some_and(|operation| {
                operation.phase == vitre_contracts::CloudHandoffPhase::Completed
            });
        let locked = status.operation.as_ref().is_some_and(|op| {
            !matches!(
                op.phase,
                vitre_contracts::CloudHandoffPhase::Completed
                    | vitre_contracts::CloudHandoffPhase::Cancelled
            )
        });
        let roots = self.workspace_roots();
        let environment = self.workspace_client();
        for panel in self
            .files
            .iter()
            .chain(self.files_cache.iter().map(|(_, panel)| panel))
        {
            if environment
                .as_ref()
                .is_some_and(|client| panel.read(cx).uses_client(client))
                && roots.iter().any(|root| root == panel.read(cx).cwd())
            {
                panel.update(cx, |panel, cx| panel.set_transfer_locked(locked, cx));
            }
        }
        if let Some(binding) = status.binding.as_ref() {
            self.cloud_store.update(cx, |store, cx| {
                if store.apply_binding(binding.clone(), status.account_revision) {
                    cx.notify();
                }
            });
            self.rebuild_cloud_shells(cx);
        }
        // Clear only the error belonging to the recovered handoff, preserving
        // unrelated notifications that may have arrived while it was running.
        if status
            .operation
            .as_ref()
            .is_some_and(|op| op.error.is_none())
            && let Some(previous) = self
                .cloud_switch
                .as_ref()
                .and_then(|status| status.operation.as_ref())
                .and_then(|op| op.error.as_ref())
            && self
                .last_error
                .as_ref()
                .is_some_and(|error| error.as_ref() == previous.0.as_str())
        {
            self.last_error = None;
        }
        if let Some(error) = status.operation.as_ref().and_then(|op| op.error.as_ref())
            && status
                .operation
                .as_ref()
                .is_none_or(|operation| operation.wait_reason.is_none())
            && !matches!(
                error.0.as_str(),
                "Preparing cloud workspace" | "Activating cloud workspace"
            )
        {
            self.last_error = Some(error.0.clone().into());
        }
        let completed = status
            .operation
            .as_ref()
            .is_some_and(|op| op.phase == vitre_contracts::CloudHandoffPhase::Completed);
        self.cloud_switch_selection = status.operation.as_ref().and_then(|op| {
            let failed = op.error.as_ref().is_some_and(|error| {
                !matches!(
                    error.0.as_str(),
                    "Preparing cloud workspace" | "Activating cloud workspace"
                )
            });
            if failed
                || matches!(
                    op.phase,
                    vitre_contracts::CloudHandoffPhase::Completed
                        | vitre_contracts::CloudHandoffPhase::Cancelled
                )
            {
                None
            } else {
                Some(match op.to {
                    vitre_contracts::CloudExecutionTarget::Local => WorkLocation::Local,
                    vitre_contracts::CloudExecutionTarget::CloudLocal => WorkLocation::CloudLocal,
                    _ => WorkLocation::Cloud,
                })
            }
        });
        self.cloud_switch = Some(status);
        if completed
            && !was_completed
            && let Some(id) = self.thread.as_ref().map(|thread| thread.id.clone())
        {
            self.cloud_store.update(cx, |store, cx| store.refresh(cx));
            self.select_thread(id, cx);
        }
        cx.notify();
    }
    pub(super) fn watch_location_switch(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        let Some(client) = self.cloud_store.read(cx).client() else {
            return;
        };
        let generation = self.cloud_transfer_generation;
        let account_generation = self.cloud_store.read(cx).account_generation();
        let binding = self.cloud_bindings.get(&id).cloned();
        let conversation_id = binding
            .as_ref()
            .map(|binding| binding.conversation_id.clone())
            .unwrap_or_else(|| id.0.clone());
        self.cloud_switch_task = Some(cx.spawn(async move |this, cx| {
            loop {
                let result = client.switch_status(conversation_id.clone()).await;
                let recover = this.read_with(cx, |app, cx| {
                    if app.cloud_transfer_generation != generation
                        || app.cloud_store.read(cx).account_generation() != account_generation
                        || app.thread.as_ref().is_none_or(|thread| thread.id != id) { return None; }
                    let status = result.as_ref().ok()?;
                    app.cloud_switch.as_ref().and_then(|status| status.operation.as_ref())
                        .filter(|op| op.revision.is_none() && op.wait_reason == Some(vitre_contracts::CloudHandoffOperationWaitReason::OwnershipConfirmation)
                            && status.operation.as_ref().is_none_or(|registered| registered.id != op.id))
                        .map(|op| vitre_contracts::CloudSwitchInput {
                            idempotency_key: op.id.clone(), conversation_id: op.conversation_id.clone(),
                            local_thread_id: binding.as_ref().map(|b| ThreadId(b.local_thread_id.clone())).unwrap_or_else(|| id.clone()),
                            cloud_task_id: if op.from == vitre_contracts::CloudExecutionTarget::Local { None } else { app.open_cloud_task_id() },
                            target: op.to.clone(),
                        })
                }).ok().flatten();
                // The absent journal is not proof the original request was rejected.
                // Recover that exact idempotent operation, preserving the ownership fence.
                let result = if let Some(input) = recover { client.switch_workspace(&input).await } else { result };
                let keep = this.update(cx, |app, cx| {
                    if app.cloud_transfer_generation != generation
                        || app.cloud_store.read(cx).account_generation() != account_generation
                        || app.thread.as_ref().is_none_or(|thread| thread.id != id) { return false; }
                    if let Ok(status) = result { app.apply_location_status(status, cx); }
                    app.cloud_switch_saving || app.location_switch_pending()
                }).unwrap_or(false);
                if !keep { break; }
                cx.background_executor().timer(Duration::from_secs(2)).await;
            }
        }));
    }
    fn begin_location_switch(
        &mut self,
        location: WorkLocation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_switch_work_location() {
            return;
        }
        let Some(id) = self.thread.as_ref().map(|thread| thread.id.clone()) else {
            return;
        };
        let Some(client) = self.cloud_store.read(cx).client() else {
            return;
        };
        let target = match location {
            WorkLocation::Local => vitre_contracts::CloudExecutionTarget::Local,
            WorkLocation::Cloud => vitre_contracts::CloudExecutionTarget::CloudGithub,
            WorkLocation::CloudLocal => vitre_contracts::CloudExecutionTarget::CloudLocal,
        };
        let binding = self.cloud_bindings.get(&id).cloned();
        let input = vitre_contracts::CloudSwitchInput {
            idempotency_key: fresh_id("switch"),
            conversation_id: binding
                .as_ref()
                .map(|b| b.conversation_id.clone())
                .unwrap_or_else(|| id.0.clone()),
            local_thread_id: binding
                .as_ref()
                .map(|b| ThreadId(b.local_thread_id.clone()))
                .unwrap_or_else(|| id.clone()),
            cloud_task_id: self.open_cloud_task_id(),
            target,
        };
        let from = binding
            .as_ref()
            .map(|b| b.target.clone())
            .unwrap_or_else(|| {
                self.cloud_task(cx)
                    .map(|task| {
                        if matches!(
                            task.source,
                            Some(vitre_contracts::CloudTaskSource::Local { .. })
                        ) {
                            vitre_contracts::CloudExecutionTarget::CloudLocal
                        } else {
                            vitre_contracts::CloudExecutionTarget::CloudGithub
                        }
                    })
                    .unwrap_or(vitre_contracts::CloudExecutionTarget::Local)
            });
        self.cloud_switch = Some(vitre_contracts::CloudSwitchStatus {
            account_revision: None,
            binding: binding.clone(),
            conflict_roots: None,
            conflicts: vec![],
            operation: Some(vitre_contracts::CloudHandoffOperation {
                cancel_requested: Some(false),
                checkpoint: None,
                conversation_id: input.conversation_id.clone(),
                error: None,
                error_disposition: Some(
                    vitre_contracts::CloudHandoffOperationErrorDisposition::UnknownX,
                ),
                from,
                generation: binding.as_ref().map_or(0, |b| b.generation),
                id: input.idempotency_key.clone(),
                phase: vitre_contracts::CloudHandoffPhase::Waiting,
                revision: None,
                started_at: Some(now_iso()),
                updated_at: Some(now_iso()),
                to: input.target.clone(),
                wait_reason: Some(
                    vitre_contracts::CloudHandoffOperationWaitReason::OwnershipConfirmation,
                ),
            }),
        });
        self.save_composer_draft(cx);
        self.cloud_switch_saving = true;
        self.cloud_switch_selection = Some(location);
        self.cloud_transfer_generation += 1;
        let generation = self.cloud_transfer_generation;
        let account_generation = self.cloud_store.read(cx).account_generation();
        let roots = self.workspace_roots();
        let environment = self.workspace_client();
        let panels: Vec<_> = self
            .files
            .iter()
            .cloned()
            .chain(self.files_cache.iter().map(|(_, panel)| panel.clone()))
            .filter(|panel| {
                environment
                    .as_ref()
                    .is_some_and(|client| panel.read(cx).uses_client(client))
                    && roots.iter().any(|root| root == panel.read(cx).cwd())
            })
            .collect();
        for panel in &panels {
            panel.update(cx, |panel, cx| {
                panel.set_transfer_locked(true, cx);
                panel.save_now(window, cx);
            });
        }
        cx.spawn_in(window, async move |this, cx| {
            let mut clean = false;
            for _ in 0..100 {
                clean = this
                    .update(cx, |_, cx| {
                        panels.iter().all(|panel| {
                            panel
                                .read(cx)
                                .active_file_status()
                                .is_none_or(|(_, dirty)| !dirty)
                        })
                    })
                    .unwrap_or(false);
                if clean {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
            }
            let result = if clean {
                client.switch_workspace(&input).await.map_err(|error| {
                    let rejected = matches!(
                        &error,
                        vitre_rpc::RpcError::CloudRequest { rejected: true, .. }
                    );
                    (format!("{error}"), rejected)
                })
            } else {
                Err((
                    "Save the open files before moving this conversation.".to_owned(),
                    true,
                ))
            };
            let _ = this.update(cx, |app, cx| {
                if app.cloud_transfer_generation != generation
                    || app.cloud_store.read(cx).account_generation() != account_generation
                    || app.thread.as_ref().is_none_or(|thread| thread.id != id)
                {
                    return;
                }
                app.cloud_switch_saving = false;
                match result {
                    Ok(status) => {
                        if app.thread.as_ref().is_some_and(|thread| thread.id == id) {
                            app.apply_location_status(status, cx);
                            app.watch_location_switch(id, cx);
                        }
                    }
                    Err((error, rejected)) => {
                        app.cloud_switch_selection = None;
                        if rejected {
                            app.cloud_switch = None;
                            for panel in &panels {
                                panel.update(cx, |panel, cx| panel.set_transfer_locked(false, cx));
                            }
                        } else {
                            app.watch_location_switch(id.clone(), cx);
                        }
                        app.last_error = Some(error.into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn edit_switch_conflict(
        &mut self,
        path: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((id, relative)) = path.split_once('/') else {
            return;
        };
        let root = self
            .cloud_switch
            .as_ref()
            .and_then(|status| status.conflict_roots.as_ref())
            .and_then(|roots| roots.iter().find(|root| root.id == id))
            .map(|root| root.path.clone());
        if let (Some(root), Some(key)) = (root, self.dock_thread_key()) {
            self.right_panel
                .map
                .open_file(&key, relative, None, None, Some(&root));
            self.after_dock_change(true, window, cx);
        }
    }
    pub(super) fn resolve_switch_conflicts(
        &mut self,
        choice: vitre_contracts::CloudSwitchResolveInputChoice,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(operation_id) = self
            .cloud_switch
            .as_ref()
            .and_then(|status| status.operation.as_ref())
            .map(|op| op.id.clone())
        else {
            return;
        };
        let Some(client) = self.cloud_store.read(cx).client() else {
            return;
        };
        let id = self.thread.as_ref().map(|thread| thread.id.clone());
        let expected_operation = operation_id.clone();
        let transfer_generation = self.cloud_transfer_generation;
        let account_generation = self.cloud_store.read(cx).account_generation();
        let panels: Vec<_> = self
            .files
            .iter()
            .cloned()
            .chain(self.files_cache.iter().map(|(_, panel)| panel.clone()))
            .filter(|panel| {
                self.cloud_switch
                    .as_ref()
                    .and_then(|status| status.conflict_roots.as_ref())
                    .is_some_and(|roots| roots.iter().any(|root| root.path == panel.read(cx).cwd()))
            })
            .collect();
        for panel in &panels {
            panel.update(cx, |panel, cx| panel.save_now(window, cx));
        }
        cx.spawn_in(window, async move |this, cx| {
            let mut saved = false;
            for _ in 0..100 {
                saved = this
                    .update(cx, |_, cx| {
                        panels.iter().all(|panel| {
                            panel
                                .read(cx)
                                .active_file_status()
                                .is_none_or(|(_, dirty)| !dirty)
                        })
                    })
                    .unwrap_or(false);
                if saved {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
            }
            let result = if saved {
                client
                    .resolve_switch(&vitre_contracts::CloudSwitchResolveInput {
                        operation_id,
                        choice,
                    })
                    .await
                    .map_err(|e| format!("{e}"))
            } else {
                Err("Save your conflict resolutions before continuing.".into())
            };
            let _ = this.update(cx, |app, cx| {
                if app.cloud_transfer_generation != transfer_generation
                    || app.cloud_store.read(cx).account_generation() != account_generation
                    || app.thread.as_ref().map(|thread| &thread.id) != id.as_ref()
                    || app
                        .cloud_switch
                        .as_ref()
                        .and_then(|status| status.operation.as_ref())
                        .is_none_or(|op| op.id != expected_operation)
                {
                    return;
                }
                match result {
                    Ok(status) => app.apply_location_status(status, cx),
                    Err(error) => app.last_error = Some(error.into()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn retry_location_switch(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(operation) = self
            .cloud_switch
            .as_ref()
            .and_then(|status| status.operation.clone())
        else {
            return;
        };
        let Some(client) = self.cloud_store.read(cx).client() else {
            return;
        };
        let selected = self.thread.as_ref().map(|thread| thread.id.clone());
        let transfer_generation = self.cloud_transfer_generation;
        let account_generation = self.cloud_store.read(cx).account_generation();
        let input = vitre_contracts::CloudSwitchInput {
            idempotency_key: operation.id.clone(),
            conversation_id: operation.conversation_id,
            local_thread_id: self
                .cloud_switch
                .as_ref()
                .and_then(|status| status.binding.as_ref())
                .map(|binding| ThreadId(binding.local_thread_id.clone()))
                .or_else(|| selected.clone())
                .unwrap_or_else(|| cloud_thread_id("unknown")),
            cloud_task_id: self.open_cloud_task_id(),
            target: operation.to,
        };
        cx.spawn(async move |this, cx| {
            let result = client.switch_workspace(&input).await;
            let _ = this.update(cx, |app, cx| {
                if app.cloud_transfer_generation != transfer_generation
                    || app.cloud_store.read(cx).account_generation() != account_generation
                    || app.thread.as_ref().map(|thread| &thread.id) != selected.as_ref()
                    || app
                        .cloud_switch
                        .as_ref()
                        .and_then(|status| status.operation.as_ref())
                        .is_none_or(|current| current.id != input.idempotency_key)
                {
                    return;
                }
                match result {
                    Ok(status) => {
                        app.apply_location_status(status, cx);
                        if let Some(id) = selected {
                            app.watch_location_switch(id, cx);
                        }
                    }
                    Err(error) => {
                        app.last_error = Some(error.to_string().into());
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    pub(super) fn cancel_location_switch(&mut self, cx: &mut Context<Self>) {
        let Some(op) = self
            .cloud_switch
            .as_ref()
            .and_then(|status| status.operation.as_ref())
            .map(|op| op.id.clone())
        else {
            return;
        };
        let Some(client) = self.cloud_store.read(cx).client() else {
            return;
        };
        let selected = self.thread.as_ref().map(|thread| thread.id.clone());
        let transfer_generation = self.cloud_transfer_generation;
        let account_generation = self.cloud_store.read(cx).account_generation();
        let operation = op.clone();
        cx.spawn(async move |this, cx| {
            let result = client.cancel_switch(op).await;
            let _ = this.update(cx, |app, cx| {
                if app.cloud_transfer_generation != transfer_generation
                    || app.cloud_store.read(cx).account_generation() != account_generation
                    || app.thread.as_ref().map(|thread| &thread.id) != selected.as_ref()
                    || app
                        .cloud_switch
                        .as_ref()
                        .and_then(|status| status.operation.as_ref())
                        .is_none_or(|op| op.id != operation)
                {
                    return;
                }
                match result {
                    Ok(status) => app.apply_location_status(status, cx),
                    Err(error) => app.last_error = Some(format!("{error}").into()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn set_draft_work_location(
        &mut self,
        location: WorkLocation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_switch_work_location() {
            return;
        }
        if self.thread.is_some() {
            self.begin_location_switch(location, window, cx);
            return;
        }
        if location.is_cloud() && self.has_unmapped_cloud_context() {
            self.last_error = Some("Cloud tasks cannot include unmapped workspace context. Remove them before choosing Cloud.".into());
            cx.notify();
            return;
        }
        self.draft_work_location = location;
        if location.is_cloud()
            && let Some(project) = self.draft_project.clone()
        {
            ClientSettings::update(cx, |settings| {
                settings.cloud_method_by_project.insert(
                    project.0,
                    if location == WorkLocation::CloudLocal {
                        "cloud-local"
                    } else {
                        "cloud-github"
                    }
                    .into(),
                );
            });
        }
        self.last_error = None;
        self.sync_cloud_draft(window, cx);
        self.schedule_draft_save(cx);
        cx.notify();
    }
    pub(super) fn sync_cloud_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let repos = self.cloud_store.read(cx).repositories();
        let selected = repos
            .iter()
            .find(|r| Some(&r.id) == self.cloud_draft.repository.as_ref());
        let identity = self
            .draft_project
            .as_ref()
            .and_then(|id| {
                self.shell
                    .snapshot
                    .as_ref()?
                    .projects
                    .iter()
                    .find(|p| &p.id == id)
            })
            .and_then(|p| vitre_state::wire_opt::defined3(&p.repository_identity).flatten());
        let repo = selected
            .or_else(|| {
                repos.iter().find(|r| {
                    identity.is_some_and(|i| {
                        i.owner
                            .as_ref()
                            .is_some_and(|o| o.0.eq_ignore_ascii_case(&r.owner))
                            && i.name
                                .as_ref()
                                .is_some_and(|n| n.0.eq_ignore_ascii_case(&r.name))
                    })
                })
            })
            .cloned();
        if let Some(repo) = repo {
            if self.cloud_draft.repository.as_ref() != Some(&repo.id)
                || self.cloud_branch.read(cx).value().trim().is_empty()
            {
                self.cloud_branch
                    .update(cx, |b, cx| b.set_value(repo.default_branch, window, cx));
            }
            self.cloud_draft.repository = Some(repo.id);
        } else {
            self.cloud_draft.repository = None;
        }
    }
    pub(super) fn new_cloud_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.new_thread(None, window, cx);
        let method = self.draft_project.as_ref().and_then(|project| {
            ClientSettings::get(cx)
                .cloud_method_by_project
                .get(&project.0)
                .cloned()
        });
        let location = if method.as_deref() == Some("cloud-local") {
            WorkLocation::CloudLocal
        } else {
            WorkLocation::Cloud
        };
        self.set_draft_work_location(location, window, cx);
    }
    pub(super) fn open_cloud_sheet(&mut self, sheet: Sheet, cx: &mut Context<Self>) {
        self.cloud_sheet = Some(sheet);
        cx.notify();
    }
    pub(super) fn render_cloud_sheet(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let sheet = self.cloud_sheet.as_ref()?;
        let pending = sheet.is_pending(self.cloud_store.read(cx));
        let card = cloud::render_sheet_card(
            sheet,
            pending,
            cx.listener(|this, _, _, cx| {
                if let Some(sheet) = this.cloud_sheet.take() {
                    sheet.submit(&this.cloud_store, cx);
                }
                cx.notify();
            }),
            cx.listener(|this, _, _, cx| {
                this.cloud_sheet = None;
                cx.notify();
            }),
            cx,
        );
        Some(
            div()
                .id("cloud-sheet-backdrop")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .items_start()
                .justify_center()
                .pt_8()
                .bg(gpui::black().opacity(0.35))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.cloud_sheet = None;
                    cx.notify();
                }))
                .child(
                    div()
                        .id("cloud-sheet")
                        .w(px(520.))
                        .max_w_full()
                        .on_click(|_, _, cx| cx.stop_propagation())
                        .child(card),
                )
                .into_any_element(),
        )
    }
    fn github_location_available(&self, cx: &App) -> bool {
        if self
            .cloud_task(cx)
            .is_some_and(|task| task.repository.installation_id != "local")
        {
            return true;
        }
        let is_github = |project: &vitre_contracts::OrchestrationProjectShell| {
            vitre_state::wire_opt::defined3(&project.repository_identity)
                .flatten()
                .and_then(|identity| identity.provider.as_ref())
                .is_some_and(|provider| provider.0.eq_ignore_ascii_case("github"))
        };
        if let Some(client) = self.workspace_client().filter(|_| self.is_cloud_thread()) {
            let shell = client.shell().borrow().clone();
            if shell
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.projects.iter().any(&is_github))
            {
                return true;
            }
        }
        let project_id = self.draft_project.as_ref().or_else(|| {
            self.thread
                .as_ref()
                .and_then(|thread| self.shell_thread(&thread.id))
                .map(|thread| &thread.project_id)
        });
        self.shell.snapshot.as_ref().is_some_and(|snapshot| {
            snapshot
                .projects
                .iter()
                .any(|project| Some(&project.id) == project_id && is_github(project))
        })
    }
    pub(super) fn render_location_switch(&self, cx: &mut Context<Self>) -> AnyElement {
        let selected = {
            self.cloud_task(cx)
                .map(|task| {
                    if matches!(
                        task.source,
                        Some(vitre_contracts::CloudTaskSource::Local { .. })
                    ) {
                        WorkLocation::CloudLocal
                    } else {
                        WorkLocation::Cloud
                    }
                })
                .unwrap_or(if self.thread.is_some() {
                    WorkLocation::Local
                } else {
                    self.draft_work_location
                })
        };
        let disabled = !self.can_switch_work_location();
        let github_available = self.github_location_available(cx);
        let owner = cx.entity().downgrade();
        let (label, icon) = match selected {
            WorkLocation::Local => ("Local", IconName::Folder),
            WorkLocation::Cloud => ("Cloud: GitHub", IconName::Globe),
            WorkLocation::CloudLocal => ("Cloud: Local", IconName::Globe),
        };
        h_flex()
            .id("thread-location-thumb")
            .debug_selector(|| "thread-location-switch".into())
            .gap_1()
            .child(
                Button::new("thread-location-picker")
                    .ghost()
                    .small()
                    .icon(icon)
                    .label(label)
                    .disabled(disabled)
                    .tooltip("Choose where this conversation runs")
                    .dropdown_menu(move |mut menu, _, _| {
                        for (location, label) in [
                            (WorkLocation::Local, "Local"),
                            (WorkLocation::Cloud, "Cloud: GitHub"),
                            (WorkLocation::CloudLocal, "Cloud: Local"),
                        ] {
                            let owner = owner.clone();
                            menu = menu.item(
                                PopupMenuItem::new(label)
                                    .checked(selected == location)
                                    .disabled(location == WorkLocation::Cloud && !github_available)
                                    .on_click(move |_, window, cx| {
                                        let _ = owner.update(cx, |app, cx| {
                                            app.set_draft_work_location(location, window, cx)
                                        });
                                    }),
                            );
                        }
                        if !github_available {
                            menu = menu
                                .item(PopupMenuItem::label("No GitHub remote; use Cloud: Local"));
                        }
                        menu
                    }),
            )
            .into_any_element()
    }
    pub(super) fn render_draft_header(&self, cx: &mut Context<Self>) -> AnyElement {
        h_flex()
            .h(px(crate::ui::CHROME_HEIGHT))
            .w_full()
            .px_5()
            .gap_2()
            .justify_end()
            .items_center()
            .flex_shrink_0()
            .child(
                Button::new("toggle-right-panel")
                    .ghost()
                    .xsmall()
                    .icon(IconName::PanelRightOpen)
                    .tooltip("Toggle right panel")
                    .on_click(cx.listener(|this, _, w, cx| this.toggle_right_panel(w, cx))),
            )
            .into_any_element()
    }
}

impl ChatApp {
    pub(super) fn render_cloud_publish_actions(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        use vitre_contracts::{
            CloudCommandPublicationCreateKind, CloudPublicationState, CloudTaskKind,
        };
        let task = self.cloud_task(cx)?;
        let store = self.cloud_store.read(cx);
        let publications: Vec<_> = store
            .overview
            .as_ref()
            .map(|o| {
                o.publications
                    .iter()
                    .filter(|p| p.task_id == task.id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let published = publications
            .iter()
            .find(|p| p.state == CloudPublicationState::Published && p.url.is_some());
        let pending = store.is_pending(&Op::Publish(task.id.clone()))
            || publications.iter().any(|p| {
                matches!(
                    p.state,
                    CloudPublicationState::Queued | CloudPublicationState::Publishing
                )
            });
        let mut actions = h_flex().gap_2().items_center();
        if let Some(published) = published {
            let url = published.url.clone().unwrap_or_default();
            actions = actions.child(
                div().debug_selector(|| "cloud-open-pr".into()).child(
                    Button::new("cloud-open-pr")
                        .primary()
                        .small()
                        .label(
                            if published.kind == vitre_contracts::CloudPublicationKind::PullRequest
                            {
                                "Open PR"
                            } else {
                                "Open comment"
                            },
                        )
                        .on_click(move |_, _, cx| cx.open_url(&url)),
                ),
            );
        } else if let Some(revision) = task
            .result
            .clone()
            .filter(|_| task.kind != CloudTaskKind::Ask)
        {
            let investigate =
                task.kind == CloudTaskKind::Investigate && task.issue_number.is_some();
            let title = cloud::task_title(&task, 72);
            let summary = self
                .cloud_detail(cx)
                .and_then(|d| d.result)
                .map(|r| r.result.summary.0)
                .unwrap_or_else(|| revision.summary.0.clone());
            let id = task.id.clone();
            actions = actions.child(
                div().debug_selector(|| "cloud-publish".into()).child(
                    Button::new("cloud-publish")
                        .primary()
                        .small()
                        .label(if investigate {
                            "Post to issue"
                        } else {
                            "Create PR"
                        })
                        .disabled(pending)
                        .loading(pending)
                        .on_click(cx.listener(move |this, _, w, cx| {
                            let kind = if investigate {
                                CloudCommandPublicationCreateKind::IssueComment
                            } else {
                                CloudCommandPublicationCreateKind::PullRequest
                            };
                            let sheet = Sheet::publish(
                                id.clone(),
                                revision.clone(),
                                kind,
                                title.clone(),
                                summary.clone(),
                                w,
                                cx,
                            );
                            this.open_cloud_sheet(sheet, cx);
                        })),
                ),
            );
        }
        for publication in &publications {
            if publication.state != CloudPublicationState::Published {
                actions = actions.child(cloud::render_publication_chip(publication, &task.id, cx));
            }
        }
        Some(actions.into_any_element())
    }
    pub(super) fn retry_cloud_task(&mut self, cx: &mut Context<Self>) {
        let Some(task) = self.cloud_task(cx) else {
            return;
        };
        self.cloud_store
            .update(cx, |store, cx| store.retry_task(task, cx));
    }
}

impl ChatApp {
    pub(super) fn cloud_delivery_status(&self, cx: &App) -> Option<CloudDeliveryState> {
        let id = self.open_cloud_task_id()?;
        let pending = self
            .cloud_pending_send
            .as_ref()
            .filter(|pending| pending.task_id == id)
            .or_else(|| self.cloud_pending_sends.get(&id))?;
        if pending.accepted
            || self
                .cloud_task(cx)
                .is_some_and(|task| task.turn_request_id.as_deref() == Some(&pending.request_key))
        {
            return Some(CloudDeliveryState::Accepted);
        }
        Some(
            match self
                .cloud_store
                .read(cx)
                .delivery_outcomes
                .get(&pending.request_key)
            {
                Some(crate::cloud::store::DeliveryOutcome::Accepted) => {
                    CloudDeliveryState::Accepted
                }
                Some(crate::cloud::store::DeliveryOutcome::Unknown(_)) => {
                    CloudDeliveryState::Unknown
                }
                Some(crate::cloud::store::DeliveryOutcome::Rejected(_)) => {
                    CloudDeliveryState::Rejected
                }
                None => pending.delivery,
            },
        )
    }

    pub(super) fn restore_cloud_outbox_message(&mut self, cx: &mut Context<Self>) {
        let Some(pending) = self.cloud_pending_send.as_ref() else {
            return;
        };
        let exists = self
            .thread
            .as_ref()
            .and_then(|open| open.state.view.as_ref())
            .is_some_and(|view| {
                view.messages
                    .iter()
                    .any(|message| pending.matches_message(message))
            });
        if !exists
            && !self
                .optimistic_user_messages
                .iter()
                .any(|message| message.id == pending.message_id)
        {
            self.optimistic_user_messages.push(OrchestrationMessage {
                attachments: None,
                created_at: pending.requested_at.clone(),
                updated_at: pending.requested_at.clone(),
                id: pending.message_id.clone(),
                role: OrchestrationMessageRole::User,
                streaming: false,
                text: tnes(pending.prompt.clone()),
                turn_id: None,
            });
        }
        self.rebuild_timeline(cx);
    }

    pub(super) fn retry_pending_cloud_send(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.open_cloud_task_id() else {
            return;
        };
        // The active account must authoritatively own this task before the saved
        // outbox may be retried. A task UUID cannot migrate between accounts.
        let Some(task) = self.cloud_task(cx) else {
            return;
        };
        let receipt = task.turn_request_id;
        let Some(pending) = self
            .cloud_pending_send
            .as_mut()
            .filter(|pending| pending.task_id == id)
        else {
            return;
        };
        if pending.accepted
            || receipt.as_deref() == Some(pending.request_key.as_str())
            || self
                .cloud_store
                .read(cx)
                .is_pending(&Op::Task(id, "continue"))
        {
            return;
        }
        let Some(input) = pending.input.clone().filter(|input| {
            input.idempotency_key == pending.request_key
                && input.task_id == pending.task_id
                && input.prompt == pending.prompt
        }) else {
            return;
        };
        pending.delivery = CloudDeliveryState::Submitting;
        self.save_composer_draft(cx);
        let Some(conversation_id) = self.thread.as_ref().map(|thread| thread.id.0.clone()) else {
            return;
        };
        let durable = self
            .drafts
            .save_confirmed(&conversation_id, &self.capture_composer_draft(cx));
        let account_generation = self.cloud_store.read(cx).account_generation();
        let store = self.cloud_store.clone();
        cx.spawn(async move |_, cx| {
            let saved = durable
                .await
                .unwrap_or_else(|_| Err("The draft writer stopped.".into()));
            store.update(cx, |store, cx| {
                if store.account_generation() != account_generation {
                    return;
                }
                match saved {
                    Ok(()) => store.retry_workspace(input, cx),
                    // This message may already have been accepted before restart;
                    // failure to persist a retry cannot reject the original send.
                    Err(error) => {
                        store.delivery_outcomes.insert(
                            input.idempotency_key,
                            crate::cloud::store::DeliveryOutcome::Unknown(format!(
                                "Could not save retry state: {error}"
                            )),
                        );
                        cx.emit(crate::cloud::store::CloudEvent::Changed);
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    fn reconcile_cloud_receipt(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(pending) = self
            .cloud_pending_send
            .as_ref()
            .filter(|pending| self.open_cloud_task_id().as_deref() == Some(&pending.task_id))
        else {
            return false;
        };
        let Some(view) = self
            .thread
            .as_ref()
            .and_then(|open| open.state.view.as_ref())
        else {
            return false;
        };
        if !view
            .messages
            .iter()
            .any(|message| pending.matches_message(message))
        {
            return false;
        }
        let projected = pending.execution_projected(view, self.cloud_task(cx).as_ref());
        self.optimistic_user_messages
            .retain(|message| message.id != pending.message_id);
        if projected {
            let pending = self.cloud_pending_send.take().unwrap();
            self.cloud_pending_sends.remove(&pending.task_id);
            self.cloud_store
                .update(cx, |store, _| store.finish_delivery(&pending.request_key));
            self.cloud_draft.request_key = None;
            self.cloud_draft.request_identity = None;
            self.cloud_draft.prompt_recovery = None;
            self.save_composer_draft(cx);
        } else {
            let pending = self.cloud_pending_send.as_mut().unwrap();
            if !pending.accepted || pending.delivery != CloudDeliveryState::Accepted {
                pending.accepted = true;
                pending.delivery = CloudDeliveryState::Accepted;
                self.save_composer_draft(cx);
            }
        }
        true
    }

    pub(super) fn reconcile_cloud_send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.open_cloud_task_id() else {
            return;
        };
        let Some(pending) = self
            .cloud_pending_send
            .as_ref()
            .filter(|pending| pending.task_id == id)
        else {
            return;
        };
        let receipt = self
            .cloud_task(cx)
            .is_some_and(|task| task.turn_request_id.as_deref() == Some(&pending.request_key));
        if self.reconcile_cloud_receipt(cx) {
            self.rebuild_timeline(cx);
            return;
        }
        let pending = self.cloud_pending_send.as_ref().unwrap();
        let outcome = if receipt {
            Some(crate::cloud::store::DeliveryOutcome::Accepted)
        } else {
            self.cloud_store
                .read(cx)
                .delivery_outcomes
                .get(&pending.request_key)
                .cloned()
        };
        match outcome {
            Some(crate::cloud::store::DeliveryOutcome::Accepted) => {
                let pending = self.cloud_pending_send.as_mut().unwrap();
                if !pending.accepted {
                    pending.accepted = true;
                    pending.delivery = CloudDeliveryState::Accepted;
                    self.save_composer_draft(cx);
                }
            }
            Some(crate::cloud::store::DeliveryOutcome::Unknown(_)) => {
                let pending = self.cloud_pending_send.as_mut().unwrap();
                if pending.delivery != CloudDeliveryState::Unknown && !pending.accepted {
                    pending.delivery = CloudDeliveryState::Unknown;
                    self.save_composer_draft(cx);
                }
            }
            Some(crate::cloud::store::DeliveryOutcome::Rejected(error)) if !pending.accepted => {
                let pending = self.cloud_pending_send.take().unwrap();
                self.cloud_draft.request_key = None;
                self.cloud_draft.request_identity = None;
                self.cloud_draft.prompt_recovery = None;
                self.cloud_pending_sends.remove(&pending.task_id);
                self.cloud_store
                    .update(cx, |store, _| store.finish_delivery(&pending.request_key));
                self.optimistic_user_messages
                    .retain(|message| message.id != pending.message_id);
                self.composer.update(cx, |input, cx| {
                    let newer = input.value().to_string();
                    input.set_value(
                        if newer.is_empty() {
                            pending.raw_prompt
                        } else {
                            format!("{}\n{newer}", pending.raw_prompt)
                        },
                        window,
                        cx,
                    );
                });
                self.pending_attachments.splice(0..0, pending.attachments);
                self.pending_review_comments
                    .splice(0..0, pending.review_comments);
                self.pending_terminal_contexts
                    .splice(0..0, pending.terminal_contexts);
                self.last_error = Some(error.into());
                self.save_composer_draft(cx);
                self.rebuild_timeline(cx);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::tests::fixtures::*;
    #[test]
    fn nested_legacy_ask_wrappers_are_hidden_without_removing_user_authored_tags() {
        let user_text = "Explain <vitre_ask_mode> and </vitre_ask_mode>";
        let nested = ask_mode_prompt(true, &ask_mode_prompt(true, user_text));
        let cloud = format!(
            "{nested}\n\n<vitre_cloud_context>\nCloud instructions\n</vitre_cloud_context>"
        );
        assert_eq!(displayed_user_prompt(&cloud), user_text);
        assert!(cloud.starts_with("<vitre_ask_mode>"));
        let authored = "<vitre_ask_mode>\nMy own instructions\n</vitre_ask_mode>\n\nQuestion";
        assert_eq!(displayed_user_prompt(authored), authored);
        let mut deeply_nested = user_text.to_string();
        for _ in 0..9 {
            deeply_nested = ask_mode_prompt(true, &deeply_nested);
        }
        assert_eq!(
            displayed_user_prompt(&deeply_nested),
            ask_mode_prompt(true, user_text)
        );
    }
    #[test]
    fn preparing_cloud_keeps_the_message_and_model_visible() {
        let mut task = task("pending", CloudTaskState::Preparing, false);
        task.prompt = ask_mode_prompt(true, "Explain this repository");
        task.model = Some("gpt-6-sol".into());
        task.model_options = Some(serde_json::json!({"reasoningEffort": "medium"}));
        assert_eq!(cloud::task_title(&task, 120), "Explain this repository");
        let state = initial_cloud_state(None, Some(&task));
        let view = state
            .view
            .expect("a preparing conversation must show its first message");
        assert_eq!(
            displayed_user_prompt(&view.messages[0].text.0),
            "Explain this repository"
        );
        assert_eq!(view.model_selection.model, serde_json::json!("gpt-6-sol"));
        assert_eq!(view.model_selection.options, task.model_options.map(Some));
    }

    #[test]
    fn thread_location_parses_cloud_prefix_and_round_trips() {
        for id in ["task-1", "cloud-nested", "uuid"] {
            assert_eq!(ThreadLocation::of(&cloud_thread_id(id)).task_id(), Some(id));
        }
        for id in ["local-1", "cloud-", ""] {
            assert_eq!(
                ThreadLocation::of(&ThreadId(id.into())),
                ThreadLocation::Local
            );
        }
    }
    #[test]
    fn repository_matches_local_identity_case_insensitively() {
        let task = task("task-1", CloudTaskState::Running, false);
        let mut identity: RepositoryIdentity = serde_json::from_value(serde_json::json!({"canonicalKey":"github.com/ACME/VITRE","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"https://github.com/acme/vitre"},"provider":"github","owner":"ACME","name":"VITRE"})).unwrap();
        assert!(repository_matches(&identity, &task));
        identity.owner = None;
        identity.name = None;
        assert!(repository_matches(&identity, &task));
        identity.provider = Some(tnes("gitlab"));
        assert!(!repository_matches(&identity, &task));
        identity.provider = None;
        identity.canonical_key = tnes("github.com/acme/vitre-other");
        assert!(!repository_matches(&identity, &task));
    }
    #[test]
    fn synthesized_shell_reflects_task_state_and_pending_interactions() {
        let t = task("task-1", CloudTaskState::WaitingForInput, false);
        let shell = synthesize_cloud_shell(&t, None, Some(&ProjectId("local-project".into())));
        assert_eq!(shell.id, cloud_thread_id("task-1"));
        assert_eq!(shell.project_id.0, "local-project");
        assert!(shell.has_pending_user_input);
        assert!(shell.worktree_path.is_none());
        let completed =
            synthesize_cloud_shell(&task("task-1", CloudTaskState::Completed, true), None, None);
        assert_eq!(
            completed.latest_turn.unwrap().state,
            OrchestrationLatestTurnState::Completed
        );
        assert_eq!(
            completed.session.unwrap().status,
            OrchestrationSessionStatus::Stopped
        );
    }
    #[test]
    fn synthesized_shell_preserves_current_turn_timestamps() {
        let t = task("task-1", CloudTaskState::Completed, false);
        let mut view = thread();
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId": "follow-up", "state": "completed", "assistantMessageId": null,
                "requestedAt": "2026-10-15T16:13:37Z", "startedAt": "2026-10-15T16:13:38Z",
                "completedAt": "2026-10-15T16:13:40Z"
            }))
            .unwrap(),
        );
        let mut detail = TaskDetail {
            conversation: Some(Arc::new(view)),
            ..Default::default()
        };
        let latest = synthesize_cloud_shell(&t, Some(&detail), None)
            .latest_turn
            .unwrap();
        let authoritative = detail
            .conversation
            .as_ref()
            .unwrap()
            .latest_turn
            .as_ref()
            .unwrap();
        assert_eq!(latest.requested_at, authoritative.requested_at);
        assert_eq!(latest.started_at, authoritative.started_at);
        assert_eq!(latest.completed_at, authoritative.completed_at);

        // A missing backend timestamp is not the conversation creation time.
        let latest = Arc::make_mut(detail.conversation.as_mut().unwrap())
            .latest_turn
            .as_mut()
            .unwrap();
        latest.started_at = None;
        latest.completed_at = None;
        let latest = synthesize_cloud_shell(&t, Some(&detail), None)
            .latest_turn
            .unwrap();
        assert!(latest.started_at.is_none());
        assert!(latest.completed_at.is_none());
    }
    #[test]
    fn stop_requires_settlement_and_is_scoped_to_its_request() {
        let mut stop = CloudStopState {
            turn_id: None,
            command_id: "stop-1".into(),
            request_id: Some("turn-1".into()),
            task_updated_at: None,
            phase: CloudStopPhase::Requested,
            error: None,
        };
        let mut task = task("task-1", CloudTaskState::Running, false);
        task.turn_request_id = Some("turn-1".into());
        task.idle = Some(true);
        assert!(
            !cloud_stop_is_settled(&stop, None, Some(&task)),
            "cached idle is not an acknowledgement"
        );
        stop.phase = CloudStopPhase::Acknowledged;
        task.idle = Some(false);
        assert!(
            !cloud_stop_is_settled(&stop, None, Some(&task)),
            "acknowledgement is not settlement"
        );
        task.idle = Some(true);
        assert!(cloud_stop_is_settled(&stop, None, Some(&task)));
        stop.phase = CloudStopPhase::Requested;
        stop.task_updated_at = Some(task.updated_at.0.clone());
        task.state = CloudTaskState::Cancelled;
        assert!(!cloud_stop_is_settled(&stop, None, Some(&task)));
        task.updated_at = tnes("2026-10-16T15:00:00Z");
        assert!(
            cloud_stop_is_settled(&stop, None, Some(&task)),
            "fresh terminal state settles even a lost acknowledgement"
        );
        task.state = CloudTaskState::Running;
        task.idle = Some(false);
        task.turn_request_id = Some("turn-2".into());
        assert!(
            cloud_stop_is_settled(&stop, None, Some(&task)),
            "old stop cannot mask the new turn"
        );
    }

    #[test]
    fn stale_transfer_cannot_replace_a_retry_or_clear_ownership_fencing() {
        let status = |id: &str, at: &str, phase: &str, revision: i64| {
            serde_json::from_value::<vitre_contracts::CloudSwitchStatus>(serde_json::json!({
                "binding": null, "conflicts": [], "operation": {
                    "id": id, "conversationId": "conversation", "from": "local", "to": "cloud-local",
                    "generation": 0, "phase": phase, "checkpoint": null, "error": null,
                    "revision": revision, "startedAt": at, "updatedAt": at
                }
            }))
            .unwrap()
        };
        let current = status("retry", "2026-10-16T12:00:02Z", "waiting", 1);
        let stale = status("original", "2026-10-16T12:00:01Z", "cancelled", 10);
        assert!(switch_status_is_stale(Some(&current), &stale));
        let mut empty = current.clone();
        empty.operation = None;
        assert!(switch_status_is_stale(Some(&current), &empty));
        let completed = status("retry", "2026-10-16T12:00:02Z", "completed", 4);
        assert!(switch_status_is_stale(Some(&completed), &current));
        assert!(!switch_status_is_stale(Some(&current), &completed));
        let mut unknown = current.operation.unwrap();
        unknown.revision = None;
        unknown.wait_reason =
            Some(vitre_contracts::CloudHandoffOperationWaitReason::OwnershipConfirmation);
        assert!(switch_ownership_fenced(&unknown));
        unknown.phase = vitre_contracts::CloudHandoffPhase::Completed;
        assert!(!switch_ownership_fenced(&unknown));
    }

    #[test]
    fn mirror_state_phase_follows_detail_presence() {
        assert_eq!(mirror_state(None).phase, SyncPhase::Disconnected);
        let detail = TaskDetail {
            conversation: Some(Arc::new(thread())),
            ..Default::default()
        };
        let state = mirror_state(Some(&detail));
        assert_eq!(state.phase, SyncPhase::Disconnected);
        assert!(Arc::ptr_eq(
            state.view.as_ref().unwrap(),
            detail.conversation.as_ref().unwrap()
        ));
    }
    #[test]
    fn cloud_stop_only_interrupts_a_confirmed_active_live_turn() {
        let mut view = thread();
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId": "turn-1", "state": "completed", "assistantMessageId": null,
                "requestedAt": "2026-10-15T10:00:00Z", "startedAt": null, "completedAt": null
            }))
            .unwrap(),
        );
        view.session = Some(
            serde_json::from_value(serde_json::json!({
                "activeTurnId": "turn-1", "status": "running", "threadId": "cloud-task-1",
                "lastError": null, "providerName": "codex", "updatedAt": "2026-10-15T10:00:00Z"
            }))
            .unwrap(),
        );
        let mut state = ThreadState {
            phase: SyncPhase::Live,
            view: Some(Arc::new(view)),
            deleted: false,
        };
        // A queued relay follow-up must be cancelled even while its old
        // completed thread remains connected.
        assert!(cloud_turn_to_interrupt(CloudSource::Live, &state).is_none());
        Arc::make_mut(state.view.as_mut().unwrap())
            .latest_turn
            .as_mut()
            .unwrap()
            .state = OrchestrationLatestTurnState::Running;
        assert_eq!(
            cloud_turn_to_interrupt(CloudSource::Live, &state),
            Some(vitre_contracts::TurnId("turn-1".into()))
        );
        assert!(cloud_turn_to_interrupt(CloudSource::Mirror, &state).is_none());
        Arc::make_mut(state.view.as_mut().unwrap())
            .session
            .as_mut()
            .unwrap()
            .active_turn_id = None;
        assert!(cloud_turn_to_interrupt(CloudSource::Live, &state).is_none());
    }
    #[test]
    fn worker_is_up_requires_ready_worker_and_active_task() {
        let mut task = task("x", CloudTaskState::Running, false);
        assert!(!worker_is_up(&task));
        task.worker = Some(serde_json::from_value(serde_json::json!({"cpu":2,"diskGiB":10,"memoryGiB":4,"environmentId":"env","id":"worker","sandboxId":null,"state":"ready","stoppedAt":null})).unwrap());
        assert!(worker_is_up(&task));
        task.state = CloudTaskState::Completed;
        assert!(!worker_is_up(&task));
        task.state = CloudTaskState::Running;
        task.worker.as_mut().unwrap().state = CloudWorkerState::Unknown("future".into());
        assert!(!worker_is_up(&task));
    }
}
