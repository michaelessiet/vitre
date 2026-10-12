//! Focused native draft/reasoning regression in the disposable UI fixture.
use super::*;

pub(super) async fn verify(
    app: &WeakEntity<ChatApp>,
    cx: &mut gpui::AsyncWindowContext,
) -> Result<(), String> {
    ui_verification::float_fixture(cx).await?;
    app.update_in(cx, |app, window, cx| {
        window.resize(gpui::size(px(1200.), px(900.)));
        let project = app.draft_project.clone().or_else(|| app.shell.snapshot.as_ref()?.projects.first().map(|p| p.id.clone()));
        app.new_thread(project, window, cx);
        if app.dock_open() { app.toggle_right_panel(window, cx); }
        let selection = app.draft_model_selection(cx).expect("fixture provider model");
        let model = app.provider_snapshots.iter_mut().flat_map(|p| p.models.iter_mut())
            .find(|m| Some(m.slug.0.as_str()) == selection.model.as_str()).expect("selected model");
        let capabilities = model.capabilities.get_or_insert_with(|| serde_json::from_value(serde_json::json!({})).unwrap());
        capabilities.option_descriptors = Some(Some(vec![serde_json::from_value(serde_json::json!({
            "type":"select", "id":"reasoningEffort", "label":"Reasoning", "currentValue":"medium",
            "options":[{"id":"low","label":"Low"},{"id":"medium","label":"Medium"},{"id":"high","label":"High"}]
        })).unwrap()]));
        app.set_model_option("reasoningEffort".into(), serde_json::json!("high"), cx);
        app.set_model_option("reasoningEffort".into(), serde_json::json!("low"), cx);
        let options = app.draft_model.as_ref().unwrap().options.clone().flatten().unwrap();
        assert_eq!(options, serde_json::json!([{"id":"reasoningEffort","value":"low"}]));
        let saved = app.capture_composer_draft(cx);
        assert_eq!(serde_json::to_value(saved).unwrap()["model"], serde_json::to_value(&app.draft_model).unwrap());
        app.composer.update(cx, |input, cx| {
            input.set_value("alpha café gamma", window, cx);
            input.set_selected_range(0..0, cx);
            input.focus(window, cx);
        });
        cx.notify();
    }).map_err(|e| e.to_string())?;
    cx.background_executor()
        .timer(Duration::from_millis(400))
        .await;
    for key in ["alt-shift-right", "alt-shift-right", "alt-shift-left"] {
        ui_verification::key(key, cx).await?;
    }
    app.update(cx, |app, cx| {
        assert_eq!(app.composer.read(cx).selected_range(), 0..6);
    })
    .map_err(|e| e.to_string())?;
    ui_verification::capture("draft-reasoning", cx).await?;
    eprintln!(
        "[vitre-reasoning-test] PASS: new conversation reasoning options, replacement and draft capture, Unicode word-selection reversal, animated native draft rendering"
    );
    Ok(())
}
