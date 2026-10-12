//! Real-window feedback and sent-message selection fixture; never runs in a live home.
use super::*;

pub(super) async fn verify(
    app: &WeakEntity<ChatApp>,
    cx: &mut gpui::AsyncWindowContext,
) -> Result<(), String> {
    ui_verification::float_fixture(cx).await?;
    app.update_in(cx, |app, window, cx| {
        window.resize(gpui::size(px(1200.), px(900.)));
        if app.dock_open() { app.toggle_right_panel(window, cx); }
        app.sidebar_visible = false;
        let stamp = tnes(now_iso());
        let messages = [("feedback-user", OrchestrationMessageRole::User, "Select this sent message: café 世界 and **literal** text."),
            ("feedback-assistant", OrchestrationMessageRole::Assistant, "Copy this response.\n\n```rust\nlet answer = 42;\n```\n\n| Item | Value |\n| --- | --- |\n| Test | 123 |")]
            .into_iter().map(|(id, role, text)| OrchestrationMessage { id: MessageId(id.into()), role, text: tnes(text), attachments: None, streaming: false, turn_id: None, created_at: stamp.clone(), updated_at: stamp.clone() }).collect();
        Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap()).messages = messages;
        app.rebuild_timeline(cx);
        cx.notify();
    }).map_err(|e| e.to_string())?;
    cx.background_executor()
        .timer(Duration::from_millis(800))
        .await;
    ui_verification::capture("feedback-before", cx).await?;
    let (right, left) = cx
        .update(|window, _| {
            let size = window.viewport_size();
            (
                gpui::point(size.width * 0.79, size.height * 0.48),
                gpui::point(size.width * 0.48, size.height * 0.48),
            )
        })
        .map_err(|e| e.to_string())?;
    cx.update(|window, cx| {
        window.dispatch_event(
            gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                position: right,
                button: gpui::MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
    })
    .map_err(|e| e.to_string())?;
    cx.background_executor()
        .timer(Duration::from_millis(50))
        .await;
    cx.update(|window, cx| {
        window.dispatch_event(
            gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                position: left,
                pressed_button: Some(gpui::MouseButton::Left),
                modifiers: Default::default(),
            }),
            cx,
        );
    })
    .map_err(|e| e.to_string())?;
    cx.background_executor()
        .timer(Duration::from_millis(50))
        .await;
    cx.update(|window, cx| {
        window.dispatch_event(
            gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                position: left,
                button: gpui::MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
    })
    .map_err(|e| e.to_string())?;
    cx.background_executor()
        .timer(Duration::from_millis(100))
        .await;
    let selected = cx
        .update(gpui_base::TextSelection::selected_text)
        .map_err(|e| e.to_string())?;
    eprintln!("[vitre-feedback-test] selected: {selected:?}");
    if !selected.contains("Select this sent message") {
        return Err("sent user bubble could not be selected".into());
    }
    ui_verification::capture("feedback-selected", cx).await?;
    ui_verification::key("cmd-c", cx).await?;
    let copied_selection = cx
        .update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text()))
        .map_err(|e| e.to_string())?;
    if copied_selection.as_deref() != Some(&selected) {
        return Err("Cmd+C did not copy selected user text".into());
    }
    // These positions are within the fixed, screenshot-verified fixture layout.
    for (x, y, expected, name) in [
        (
            0.766,
            0.52,
            "Select this sent message: café 世界 and **literal** text.",
            "user-copy-confirmed",
        ),
        (0.785, 0.614, "let answer = 42;", "code-copy-confirmed"),
    ] {
        click(x, y, cx).await?;
        cx.background_executor()
            .timer(Duration::from_millis(250))
            .await;
        let copied = cx
            .update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text()))
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        if copied.trim() != expected {
            return Err(format!("{name}: wrong clipboard value: {copied:?}"));
        }
        ui_verification::capture(name, cx).await?;
    }
    cx.background_executor()
        .timer(Duration::from_millis(2100))
        .await;
    ui_verification::capture("copy-reset-and-header", cx).await?;
    eprintln!(
        "[vitre-feedback-test] PASS: sent user bubble selection and Cmd+C, user/code copy actions and green-check feedback, reset and macOS header layout"
    );
    Ok(())
}

async fn click(x: f32, y: f32, cx: &mut gpui::AsyncWindowContext) -> Result<(), String> {
    cx.update(|w, cx| {
        let size = w.viewport_size();
        let position = gpui::point(size.width * x, size.height * y);
        w.dispatch_event(
            gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                position,
                pressed_button: None,
                modifiers: Default::default(),
            }),
            cx,
        );
        w.dispatch_event(
            gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                position,
                button: gpui::MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        w.dispatch_event(
            gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                position,
                button: gpui::MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
    })
    .map_err(|e| e.to_string())
}
