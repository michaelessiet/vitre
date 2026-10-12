//! Native regression pass, called only by the disposable icon fixture (mode `ui`).
use super::*;

/// Tile managers can immediately undo `Window::resize`. Float only this
/// disposable fixture window, if AeroSpace owns it; never touch other apps.
pub(super) async fn float_fixture(cx: &mut gpui::AsyncWindowContext) -> Result<(), String> {
    let pid = std::process::id().to_string();
    Tokio::spawn_result(cx, async move {
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let Ok(output) = std::process::Command::new("aerospace")
                .args([
                    "list-windows",
                    "--all",
                    "--format",
                    "%{window-id} %{app-pid}",
                ])
                .output()
            else {
                return Ok(());
            };
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let mut fields = line.split_whitespace();
                let Some(id) = fields.next() else {
                    continue;
                };
                if fields.next() == Some(pid.as_str()) {
                    anyhow::ensure!(
                        std::process::Command::new("aerospace")
                            .args(["layout", "--window-id", id, "floating"])
                            .status()?
                            .success(),
                        "could not float fixture window"
                    );
                }
            }
            Ok(())
        })
        .await?
    })
    .await
    .map_err(|e| e.to_string())
}

pub(crate) async fn key(key: &str, cx: &mut gpui::AsyncWindowContext) -> Result<(), String> {
    let keystroke = gpui::Keystroke::parse(key).map_err(|e| e.to_string())?;
    cx.update(|window, cx| {
        window.dispatch_event(
            gpui::PlatformInput::KeyDown(gpui::KeyDownEvent {
                keystroke,
                is_held: false,
                prefer_character_input: false,
            }),
            cx,
        );
    })
    .map_err(|e| e.to_string())
}

pub(crate) async fn capture(name: &str, cx: &mut gpui::AsyncWindowContext) -> Result<(), String> {
    cx.update(|window, cx| {
        window.dispatch_event(
            gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                position: gpui::point(px(20.), px(400.)),
                pressed_button: None,
                modifiers: Default::default(),
            }),
            cx,
        )
    })
    .map_err(|e| e.to_string())?;
    let path = format!("/tmp/vitre-ui-{name}.png");
    Tokio::spawn_result(cx, async move {
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            #[cfg(target_os = "macos")]
            {
                use std::ffi::{CString, c_char, c_int};
                unsafe extern "C" {
                    fn vitre_capture_own_window(output_path: *const c_char) -> c_int;
                }
                let output_path = CString::new(path.as_str())?;
                let status = unsafe { vitre_capture_own_window(output_path.as_ptr()) };
                anyhow::ensure!(status == 0, "Vitre window capture failed (status {status})");
                eprintln!("[vitre-ui-test] screenshot {path}");
                Ok(())
            }
            #[cfg(not(target_os = "macos"))]
            {
                anyhow::bail!("native window capture is only available on macOS");
            }
        })
        .await?
    })
    .await
    .map_err(|e| e.to_string())
}

impl ChatApp {
    pub(super) fn verify_surface_ui(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let executor = cx.background_executor().clone();
        cx.spawn_in(window, async move |this, cx| {
            let test = async {
                executor.timer(Duration::from_millis(650)).await;
                let editor = this.update_in(cx, |a, w, cx| {
                    let editor = a.files.as_ref().unwrap().read(cx).verification_editor();
                    editor.update(cx, |s, cx| { s.set_selected_range(0..0, cx); s.focus(w, cx); });
                    editor
                }).map_err(|e| e.to_string())?;
                let original = editor.read_with(cx, |s, _| s.value());
                key("cmd-/", cx).await?;
                if !editor.read_with(cx, |s, _| s.value().starts_with("// ")) { return Err("Cmd+/ did not comment in the real files panel".into()); }
                key("cmd-z", cx).await?;
                if editor.read_with(cx, |s, _| s.value()) != original {return Err("Undo did not restore the file".into());}
                capture("editor", cx).await?;
                let marketing_capture = std::env::var_os("VITRE_MARKETING_CAPTURE").is_some();
                this.update_in(cx, |a, w, cx| {
                    if !marketing_capture && a.dock_open() {a.toggle_right_panel(w, cx);}
                    // Visual-only chat data; no paid provider turn and no durable messages.
                    let view = Arc::make_mut(a.thread.as_mut().unwrap().state.view.as_mut().unwrap());
                    let marketing_messages = [
                        "Give the workspace a calmer first impression.",
                        "I opened `src/components/Workspace.tsx` beside this thread. The layout is ready for us to refine.",
                        "Keep the editor close while we work through the details.",
                        "The conversation and file stay together. We can inspect the diff next.",
                    ];
                    view.messages = (0..(if marketing_capture { marketing_messages.len() } else { 6 })).map(|i| serde_json::from_value(serde_json::json!({
                        "id": format!("ui-message-{i}"), "role": if i % 2 == 0 {"user"} else {"assistant"},
                        "text": if marketing_capture {
                            marketing_messages[i].to_string()
                        } else if i % 2 == 0 {format!("If a tick fails more than 3 times please skip it and move to the next. Let's fast track the catch up. The only chain that is being indexed for now is Plasma mainnet. Section {}.", i / 2 + 1)} else {"Use `cargo test` to verify the change. The `café` value and `src/components/Workspace.tsx` should remain readable on glass.\n\nThe editor supports **line commands**, undo, and Unicode selections.".into()},
                        "createdAt": now_iso(), "updatedAt": now_iso(), "streaming": false, "turnId": null
                    })).unwrap()).collect();
                    a.rebuild_timeline(cx); cx.notify();
                }).map_err(|e| e.to_string())?;
                executor.timer(Duration::from_millis(800)).await;
                if marketing_capture {
                    executor.timer(Duration::from_secs(5)).await;
                    capture("workspace", cx).await?;
                    this.update_in(cx, |a, w, cx| { if a.dock_open() { a.toggle_right_panel(w, cx); } }).map_err(|e| e.to_string())?;
                    executor.timer(Duration::from_millis(400)).await;
                }
                capture("chat", cx).await?;
                this.update(cx, |a, cx| {a.sidebar_visible = false; cx.notify();}).map_err(|e| e.to_string())?;
                executor.timer(Duration::from_millis(600)).await;
                capture("sidebar-closed", cx).await?;
                this.update_in(cx, |a, w, cx| {a.sidebar_visible = true; a.open_model_picker(w, cx); cx.notify();}).map_err(|e| e.to_string())?;
                executor.timer(Duration::from_millis(700)).await;
                capture("model-menu", cx).await?;
                let claude_id = this.update(cx, |a, cx| -> Result<String, String> {
                    let picker = a.model_picker.as_ref().ok_or("Model picker did not open")?;
                    let picker_state = picker.read(cx);
                    let provider_summary = picker_state.providers.iter().map(|provider| {
                        format!("{}:{}:{:?}", provider.instance_id.0, provider.driver.0, provider.status)
                    }).collect::<Vec<_>>();
                    let has_codex = picker_state.providers.iter().any(|provider| {
                        provider_picker_ready(provider)
                            && (provider.instance_id.0 == "codex" || provider.driver.0 == "codex")
                    });
                    let claude_id = picker_state.providers.iter().find(|provider| {
                        provider_picker_ready(provider)
                            && (provider.instance_id.0 == "claudeAgent"
                                || provider.driver.0 == "claudeAgent")
                    }).map(|provider| provider.instance_id.0.clone());
                    if !has_codex || claude_id.is_none() {
                        return Err(format!(
                            "Model picker did not expose both ready Codex and Claude providers: {}",
                            provider_summary.join(", ")
                        ));
                    }
                    let claude_id = claude_id.unwrap();
                    let selected = claude_id.clone();
                    picker.update(cx, |picker, cx| {
                        picker.selected_provider = Some(selected);
                        picker.active_choice = 0;
                        cx.notify();
                    });
                    Ok(claude_id)
                }).map_err(|e| e.to_string())??;
                executor.timer(Duration::from_millis(350)).await;
                let claude_models_visible = this.update(cx, |a, cx| {
                    a.model_picker.as_ref().is_some_and(|picker| {
                        let picker = picker.read(cx);
                        !picker.choices.is_empty() && picker.choices.iter().all(|(selection, _)| {
                            model_selection_identity(selection)
                                .is_some_and(|(instance, _)| instance == claude_id)
                        })
                    })
                }).map_err(|e| e.to_string())?;
                if !claude_models_visible {
                    return Err("Selecting Claude did not render its live model list".into());
                }
                capture("model-menu-claude", cx).await?;
                key("down", cx).await?;
                let moved = this.update(cx, |a, cx| a.model_picker.as_ref().is_some_and(|p| p.read(cx).active_choice == 1 || p.read(cx).choices.len() <= 1)).map_err(|e| e.to_string())?;
                if !moved {return Err("Model menu arrow-key navigation failed".into());}
                key("escape", cx).await?;
                executor.timer(Duration::from_millis(150)).await;
                if this.update(cx, |a, _| a.model_picker.is_some()).map_err(|e| e.to_string())? {return Err("Escape did not dismiss model menu".into());}
                this.update_in(cx, |a, w, cx| a.toggle_quick_search(QuickSearchMode::Open, w, cx)).map_err(|e| e.to_string())?;
                executor.timer(Duration::from_millis(700)).await;
                capture("search-card", cx).await?;
                let command = this.update(cx, |a, cx| a.quick_search.as_ref().unwrap().read(cx).verification_state()).map_err(|e| e.to_string())?;
                cx.update(|w, cx| command.update(cx, |s, cx| s.set_query("Workspace.tsx", w, cx))).map_err(|e| e.to_string())?;
                loop {
                    executor.timer(Duration::from_millis(80)).await;
                    if this.update(cx, |a, cx| a.quick_search.as_ref().unwrap().read(cx).verification_preview_ready()).map_err(|e| e.to_string())? {break;}
                }
                executor.timer(Duration::from_millis(600)).await;
                capture("search-code", cx).await?;
                this.update_in(cx, |a, w, cx| {a.toggle_quick_search(QuickSearchMode::Open, w, cx); a.toggle_right_panel(w, cx);}).map_err(|e| e.to_string())?;
                Ok::<_, String>(())
            };
            let result = tokio::select! { result = test => result, _ = executor.timer(Duration::from_secs(75)) => Err("UI verification timed out".into()) };
            match result {
                Ok(()) => eprintln!("[vitre-ui-test] PASS: real editor Cmd+/ and Undo, chat rail/code chips, sidebar/dock transitions, live Codex+Claude model switching and keyboard navigation/Escape, search card-to-code preview; screenshots in /tmp/vitre-ui-*.png"),
                Err(error) => eprintln!("[vitre-ui-test] FAIL: {error}"),
            }
        }).detach();
    }
}
