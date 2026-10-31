//! Native Devices picker and thread-owned dock surface.
use super::ChatApp;
use crate::mobile::{Device, DevicePanel};
use gpui::{Context, Window, div, prelude::*, px};
use gpui_component::{
    ActiveTheme as _, Icon, IconName, StyledExt as _, WindowExt as _,
    command::{Command, CommandItem, CommandState},
    h_flex,
    notification::Notification,
    v_flex,
};
use vitre_state::right_panel::SurfaceKind;
impl ChatApp {
    pub(super) fn open_devices(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !cfg!(target_os = "macos") || self.mobile_opening {
            return;
        }
        let Some(thread) = self.dock_thread_key() else {
            return;
        };
        if self.is_cloud_thread() {
            window.push_notification(
                Notification::info("Devices requires a local project thread."),
                cx,
            );
            return;
        }
        self.mobile_opening = true;
        cx.notify();
        let job = gpui_tokio::Tokio::spawn_result(cx, crate::mobile::devices());
        cx.spawn_in(window, async move |this, cx| {
            let result = job.await;
            let _ = this.update_in(cx, |app, window, cx| {
                app.mobile_opening = false;
                match result {
                    Ok(devices) => {
                        let owner = cx.weak_entity();
                        let state = cx.new(|cx| CommandState::new(window, cx));
                        let focus = state.clone();
                        window.open_dialog(cx, move |dialog, _, _| {
                            let state = state.clone();
                            let devices = devices.clone();
                            let owner = owner.clone();
                            let thread = thread.clone();
                            dialog.close_button(false).p_0().margin_top(px(72.))
                                .w(px(576.)).max_w(px(576.))
                                .content(move |content, _, cx| {
                                    let selected = devices.clone();
                                    let owner = owner.clone();
                                    let thread = thread.clone();
                                    let empty = devices.is_empty();
                                    content.child(Command::new(&state)
                                        .bordered(false).bg(cx.theme().popover.opacity(0.))
                                        .cancel_clears_query(false)
                                        .placeholder("Search devices…")
                                        .max_h(px(300.))
                                        .header(|_, _, cx| {
                                            v_flex().px_3().pt_3().pb_1().gap_1()
                                                .child(div().text_sm().font_semibold().child("Devices"))
                                                .child(div().text_xs().text_color(cx.theme().muted_foreground)
                                                    .child("Choose a device to connect. Stopped devices start automatically."))
                                        })
                                        .items(devices.iter().map(|device| device_item(device, &devices)))
                                        .empty(move |_, _, cx| {
                                            div().px_4().py_8().text_sm().text_color(cx.theme().muted_foreground)
                                                .child(if empty {
                                                    "Create a simulator in Xcode or a virtual device in Android Studio, then reopen Devices."
                                                } else { "No devices match your search." })
                                        })
                                        .footer(|_, _, cx| {
                                            crate::palette::chrome::footer(cx)
                                                .child(crate::palette::chrome::key_hint("↑↓", "navigate", cx))
                                                .child(crate::palette::chrome::key_hint("↵", "connect", cx))
                                                .child(crate::palette::chrome::key_hint("esc", "close", cx))
                                        })
                                        .on_confirm(move |index, window, cx| {
                                            let Some(device) = selected.get(index.row).cloned() else { return; };
                                            window.close_dialog(cx);
                                            let _ = owner.update(cx, |app, cx| {
                                                if let Err(error) = app.connect_native_device(thread.clone(), device, window, cx) {
                                                    window.push_notification(Notification::error(error), cx);
                                                }
                                            });
                                        }))
                                })
                        });
                        window.defer(cx, move |window, cx| { focus.update(cx, |state, cx| state.focus(window, cx)); });
                    }
                    Err(error) => { window.push_notification(Notification::error(error.to_string()), cx); }
                }
                cx.notify();
            });
        }).detach();
    }

    pub(super) fn connect_native_device(
        &mut self,
        thread: String,
        device: Device,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        if self.dock_thread_key().as_ref() != Some(&thread) {
            return Err("Switch back to this thread before connecting Devices.".into());
        }
        if self
            .mobile_panel
            .as_ref()
            .is_some_and(|(owner, _)| owner != &thread)
        {
            return Err("Close Devices in the other thread first.".into());
        }
        if self.mobile_panel.as_ref().is_some_and(|(_, panel)| {
            let panel = panel.read(cx);
            panel.device.same_target(&device) && panel.can_reuse()
        }) {
            self.open_workspace_surface(SurfaceKind::Devices, window, cx);
            return Ok(());
        }
        self.mobile_panel = None;
        let panel = DevicePanel::open(device, window, cx).map_err(|e| e.to_string())?;
        self.mobile_panel = Some((thread.clone(), panel));
        self.right_panel.map.open(&thread, SurfaceKind::Devices);
        self.open_workspace_surface(SurfaceKind::Devices, window, cx);
        Ok(())
    }
}

fn device_item(device: &Device, devices: &[Device]) -> CommandItem {
    let device = device.clone();
    let duplicate_name = devices
        .iter()
        .filter(|d| {
            d.name == device.name && d.runtime == device.runtime && d.platform == device.platform
        })
        .count()
        > 1;
    let mut detail = device
        .runtime
        .clone()
        .unwrap_or_else(|| "Android emulator".into());
    if duplicate_name {
        let id = if device.platform == "ios" {
            device.id.chars().take(8).collect::<String>()
        } else {
            device.id.clone()
        };
        detail.push_str(&format!(" · {id}"));
    }
    CommandItem::new()
        .label(device.name.clone())
        .keywords([device.id.clone(), detail.clone(), device.platform.clone()])
        .child(move |_, cx| {
            let muted = cx.theme().muted_foreground;
            h_flex()
                .w_full()
                .gap_2()
                .child(Icon::new(IconName::Globe).size_4().text_color(muted))
                .child(
                    v_flex()
                        .min_w_0()
                        .flex_1()
                        .child(div().truncate().child(device.name.clone()))
                        .child(
                            div()
                                .truncate()
                                .text_xs()
                                .text_color(muted)
                                .child(detail.clone()),
                        ),
                )
                .child(
                    h_flex()
                        .flex_shrink_0()
                        .gap_1()
                        .text_xs()
                        .text_color(muted)
                        .child(
                            Icon::new(if device.running {
                                IconName::CircleCheck
                            } else {
                                IconName::Play
                            })
                            .size_3(),
                        )
                        .child(if device.running { "Running" } else { "Start" }),
                )
        })
}

/// The broker already authenticates the environment/capability. The desktop
/// additionally checks thread ownership before allowing device input.
pub(super) async fn automation(
    this: &gpui::WeakEntity<ChatApp>,
    request: &vitre_contracts::PreviewAutomationRequest,
    cx: &mut gpui::AsyncWindowContext,
) -> Result<serde_json::Value, String> {
    use crate::mobile::Input;
    use base64::Engine as _;
    use serde_json::json;
    let action = request.input["action"]
        .as_str()
        .ok_or("Missing mobile action")?;
    let parameters = &request.input["parameters"];
    if action == "devices" || action == "open" {
        let job = this
            .update(cx, |_, cx| {
                gpui_tokio::Tokio::spawn_result(cx, crate::mobile::devices())
            })
            .map_err(|e| e.to_string())?;
        let devices = job.await.map_err(|e| e.to_string())?;
        if action == "devices" {
            return Ok(json!({"devices":devices}));
        }
        let id = parameters["deviceId"]
            .as_str()
            .ok_or("Choose a deviceId from mobile_devices")?;
        let device = devices
            .into_iter()
            .find(|d| d.id == id)
            .ok_or("Device is no longer available. Refresh mobile_devices.")?;
        this.update_in(cx, |app, window, cx| {
            if app.execution_thread_id().as_ref() != Some(&request.thread_id) {
                return Err("Switch to this thread in Vitre before connecting Devices.".into());
            }
            let key = app.dock_thread_key().ok_or("No local workspace")?;
            app.connect_native_device(key, device, window, cx)
        })
        .map_err(|e| e.to_string())??;
    }
    let panel = this
        .update_in(cx, |app, window, cx| {
            if app.execution_thread_id().as_ref() != Some(&request.thread_id) {
                return Err(
                    "Switch to this thread in Vitre before controlling Devices.".to_string()
                );
            }
            let key = app.dock_thread_key().ok_or("No local workspace")?;
            let (owner, panel) = app
                .mobile_panel
                .as_ref()
                .ok_or("Open a device first with mobile_open")?;
            if *owner != key {
                return Err("Devices belongs to another thread".into());
            }
            let panel = panel.clone();
            if action == "close" {
                panel.update(cx, |p, _| p.set_visible(false));
                app.mobile_panel = None;
                app.right_panel.map.close_surface(&key, "devices");
                app.sync_active_preview_surface(window, cx);
                cx.notify();
            }
            Ok(panel)
        })
        .map_err(|e| e.to_string())??;
    match action {
        "open" => {
            for _ in 0..300 {
                let status = panel.update(cx, |p, _| p.status());
                if status["connected"] == true {
                    return Ok(status);
                }
                if status["error"].is_string() {
                    return Err(status["error"].as_str().unwrap().into());
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(50))
                    .await;
            }
            let status = panel.update(cx, |p, _| p.status());
            if status["starting"] == true {
                // Cold boots can exceed an automation request's lifetime.
                // The panel owns startup; callers can follow it with status.
                Ok(status)
            } else {
                Err("Device connected but no display frame arrived within 15 seconds".into())
            }
        }
        "close" => Ok(json!({"closed":true})),
        "stop" => {
            panel.update(cx, |p, cx| p.stop(cx))?;
            for _ in 0..300 {
                let status = panel.update(cx, |p, _| p.status());
                if let Some(error) = status["error"].as_str() {
                    return Err(error.into());
                }
                if status["stopping"] != true {
                    return Ok(status);
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(50))
                    .await;
            }
            Ok(panel.update(cx, |p, _| p.status()))
        }
        "status" => Ok(panel.update(cx, |p, _| p.status())),
        "screenshot" => {
            let bytes = panel
                .update(cx, |p, _| p.snapshot())
                .map_err(|e| e.to_string())?;
            Ok(
                json!({"mimeType":"image/png","data":base64::engine::general_purpose::STANDARD.encode(bytes)}),
            )
        }
        "type" => {
            let text = parameters["text"].as_str().ok_or("Missing text")?;
            if !text.is_ascii() || text.len() > 1024 || text.contains('\0') {
                return Err("Use at most 1024 ASCII characters".into());
            }
            panel.update(cx, |p, _| p.input(Input::Text { text: text.into() }))?;
            Ok(json!({"sent":true}))
        }
        "press" => {
            let key = parameters["key"].as_str().ok_or("Missing key")?;
            if !["GoHome", "GoBack", "AppSwitch", "Power"].contains(&key) {
                return Err("Unsupported device key".into());
            }
            panel.update(cx, |p, _| {
                if p.device.platform == "ios" && ["GoBack", "AppSwitch"].contains(&key) {
                    return Err("This key is Android only".into());
                }
                p.input(Input::Key { key: key.into() })
            })?;
            Ok(json!({"sent":true}))
        }
        "tap" | "swipe" => {
            #[cfg(target_os = "macos")]
            {
                fn point(value: &serde_json::Value) -> Result<(f64, f64), String> {
                    let x = value["x"].as_f64().ok_or("Missing x")?;
                    let y = value["y"].as_f64().ok_or("Missing y")?;
                    if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
                        return Err("Coordinates must be normalized between 0 and 1".into());
                    }
                    Ok((x, y))
                }
                let from = point(if action == "tap" {
                    parameters
                } else {
                    &parameters["from"]
                })?;
                let to = if action == "tap" {
                    from
                } else {
                    point(&parameters["to"])?
                };
                let duration = if action == "tap" {
                    50
                } else {
                    parameters["durationMs"]
                        .as_u64()
                        .filter(|v| (50..=5000).contains(v))
                        .ok_or("durationMs must be 50–5000")?
                };
                let sender = panel.update(cx, |p, _| p.controller())?;
                struct Release {
                    sender: tokio::sync::mpsc::UnboundedSender<Input>,
                    x: f64,
                    y: f64,
                }
                impl Drop for Release {
                    fn drop(&mut self) {
                        let _ = self.sender.send(Input::Touch {
                            x: self.x,
                            y: self.y,
                            phase: 2,
                        });
                    }
                }
                let mut release = Release {
                    sender,
                    x: from.0,
                    y: from.1,
                };
                release
                    .sender
                    .send(Input::Touch {
                        x: from.0,
                        y: from.1,
                        phase: 0,
                    })
                    .map_err(|_| "Device disconnected")?;
                let steps = (duration / 16).max(1);
                for step in 1..=steps {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(duration / steps))
                        .await;
                    let t = step as f64 / steps as f64;
                    release.x = from.0 + (to.0 - from.0) * t;
                    release.y = from.1 + (to.1 - from.1) * t;
                    if action == "swipe" {
                        release
                            .sender
                            .send(Input::Touch {
                                x: release.x,
                                y: release.y,
                                phase: 1,
                            })
                            .map_err(|_| "Device disconnected")?;
                    }
                }
                drop(release);
                Ok(json!({"sent":true}))
            }
            #[cfg(not(target_os = "macos"))]
            Err("Native Devices requires macOS".into())
        }
        _ => Err("Unknown mobile action".into()),
    }
}
