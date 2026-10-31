use super::*;
use vitre_contracts::CloudTaskKind;

pub(crate) mod fixtures {
    use super::*;
    use vitre_contracts::{
        CloudOverview, CloudProviderAccount, CloudProviderAccountState, CloudRepository,
        CloudResultRevision, CloudSavedResult, CloudSavedResultResult, CloudUsageSummary,
        OrchestrationThread, TrimmedNonEmptyString,
    };
    fn tnes(value: &str) -> TrimmedNonEmptyString {
        TrimmedNonEmptyString(value.to_owned())
    }

    pub(crate) fn repository() -> CloudRepository {
        CloudRepository {
            github_account_id: None,
            default_branch: "main".into(),
            id: "repo-1".into(),
            installation_id: "42".into(),
            name: "vitre".into(),
            owner: "acme".into(),
            revision: 1,
            setup_command: String::new(),
            test_command: "cargo test".into(),
        }
    }

    pub(crate) fn task(id: &str, state: CloudTaskState, with_result: bool) -> CloudTask {
        CloudTask {
            publication_preparation: None,
            project_snapshot: None,
            turn_settings: None,
            runtime_mode: None,
            preparation: None,
            dependency_setup: None,
            title: None,
            archived_at: None,
            project_id: None,
            handoff: None,
            idle: None,
            keep_alive_seconds: None,
            turn_request_id: None,
            wake_only: None,
            attachments: None,
            source: None,
            model: None,
            model_options: None,
            interaction_mode: None,
            attempt: None,
            base_branch: "main".into(),
            base_sha: None,
            branch: "vitre/fix-login".into(),
            checkpoint: None,
            created_at: tnes("2026-10-09T10:00:00Z"),
            error: None,
            id: id.into(),
            issue_number: None,
            kind: CloudTaskKind::Build,
            prompt: "Fix the login redirect loop\n\nIt happens after sign-out.".into(),
            provider: CloudProvider::Codex,
            repository: repository(),
            result: with_result.then(|| CloudResultRevision {
                checkpoint_id: "chk-1".into(),
                created_at: tnes("2026-10-09T10:20:00Z"),
                id: "rev-1".into(),
                sha256: "abc".into(),
                summary: tnes("Replaced the redirect with a guard."),
                task_id: id.into(),
            }),
            state,
            updated_at: tnes("2026-10-09T10:20:00Z"),
            worker: None,
        }
    }

    pub(crate) fn overview(
        repositories: Vec<CloudRepository>,
        tasks: Vec<CloudTask>,
    ) -> CloudOverview {
        CloudOverview {
            github_accounts: None,
            github_manage_url: None,
            capabilities: None,
            projects: None,
            revision: None,
            bindings: None,
            handoffs: None,
            accounts: vec![CloudProviderAccount {
                credential_version: 1,
                leased_by: None,
                provider: CloudProvider::Codex,
                state: CloudProviderAccountState::Connected,
            }],
            enabled: true,
            publications: vec![],
            repositories,
            tasks,
            usage: CloudUsageSummary {
                limit_micro_dollars: 20_000_000,
                month: tnes("2026-10"),
                reserved_micro_dollars: 0,
                spent_micro_dollars: 1_250_000,
                warning: false,
            },
        }
    }

    pub(crate) fn saved_result() -> CloudSavedResult {
        CloudSavedResult {
            result: CloudSavedResultResult {
                conversation: serde_json::json!({}),
                diff: tnes(
                    "diff --git a/src/auth.rs b/src/auth.rs\n--- a/src/auth.rs\n+++ b/src/auth.rs\n@@ -1,3 +1,4 @@ fn login\n fn login() {\n-    redirect();\n+    if !signed_out() {\n+        redirect();\n }\n",
                ),
                summary: tnes("Replaced the redirect with a guard."),
                test_exit_code: Some(0),
                test_output: tnes("running 3 tests\ntest result: ok."),
            },
            revision: None,
        }
    }

    pub(crate) fn thread() -> OrchestrationThread {
        serde_json::from_value(serde_json::json!({
        "activities": [], "additionalRoots": [], "archivedAt": null, "branch": "main", "checkpoints": [],
        "createdAt": "2026-10-09T10:00:00Z", "deletedAt": null, "id": "cloud-task-1", "interactionMode": "default", "latestTurn": null,
        "messages": [{"attachments": [], "createdAt": "2026-10-09T10:00:00Z", "id": "m1", "role": "user", "streaming": false, "text": "Fix login", "turnId": "turn-1", "updatedAt": "2026-10-09T10:00:00Z"}],
        "modelSelection": {"model":"gpt-5"}, "projectId": "project-1", "proposedPlans": [], "resolvedAdditionalRoots": [],
        "runtimeMode": "full-access", "session": null, "settledAt": null, "settledOverride": null, "snoozedAt": null, "snoozedUntil": null,
        "title": "Thread", "updatedAt": "2026-10-09T10:20:00Z", "worktreePath": null
    })).unwrap()
    }
}
#[cfg(test)]
use fixtures::*;
#[test]
fn presentation_helpers() {
    let t = task("x", CloudTaskState::Queued, false);
    assert_eq!(task_title(&t, 80), "Fix the login redirect loop");
    assert_eq!(task_title(&t, 8), "Fix the…");
    assert_eq!(repo_label(&t), "acme/vitre");
    assert!(is_active(&CloudTaskState::Running));
    assert!(!is_active(&CloudTaskState::Completed));
    assert!(needs_attention(&CloudTaskState::WaitingForInput));
    assert_eq!(store::dollars(1_250_000), "$1.25");

    // A running attempt's hold is shown apart from real spend, never summed
    // into it.
    let usage = |reserved| vitre_contracts::CloudUsageSummary {
        limit_micro_dollars: 25_000_000,
        month: vitre_contracts::TrimmedNonEmptyString("2026-10".into()),
        reserved_micro_dollars: reserved,
        spent_micro_dollars: 220_000,
        warning: false,
    };
    assert_eq!(
        usage_label(&usage(1_330_000)),
        "$0.22 used · $1.33 held · $25.00 limit"
    );
    assert_eq!(usage_label(&usage(0)), "$0.22 used of $25.00 this month");

    let ago = |secs: i64| (chrono::Utc::now() - chrono::Duration::seconds(secs)).to_rfc3339();
    assert_eq!(elapsed_since(&ago(48)).unwrap(), "48s");
    assert_eq!(elapsed_since(&ago(185)).unwrap(), "3m 05s");
    assert_eq!(elapsed_since(&ago(4320)).unwrap(), "1h 12m");
    assert_eq!(elapsed_since("not a date"), None);
}

#[test]
fn cloud_retry_preserves_workspace_attachments_and_model() {
    let mut task = fixtures::task("source", CloudTaskState::Failed, false);
    task.source = Some(vitre_contracts::CloudTaskSource::Local {
        name: "folder".into(),
        snapshot: vitre_contracts::CloudSnapshotRef {
            id: "a".repeat(64),
            sha256: "a".repeat(64),
        },
    });
    task.model = Some("chosen-model".into());
    task.model_options = Some(serde_json::json!([{ "id": "reasoningEffort", "value": "high" }]));
    task.attachments = Some(vec![serde_json::from_value(serde_json::json!({"type":"file","name":"file.txt","mimeType":"text/plain","sizeBytes":1,"sha256":"b".repeat(64),"chunks":["b".repeat(64)]})).unwrap()]);
    let command = super::store::retry_command(&task, "retry".into()).unwrap();
    let value = serde_json::to_value(command).unwrap();
    let original = serde_json::to_value(task).unwrap();
    for key in ["prompt", "attachments"] {
        assert_eq!(value[key], original[key]);
    }
    assert_eq!(value["taskId"], original["id"]);
    assert_eq!(value["type"], "task.continue");
}
