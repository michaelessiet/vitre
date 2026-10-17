//! Opt-in native scrolling benchmark. Run with `VITRE_VERIFY_ICONS=chat-perf`,
//! `VITRE_CHAT_PERF_TURNS=100|1000|5000`, and the `perf-probe` Cargo feature.
//! The existing icon harness supplies a disposable project and thread.

use super::*;
use gpui::profiler::{self, FrameEvent, FrameTimingCollector};
use std::io::Cursor;

fn percentile(values: &[f64], percentile: usize) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[(sorted.len() - 1) * percentile / 100]
}

fn report(
    name: &str,
    turns: usize,
    draws: &[f64],
    present_intervals: &[f64],
    image_loads: u64,
    before_item: usize,
    after_item: usize,
) -> serde_json::Value {
    serde_json::json!({
        "phase": name,
        "turns": turns,
        "draws": draws.len(),
        "draw_p50_ms": percentile(draws, 50),
        "draw_p95_ms": percentile(draws, 95),
        "draw_p99_ms": percentile(draws, 99),
        "draws_over_33_ms": draws.iter().filter(|time| **time > 33.0).count(),
        "present_intervals": present_intervals.len(),
        "present_p95_ms": percentile(present_intervals, 95),
        "presents_over_33_ms": present_intervals.iter().filter(|time| **time > 33.0).count(),
        "image_loads": image_loads,
        "start_item": before_item,
        "end_item": after_item,
    })
}

pub(super) async fn verify(
    app: &WeakEntity<ChatApp>,
    cx: &mut gpui::AsyncWindowContext,
) -> Result<(), String> {
    let turns: usize = std::env::var("VITRE_CHAT_PERF_TURNS")
        .unwrap_or_else(|_| "1000".into())
        .parse()
        .map_err(|_| "VITRE_CHAT_PERF_TURNS must be 100, 1000 or 5000")?;
    if ![100, 1000, 5000].contains(&turns) {
        return Err("VITRE_CHAT_PERF_TURNS must be 100, 1000 or 5000".into());
    }
    ui_verification::float_fixture(cx).await?;

    // One realistic raster with distinct signed-style source keys. Keeping
    // the bytes identical makes setup deterministic while every attachment
    // still incurs its own cache entry and decode on first encounter.
    let mut png = Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(1024, 768, image::Rgba([74, 129, 211, 255]))
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    let stamp = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
        .map_err(|error| error.to_string())?;
    app.update_in(cx, |app, window, cx| {
        window.resize(gpui::size(px(1440.), px(960.)));
        if app.dock_open() {
            app.toggle_right_panel(window, cx);
        }
        app.sidebar_visible = false;
        let mut messages = Vec::with_capacity(turns * 2);
        for turn in 0..turns {
            let timestamp = |offset: usize| {
                tnes((stamp + chrono::Duration::milliseconds(offset as i64)).to_rfc3339())
            };
            let attachments = (turn % 4 == 0).then(|| {
                (0..2)
                    .map(|image_index| {
                        let id = format!("perf-image-{turn}-{image_index}");
                        let url = format!(
                            "data:image/png;name={id};base64,{encoded}"
                        );
                        app.attachment_urls.insert(id.clone(), url.into());
                        ChatAttachment::ChatImageAttachment(ChatImageAttachment {
                            id: tnes(id),
                            mime_type: tnes("image/png"),
                            name: tnes(format!("reference-{turn}-{image_index}.png")),
                            size_bytes: 4096,
                            r#type: Default::default(),
                        })
                    })
                    .collect::<Vec<_>>()
            });
            messages.push(OrchestrationMessage {
                attachments: attachments.map(Some),
                created_at: timestamp(turn * 2),
                id: MessageId(format!("perf-user-{turn}")),
                role: OrchestrationMessageRole::User,
                streaming: false,
                text: tnes(format!(
                    "Question {turn}: compare the attached references and summarize the result."
                )),
                turn_id: None,
                updated_at: timestamp(turn * 2),
            });
            let text = if turn % 10 == 0 {
                let code = (0..45)
                    .map(|line| format!("let item_{line} = calculate({turn}, {line});\n"))
                    .collect::<String>();
                format!("## Response {turn}\n\nThe result has **several details**.\n\n```rust\n{code}```\n\n| Item | Value |\n| --- | --- |\n| Result | {turn} |")
            } else {
                format!("## Response {turn}\n\nHere is the summary with `code`, **bold text**, and a [reference](https://example.com).")
            };
            messages.push(OrchestrationMessage {
                attachments: None,
                created_at: timestamp(turn * 2 + 1),
                id: MessageId(format!("perf-assistant-{turn}")),
                role: OrchestrationMessageRole::Assistant,
                streaming: false,
                text: tnes(text),
                turn_id: Some(vitre_contracts::TurnId(format!("perf-turn-{turn}"))),
                updated_at: timestamp(turn * 2 + 1),
            });
        }
        let view = Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap());
        view.messages = messages;
        view.activities.clear();
        view.checkpoints.clear();
        view.latest_turn = None;
        app.rebuild_timeline(cx);
        let middle = app.timeline.len() / 3;
        app.timeline_list.scroll_to(ListOffset {
            item_ix: middle,
            offset_in_item: px(0.),
        });
        cx.notify();
    })
    .map_err(|error| error.to_string())?;

    cx.update(|window, cx| window.draw(cx).clear(cx))
        .map_err(|error| error.to_string())?;
    let marker_bounds = app
        .update(cx, |app, _| {
            (
                app.timeline_markers.first().map(|marker| marker.item_ix),
                app.timeline_markers.last().map(|marker| marker.item_ix),
                app.timeline.len(),
            )
        })
        .map_err(|error| error.to_string())?;
    if marker_bounds.0 != Some(0) || marker_bounds.1 != Some(marker_bounds.2 - 2) {
        return Err(format!(
            "minimap lost the first or last turn: {marker_bounds:?}"
        ));
    }
    let window_id = cx
        .update(|window, _| window.window_handle().window_id())
        .map_err(|error| error.to_string())?;
    profiler::set_trace_enabled(true);
    let mut collector = FrameTimingCollector::new();
    let mut results = Vec::new();
    for (phase, delta) in [("first", -180.0), ("back", 180.0)] {
        let before_item = app
            .update(cx, |app, _| app.timeline_list.logical_scroll_top().item_ix)
            .map_err(|error| error.to_string())?;
        let before_loads = images::image_load_count();
        let mut draws = Vec::new();
        let mut present_intervals = Vec::new();
        let mut last_present = None;
        for _ in 0..100 {
            cx.update(|window, cx| {
                let position = window.viewport_size().center();
                window.dispatch_event(
                    gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                        position,
                        ..Default::default()
                    }),
                    cx,
                );
                window.dispatch_event(
                    gpui::PlatformInput::ScrollWheel(gpui::ScrollWheelEvent {
                        position,
                        delta: gpui::ScrollDelta::Pixels(gpui::point(px(0.), px(delta))),
                        ..Default::default()
                    }),
                    cx,
                );
                window.draw(cx).clear(cx);
            })
            .map_err(|error| error.to_string())?;
            cx.background_executor()
                .timer(Duration::from_millis(16))
                .await;
            for event in collector.collect_unseen() {
                match event {
                    FrameEvent::Draw(timing) if timing.window_id == window_id => {
                        draws.push(timing.draw_duration().as_secs_f64() * 1000.0);
                    }
                    FrameEvent::Present(timing) if timing.window_id == window_id => {
                        if let Some(previous) = last_present {
                            present_intervals.push(
                                timing.present_start.duration_since(previous).as_secs_f64()
                                    * 1000.0,
                            );
                        }
                        last_present = Some(timing.present_start);
                    }
                    _ => {}
                }
            }
        }
        let after_item = app
            .update(cx, |app, _| app.timeline_list.logical_scroll_top().item_ix)
            .map_err(|error| error.to_string())?;
        if (delta < 0.0 && after_item <= before_item) || (delta > 0.0 && after_item >= before_item)
        {
            return Err(format!(
                "{phase} scroll moved in the wrong direction: {before_item} -> {after_item}"
            ));
        }
        results.push(report(
            phase,
            turns,
            &draws,
            &present_intervals,
            images::image_load_count() - before_loads,
            before_item,
            after_item,
        ));
    }
    profiler::set_trace_enabled(false);
    let result = serde_json::Value::Array(results);
    if let Ok(path) = std::env::var("VITRE_CHAT_PERF_OUTPUT") {
        std::fs::write(&path, serde_json::to_vec_pretty(&result).unwrap())
            .map_err(|error| error.to_string())?;
    }
    eprintln!("[vitre-chat-perf] {result}");
    cx.update(|_, cx| cx.quit())
        .map_err(|error| error.to_string())?;
    Ok(())
}
