//! Subagents and background tasks, derived from a thread's `task.*` activities.
//!
//! The server records each provider task as activities: `task.started`,
//! `task.progress`, `task.updated`, `task.transcript` (one per entry of the
//! subagent's own conversation), `task.summary` (Vitre's small-model progress
//! line) and `task.completed`. This folds them into one [`Subagent`] per task,
//! for the inline cards at the launching tool call and the dock's Agents panel.
//!
//! A task is keyed by its task id. Claude can deliver a subagent's first
//! messages before its `task_started`; the server then keys them by the
//! launching tool call, and the start event renames that placeholder.

use std::collections::HashSet;

use serde_json::{Map, Value};
use vitre_contracts::generated::OrchestrationThreadActivity;

use crate::work_log::compare_activities_by_order;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentStatus {
    Pending,
    Running,
    Paused,
    Completed,
    Failed,
    Stopped,
}

impl SubagentStatus {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "paused" => Self::Paused,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "stopped" | "killed" => Self::Stopped,
            _ => return None,
        })
    }

    /// Still doing work, or able to resume it.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Running | Self::Paused)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Pending => "Queued",
            Self::Running => "Running",
            Self::Paused => "Paused",
            Self::Completed => "Done",
            Self::Failed => "Failed",
            Self::Stopped => "Stopped",
        }
    }
}

/// A subagent the model launched, or a background task (a backgrounded shell
/// command, a workflow) with no agent type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentKind {
    Agent,
    Background,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SubagentTranscriptEntry {
    Text(String),
    Reasoning(String),
    Tool {
        tool_use_id: String,
        tool_name: String,
        detail: Option<String>,
        /// `None` until the result arrives.
        result: Option<SubagentToolResult>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubagentToolResult {
    pub is_error: bool,
    pub output: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Subagent {
    pub task_id: String,
    /// The tool call that launched it; the inline card renders at that row.
    pub tool_use_id: Option<String>,
    pub kind: SubagentKind,
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub prompt: Option<String>,
    pub status: SubagentStatus,
    pub background: bool,
    /// Latest progress line: Vitre's summary, else the provider's.
    pub summary: Option<String>,
    pub last_tool_name: Option<String>,
    pub tool_uses: Option<u64>,
    pub total_tokens: Option<u64>,
    pub duration_ms: Option<u64>,
    /// The final report, once finished.
    pub result: Option<String>,
    pub error: Option<String>,
    pub turn_id: Option<String>,
    pub started_at: String,
    pub updated_at: String,
    pub ended_at: Option<String>,
    pub transcript: Vec<SubagentTranscriptEntry>,
}

impl Subagent {
    /// The card's title: `Explore · Find the reducers`.
    pub fn title(&self) -> String {
        let description = self.description.as_deref().unwrap_or("Background task");
        match self.agent_type.as_deref() {
            Some(agent_type) if agent_type != "subagent" => format!("{agent_type} · {description}"),
            _ => description.to_string(),
        }
    }

    /// Tool calls so far: the provider's count, else the transcript's.
    pub fn tool_count(&self) -> usize {
        let counted = self
            .transcript
            .iter()
            .filter(|entry| matches!(entry, SubagentTranscriptEntry::Tool { .. }))
            .count();
        self.tool_uses
            .map_or(counted, |uses| (uses as usize).max(counted))
    }

    /// One line about what it is doing now (running) or what it found (done).
    pub fn status_line(&self) -> Option<&str> {
        if !self.status.is_active()
            && let Some(result) = self.result.as_deref().or(self.error.as_deref())
        {
            return Some(result);
        }
        self.summary.as_deref().or_else(|| {
            self.transcript.iter().rev().find_map(|entry| match entry {
                SubagentTranscriptEntry::Tool {
                    tool_name, detail, ..
                } => Some(detail.as_deref().unwrap_or(tool_name.as_str())),
                SubagentTranscriptEntry::Text(text) => Some(text.as_str()),
                SubagentTranscriptEntry::Reasoning(_) => None,
            })
        })
    }
}

fn string(payload: &Map<String, Value>, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn number(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| value.as_u64().or_else(|| value.as_f64().map(|f| f as u64)))
}

/// Activity kinds owned by [`derive_subagents`]; the flat work log skips them.
pub fn is_subagent_activity_kind(kind: &str) -> bool {
    matches!(kind, "task.transcript" | "task.summary" | "task.updated")
}

/// Whether a `task.*` activity marks its task as a subagent or background
/// task, as opposed to a provider's plan task, which keeps its own row.
fn marks_subagent_task(activity: &OrchestrationThreadActivity) -> bool {
    let kind = activity.kind.0.as_str();
    if is_subagent_activity_kind(kind) {
        return true;
    }
    if !matches!(kind, "task.started" | "task.progress" | "task.completed") {
        return false;
    }
    let Some(payload) = activity.payload.as_object() else {
        return false;
    };
    payload.contains_key("toolUseId")
        || payload.contains_key("agentType")
        || payload
            .get("taskType")
            .and_then(Value::as_str)
            .is_some_and(|task_type| task_type != "plan")
}

fn task_id_of(activity: &OrchestrationThreadActivity) -> Option<&str> {
    activity.payload.as_object()?.get("taskId")?.as_str()
}

/// The ids of every subagent or background task in `activities`. A later
/// event may carry only the task id (a Codex `wait` reporting a finished
/// agent), so membership is decided per task, not per event.
pub fn subagent_task_ids(activities: &[OrchestrationThreadActivity]) -> HashSet<String> {
    activities
        .iter()
        .filter(|activity| marks_subagent_task(activity))
        .filter_map(task_id_of)
        .map(str::to_string)
        .collect()
}

/// Whether `activity` belongs to one of `ids` (from [`subagent_task_ids`]).
pub fn is_subagent_task_activity(
    activity: &OrchestrationThreadActivity,
    ids: &HashSet<String>,
) -> bool {
    activity.kind.0.starts_with("task.")
        && (marks_subagent_task(activity)
            || task_id_of(activity).is_some_and(|id| ids.contains(id)))
}

#[derive(Default)]
struct Builder {
    agents: Vec<Subagent>,
}

impl Builder {
    fn index_of(&self, task_id: &str) -> Option<usize> {
        self.agents
            .iter()
            .position(|agent| agent.task_id == task_id)
    }

    fn entry(
        &mut self,
        activity: &OrchestrationThreadActivity,
        payload: &Map<String, Value>,
    ) -> Option<&mut Subagent> {
        let task_id = string(payload, "taskId")?;
        let tool_use_id = string(payload, "toolUseId");
        let index = match self.index_of(&task_id) {
            Some(index) => index,
            None => {
                // A placeholder keyed by the tool call becomes this task.
                let placeholder = tool_use_id
                    .as_deref()
                    .filter(|tool| *tool != task_id)
                    .and_then(|tool| self.index_of(tool));
                if let Some(index) = placeholder {
                    self.agents[index].task_id = task_id.clone();
                    index
                } else {
                    self.agents.push(Subagent {
                        task_id: task_id.clone(),
                        tool_use_id: None,
                        kind: SubagentKind::Background,
                        agent_type: None,
                        description: None,
                        prompt: None,
                        status: SubagentStatus::Running,
                        background: false,
                        summary: None,
                        last_tool_name: None,
                        tool_uses: None,
                        total_tokens: None,
                        duration_ms: None,
                        result: None,
                        error: None,
                        turn_id: activity.turn_id.as_ref().map(|turn| turn.0.clone()),
                        started_at: activity.created_at.0.clone(),
                        updated_at: activity.created_at.0.clone(),
                        ended_at: None,
                        transcript: Vec::new(),
                    });
                    self.agents.len() - 1
                }
            }
        };
        let agent = &mut self.agents[index];
        if agent.tool_use_id.is_none() {
            agent.tool_use_id = tool_use_id;
        }
        if let Some(agent_type) = string(payload, "agentType") {
            agent.agent_type = Some(agent_type);
            agent.kind = SubagentKind::Agent;
        }
        if let Some(background) = payload.get("background").and_then(Value::as_bool) {
            agent.background = background;
        }
        agent.updated_at = activity.created_at.0.clone();
        Some(agent)
    }
}

fn apply_usage(agent: &mut Subagent, usage: Option<&Value>) {
    let Some(usage) = usage.and_then(Value::as_object) else {
        return;
    };
    agent.total_tokens = number(usage.get("total_tokens")).or(agent.total_tokens);
    agent.tool_uses = number(usage.get("tool_uses")).or(agent.tool_uses);
    agent.duration_ms = number(usage.get("duration_ms")).or(agent.duration_ms);
}

fn apply_transcript_entry(agent: &mut Subagent, entry: &Map<String, Value>) {
    match entry.get("kind").and_then(Value::as_str) {
        Some("text") => {
            if let Some(text) = string(entry, "text") {
                agent.transcript.push(SubagentTranscriptEntry::Text(text));
            }
        }
        Some("reasoning") => {
            if let Some(text) = string(entry, "text") {
                agent
                    .transcript
                    .push(SubagentTranscriptEntry::Reasoning(text));
            }
        }
        Some("tool") => {
            let (Some(tool_use_id), Some(tool_name)) =
                (string(entry, "toolUseId"), string(entry, "toolName"))
            else {
                return;
            };
            agent.last_tool_name = Some(tool_name.clone());
            agent.transcript.push(SubagentTranscriptEntry::Tool {
                tool_use_id,
                tool_name,
                detail: string(entry, "detail"),
                result: None,
            });
        }
        Some("tool_result") => {
            let Some(id) = string(entry, "toolUseId") else {
                return;
            };
            let result = SubagentToolResult {
                is_error: entry.get("isError").and_then(Value::as_bool) == Some(true),
                output: string(entry, "output"),
            };
            let call = agent
                .transcript
                .iter_mut()
                .rev()
                .find_map(|item| match item {
                    SubagentTranscriptEntry::Tool {
                        tool_use_id,
                        result,
                        ..
                    } if *tool_use_id == id => Some(result),
                    _ => None,
                });
            if let Some(slot) = call {
                *slot = Some(result);
            }
        }
        _ => {}
    }
}

/// Every subagent and background task in the thread, in launch order.
pub fn derive_subagents(activities: &[OrchestrationThreadActivity]) -> Vec<Subagent> {
    let ids = subagent_task_ids(activities);
    let mut ordered: Vec<&OrchestrationThreadActivity> = activities
        .iter()
        .filter(|activity| is_subagent_task_activity(activity, &ids))
        .collect();
    ordered.sort_by(|a, b| compare_activities_by_order(a, b));

    let mut builder = Builder::default();
    for activity in ordered {
        let Some(payload) = activity.payload.as_object() else {
            continue;
        };
        let kind = activity.kind.0.as_str();
        let Some(agent) = builder.entry(activity, payload) else {
            continue;
        };
        match kind {
            "task.started" => {
                agent.started_at = activity.created_at.0.clone();
                agent.turn_id = activity.turn_id.as_ref().map(|turn| turn.0.clone());
                agent.description = string(payload, "detail").or(agent.description.take());
                agent.prompt = string(payload, "prompt").or(agent.prompt.take());
                if agent.ended_at.is_none() {
                    agent.status = SubagentStatus::Running;
                }
            }
            "task.progress" => {
                agent.description = agent
                    .description
                    .take()
                    .or_else(|| string(payload, "title"));
                if let Some(summary) = string(payload, "summary") {
                    agent.summary = Some(summary);
                }
                if let Some(tool) = string(payload, "lastToolName") {
                    agent.last_tool_name = Some(tool);
                }
                apply_usage(agent, payload.get("usage"));
            }
            "task.updated" => {
                if let Some(status) =
                    string(payload, "status").and_then(|s| SubagentStatus::parse(&s))
                {
                    agent.status = status;
                }
                if let Some(title) = string(payload, "title") {
                    agent.description = Some(title);
                }
                if let Some(error) = string(payload, "detail") {
                    agent.error = Some(error);
                }
            }
            "task.summary" => {
                if let Some(summary) = string(payload, "summary") {
                    agent.summary = Some(summary);
                }
            }
            "task.transcript" => {
                if let Some(entry) = payload.get("entry").and_then(Value::as_object) {
                    apply_transcript_entry(agent, entry);
                }
            }
            "task.completed" => {
                agent.status = string(payload, "status")
                    .and_then(|s| SubagentStatus::parse(&s))
                    .unwrap_or(SubagentStatus::Completed);
                agent.ended_at = Some(activity.created_at.0.clone());
                if let Some(result) = string(payload, "summary") {
                    agent.result = Some(result);
                }
                if agent.description.is_none() {
                    agent.description = string(payload, "title");
                }
                apply_usage(agent, payload.get("usage"));
            }
            _ => {}
        }
    }
    builder.agents
}

/// How many are still working, for the status bar and the panel badge.
pub fn active_subagent_count(agents: &[Subagent]) -> usize {
    agents
        .iter()
        .filter(|agent| agent.status.is_active())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use vitre_contracts::generated::{
        EventId, OrchestrationThreadActivityTone, TrimmedNonEmptyString,
    };

    fn activity(id: &str, kind: &str, at: &str, payload: Value) -> OrchestrationThreadActivity {
        OrchestrationThreadActivity {
            created_at: TrimmedNonEmptyString(at.into()),
            id: EventId(id.into()),
            kind: TrimmedNonEmptyString(kind.into()),
            payload,
            sequence: None,
            summary: TrimmedNonEmptyString("summary".into()),
            tone: OrchestrationThreadActivityTone::Info,
            turn_id: None,
        }
    }

    const ID: &str = "task-1";

    fn identity() -> Value {
        json!({ "taskId": ID, "toolUseId": "toolu_1", "agentType": "Explore" })
    }

    fn with(extra: Value) -> Value {
        let mut base = identity();
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base
    }

    #[test]
    fn folds_a_subagent_lifecycle_into_one_entry() {
        let agents = derive_subagents(&[
            activity(
                "a",
                "task.started",
                "2026-01-01T00:00:01Z",
                with(json!({ "detail": "Find reducers", "prompt": "Look in crates" })),
            ),
            activity(
                "b",
                "task.transcript",
                "2026-01-01T00:00:02Z",
                with(
                    json!({ "entry": { "kind": "tool", "toolUseId": "g", "toolName": "Grep", "detail": "reduce" } }),
                ),
            ),
            activity(
                "c",
                "task.transcript",
                "2026-01-01T00:00:03Z",
                with(
                    json!({ "entry": { "kind": "tool_result", "toolUseId": "g", "isError": false, "output": "3" } }),
                ),
            ),
            activity(
                "d",
                "task.summary",
                "2026-01-01T00:00:04Z",
                with(json!({ "summary": "Reading thread.rs" })),
            ),
            activity(
                "e",
                "task.progress",
                "2026-01-01T00:00:05Z",
                with(
                    json!({ "description": "x", "usage": { "total_tokens": 1200, "tool_uses": 4, "duration_ms": 9000 } }),
                ),
            ),
        ]);
        assert_eq!(agents.len(), 1);
        let agent = &agents[0];
        assert_eq!(agent.title(), "Explore · Find reducers");
        assert_eq!(agent.status, SubagentStatus::Running);
        assert_eq!(agent.summary.as_deref(), Some("Reading thread.rs"));
        assert_eq!(agent.status_line(), Some("Reading thread.rs"));
        assert_eq!(agent.tool_count(), 4);
        assert_eq!(agent.total_tokens, Some(1200));
        assert_eq!(
            agent.transcript,
            vec![SubagentTranscriptEntry::Tool {
                tool_use_id: "g".into(),
                tool_name: "Grep".into(),
                detail: Some("reduce".into()),
                result: Some(SubagentToolResult {
                    is_error: false,
                    output: Some("3".into())
                }),
            }]
        );
        assert_eq!(active_subagent_count(&agents), 1);
    }

    #[test]
    fn completion_shows_the_result_and_backgrounding_sticks() {
        let agents = derive_subagents(&[
            activity("a", "task.started", "1", with(json!({ "detail": "Audit" }))),
            activity(
                "b",
                "task.updated",
                "2",
                with(json!({ "background": true, "status": "running" })),
            ),
            activity(
                "c",
                "task.completed",
                "3",
                json!({ "taskId": ID, "status": "failed", "summary": "Hit a permission error" }),
            ),
        ]);
        let agent = &agents[0];
        assert!(agent.background);
        assert_eq!(agent.status, SubagentStatus::Failed);
        assert_eq!(agent.status_line(), Some("Hit a permission error"));
        assert_eq!(active_subagent_count(&agents), 0);
    }

    #[test]
    fn renames_a_placeholder_keyed_by_the_tool_call() {
        let agents = derive_subagents(&[
            activity(
                "a",
                "task.transcript",
                "1",
                json!({ "taskId": "toolu_1", "toolUseId": "toolu_1", "entry": { "kind": "text", "text": "Hi" } }),
            ),
            activity("b", "task.started", "2", with(json!({ "detail": "Audit" }))),
        ]);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].task_id, ID);
        assert_eq!(agents[0].transcript.len(), 1);
    }

    #[test]
    fn leaves_plan_tasks_to_the_work_log_and_keeps_parallel_agents_apart() {
        let plan = activity(
            "p",
            "task.started",
            "1",
            json!({ "taskId": "turn", "taskType": "plan" }),
        );
        assert!(!is_subagent_task_activity(&plan, &HashSet::new()));
        let agents = derive_subagents(&[
            plan,
            activity(
                "a",
                "task.started",
                "2",
                json!({ "taskId": "c1", "toolUseId": "spawn", "agentType": "subagent" }),
            ),
            activity(
                "b",
                "task.started",
                "2",
                json!({ "taskId": "c2", "toolUseId": "spawn", "agentType": "subagent" }),
            ),
        ]);
        assert_eq!(
            agents
                .iter()
                .map(|a| a.task_id.as_str())
                .collect::<Vec<_>>(),
            ["c1", "c2"]
        );
    }
}
