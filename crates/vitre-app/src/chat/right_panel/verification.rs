//! Regression pass using the disposable native fixture and real file reads.
use super::*;
use crate::chat::ui_verification;
use gpui::AsyncWindowContext;
use std::sync::Arc;
use std::time::Duration;

const SOURCE: &str = "src/components/Workspace.tsx";
const DEFINITION: &str = "src/main.rs";

async fn wait_for_file(
    app: &WeakEntity<ChatApp>,
    path: &str,
    text: &str,
    cx: &mut AsyncWindowContext,
) -> Result<(), String> {
    for _ in 0..50 {
        cx.background_executor()
            .timer(Duration::from_millis(80))
            .await;
        let ready = app.update(cx, |app, cx| {
            let key = app.dock_thread_key().unwrap();
            let panel = app.files.as_ref().unwrap().read(cx);
            matches!(app.right_panel.map.active_surface(&key), Some(RightPanelSurface::File { relative_path, .. }) if relative_path == path)
                && panel.active_file_status().is_some_and(|(open, _)| open == path)
                && panel.verification_editor().read(cx).value().contains(text)
        }).map_err(|e| e.to_string())?;
        if ready {
            return Ok(());
        }
    }
    Err(format!(
        "Selected tab and editor contents did not converge on {path}"
    ))
}

impl ChatApp {
    pub(in crate::chat) fn verify_dock_tabs(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let executor = cx.background_executor().clone();
        cx.spawn_in(window, async move |app, cx| {
            let run = async {
                ui_verification::float_fixture(cx).await?;
                cx.update(|w, _| w.resize(gpui::size(px(1440.), px(960.)))).map_err(|e| e.to_string())?;
                for maximized in [false, true] {
                    app.update_in(cx, |app, w, cx| {
                        app.right_panel_maximized = maximized;
                        app.dock_open_file(SOURCE.into(), None, w, cx);
                    }).map_err(|e| e.to_string())?;
                    wait_for_file(&app, SOURCE, "export function Workspace", cx).await?;
                    executor.timer(Duration::from_millis(500)).await;
                    let epoch = app.update(cx, |app, _| app.dock_reveal_epoch).map_err(|e| e.to_string())?;
                    // Exercise tree/file activation without changing dock visibility.
                    app.update_in(cx, |app, w, cx| app.dock_open_files_surface(w, cx)).map_err(|e| e.to_string())?;
                    executor.timer(Duration::from_millis(120)).await;
                    app.update_in(cx, |app, w, cx| app.dock_activate_surface(&vitre_state::right_panel::file_surface_id(None, SOURCE), w, cx)).map_err(|e| e.to_string())?;
                    wait_for_file(&app, SOURCE, "export function Workspace", cx).await?;
                    let stable = app.update(cx, |app, _| app.dock_reveal_epoch == epoch).map_err(|e| e.to_string())?;
                    if !stable { eprintln!("[vitre-tabs-test] REGRESSION: tab switching restarted dock entrance"); }

                    // Standard macOS tab chords work even while focus is in the
                    // chat composer rather than inside the right panel.
                    let (original_id, previous_id) = app.update(cx, |app, _| {
                        let key = app.dock_thread_key().unwrap();
                        let state = app.right_panel.map.thread(&key);
                        let original = state.active_surface_id.clone().unwrap();
                        let index = state.surfaces.iter().position(|surface| surface.id() == original).unwrap();
                        let previous = state.surfaces[(index + state.surfaces.len() - 1) % state.surfaces.len()].id().to_string();
                        (original, previous)
                    }).map_err(|e| e.to_string())?;
                    app.update_in(cx, |app, w, cx| app.composer.focus_handle(cx).focus(w, cx)).map_err(|e| e.to_string())?;
                    ui_verification::key("cmd-shift-[", cx).await?;
                    let selected_previous = app.update(cx, |app, _| {
                        let key = app.dock_thread_key().unwrap();
                        app.right_panel.map.thread(&key).active_surface_id.as_deref() == Some(&previous_id)
                    }).map_err(|e| e.to_string())?;
                    if !selected_previous { return Err("Cmd+Shift+[ did not select the previous right-panel tab from composer focus".into()); }
                    ui_verification::key("cmd-shift-]", cx).await?;
                    let restored_original = app.update(cx, |app, _| {
                        let key = app.dock_thread_key().unwrap();
                        app.right_panel.map.thread(&key).active_surface_id.as_deref() == Some(&original_id)
                    }).map_err(|e| e.to_string())?;
                    if !restored_original { return Err("Cmd+Shift+] did not restore the next right-panel tab from composer focus".into()); }
                    wait_for_file(&app, SOURCE, "export function Workspace", cx).await?;

                    // Feed a resolved cross-file location through the editor's real
                    // definition-navigation callback. No language-server install needed.
                    let (show, uri) = app.update(cx, |app, cx| {
                        let panel = app.files.as_ref().unwrap().read(cx);
                        let show = panel.verification_editor().read(cx).lsp().show_document.clone().unwrap();
                        (show, crate::lsp::bridge::file_uri(panel.cwd(), DEFINITION).unwrap())
                    }).map_err(|e| e.to_string())?;
                    let params = serde_json::from_value(serde_json::json!({"uri":uri,"selection":{"start":{"line":0,"character":3},"end":{"line":0,"character":7}}})).map_err(|e| e.to_string())?;
                    cx.update(|w, cx| show(&params, w, cx)).map_err(|e| e.to_string())?;
                    wait_for_file(&app, DEFINITION, "Hello, Vitre", cx).await?;
                    // Close with the same keyboard action as the normal editor UI.
                    ui_verification::key("cmd-w", cx).await?;
                    // Files was appended after SOURCE above: close selects Files.
                    app.update_in(cx, |app, w, cx| app.dock_activate_surface(&vitre_state::right_panel::file_surface_id(None, SOURCE), w, cx)).map_err(|e| e.to_string())?;
                    wait_for_file(&app, SOURCE, "export function Workspace", cx).await?;

                    // Reopen, then remove the Files tab so close must automatically
                    // select SOURCE without an explicit click/focus request.
                    app.update_in(cx, |app, w, cx| app.dock_close_surface("files", w, cx)).map_err(|e| e.to_string())?;
                    cx.update(|w, cx| show(&params, w, cx)).map_err(|e| e.to_string())?;
                    wait_for_file(&app, DEFINITION, "Hello, Vitre", cx).await?;
                    ui_verification::key("cmd-w", cx).await?;
                    wait_for_file(&app, SOURCE, "export function Workspace", cx).await?;
                    if !stable { return Err("Tab switching restarted the dock entrance".into()); }

                    // A → B → A before B's read completes must keep A active.
                    app.update_in(cx, |app, w, cx| {
                        app.dock_open_file("package.json".into(), None, w, cx);
                        app.dock_activate_surface(&vitre_state::right_panel::file_surface_id(None, SOURCE), w, cx);
                    }).map_err(|e| e.to_string())?;
                    executor.timer(Duration::from_millis(700)).await;
                    wait_for_file(&app, SOURCE, "export function Workspace", cx).await?;
                    ui_verification::capture(if maximized {"tabs-overlay"} else {"tabs-inline"}, cx).await?;
                    app.update_in(cx, |app, w, cx| {
                        let implemented_plan = serde_json::from_value(serde_json::json!({
                            "createdAt": "2026-09-18T12:00:00.000Z",
                            "id": "verified-accepted-plan",
                            "implementationThreadId": app.thread.as_ref().unwrap().id.0.clone(),
                            "implementedAt": "2026-09-18T12:00:01.000Z",
                            "planMarkdown": "# Verify accepted plans\n\n1. Leave the chat timeline\n2. Render in the right sidebar",
                            "turnId": "verified-plan-turn",
                            "updatedAt": "2026-09-18T12:00:01.000Z"
                        })).unwrap();
                        let view = Arc::make_mut(
                            app.thread
                                .as_mut()
                                .unwrap()
                                .state
                                .view
                                .as_mut()
                                .unwrap(),
                        );
                        view.proposed_plans = Some(Some(vec![implemented_plan]));
                        app.rebuild_timeline(cx);
                        app.open_workspace_surface(SurfaceKind::Plan, w, cx);
                    }).map_err(|e| e.to_string())?;
                    executor.timer(Duration::from_millis(300)).await;
                    let accepted_plan_moved = app.update(cx, |app, _| {
                        let key = app.dock_thread_key().unwrap();
                        app.right_panel.map.active_surface(&key).is_some_and(|surface| surface.kind() == SurfaceKind::Plan)
                            && app.sidebar_proposed_plan().is_some_and(|plan| plan.id == "verified-accepted-plan")
                            && !app.timeline.iter().any(|row| matches!(row, crate::chat::TimelineRow::ProposedPlan(_)))
                    }).map_err(|e| e.to_string())?;
                    if !accepted_plan_moved {
                        return Err("Accepted plan did not move from the chat timeline into the Plan dock surface".into());
                    }
                    ui_verification::capture(if maximized {"plan-overlay"} else {"plan-inline"}, cx).await?;
                }
                Ok::<_, String>(())
            };
            let result = tokio::select! {
                result = run => result,
                _ = executor.timer(Duration::from_secs(50)) => Err("Dock verification timed out".into()),
            };
            match result {
                Ok(()) => eprintln!("[vitre-tabs-test] PASS: Cmd+Shift+[ / ] traversal from composer focus, stable dock animation, tree/file switching, definition navigation and Cmd+W fallback, rapid tab switching; inline and overlay layouts"),
                Err(error) => eprintln!("[vitre-tabs-test] FAIL: {error}"),
            }
        }).detach();
    }
}
