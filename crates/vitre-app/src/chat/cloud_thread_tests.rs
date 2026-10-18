//! Exercise the shared ChatApp rather than the removed cloud surface.
use super::cloud_thread::*;
use super::*;
use crate::cloud::{
    CloudStore, SessionState,
    store::{CloudEvent, TaskDetail},
    tests::fixtures::*,
};
use gpui::{TestAppContext, VisualTestContext};
use vitre_contracts::{CloudOverview, CloudTaskState};

fn setup(cx: &mut TestAppContext) -> (Entity<ChatApp>, Entity<CloudStore>, &mut VisualTestContext) {
    let home = std::env::temp_dir().join(fresh_id("vitre-cloud-test"));
    cx.update(|cx| {
        gpui_component::init(cx);
        ClientSettings::init(cx, &home);
    });
    let store = cx.update(CloudStore::global);
    let holder = std::rc::Rc::new(std::cell::RefCell::new(None));
    let capture = holder.clone();
    let (_, cx) = cx.add_window_view(move |window, cx| {
        let (_, status) = watch::channel(SupervisorStatus::Idle);
        let app = cx.new(|cx| ChatApp::new_with_backend(&home, status, false, window, cx));
        *capture.borrow_mut() = Some(app.clone());
        Root::new(app, window, cx)
    });
    let app = holder.borrow_mut().take().unwrap();
    (app, store, cx)
}
fn seed(store: &Entity<CloudStore>, overview: CloudOverview, cx: &mut VisualTestContext) {
    store.update(cx, |s, cx| {
        s.apply_overview(overview, cx);
        cx.emit(CloudEvent::Changed);
        cx.notify();
    });
}
fn draw(cx: &mut VisualTestContext) {
    cx.update(|w, cx| w.draw(cx).clear(cx));
}
fn open(
    state: CloudTaskState,
    cx: &mut TestAppContext,
) -> (Entity<ChatApp>, Entity<CloudStore>, &mut VisualTestContext) {
    let (app, store, cx) = setup(cx);
    seed(
        &store,
        overview(vec![repository()], vec![task("task-1", state, true)]),
        cx,
    );
    store.update(cx, |s, _| {
        s.details.insert(
            "task-1".into(),
            TaskDetail {
                conversation: Some(Arc::new(thread())),
                result: Some(saved_result()),
                ..Default::default()
            },
        );
    });
    app.update(cx, |a, cx| {
        a.rebuild_cloud_shells(cx);
        a.select_thread(cloud_thread_id("task-1"), cx);
    });
    (app, store, cx)
}
#[gpui::test]
fn draft_landing_shows_location_switch_and_defaults_to_local(cx: &mut TestAppContext) {
    let (app, _, cx) = setup(cx);
    draw(cx);
    app.read_with(cx, |a, _| {
        assert_eq!(a.draft_work_location, WorkLocation::Local);
        assert!(a.can_switch_work_location());
    });
}
#[gpui::test]
fn composer_return_preserves_mid_text_prompt_and_shift_return_inserts_newline(
    cx: &mut TestAppContext,
) {
    let (app, _, cx) = setup(cx);
    let prompt = "Run sleep 30, then reply UX-STOP-SHOULD-NOT-FINISH.";
    let caret = prompt.find("SHOULD").unwrap() + 2;
    app.update_in(cx, |app, window, cx| {
        app.draft_restore = None;
        app.composer.update(cx, |input, cx| {
            input.set_value(prompt, window, cx);
            input.set_selected_range(caret..caret, cx);
            input.focus(window, cx);
        });
    });
    draw(cx);
    // With no configured backend, sending cannot clear the draft. The real
    // key action must nevertheless leave the exact submit payload intact.
    cx.simulate_keystrokes("enter");
    app.read_with(cx, |app, cx| {
        assert_eq!(app.composer.read(cx).value(), prompt)
    });
    cx.simulate_keystrokes("shift-enter");
    app.read_with(cx, |app, cx| {
        assert_eq!(
            app.composer.read(cx).value(),
            format!("{}\n{}", &prompt[..caret], &prompt[caret..])
        );
    });
}

#[gpui::test]
fn minimum_window_keeps_long_draft_controls_visible(cx: &mut TestAppContext) {
    let (app, _, cx) = setup(cx);
    cx.simulate_resize(gpui::size(px(640.), px(480.)));
    app.update_in(cx, |app, window, cx| {
        app.draft_restore = None;
        app.composer.update(cx, |input, cx| {
            input.set_value(
                (1..=24)
                    .map(|line| format!("Minimum-window draft line {line}: preserve all text."))
                    .collect::<Vec<_>>()
                    .join("\n"),
                window,
                cx,
            );
        });
        cx.notify();
    });
    draw(cx);
    let toolbar = cx.debug_bounds("composer-location-toolbar").unwrap();
    let actions = cx.debug_bounds("composer-action-row").unwrap();
    let viewport = cx.debug_bounds("draft-input-viewport").unwrap();
    app.read_with(cx, |app, cx| {
        let text_bounds = app.composer.read(cx).text_bounds().unwrap();
        assert!(
            text_bounds.bottom() <= viewport.bottom(),
            "text {text_bounds:?}, viewport {viewport:?}"
        );
        assert!(
            text_bounds.bottom() <= toolbar.top(),
            "text {text_bounds:?}, toolbar {toolbar:?}"
        );
        assert!(text_bounds.size.height <= px(80.), "{text_bounds:?}");
    });
    assert!(toolbar.top() >= px(0.), "{toolbar:?}");
    assert!(actions.bottom() <= px(480.), "{actions:?}");
    assert!(actions.right() <= px(640.), "{actions:?}");
    assert!(actions.size.height >= px(24.), "{actions:?}");
    app.update_in(cx, |app, window, cx| {
        app.composer.update(cx, |input, cx| {
            input.set_selected_range(0..0, cx);
            input.focus(window, cx);
        });
    });
    draw(cx);
    cx.simulate_keystrokes("cmd-down");
    draw(cx);
    draw(cx);
    app.read_with(cx, |app, cx| {
        let input = app.composer.read(cx);
        assert_eq!(input.cursor(), input.value().len());
        let (mut caret, _) = input.cursor_layout().unwrap();
        caret.origin.y += input.scroll_offset().y;
        let editor = input.input_bounds();
        assert!(
            caret.bottom() <= editor.bottom(),
            "end caret {caret:?} is clipped by editor {editor:?}"
        );
        assert!(
            caret.top() >= editor.top(),
            "end caret {caret:?} is above editor {editor:?}"
        );
        assert_eq!(input.value().lines().count(), 24);
        assert!(
            input.scroll_offset().y < px(0.),
            "long draft must scroll inside its own viewport"
        );
        assert!(input.text_bounds().unwrap().bottom() <= toolbar.top());
    });
    // Restoring a normal-size window restores the usual composer capacity.
    cx.simulate_resize(gpui::size(px(1100.), px(760.)));
    draw(cx);
    app.read_with(cx, |app, _| assert_eq!(app.composer_max_rows, 8));
}

#[gpui::test]
fn minimum_window_keeps_every_approval_action_visible(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::WaitingForInput, cx);
    cx.simulate_resize(gpui::size(px(640.), px(480.)));
    app.update(cx, |app, cx| {
        let open = app.thread.as_mut().unwrap();
        let view = Arc::make_mut(open.state.view.as_mut().unwrap());
        view.activities.push(serde_json::from_value(serde_json::json!({
            "id":"approval-minimum", "kind":"approval.requested", "createdAt":"2026-10-16T10:00:00Z",
            "summary":"Command approval requested", "tone":"tool", "turnId":null,
            "payload":{"requestId":"approve-minimum","requestKind":"command","detail":"git log -2 --format=%H"}
        })).unwrap());
        app.rebuild_timeline(cx);
        cx.notify();
    });
    draw(cx);
    let mut bounds = Vec::new();
    for selector in [
        "approval-cancel",
        "approval-decline",
        "approval-accept-session",
        "approval-accept",
    ] {
        let action = cx.debug_bounds(selector).expect(selector);
        assert!(action.left() >= px(256.), "{selector}: {action:?}");
        assert!(action.right() <= px(640.), "{selector}: {action:?}");
        assert!(
            action.top() >= px(0.) && action.bottom() <= px(480.),
            "{selector}: {action:?}"
        );
        for other in &bounds {
            assert!(!action.intersects(other), "approval actions overlap");
        }
        bounds.push(action);
    }
}

#[gpui::test]
fn terminal_cloud_state_removes_stale_approval_panel_but_preserves_history_and_draft(
    cx: &mut TestAppContext,
) {
    let (app, store, cx) = open(CloudTaskState::WaitingForInput, cx);
    app.update_in(cx, |app, window, cx| {
        app.draft_restore = None;
        app.composer.update(cx, |input, cx| {
            input.set_value("Keep my unsent draft", window, cx)
        });
        let open = app.thread.as_mut().unwrap();
        let view = Arc::make_mut(open.state.view.as_mut().unwrap());
        view.activities.push(serde_json::from_value(serde_json::json!({
            "id":"stale-approval", "kind":"approval.requested", "createdAt":"2026-10-16T10:00:00Z",
            "summary":"Command approval requested", "tone":"tool", "turnId":null,
            "payload":{"requestId":"approve-stale","requestKind":"command","detail":"git status --short"}
        })).unwrap());
        cx.notify();
    });
    draw(cx);
    // A disconnect alone keeps a valid cached request readable, but disabled.
    assert!(cx.debug_bounds("approval-panel").is_some());
    app.read_with(cx, |app, cx| {
        assert!(!app.conversation_status(cx).can_respond);
    });
    for state in [
        CloudTaskState::Interrupted,
        CloudTaskState::Failed,
        CloudTaskState::NeedsAuth,
        CloudTaskState::UsageLimited,
    ] {
        store.update(cx, |store, _| {
            store.overview.as_mut().unwrap().tasks[0].state = state;
        });
        app.update(cx, |app, cx| {
            let open = app.thread.as_mut().unwrap();
            if let ThreadFeed::Cloud(feed) = &mut open.feed {
                feed.source = CloudSource::Live;
                feed.connection_phase = SyncPhase::Live;
            }
            cx.notify();
        });
        draw(cx);
        assert!(cx.debug_bounds("approval-panel").is_none());
        assert!(cx.debug_bounds("approval-accept").is_none());
        assert!(cx.debug_bounds("composer-action-row").is_some());
        app.read_with(cx, |app, cx| {
            let status = app.conversation_status(cx);
            assert!(!status.can_respond);
            assert!(!status.can_stop);
            assert_eq!(app.composer.read(cx).value(), "Keep my unsent draft");
            let view = app.thread.as_ref().unwrap().state.view.as_ref().unwrap();
            assert_eq!(derive_pending_approvals(&view.activities).len(), 1);
        });
    }
}

#[gpui::test]
fn new_cloud_request_cannot_revive_an_old_turn_or_approval(cx: &mut TestAppContext) {
    use conversation_status::{Transcript, Turn};
    let (app, store, cx) = open(CloudTaskState::WaitingForInput, cx);
    store.update(cx, |store, _| {
        store.overview.as_mut().unwrap().tasks[0].turn_request_id = Some("retry-request".into());
    });
    app.update_in(cx, |app, window, cx| {
        app.draft_restore = None;
        app.composer.update(cx, |input, cx| {
            input.set_value("Preserve draft during retry", window, cx)
        });
        let open = app.thread.as_mut().unwrap();
        if let ThreadFeed::Cloud(feed) = &mut open.feed {
            feed.source = CloudSource::Live;
            feed.connection_phase = SyncPhase::Live;
        }
        let view = Arc::make_mut(open.state.view.as_mut().unwrap());
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId":"old-turn", "state":"running", "requestedAt":"2026-10-16T10:00:00Z",
                "startedAt":"2026-10-16T10:00:00Z", "completedAt":null,
                "assistantMessageId":null, "sourceProposedPlan":null
            }))
            .unwrap(),
        );
        view.activities.push(serde_json::from_value(serde_json::json!({
            "id":"old-approval", "kind":"approval.requested", "createdAt":"2026-10-16T10:00:01Z",
            "summary":"Command approval requested", "tone":"tool", "turnId":"old-turn",
            "payload":{"requestId":"approve-old","requestKind":"command","detail":"git status"}
        })).unwrap());
        cx.notify();
    });
    for state in [
        CloudTaskState::Queued,
        CloudTaskState::Preparing,
        CloudTaskState::Running,
    ] {
        store.update(cx, |store, _| {
            store.overview.as_mut().unwrap().tasks[0].state = state
        });
        app.update(cx, |_, cx| cx.notify());
        draw(cx);
        assert!(cx.debug_bounds("approval-panel").is_none());
        app.read_with(cx, |app, cx| {
            let status = app.conversation_status(cx);
            assert_eq!(status.facts.turn, Turn::Preparing);
            assert_eq!(status.facts.transcript, Transcript::Cached);
            assert!(!status.can_respond);
            assert!(!status.can_send);
            assert_eq!(app.composer.read(cx).value(), "Preserve draft during retry");
        });
    }
    app.update(cx, |app, cx| {
        // Delivery receipt may arrive before the matching execution projection.
        let view = Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap());
        view.messages.push(OrchestrationMessage {
            id: MessageId("retry-request-message".into()),
            role: OrchestrationMessageRole::User,
            text: tnes("Retry this request"),
            created_at: tnes("2026-10-16T11:00:00Z"),
            updated_at: tnes("2026-10-16T11:00:00Z"),
            turn_id: None,
            attachments: None,
            streaming: false,
        });
        cx.notify();
    });
    draw(cx);
    app.read_with(cx, |app, cx| {
        assert_eq!(app.conversation_status(cx).facts.turn, Turn::Preparing)
    });
    app.update(cx, |app, cx| {
        let view = Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap());
        let latest = view.latest_turn.as_mut().unwrap();
        latest.turn_id = vitre_contracts::TurnId("new-turn".into());
        latest.requested_at = tnes("2026-10-16T11:00:00Z");
        latest.started_at = Some(tnes("2026-10-16T11:00:00Z"));
        view.session = Some(
            serde_json::from_value(serde_json::json!({
                "threadId": view.id.0, "status":"running", "activeTurnId":"new-turn",
                "updatedAt":"2026-10-16T11:00:00Z", "lastError":null
            }))
            .unwrap(),
        );
        cx.notify();
    });
    draw(cx);
    assert!(cx.debug_bounds("approval-panel").is_none());
    app.read_with(cx, |app, cx| {
        assert_eq!(app.conversation_status(cx).facts.turn, Turn::Working)
    });
    app.update(cx, |app, cx| {
        let view = Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap());
        let mut approval = view.activities.last().unwrap().clone();
        approval.turn_id = Some(vitre_contracts::TurnId("new-turn".into()));
        approval.created_at = tnes("2026-10-16T11:00:01Z");
        approval.payload["requestId"] = serde_json::json!("approve-new");
        view.activities.push(approval);
        cx.notify();
    });
    draw(cx);
    assert!(cx.debug_bounds("approval-panel").is_some());
    app.read_with(cx, |app, cx| {
        let status = app.conversation_status(cx);
        assert_eq!(status.facts.turn, Turn::Approval);
        assert!(status.can_respond);
        let view = app.thread.as_ref().unwrap().state.view.as_ref().unwrap();
        assert_eq!(derive_pending_approvals(&view.activities).len(), 2);
        assert_eq!(
            derive_pending_approvals(&conversation_status::current_request_activities(view))[0]
                .request_id,
            "approve-new"
        );
    });
}

#[gpui::test]
fn idle_restored_cloud_execution_accepts_send_without_a_new_turn_receipt(cx: &mut TestAppContext) {
    use conversation_status::Turn;
    let (app, store, cx) = open(CloudTaskState::Running, cx);
    app.update_in(cx, |app, window, cx| {
        app.draft_restore = None;
        app.composer.update(cx, |input, cx| input.set_value("Next request", window, cx));
        let open = app.thread.as_mut().unwrap();
        if let ThreadFeed::Cloud(feed) = &mut open.feed {
            feed.source = CloudSource::Live;
            feed.connection_phase = SyncPhase::Live;
        }
        let view = Arc::make_mut(open.state.view.as_mut().unwrap());
        view.activities.push(serde_json::from_value(serde_json::json!({
            "id":"historical-approval", "kind":"approval.requested", "createdAt":"2026-10-16T10:00:01Z",
            "summary":"Command approval requested", "tone":"tool", "turnId":null,
            "payload":{"requestId":"old-request","requestKind":"command","detail":"git status"}
        })).unwrap());
        cx.notify();
    });
    for wake_only in [true, false] {
        store.update(cx, |store, _| {
            let task = &mut store.overview.as_mut().unwrap().tasks[0];
            task.state = CloudTaskState::Running;
            task.idle = Some(true);
            task.turn_request_id = Some("restore-without-user-message".into());
            task.wake_only = Some(wake_only);
            task.handoff = (!wake_only).then(|| {
                serde_json::from_value(serde_json::json!({
                    "operationId":"move", "conversationId":"conversation", "generation":0,
                    "history":{"chunks":[],"sha256":"history","sizeBytes":0}
                }))
                .unwrap()
            });
        });
        app.update(cx, |_, cx| cx.notify());
        draw(cx);
        app.read_with(cx, |app, cx| {
            let status = app.conversation_status(cx);
            assert_eq!(status.facts.turn, Turn::Finished);
            assert!(status.can_send);
            assert!(!status.can_respond);
            assert!(!status.show_requests);
        });
        assert!(cx.debug_bounds("approval-panel").is_none());
        store.update(cx, |store, _| {
            let task = &mut store.overview.as_mut().unwrap().tasks[0];
            task.idle = Some(false);
            task.wake_only = Some(false);
            task.turn_request_id = Some("new-user-request".into());
        });
        app.update(cx, |_, cx| cx.notify());
        app.read_with(cx, |app, cx| {
            let status = app.conversation_status(cx);
            assert_eq!(status.facts.turn, Turn::Preparing);
            assert!(!status.can_send);
            assert!(!status.show_requests);
        });
        store.update(cx, |store, _| {
            store.overview.as_mut().unwrap().tasks[0].state = CloudTaskState::Queued
        });
        app.read_with(cx, |app, cx| assert!(!app.conversation_status(cx).can_send));
    }
}

#[gpui::test]
fn mirror_reconnect_keeps_newer_live_history_and_applies_connection_and_deletion(
    cx: &mut TestAppContext,
) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    let mut live = thread();
    live.messages[0].text = tnes("Latest live answer");
    live.messages[0].updated_at = tnes("2026-10-16T11:00:00Z");
    live.activities.clear();
    live.latest_turn = None;
    app.update(cx, |app, cx| {
        app.apply_cloud_state(
            ThreadState {
                phase: SyncPhase::Live,
                view: Some(Arc::new(live.clone())),
                deleted: false,
            },
            cx,
        );
        let mut older = live.clone();
        older.messages[0].text = tnes("Older checkpoint answer");
        older.messages[0].updated_at = tnes("2026-10-16T10:00:00Z");
        // A newer relay heartbeat can synthesize newer metadata without newer history.
        older.updated_at = tnes("2026-10-16T12:00:00Z");
        older.activities.push(
            serde_json::from_value(serde_json::json!({
                "id":"restored-old-checkpoint", "kind":"thread.history.imported",
                "createdAt":"2026-10-16T12:00:00Z", "summary":"History restored",
                "tone":"info", "turnId":null, "payload":{"historicalActivityIds":[]}
            }))
            .unwrap(),
        );
        app.apply_cloud_mirror_state(
            ThreadState {
                phase: SyncPhase::Disconnected,
                view: Some(Arc::new(older)),
                deleted: false,
            },
            cx,
        );
        let state = &app.thread.as_ref().unwrap().state;
        assert_eq!(state.phase, SyncPhase::Disconnected);
        assert_eq!(
            state.view.as_ref().unwrap().messages[0].text.0,
            "Latest live answer"
        );
        let mut newer = live.clone();
        newer.messages[0].text = tnes("Newer mirrored answer");
        newer.messages[0].updated_at = tnes("2026-10-16T13:00:00Z");
        app.apply_cloud_mirror_state(
            ThreadState {
                phase: SyncPhase::Synchronizing,
                view: Some(Arc::new(newer)),
                deleted: false,
            },
            cx,
        );
        let state = &app.thread.as_ref().unwrap().state;
        assert_eq!(state.phase, SyncPhase::Synchronizing);
        assert_eq!(
            state.view.as_ref().unwrap().messages[0].text.0,
            "Newer mirrored answer"
        );
        let mut deleted = live;
        deleted.deleted_at = Some(tnes("2026-10-16T14:00:00Z"));
        app.apply_cloud_mirror_state(
            ThreadState {
                phase: SyncPhase::Disconnected,
                view: Some(Arc::new(deleted)),
                deleted: false,
            },
            cx,
        );
        assert!(app.thread.as_ref().unwrap().state.deleted);
    });
}

#[gpui::test]
fn switching_draft_to_cloud_does_not_select_an_unrelated_repository(cx: &mut TestAppContext) {
    let (app, store, cx) = setup(cx);
    seed(&store, overview(vec![repository()], vec![]), cx);
    app.update_in(cx, |a, w, cx| {
        a.set_draft_work_location(WorkLocation::Cloud, w, cx)
    });
    draw(cx);
    app.read_with(cx, |a, cx| {
        assert_eq!(a.draft_work_location, WorkLocation::Cloud);
        assert_eq!(a.cloud_draft.repository.as_deref(), None);
        assert_eq!(a.cloud_branch.read(cx).value().as_ref(), "");
    });
}
#[gpui::test]
fn switching_draft_to_cloud_preserves_attachments(cx: &mut TestAppContext) {
    let (app, _, cx) = setup(cx);
    app.update_in(cx, |a, w, cx| {
        a.pending_attachments.push(PendingAttachment {
            name: "local.txt".into(),
            mime_type: "text/plain".into(),
            size_bytes: 1,
            data_url: "data:text/plain;base64,eA==".into(),
            is_image: false,
        });
        a.set_draft_work_location(WorkLocation::Cloud, w, cx);
    });
    app.read_with(cx, |a, _| {
        assert_eq!(a.draft_work_location, WorkLocation::Cloud);
        assert!(a.last_error.is_none());
        assert_eq!(a.pending_attachments.len(), 1);
    });
}
#[gpui::test]
fn cloud_draft_walks_through_onboarding_states(cx: &mut TestAppContext) {
    let (app, store, cx) = setup(cx);
    app.update_in(cx, |a, w, cx| {
        a.set_draft_work_location(WorkLocation::Cloud, w, cx)
    });
    for session in [
        SessionState::Unknown,
        SessionState::Disabled,
        SessionState::SignedOut,
        SessionState::SigningIn,
        SessionState::SignedIn,
    ] {
        store.update(cx, |s, cx| {
            s.session = session;
            cx.notify();
        });
        draw(cx);
        app.update(cx, |a, cx| assert!(a.cloud_start_blocker(cx).is_some()));
    }
}
#[gpui::test]
fn selecting_cloud_thread_mirrors_store_detail_without_local_open_thread(cx: &mut TestAppContext) {
    let (app, store, cx) = open(CloudTaskState::Completed, cx);
    draw(cx);
    app.read_with(cx, |a, cx| {
        let open = a.thread.as_ref().unwrap();
        assert!(matches!(open.feed, ThreadFeed::Cloud(_)));
        assert_eq!(open.state.phase, SyncPhase::Disconnected);
        assert_eq!(open.state.view.as_ref().unwrap().messages.len(), 1);
        assert_eq!(store.read(cx).watching.as_deref(), Some("task-1"));
        assert!(a.search_root().is_none());
    });
    app.update(cx, |a, cx| a.close_open_thread(cx));
    assert!(store.read_with(cx, |s, _| s.watching.is_none()));
}
#[gpui::test]
fn task_created_event_selects_the_new_cloud_thread_and_clears_draft(cx: &mut TestAppContext) {
    let (app, store, cx) = setup(cx);
    seed(
        &store,
        overview(
            vec![repository()],
            vec![task("task-1", CloudTaskState::Queued, false)],
        ),
        cx,
    );
    app.update_in(cx, |a, w, cx| {
        a.draft_creating = true;
        a.draft_project = Some(ProjectId("origin-project".into()));
        a.cloud_creating_project = a.draft_project.clone();
        a.composer
            .update(cx, |s, cx| s.set_value("queued prompt", w, cx));
    });
    store.update(cx, |_, cx| {
        cx.emit(CloudEvent::TaskCreated("task-1".into()))
    });
    app.read_with(cx, |a, cx| {
        assert_eq!(a.open_cloud_task_id().as_deref(), Some("task-1"));
        assert!(!a.draft_creating);
        assert!(a.composer.read(cx).value().is_empty());
    });
}
#[gpui::test]
fn cloud_shell_preserves_metadata_when_disconnected_and_allows_ask_mode(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    app.update(cx, |a, cx| {
        let before = a.shell_thread(&cloud_thread_id("task-1")).unwrap().clone();
        a.set_runtime_mode(RuntimeMode::ApprovalRequired, cx);
        a.set_ask_mode(cx);
        a.archive_thread(cloud_thread_id("task-1"), cx);
        a.set_thread_settled(cloud_thread_id("task-1"), true, cx);
        assert_eq!(a.shell_thread(&before.id), Some(&before));
        assert!(a.ask_mode);
    });
}
#[gpui::test]
fn existing_cloud_conversation_offers_switch_without_changing_owner_offline(
    cx: &mut TestAppContext,
) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    app.update_in(cx, |a, w, cx| {
        assert!(a.can_switch_work_location());
        a.set_draft_work_location(WorkLocation::Local, w, cx);
        assert!(a.is_cloud_thread());
    });
}
#[gpui::test]
fn active_cloud_task_disables_send_and_offers_stop(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Running, cx);
    app.update(cx, |a, _| {
        let open = a.thread.as_mut().unwrap();
        open.state.phase = SyncPhase::Live;
        if let ThreadFeed::Cloud(feed) = &mut open.feed {
            feed.source = CloudSource::Live;
            feed.connection_phase = SyncPhase::Live;
        }
        let view = Arc::make_mut(open.state.view.as_mut().unwrap());
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId": "active-turn", "state": "running", "assistantMessageId": null,
                "requestedAt": "2026-10-16T15:00:00Z", "startedAt": null, "completedAt": null
            }))
            .unwrap(),
        );
    });
    draw(cx);
    app.read_with(cx, |a, cx| {
        assert!(a.conversation_status(cx).can_stop);
        assert!(a.cloud_send_blocker(cx).is_some());
    });
}
#[gpui::test]
fn terminal_cloud_task_enables_follow_up(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    draw(cx);
    app.read_with(cx, |a, cx| {
        assert!(a.conversation_status(cx).can_send);
        assert_eq!(a.cloud_send_blocker(cx), None);
    });
}
#[gpui::test]
fn interrupted_cloud_task_offers_specific_retry(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Interrupted, cx);
    draw(cx);
    app.update(cx, |a, cx| {
        assert_eq!(
            a.conversation_status(cx).action,
            super::conversation_status::Action::Retry
        )
    });
}
#[gpui::test]
fn cloud_thread_never_renders_revert(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    draw(cx);
    app.read_with(cx, |a, _| assert!(a.revert_turn_counts.is_empty()));
}
#[gpui::test]
fn publish_sheet_opens_over_chat_and_escape_closes_it(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    app.update(cx, |a, cx| {
        a.open_cloud_sheet(
            crate::cloud::Sheet::confirm_delete("task-1".into(), "Test".into()),
            cx,
        )
    });
    draw(cx);
    app.read_with(cx, |a, _| assert!(a.cloud_sheet.is_some()));
    cx.simulate_keystrokes("escape");
    app.read_with(cx, |a, _| {
        assert!(a.cloud_sheet.is_none());
        assert!(a.is_cloud_thread());
    });
}

#[gpui::test]
fn cloud_tasks_merge_into_sidebar_rows_under_matching_project(cx: &mut TestAppContext) {
    let (app, store, cx) = setup(cx);
    let mut matching = task("task-1", CloudTaskState::Running, false);
    matching.repository.owner = "ACME".into();
    app.update(cx,|a,cx| {
        a.shell.snapshot=Some(Arc::new(serde_json::from_value(serde_json::json!({"snapshotSequence":1,"updatedAt":"2026-10-10T10:00:00Z","threads":[],"projects":[{
            "id":"local-project","title":"Vitre","workspaceRoot":"/tmp/vitre-cloud-project","defaultModelSelection":null,"scripts":[],"createdAt":"2026-10-09T10:00:00Z","updatedAt":"2026-10-10T10:00:00Z",
            "repositoryIdentity":{"canonicalKey":"github.com/acme/vitre","provider":"github","owner":"acme","name":"vitre","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"https://github.com/acme/vitre"}}
        }]})).unwrap()));cx.notify();
    });
    let mut unmatched = task("task-2", CloudTaskState::Completed, false);
    unmatched.repository.name = "other".into();
    seed(
        &store,
        overview(vec![repository()], vec![matching, unmatched]),
        cx,
    );
    draw(cx);
    app.read_with(cx, |a, _| {
        let rows = a.cloud_sidebar_rows();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            (
                ProjectId("local-project".into()),
                vec![cloud_thread_id("task-1")]
            )
        );
        assert_eq!(rows[1].0.0, "cloud:acme/other");
        assert_eq!(rows[1].1, vec![cloud_thread_id("task-2")]);
    });
}
#[gpui::test]
fn cloud_thread_header_hides_local_controls_and_shows_publish(cx: &mut TestAppContext) {
    let (_app, _, cx) = open(CloudTaskState::Completed, cx);
    draw(cx);
    assert!(cx.debug_bounds("cloud-publish").is_some());
    assert!(cx.debug_bounds("thread-location-switch").is_some());
    assert!(cx.debug_bounds("local-workspace-controls").is_none());
}
#[gpui::test]
fn cloud_thread_with_open_pr_shows_open_pr(cx: &mut TestAppContext) {
    let (_, store, cx) = open(CloudTaskState::Completed, cx);
    store.update(cx,|s,cx| {
        s.overview.as_mut().unwrap().publications.push(serde_json::from_value(serde_json::json!({"body":"body","id":"pub-1","kind":"pull_request","resultId":"rev-1","resultSha256":"abc","state":"published","taskId":"task-1","title":"Fix login","url":"https://github.com/acme/vitre/pull/1"})).unwrap());cx.notify();
    });
    draw(cx);
    assert!(cx.debug_bounds("cloud-open-pr").is_some());
    assert!(cx.debug_bounds("cloud-publish").is_none());
}
#[gpui::test]
fn cloud_task_error_feeds_error_banner_with_retry(cx: &mut TestAppContext) {
    let (app, store, cx) = open(CloudTaskState::Failed, cx);
    store.update(cx, |s, cx| {
        s.overview.as_mut().unwrap().tasks[0].error = Some(tnes("Worker failed"));
        cx.emit(CloudEvent::Changed);
        cx.notify();
    });
    draw(cx);
    app.read_with(cx, |a, cx| {
        let status = a.conversation_status(cx);
        assert_eq!(status.action, super::conversation_status::Action::Retry);
        assert_eq!(status.facts.detail.as_deref(), Some("Worker failed"));
        assert!(a.last_error.is_none());
    });
}
#[gpui::test]
fn cloud_right_panel_offers_diff_and_tests_only(cx: &mut TestAppContext) {
    use vitre_state::right_panel::SurfaceKind;
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    app.read_with(cx, |a, _| {
        assert_eq!(
            a.offered_surface_kinds(),
            vec![SurfaceKind::Diff, SurfaceKind::Tests]
        );
        assert_eq!(a.cloud_diff_cache.as_ref().unwrap().1.len(), 1);
    });
    for kind in [SurfaceKind::Diff, SurfaceKind::Tests] {
        app.update_in(cx, |a, w, cx| a.open_workspace_surface(kind, w, cx));
        draw(cx);
        app.read_with(cx, |a, _| {
            assert_eq!(
                a.right_panel.map.active_kind(&a.dock_thread_key().unwrap()),
                Some(kind)
            );
            assert!(a.diff.is_none());
        });
    }
    app.update_in(cx, |a, w, cx| {
        a.open_workspace_surface(SurfaceKind::Terminal, w, cx)
    });
    app.read_with(cx, |a, _| {
        assert_eq!(
            a.right_panel.map.active_kind(&a.dock_thread_key().unwrap()),
            Some(SurfaceKind::Tests)
        )
    });
}
#[gpui::test]
fn cloud_send_blocker_gates_on_terminal_state_and_attachments(cx: &mut TestAppContext) {
    let (app, store, cx) = open(CloudTaskState::Completed, cx);
    store.update(cx, |s, _| {
        s.pending
            .insert(crate::cloud::Op::Task("task-1".into(), "continue"));
    });
    app.read_with(cx, |a, cx| {
        assert_eq!(a.cloud_send_blocker(cx), Some("Sending follow-up…"))
    });
    store.update(cx, |s, _| s.pending.clear());
    app.update(cx, |a, cx| {
        a.pending_attachments.push(PendingAttachment {
            name: "local.txt".into(),
            mime_type: "text/plain".into(),
            size_bytes: 1,
            data_url: "data:text/plain;base64,eA==".into(),
            is_image: false,
        });
        assert!(a.cloud_send_blocker(cx).is_none());
    });
}
#[gpui::test]
fn cloud_follow_up_reconciles_worker_assigned_message_ids(cx: &mut TestAppContext) {
    let (app, store, cx) = open(CloudTaskState::Completed, cx);
    app.update_in(cx, |a, window, cx| {
        a.restore_composer_draft(window, cx);
        a.cloud_draft.request_key = Some("submitted-request".into());
        let mut message = thread().messages[0].clone();
        message.id = MessageId("optimistic".into());
        message.text = tnes(ask_mode_prompt(true, "follow up"));
        a.optimistic_user_messages.push(message);
        a.cloud_pending_send = Some(CloudPendingSend {
            request_key: a
                .cloud_draft
                .request_key
                .clone()
                .unwrap_or_else(|| "test-request".into()),
            delivery: super::cloud_thread::CloudDeliveryState::Submitting,
            input: None,
            requested_at: tnes("2026-10-15T16:13:37Z"),
            attachments: Vec::new(),
            raw_prompt: "follow up".into(),
            review_comments: Vec::new(),
            terminal_contexts: Vec::new(),
            task_id: "task-1".into(),
            message_id: MessageId("optimistic".into()),
            prompt: ask_mode_prompt(true, "follow up"),
            baseline_ids: HashSet::from([MessageId("m1".into())]),
            accepted: false,
        });
        a.save_composer_draft(cx);
        let saved = serde_json::to_value(a.drafts.load("cloud-task-1")).unwrap();
        assert_eq!(a.drafts.take_error(), None, "draft writer or reader failed");
        assert_eq!(saved["text"], "");
        assert_eq!(saved["pending_cloud"]["raw_prompt"], "follow up");
    });
    store.update(cx, |s, cx| {
        let detail = s.details.get_mut("task-1").unwrap();
        let view = Arc::make_mut(detail.conversation.as_mut().unwrap());
        let mut message = view.messages[0].clone();
        message.role = OrchestrationMessageRole::User;
        message.id = MessageId("submitted-request-message".into());
        message.created_at = tnes("2026-10-15T16:13:37Z");
        message.turn_id = None;
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId":"previous-turn", "state":"completed", "assistantMessageId":null,
                "requestedAt":"2026-10-09T10:00:00Z", "startedAt":null, "completedAt":null
            }))
            .unwrap(),
        );
        message.text = tnes(format!(
            "{}\n\n<vitre_cloud_context>\nCloud execution instructions\n</vitre_cloud_context>",
            ask_mode_prompt(true, "follow up")
        ));
        view.messages.push(message);
        cx.emit(CloudEvent::Changed);
    });
    app.read_with(cx, |a, cx| {
        let pending = a
            .cloud_pending_send
            .as_ref()
            .expect("receipt precedes turn projection");
        assert!(pending.accepted);
        assert_eq!(pending.delivery, CloudDeliveryState::Accepted);
        assert!(!a.conversation_status(cx).can_send);
        assert!(a.optimistic_user_messages.is_empty());
        assert_eq!(a.display_messages.len(), 2);
        let saved = serde_json::to_value(a.drafts.load("cloud-task-1")).unwrap();
        assert_eq!(saved["pending_cloud"]["delivery"], "Accepted");
    });
    store.update(cx, |s, cx| {
        s.delivery_outcomes.insert(
            "submitted-request".into(),
            crate::cloud::store::DeliveryOutcome::Unknown("Late response lost".into()),
        );
        cx.emit(CloudEvent::Changed);
    });
    app.read_with(cx, |a, cx| {
        assert_eq!(
            a.cloud_delivery_status(cx),
            Some(CloudDeliveryState::Accepted)
        );
        assert!(!a.conversation_status(cx).can_send);
    });
    store.update(cx, |s, cx| {
        let view = Arc::make_mut(
            s.details
                .get_mut("task-1")
                .unwrap()
                .conversation
                .as_mut()
                .unwrap(),
        );
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId":"follow-up-turn", "state":"completed", "assistantMessageId":null,
                "requestedAt":"2026-10-15T16:13:37.000Z", "startedAt":null, "completedAt":null
            }))
            .unwrap(),
        );
        cx.emit(CloudEvent::Changed);
    });
    app.read_with(cx, |a, _| {
        assert!(a.cloud_pending_send.is_none());
        assert!(a.optimistic_user_messages.is_empty());
        assert_eq!(a.display_messages.len(), 2);
        let saved = serde_json::to_value(a.drafts.load("cloud-task-1")).unwrap();
        assert_eq!(saved["text"], "");
        assert!(saved["cloud"]["request_key"].is_null());
    });
}

#[gpui::test]
fn cloud_acknowledgement_rejects_old_identical_messages_and_preserves_new_draft(
    cx: &mut TestAppContext,
) {
    let (app, store, cx) = open(CloudTaskState::Completed, cx);
    app.update_in(cx, |a, window, cx| {
        a.restore_composer_draft(window, cx);
        a.cloud_draft.request_key = Some("current-request".into());
        a.cloud_pending_send = Some(CloudPendingSend {
            request_key: a
                .cloud_draft
                .request_key
                .clone()
                .unwrap_or_else(|| "test-request".into()),
            delivery: super::cloud_thread::CloudDeliveryState::Submitting,
            input: None,
            requested_at: tnes("2026-10-15T16:13:37Z"),
            task_id: "task-1".into(),
            message_id: MessageId("optimistic".into()),
            prompt: "same question".into(),
            raw_prompt: "same question".into(),
            attachments: Vec::new(),
            review_comments: Vec::new(),
            terminal_contexts: Vec::new(),
            // An idempotent retry may already have this exact request in its
            // baseline; a different request with the same words is still old.
            baseline_ids: HashSet::from([MessageId("current-request-message".into())]),
            accepted: true,
        });
        a.composer
            .update(cx, |s, cx| s.set_value("my next draft", window, cx));
    });
    for (request, acknowledged) in [("older-request", false), ("current-request", true)] {
        store.update(cx, |s, cx| {
            let detail = s.details.get_mut("task-1").unwrap();
            let view = Arc::make_mut(detail.conversation.as_mut().unwrap());
            let mut message = view.messages[0].clone();
            message.id = MessageId(format!("{request}-message"));
            message.turn_id = Some(vitre_contracts::TurnId(format!("{request}-turn")));
            view.latest_turn = Some(serde_json::from_value(serde_json::json!({
                "turnId":format!("{request}-turn"), "state":"completed", "assistantMessageId":null,
                "requestedAt":"2026-10-15T16:13:37Z", "startedAt":null, "completedAt":null
            })).unwrap());
            message.text = tnes("same question\n\n<vitre_cloud_context>\nCloud instructions\n</vitre_cloud_context>");
            view.messages.push(message);
            cx.emit(CloudEvent::Changed);
        });
        app.read_with(cx, |a, cx| {
            assert_eq!(a.cloud_pending_send.is_none(), acknowledged);
            assert_eq!(a.composer.read(cx).value().as_ref(), "my next draft");
            if acknowledged {
                let saved = serde_json::to_value(a.drafts.load("cloud-task-1")).unwrap();
                assert_eq!(saved["text"], "my next draft");
            }
        });
    }
}

fn legacy_ask_retry_draft() -> drafts::ComposerDraft {
    let prompt = ask_mode_prompt(true, "already submitted");
    let input = vitre_contracts::CloudContinueConversationInput {
        idempotency_key: String::new(),
        task_id: "task-1".into(),
        prompt: prompt.clone(),
        attachments: Vec::new(),
    };
    serde_json::from_value(serde_json::json!({
        "text": prompt,
        "ask_mode": true,
        "cloud": {
            "request_key": "submitted-request",
            "request_identity": serde_json::to_string(&input).unwrap(),
        },
    }))
    .unwrap()
}

fn acknowledge_restored_cloud_request(store: &Entity<CloudStore>, cx: &mut VisualTestContext) {
    store.update(cx, |s, cx| {
        let detail = s.details.get_mut("task-1").unwrap();
        let view = Arc::make_mut(detail.conversation.as_mut().unwrap());
        let mut message = view.messages[0].clone();
        message.id = MessageId("submitted-request-message".into());
        message.text = tnes(format!(
            "{}\n\n<vitre_cloud_context>\nCloud instructions\n</vitre_cloud_context>",
            ask_mode_prompt(true, "already submitted")
        ));
        view.messages.push(message);
        cx.emit(CloudEvent::Changed);
    });
}

#[gpui::test]
fn cloud_restart_recovers_raw_ask_text_then_clears_only_the_acknowledged_retry(
    cx: &mut TestAppContext,
) {
    let (app, store, cx) = open(CloudTaskState::Completed, cx);
    app.update_in(cx, |a, window, cx| {
        a.draft_restore = Some(legacy_ask_retry_draft());
        a.restore_composer_draft(window, cx);
        assert_eq!(a.composer.read(cx).value().as_ref(), "already submitted");
        assert!(a.ask_mode);
        a.save_composer_draft(cx);
        // Preserve the recovery marker if history is still unavailable at quit.
        a.draft_restore = Some(a.drafts.load("cloud-task-1"));
        a.restore_composer_draft(window, cx);
    });
    acknowledge_restored_cloud_request(&store, cx);
    draw(cx);
    app.read_with(cx, |a, cx| {
        assert!(a.composer.read(cx).value().is_empty());
        assert!(a.cloud_draft.request_key.is_none());
        let saved = serde_json::to_value(a.drafts.load("cloud-task-1")).unwrap();
        assert_eq!(saved["text"], "");
        assert!(saved["cloud"]["prompt_recovery"].is_null());
    });
}

#[gpui::test]
fn late_cloud_history_never_clears_a_newly_edited_draft(cx: &mut TestAppContext) {
    let (app, store, cx) = open(CloudTaskState::Completed, cx);
    app.update_in(cx, |a, window, cx| {
        a.draft_restore = Some(legacy_ask_retry_draft());
        a.restore_composer_draft(window, cx);
        a.composer
            .update(cx, |s, cx| s.set_value("keep my new question", window, cx));
    });
    acknowledge_restored_cloud_request(&store, cx);
    draw(cx);
    app.read_with(cx, |a, cx| {
        assert_eq!(a.composer.read(cx).value().as_ref(), "keep my new question");
        let saved = serde_json::to_value(a.drafts.load("cloud-task-1")).unwrap();
        assert_eq!(saved["text"], "keep my new question");
    });
}

#[gpui::test]
fn cloud_restore_leaves_user_authored_wrapper_text_untouched(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    app.update_in(cx, |a, window, cx| {
        let text = "<vitre_ask_mode>\nExplain this XML tag\n</vitre_ask_mode>";
        a.draft_restore = Some(serde_json::from_value(serde_json::json!({"text": text})).unwrap());
        a.restore_composer_draft(window, cx);
        assert_eq!(a.composer.read(cx).value().as_ref(), text);
    });
}

#[gpui::test]
fn failed_cloud_follow_up_restores_prompt(cx: &mut TestAppContext) {
    let (app, store, cx) = open(CloudTaskState::Completed, cx);
    app.update(cx, |a, _| {
        a.cloud_pending_send = Some(CloudPendingSend {
            request_key: a
                .cloud_draft
                .request_key
                .clone()
                .unwrap_or_else(|| "test-request".into()),
            delivery: super::cloud_thread::CloudDeliveryState::Submitting,
            input: None,
            requested_at: tnes("2026-10-15T16:13:37Z"),
            attachments: vec![PendingAttachment {
                name: "retry.txt".into(),
                mime_type: "text/plain".into(),
                size_bytes: 1,
                data_url: "data:text/plain;base64,eA==".into(),
                is_image: false,
            }],
            raw_prompt: "retry me".into(),
            review_comments: Vec::new(),
            terminal_contexts: Vec::new(),
            task_id: "task-1".into(),
            message_id: MessageId("optimistic".into()),
            prompt: "retry me".into(),
            baseline_ids: HashSet::new(),
            accepted: false,
        })
    });
    store.update(cx, |s, cx| {
        s.delivery_outcomes.insert(
            "test-request".into(),
            crate::cloud::store::DeliveryOutcome::Rejected("Request rejected".into()),
        );
        cx.emit(CloudEvent::Changed);
    });
    app.read_with(cx, |a, cx| {
        assert!(a.cloud_pending_send.is_none());
        assert_eq!(a.composer.read(cx).value().as_ref(), "retry me");
        assert!(a.last_error.is_some());
        assert_eq!(a.pending_attachments.len(), 1);
        assert_eq!(a.pending_attachments[0].name, "retry.txt");
    });
}

#[gpui::test]
fn cloud_creation_clears_origin_draft_after_navigating_away(cx: &mut TestAppContext) {
    let (app, store, cx) = open(CloudTaskState::Completed, cx);
    app.update_in(cx, |a, w, cx| {
        let project = ProjectId("origin".into());
        a.new_thread(Some(project.clone()), w, cx);
        a.composer
            .update(cx, |s, cx| s.set_value("submitted prompt", w, cx));
        a.save_composer_draft(cx);
        a.cloud_creating_project = Some(project);
        a.draft_creating = true;
        a.select_thread(cloud_thread_id("task-1"), cx);
        a.composer
            .update(cx, |s, cx| s.set_value("separate follow-up", w, cx));
    });
    store.update(cx, |_, cx| {
        cx.emit(CloudEvent::TaskCreated("new-task".into()))
    });
    app.update_in(cx, |a, w, cx| {
        a.new_thread(Some(ProjectId("origin".into())), w, cx);
        assert!(a.composer.read(cx).value().is_empty());
    });
}

#[gpui::test]
fn cloud_workspace_routing_never_falls_back_to_desktop(cx: &mut TestAppContext) {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _entered = runtime.enter();
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    let (_, status) = watch::channel(SupervisorStatus::Idle);
    let desktop = Arc::new(EnvironmentClient::start(status));
    let (_, status) = watch::channel(SupervisorStatus::Idle);
    let remote = Arc::new(EnvironmentClient::start(status));
    app.update(cx, |a, _| {
        a.client = Some(desktop.clone());
        assert!(a.workspace_client().is_none());
        assert!(a.search_root().is_none());
        let ThreadFeed::Cloud(feed) = &mut a.thread.as_mut().unwrap().feed else {
            panic!("cloud feed");
        };
        feed.live = Some((
            remote.clone(),
            Arc::new(remote.open_thread(cloud_thread_id("task-1"))),
        ));
        assert!(Arc::ptr_eq(&a.workspace_client().unwrap(), &remote));
        let remote_key = a.workspace_cache_key("/workspace/repository").unwrap();
        a.thread = None;
        assert!(Arc::ptr_eq(&a.workspace_client().unwrap(), &desktop));
        assert_ne!(
            remote_key,
            a.workspace_cache_key("/workspace/repository").unwrap()
        );
    });
}

#[gpui::test]
fn cloud_unacknowledged_input_is_separate_from_the_editable_draft(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    app.update_in(cx, |a, window, cx| {
        a.restore_composer_draft(window, cx);
        a.cloud_draft.request_key = Some("stable-retry-key".into());
        a.cloud_pending_send = Some(CloudPendingSend {
            request_key: a
                .cloud_draft
                .request_key
                .clone()
                .unwrap_or_else(|| "test-request".into()),
            delivery: super::cloud_thread::CloudDeliveryState::Submitting,
            input: None,
            requested_at: tnes("2026-10-15T16:13:37Z"),
            task_id: "task-1".into(),
            message_id: MessageId("sending".into()),
            prompt: "Review this".into(),
            raw_prompt: "Review this".into(),
            attachments: vec![PendingAttachment {
                name: "file.txt".into(),
                mime_type: "text/plain".into(),
                size_bytes: 1,
                data_url: "data:text/plain;base64,eA==".into(),
                is_image: false,
            }],
            review_comments: Vec::new(),
            terminal_contexts: Vec::new(),
            baseline_ids: HashSet::new(),
            accepted: false,
        });
        a.save_composer_draft(cx);
        let saved = serde_json::to_value(a.drafts.load("cloud-task-1")).unwrap();
        assert_eq!(saved["text"], "");
        assert_eq!(saved["pending_cloud"]["raw_prompt"], "Review this");
        assert_eq!(saved["pending_cloud"]["attachments"][0]["name"], "file.txt");
        assert_eq!(saved["cloud"]["request_key"], "stable-retry-key");
        a.cloud_pending_send.as_mut().unwrap().accepted = true;
        a.save_composer_draft(cx);
        let saved = serde_json::to_value(a.drafts.load("cloud-task-1")).unwrap();
        assert_eq!(saved["text"], "");
        assert_eq!(saved["attachments"], serde_json::json!([]));
    });
}

#[gpui::test]
fn cloud_follow_up_waits_for_worker_cleanup(cx: &mut TestAppContext) {
    let (app, store, cx) = open(CloudTaskState::Cancelled, cx);
    for (state, idle, worker_state, allowed) in [
        (CloudTaskState::Cancelled, false, "ready", false),
        (CloudTaskState::Cancelled, false, "deleting", false),
        (CloudTaskState::Cancelled, false, "stopped", true),
        (CloudTaskState::Running, true, "ready", true),
        (CloudTaskState::Queued, true, "stopped", false),
    ] {
        let mut task = task("task-1", state, false);
        task.idle = Some(idle);
        task.worker = Some(
            serde_json::from_value(serde_json::json!({
                "id":"worker", "environmentId":"environment", "state":worker_state,
                "cpu":8,"memoryGiB":16,"diskGiB":100
            }))
            .unwrap(),
        );
        seed(&store, overview(vec![repository()], vec![task]), cx);
        app.read_with(cx, |a, cx| {
            assert_eq!(a.cloud_send_blocker(cx).is_none(), allowed)
        });
    }
}

#[gpui::test]
fn cloud_location_selection_rolls_back_on_transfer_error(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    app.update(cx, |a, cx| {
        let status = |error: Option<&str>| {
            serde_json::from_value(serde_json::json!({
                "binding":null,"conflicts":[],"operation":{
                    "id":"switch","conversationId":"cloud-task-1","generation":1,
                    "from":"cloud-github","to":"local","phase":"transferring",
                    "checkpoint":null,"error":error
                }
            }))
            .unwrap()
        };
        a.apply_location_status(status(None), cx);
        assert_eq!(a.cloud_switch_selection, Some(WorkLocation::Local));
        assert!(a.is_cloud_thread());
        a.apply_location_status(status(Some("Transfer failed")), cx);
        assert_eq!(a.cloud_switch_selection, None);
        assert!(a.is_cloud_thread());
        assert_eq!(a.last_error.as_deref(), Some("Transfer failed"));
    });
    draw(cx);
}

#[gpui::test]
fn cloud_location_selector_is_inside_the_composer(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    draw(cx);
    let selector = cx
        .debug_bounds("thread-location-switch")
        .expect("location selector");
    let toolbar = cx
        .debug_bounds("composer-location-toolbar")
        .expect("composer toolbar");
    assert!(selector.top() >= toolbar.top());
    assert!(selector.bottom() <= toolbar.bottom());
    app.update_in(cx, |a, w, cx| a.new_thread(None, w, cx));
    draw(cx);
    let selector = cx
        .debug_bounds("thread-location-switch")
        .expect("draft location selector");
    let toolbar = cx
        .debug_bounds("composer-location-toolbar")
        .expect("draft composer toolbar");
    assert!(selector.top() >= toolbar.top());
    assert!(selector.bottom() <= toolbar.bottom());
}

#[gpui::test]
fn cloud_location_popup_selects_from_the_composer(cx: &mut TestAppContext) {
    let (app, _, cx) = setup(cx);
    draw(cx);
    let selector = cx
        .debug_bounds("thread-location-switch")
        .expect("location popup trigger");
    cx.simulate_mouse_down(
        selector.center(),
        gpui::MouseButton::Left,
        Default::default(),
    );
    cx.simulate_mouse_up(
        selector.center(),
        gpui::MouseButton::Left,
        Default::default(),
    );
    draw(cx);
    cx.simulate_keystrokes("down down enter");
    draw(cx);
    app.read_with(cx, |a, _| {
        assert_eq!(a.draft_work_location, WorkLocation::CloudLocal)
    });
}

#[gpui::test]
fn preparing_handoff_disables_send_and_keeps_editable_draft(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    app.update_in(cx, |app, window, cx| {
        app.draft_restore = None;
        let open = app.thread.as_mut().unwrap();
        if let ThreadFeed::Cloud(feed) = &mut open.feed {
            feed.source = CloudSource::Live;
            feed.connection_phase = SyncPhase::Live;
        }
        app.composer.update(cx, |input, cx| {
            input.set_value("Keep this draft", window, cx)
        });
        assert!(app.conversation_status(cx).can_send);
        app.cloud_switch = Some(
            serde_json::from_value(serde_json::json!({
                "binding":null,"conflicts":[],"operation":{
                    "id":"preparing-move","conversationId":"cloud-task-1","from":"cloud-local",
                    "to":"local","generation":0,"phase":"preparing","checkpoint":null,"error":null
                }
            }))
            .unwrap(),
        );
        assert!(!app.location_switch_blocks_turn());
        assert!(!app.conversation_status(cx).can_send);
        app.composer.update(cx, |input, cx| {
            input.set_value("Keep this edited draft", window, cx)
        });
        cx.notify();
    });
    draw(cx);
    assert!(cx.debug_bounds("send-disabled").is_some());
    assert!(cx.debug_bounds("send").is_none());
    app.read_with(cx, |app, cx| {
        assert_eq!(app.composer.read(cx).value(), "Keep this edited draft")
    });
}

#[gpui::test]
fn settled_handoff_keeps_the_current_turn_identity_and_elapsed_time(cx: &mut TestAppContext) {
    use conversation_status::{Transfer, Turn};
    let (app, _, cx) = open(CloudTaskState::Running, cx);
    app.update(cx, |app, cx| {
        let open = app.thread.as_mut().unwrap();
        if let ThreadFeed::Cloud(feed) = &mut open.feed {
            feed.source = CloudSource::Live;
            feed.connection_phase = SyncPhase::Live;
        }
        let view = Arc::make_mut(open.state.view.as_mut().unwrap());
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId":"new-turn", "state":"running", "requestedAt":"2026-10-16T11:00:00Z",
                "startedAt":"2026-10-16T11:00:01Z", "completedAt":null, "assistantMessageId":null
            }))
            .unwrap(),
        );
        view.session = Some(
            serde_json::from_value(serde_json::json!({
                "threadId":view.id.0, "status":"running", "activeTurnId":"new-turn",
                "updatedAt":"2026-10-16T11:00:01Z", "lastError":null
            }))
            .unwrap(),
        );
        for phase in ["completed", "cancelled"] {
            app.cloud_switch = Some(
                serde_json::from_value(serde_json::json!({
                    "binding":null, "conflicts":[], "operation":{
                        "id":"old-move", "conversationId":"cloud-task-1", "from":"cloud-local",
                        "to":"local", "generation":0, "phase":phase, "checkpoint":null,
                        "error":null, "startedAt":"2026-10-16T10:00:00Z"
                    }
                }))
                .unwrap(),
            );
            let status = app.conversation_status(cx);
            assert_eq!(status.facts.transfer, Transfer::None);
            assert_eq!(status.facts.turn, Turn::Working);
            assert_eq!(status.facts.identity, "cloud-task-1:new-turn");
            assert_eq!(
                status.facts.started_at.as_deref(),
                Some("2026-10-16T11:00:01Z")
            );
        }
        app.cloud_switch
            .as_mut()
            .unwrap()
            .operation
            .as_mut()
            .unwrap()
            .phase = vitre_contracts::CloudHandoffPhase::Preparing;
        let status = app.conversation_status(cx);
        assert_eq!(status.facts.identity, "cloud-task-1:old-move");
        assert_eq!(
            status.facts.started_at.as_deref(),
            Some("2026-10-16T10:00:00Z")
        );
    });
}

#[gpui::test]
fn cloud_handoff_state_does_not_block_another_project_draft(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Running, cx);
    app.update(cx, |a, cx| {
        a.cloud_switch = Some(
            serde_json::from_value(serde_json::json!({
                "binding": null, "conflicts": [],
                "operation": {"id":"switch-test", "conversationId":"cloud-task-1",
                    "from":"cloud-local", "to":"local", "generation":0,
                    "phase":"transferring", "checkpoint":null, "error":null}
            }))
            .unwrap(),
        );
        assert!(a.location_switch_blocks_turn());
        a.close_open_thread(cx);
        assert!(a.can_switch_work_location());
        assert!(!a.location_switch_blocks_turn());
    });
}

#[gpui::test]
fn cloud_handoff_recovery_clears_its_error(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Running, cx);
    app.update(cx, |a, cx| {
        let mut status: vitre_contracts::CloudSwitchStatus =
            serde_json::from_value(serde_json::json!({
                "binding":null, "conflicts":[], "operation":{
                    "id":"switch-test", "conversationId":"cloud-task-1", "from":"cloud-local",
                    "to":"local", "generation":0, "phase":"checkpointing", "checkpoint":null,
                    "error":"Transfer interrupted"}
            }))
            .unwrap();
        a.apply_location_status(status.clone(), cx);
        assert_eq!(a.last_error.as_deref(), Some("Transfer interrupted"));
        status.operation.as_mut().unwrap().error = None;
        a.apply_location_status(status, cx);
        assert!(a.last_error.is_none());
    });
}

fn pending_delivery(task_id: &str, request_key: &str) -> CloudPendingSend {
    CloudPendingSend {
        task_id: task_id.into(),
        message_id: MessageId(format!("{request_key}-message")),
        requested_at: tnes("2026-10-16T12:00:00Z"),
        prompt: "original request".into(),
        raw_prompt: "original request".into(),
        attachments: Vec::new(),
        review_comments: Vec::new(),
        terminal_contexts: Vec::new(),
        baseline_ids: HashSet::new(),
        accepted: false,
        request_key: request_key.into(),
        delivery: CloudDeliveryState::Submitting,
        input: Some(vitre_contracts::CloudContinueConversationInput {
            idempotency_key: request_key.into(),
            task_id: task_id.into(),
            prompt: "original request".into(),
            attachments: Vec::new(),
        }),
    }
}

#[gpui::test]
fn ambiguous_delivery_preserves_the_outbox_and_new_draft(cx: &mut TestAppContext) {
    let (app, store, cx) = open(CloudTaskState::Completed, cx);
    app.update_in(cx, |a, window, cx| {
        a.restore_composer_draft(window, cx);
        a.cloud_pending_send = Some(pending_delivery("task-1", "lost-response"));
        a.composer
            .update(cx, |input, cx| input.set_value("next question", window, cx));
        a.save_composer_draft(cx);
    });
    store.update(cx, |store, cx| {
        store.error = Some("An unrelated provider failed".into());
        store.delivery_outcomes.insert(
            "lost-response".into(),
            crate::cloud::store::DeliveryOutcome::Unknown("Disconnected".into()),
        );
        cx.emit(CloudEvent::Changed);
    });
    app.read_with(cx, |a, cx| {
        assert_eq!(
            a.cloud_pending_send.as_ref().unwrap().delivery,
            CloudDeliveryState::Unknown
        );
        assert_eq!(a.composer.read(cx).value().as_ref(), "next question");
        let saved = serde_json::to_value(a.drafts.load("cloud-task-1")).unwrap();
        assert_eq!(saved["text"], "next question");
        assert_eq!(
            saved["pending_cloud"]["input"]["idempotencyKey"],
            "lost-response"
        );
        assert_eq!(
            saved["pending_cloud"]["input"]["prompt"],
            "original request"
        );
    });
    store.update(cx, |store, cx| {
        store.delivery_outcomes.insert(
            "lost-response".into(),
            crate::cloud::store::DeliveryOutcome::Accepted,
        );
        cx.emit(CloudEvent::Changed);
    });
    store.update(cx, |store, cx| {
        store.error = Some("An unrelated command failed again".into());
        cx.emit(CloudEvent::Changed);
    });
    app.read_with(cx, |a, cx| {
        assert!(a.cloud_pending_send.as_ref().unwrap().accepted);
        assert_eq!(a.composer.read(cx).value().as_ref(), "next question");
    });
}

#[gpui::test]
fn definite_rejection_restores_original_input_only_once(cx: &mut TestAppContext) {
    let (app, store, cx) = open(CloudTaskState::Completed, cx);
    app.update_in(cx, |a, window, cx| {
        a.restore_composer_draft(window, cx);
        a.cloud_pending_send = Some(pending_delivery("task-1", "rejected"));
        a.composer
            .update(cx, |input, cx| input.set_value("new input", window, cx));
    });
    for _ in 0..2 {
        store.update(cx, |store, cx| {
            store.delivery_outcomes.insert(
                "rejected".into(),
                crate::cloud::store::DeliveryOutcome::Rejected("Rejected before acceptance".into()),
            );
            cx.emit(CloudEvent::Changed);
        });
    }
    app.read_with(cx, |a, cx| {
        assert!(a.cloud_pending_send.is_none());
        assert_eq!(
            a.composer.read(cx).value().as_ref(),
            "original request\nnew input"
        );
    });
}

#[gpui::test]
fn old_transfer_revision_cannot_relock_cancelled_conversation(cx: &mut TestAppContext) {
    let (app, _, cx) = open(CloudTaskState::Completed, cx);
    app.update(cx, |a, cx| {
        let status = |revision, phase| {
            serde_json::from_value(serde_json::json!({
                "binding":null,"conflicts":[],"operation":{
                    "id":"ordered-switch","conversationId":"cloud-task-1","generation":1,
                    "from":"cloud-github","to":"local","phase":phase,"revision":revision,
                    "checkpoint":null,"error":null
                }
            }))
            .unwrap()
        };
        a.apply_location_status(status(3, "cancelled"), cx);
        a.apply_location_status(status(2, "transferring"), cx);
        assert_eq!(
            a.cloud_switch
                .as_ref()
                .unwrap()
                .operation
                .as_ref()
                .unwrap()
                .phase,
            vitre_contracts::CloudHandoffPhase::Cancelled
        );
        assert!(!a.location_switch_pending());
        assert!(!a.location_switch_blocks_turn());
    });
}

#[gpui::test]
fn initial_cloud_delivery_is_scoped_and_rejects_once_without_losing_later_typing(
    cx: &mut TestAppContext,
) {
    let (app, store, cx) = setup(cx);
    let pending: CloudPendingStart = serde_json::from_value(serde_json::json!({
        "input": {"idempotencyKey":"first-send", "projectId":"project-a", "roots":[{"id":"primary","path":"/tmp/repository"}],
            "target":"cloud-local", "prompt":"original", "provider":"codex", "model":"gpt-6-sol", "attachments":[]},
        "raw_prompt":"original", "attachments":[], "review_comments":[], "terminal_contexts":[],
        "delivery":"Submitting", "error":null, "requested_at":"2026-10-16T15:00:00Z", "account_identity":"relay|account-a"
    })).unwrap();
    app.update_in(cx, |a, w, cx| {
        a.draft_project = Some(ProjectId("project-a".into()));
        a.draft_restore = None;
        a.cloud_draft.pending_start = Some(pending.clone());
        a.composer
            .update(cx, |input, cx| input.set_value("new typing", w, cx));
        a.save_composer_draft(cx);
    });
    for outcome in [
        crate::cloud::store::CreationOutcome::Unknown("lost response".into()),
        crate::cloud::store::CreationOutcome::Rejected("rejected".into()),
    ] {
        store.update(cx, |s, cx| {
            s.creation_outcomes.insert(
                "first-send".into(),
                crate::cloud::store::CreationResult {
                    project_id: "project-a".into(),
                    outcome,
                },
            );
            cx.emit(CloudEvent::Changed);
        });
    }
    app.read_with(cx, |a, cx| {
        assert_eq!(a.composer.read(cx).value().as_ref(), "original\nnew typing");
        assert!(a.cloud_draft.pending_start.is_none());
    });
    store.update(cx, |s, cx| {
        s.creation_outcomes.insert(
            "first-send".into(),
            crate::cloud::store::CreationResult {
                project_id: "project-a".into(),
                outcome: crate::cloud::store::CreationOutcome::Rejected("late".into()),
            },
        );
        cx.emit(CloudEvent::Changed);
    });
    app.read_with(cx, |a, cx| {
        assert_eq!(a.composer.read(cx).value().as_ref(), "original\nnew typing")
    });
    app.update_in(cx, |a, w, cx| {
        a.cloud_draft.pending_start = Some(pending);
        a.save_composer_draft(cx);
        a.draft_project = Some(ProjectId("project-b".into()));
        a.cloud_draft = CloudDraft::default();
        a.composer
            .update(cx, |input, cx| input.set_value("other draft", w, cx));
    });
    store.update(cx, |s, cx| {
        s.creation_outcomes.insert(
            "first-send".into(),
            crate::cloud::store::CreationResult {
                project_id: "project-a".into(),
                outcome: crate::cloud::store::CreationOutcome::Accepted("task-created".into()),
            },
        );
        cx.emit(CloudEvent::Changed);
    });
    app.read_with(cx, |a, cx| {
        assert_eq!(a.composer.read(cx).value().as_ref(), "other draft");
        assert!(a.thread.is_none());
        let saved = serde_json::to_value(a.drafts.load("project:project-a")).unwrap();
        assert!(saved["cloud"]["pending_start"].is_null());
    });
}

#[gpui::test]
fn ambiguous_cloud_stop_cannot_dispatch_a_duplicate(cx: &mut TestAppContext) {
    let (app, store, cx) = open(CloudTaskState::Running, cx);
    app.update(cx, |a, cx| {
        a.cloud_stops.insert(
            "task-1".into(),
            CloudStopState {
                turn_id: Some(vitre_contracts::TurnId("turn-1".into())),
                command_id: "stop-original".into(),
                request_id: None,
                task_updated_at: None,
                phase: CloudStopPhase::Requested,
                error: Some("reply lost".into()),
            },
        );
        assert!(a.cloud_stop_pending());
        a.cancel_cloud_task(cx);
        assert_eq!(a.cloud_stops["task-1"].command_id, "stop-original");
    });
    store.update(cx, |s, cx| {
        s.stop_outcomes.insert(
            "stop-original".into(),
            crate::cloud::store::DeliveryOutcome::Rejected("definite rejection".into()),
        );
        cx.emit(CloudEvent::Changed);
    });
    app.read_with(cx, |a, _| assert!(!a.cloud_stop_pending()));
}
