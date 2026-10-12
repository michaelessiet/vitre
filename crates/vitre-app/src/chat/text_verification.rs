//! Isolated native regression for asynchronously parsed chat rows.
use super::*;

pub(super) async fn verify(
    app: &WeakEntity<ChatApp>,
    cx: &mut gpui::AsyncWindowContext,
) -> Result<(), String> {
    ui_verification::float_fixture(cx).await?;
    app.update_in(cx, |app, window, cx| {
        window.resize(gpui::size(px(1200.), px(1000.)));
        if app.dock_open() { app.toggle_right_panel(window, cx); }
        app.sidebar_visible = false;
        let code = (0..180).map(|i| format!("let value_{i} = calculate_total(\"café 世界\", {i});\n")).collect::<String>();
        let source = format!("# Long response\n\nText with **bold**, `inline code`, and a table.\n\n| Item | Value |\n| --- | --- |\n| Test | 123 |\n\n```rust\n{code}```\n\nEnd of response.");
        assert!(source.len() > 4096);
        let stamp = tnes(now_iso());
        let messages = [("literal", OrchestrationMessageRole::User, "**literal** <tag> café 世界".to_string()), ("long-markdown", OrchestrationMessageRole::Assistant, source), ("tail", OrchestrationMessageRole::Assistant, "Finished.".to_string())]
            .into_iter().map(|(id, role, text)| OrchestrationMessage { id: MessageId(id.into()), role, text: tnes(text), attachments: None, streaming: false, turn_id: None, created_at: stamp.clone(), updated_at: stamp.clone() }).collect();
        Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap()).messages = messages;
        app.rebuild_timeline(cx);
        app.timeline_list.scroll_to(ListOffset { item_ix: 1, offset_in_item: px(0.) });
        cx.notify();
    }).map_err(|e| e.to_string())?;

    let id = MessageId("long-markdown".into());
    let mut ready = false;
    for _ in 0..80 {
        cx.background_executor()
            .timer(Duration::from_millis(50))
            .await;
        app.update(cx, |app, cx| {
            app.timeline_list.scroll_to(ListOffset {
                item_ix: 1,
                offset_in_item: px(0.),
            });
            cx.notify();
        })
        .map_err(|e| e.to_string())?;
        cx.update(|window, cx| window.draw(cx).clear(cx))
            .map_err(|e| e.to_string())?;
        ready = app
            .update(cx, |app, _| {
                app.message_markdown.contains_key(&id)
                    && app
                        .timeline_list
                        .bounds_for_item(1)
                        .is_some_and(|row| row.size.height > px(1000.))
            })
            .map_err(|e| e.to_string())?;
        if ready {
            break;
        }
    }
    if !ready {
        app.update(cx, |app, _| {
            eprintln!(
                "[vitre-chat-text-test] debug: rows={:?} cached={} bounds={:?} viewport={:?}",
                app.timeline,
                app.message_markdown.contains_key(&id),
                app.timeline_list.bounds_for_item(1),
                app.timeline_list.viewport_bounds()
            );
        })
        .map_err(|e| e.to_string())?;
        return Err("long Markdown parsed without correcting its cached timeline height".into());
    }
    let (identity, height) = app
        .update(cx, |app, _| {
            (
                app.message_markdown[&id].state.entity_id(),
                app.timeline_list.bounds_for_item(1).unwrap().size.height,
            )
        })
        .map_err(|e| e.to_string())?;
    for _ in 0..6 {
        let (position, before) = app
            .update(cx, |app, _| {
                (
                    app.timeline_list.viewport_bounds().center(),
                    app.timeline_list.scroll_px_offset_for_scrollbar().y,
                )
            })
            .map_err(|e| e.to_string())?;
        cx.update(|window, cx| {
            window.dispatch_event(
                gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                    position,
                    ..Default::default()
                }),
                cx,
            );
            window.draw(cx).clear(cx);
            window.dispatch_event(
                gpui::PlatformInput::ScrollWheel(gpui::ScrollWheelEvent {
                    position,
                    delta: gpui::ScrollDelta::Pixels(gpui::point(px(0.), px(-180.))),
                    ..Default::default()
                }),
                cx,
            );
            window.draw(cx).clear(cx);
        })
        .map_err(|e| e.to_string())?;
        cx.background_executor()
            .timer(Duration::from_millis(50))
            .await;
        cx.update(|w, cx| w.draw(cx).clear(cx))
            .map_err(|e| e.to_string())?;
        let after = app
            .update(cx, |app, _| {
                app.timeline_list.scroll_px_offset_for_scrollbar().y
            })
            .map_err(|e| e.to_string())?;
        if (after - before).abs() < px(10.) {
            return Err(format!(
                "vertical wheel over Markdown/code did not scroll the chat: {before:?} -> {after:?}, height={height:?}"
            ));
        }
    }
    app.update(cx, |app, cx| {
        app.timeline_list.scroll_to_end();
        cx.notify();
    })
    .map_err(|e| e.to_string())?;
    cx.background_executor()
        .timer(Duration::from_millis(200))
        .await;
    cx.update(|w, cx| w.draw(cx).clear(cx))
        .map_err(|e| e.to_string())?;
    app.update(cx, |app, cx| {
        app.timeline_list.scroll_to(ListOffset {
            item_ix: 1,
            offset_in_item: px(0.),
        });
        cx.notify();
    })
    .map_err(|e| e.to_string())?;
    cx.background_executor()
        .timer(Duration::from_millis(200))
        .await;
    cx.update(|w, cx| w.draw(cx).clear(cx))
        .map_err(|e| e.to_string())?;
    app.update(cx, |app, _| {
        assert_eq!(
            app.message_markdown[&id].state.entity_id(),
            identity,
            "scrolling must retain the parsed message"
        );
        assert!(
            (app.timeline_list.bounds_for_item(1).unwrap().size.height - height).abs() < px(2.),
            "row height changed on revisit"
        );
    })
    .map_err(|e| e.to_string())?;
    eprintln!(
        "[vitre-chat-text-test] PASS: long Markdown async height, wheel scrolling over code/table, retained parsed state and stable row height"
    );
    cx.update(|_, cx| cx.quit()).map_err(|e| e.to_string())?;
    Ok(())
}
