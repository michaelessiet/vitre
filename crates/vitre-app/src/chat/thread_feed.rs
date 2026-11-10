//! How an open conversation is fed and where its workspace operations run.
use super::*;

/// Keeps the open thread's live subscription alive for as long as it is shown.
pub(crate) struct ThreadFeed {
    _handle: Option<ThreadHandle>,
}

impl ThreadFeed {
    pub(crate) fn live(handle: ThreadHandle) -> Self {
        Self {
            _handle: Some(handle),
        }
    }

    /// An open thread with no subscription, for tests that drive state directly.
    #[cfg(test)]
    pub(crate) fn detached() -> Self {
        Self { _handle: None }
    }
}

/// A minimal thread projection for tests.
#[cfg(test)]
pub(crate) fn thread_fixture() -> OrchestrationThread {
    serde_json::from_value(serde_json::json!({
        "activities": [], "additionalRoots": [], "archivedAt": null, "branch": "main",
        "checkpoints": [], "createdAt": "2026-10-09T10:00:00Z", "deletedAt": null,
        "id": "thread-1", "interactionMode": "default", "latestTurn": null,
        "messages": [{"attachments": [], "createdAt": "2026-10-09T10:00:00Z", "id": "m1",
            "role": "user", "streaming": false, "text": "Fix login", "turnId": "turn-1",
            "updatedAt": "2026-10-09T10:00:00Z"}],
        "modelSelection": {"model":"gpt-5"}, "projectId": "project-1", "proposedPlans": [],
        "resolvedAdditionalRoots": [], "runtimeMode": "full-access", "session": null,
        "settledAt": null, "settledOverride": null, "snoozedAt": null, "snoozedUntil": null,
        "title": "Thread", "updatedAt": "2026-10-09T10:20:00Z", "worktreePath": null
    }))
    .unwrap()
}

impl ChatApp {
    /// The environment that owns the open conversation's workspace.
    pub(super) fn workspace_client(&self) -> Option<Arc<EnvironmentClient>> {
        self.client.clone()
    }

    pub(super) fn workspace_cache_key(&self, root: &str) -> Option<String> {
        self.workspace_client()
            .map(|client| format!("{:p}:{root}", Arc::as_ptr(&client)))
    }

    /// The thread id the environment executes, which is the open thread's own id.
    pub(super) fn execution_thread_id(&self) -> Option<ThreadId> {
        self.thread.as_ref().map(|thread| thread.id.clone())
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
