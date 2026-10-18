//! Real-window regression for project tab dragging and attention dots.
//! Runs only in the disposable `project-tabs` icon fixture.
use super::*;
use vitre_state::project_grouping::derive_physical_project_key;
use vitre_state::sidebar::ThreadStatus;

async fn draw(cx: &mut gpui::AsyncWindowContext) -> Result<(), String> {
    cx.background_executor()
        .timer(Duration::from_millis(150))
        .await;
    cx.update(|window, cx| window.draw(cx).clear(cx))
        .map_err(|e| e.to_string())
}

async fn mouse(x: f32, kind: &str, cx: &mut gpui::AsyncWindowContext) -> Result<(), String> {
    cx.update(|window, cx| {
        let position = gpui::point(px(x), px(22.));
        let event = match kind {
            "down" => gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                button: gpui::MouseButton::Left,
                position,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            "move" => gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                position,
                pressed_button: Some(gpui::MouseButton::Left),
                modifiers: Default::default(),
            }),
            _ => gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                button: gpui::MouseButton::Left,
                position,
                modifiers: Default::default(),
                click_count: 1,
            }),
        };
        window.dispatch_event(event, cx);
    })
    .map_err(|e| e.to_string())?;
    draw(cx).await
}

pub(super) async fn verify(
    app: &WeakEntity<ChatApp>,
    cx: &mut gpui::AsyncWindowContext,
) -> Result<(), String> {
    let (keys, selected) = app
        .update(cx, |app, cx| {
            ClientSettings::update(cx, |settings| settings.project_tabs_enabled = true);
            let keys: Vec<_> = app
                .shell
                .snapshot
                .as_ref()
                .unwrap()
                .projects
                .iter()
                .map(derive_physical_project_key)
                .collect();
            (keys, app.tab_project_id())
        })
        .map_err(|e| e.to_string())?;
    draw(cx).await?;

    // Positions within the screenshot-verified 1400px fixture: drag the last
    // tab to the first and back, without selecting the dragged project.
    for (from, to, expected) in [(600., 300., vec![2, 0, 1]), (300., 600., vec![0, 1, 2])] {
        mouse(from, "down", cx).await?;
        mouse(from + 12., "move", cx).await?;
        mouse(to, "move", cx).await?;
        ui_verification::capture("project-tabs-drag", cx).await?;
        // Capture moves the pointer; restore it to the drop target.
        mouse(to, "move", cx).await?;
        mouse(to, "up", cx).await?;
        app.update(cx, |app, _| {
            assert_eq!(
                app.sidebar.order_projects(&keys),
                expected,
                "native tab drag"
            );
            assert_eq!(
                app.tab_project_id(),
                selected,
                "drag must preserve selection"
            );
            assert_eq!(
                crate::sidebar_prefs::SidebarPrefs::load(&crate::vitre_home())
                    .order_projects(&keys),
                expected,
                "tab order must survive reload"
            );
        })
        .map_err(|e| e.to_string())?;
    }

    let (unread_project, approval_project) = app
        .update(cx, |app, cx| {
            // First project stays selected; a background completion and pending
            // approval on the other two projects must both show a dot.
            let snapshot = app.shell.snapshot.as_ref().unwrap();
            let first = snapshot
                .threads
                .iter()
                .find(|thread| thread.project_id == snapshot.projects[0].id)
                .unwrap()
                .id
                .clone();
            let unread_project = snapshot.projects[1].id.clone();
            let approval_project = snapshot.projects[2].id.clone();
            app.select_thread(first, cx);
            let snapshot = Arc::make_mut(app.shell.snapshot.as_mut().unwrap());
            let unread = snapshot
                .threads
                .iter_mut()
                .find(|thread| thread.project_id == unread_project)
                .unwrap();
            let old = "2026-01-01T00:00:00.000Z";
            let completed = now_iso();
            unread.updated_at = tnes(completed.clone());
            unread.latest_turn = Some(
                serde_json::from_value(serde_json::json!({
                    "turnId":"tab-completion", "assistantMessageId":null,
                    "requestedAt":old, "startedAt":old, "completedAt":completed, "state":"completed"
                }))
                .unwrap(),
            );
            app.sidebar
                .mark_thread_unread(&unread.id.0, Some(&completed));
            let approval = snapshot
                .threads
                .iter_mut()
                .find(|thread| thread.project_id == approval_project)
                .unwrap();
            approval.has_pending_approvals = true;
            app.rebuild_sidebar();
            assert_eq!(
                app.project_tab_attention(&unread_project),
                Some(ThreadStatus::Completed)
            );
            assert_eq!(
                app.project_tab_attention(&approval_project),
                Some(ThreadStatus::PendingApproval)
            );
            cx.notify();
            (unread_project, approval_project)
        })
        .map_err(|e| e.to_string())?;
    draw(cx).await?;
    ui_verification::capture("project-tabs-attention", cx).await?;

    mouse(430., "down", cx).await?;
    mouse(430., "up", cx).await?;
    app.update(cx, |app, _| {
        assert_eq!(app.tab_project_id(), Some(unread_project.clone()));
        assert_eq!(
            app.project_tab_attention(&unread_project),
            None,
            "opening clears unread completion"
        );
        assert_eq!(
            app.project_tab_attention(&approval_project),
            Some(ThreadStatus::PendingApproval)
        );
    })
    .map_err(|e| e.to_string())?;
    ui_verification::capture("project-tabs-read", cx).await?;

    mouse(600., "down", cx).await?;
    mouse(600., "up", cx).await?;
    app.update(cx, |app, cx| {
        assert_eq!(app.tab_project_id(), Some(approval_project.clone()));
        assert_eq!(
            app.project_tab_attention(&approval_project),
            Some(ThreadStatus::PendingApproval),
            "viewing an approval must not dismiss it"
        );
        Arc::make_mut(app.shell.snapshot.as_mut().unwrap())
            .threads
            .iter_mut()
            .find(|thread| thread.project_id == approval_project)
            .unwrap()
            .has_pending_approvals = false;
        app.rebuild_sidebar();
        assert_eq!(
            app.project_tab_attention(&approval_project),
            None,
            "resolved approval clears dot"
        );
        cx.notify();
    })
    .map_err(|e| e.to_string())?;
    draw(cx).await?;
    ui_verification::capture("project-tabs-resolved", cx).await?;
    eprintln!(
        "[vitre-project-tabs-test] PASS: native drag both directions, saved order, preserved selection, unread completion clears on visit, approval persists until resolved"
    );
    cx.update(|_, cx| cx.quit()).map_err(|e| e.to_string())?;
    Ok(())
}
