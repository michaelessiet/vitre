//! Native device workspace. Rendering stays in the desktop process; the server
//! brokers agent requests only and never carries the live video stream.
#[cfg(target_os = "macos")]
mod android;
#[cfg(target_os = "macos")]
mod native;
use gpui::{Context, Window, prelude::*};
use gpui_component::{
    button::{Button, ButtonVariants},
    h_flex, v_flex,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub platform: String,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Input {
    Touch { x: f64, y: f64, phase: i32 },
    Key { key: String },
    Text { text: String },
}

pub async fn devices() -> anyhow::Result<Vec<Device>> {
    #[cfg(target_os = "macos")]
    {
        let mut devices = android::devices();
        let output = tokio::process::Command::new("xcrun")
            .args(["simctl", "list", "devices", "booted", "--json"])
            .output()
            .await?;
        if output.status.success() {
            let value: serde_json::Value = serde_json::from_slice(&output.stdout)?;
            if let Some(runtimes) = value["devices"].as_object() {
                for list in runtimes.values() {
                    if let Some(list) = list.as_array() {
                        for d in list {
                            if d["state"] == "Booted"
                                && let (Some(id), Some(name)) =
                                    (d["udid"].as_str(), d["name"].as_str())
                            {
                                devices.push(Device {
                                    id: id.into(),
                                    name: format!("{name} · {}", &id[..8.min(id.len())]),
                                    platform: "ios".into(),
                                });
                            }
                        }
                    }
                }
            }
        }
        Ok(devices)
    }
    #[cfg(not(target_os = "macos"))]
    anyhow::bail!("Native Devices currently requires macOS")
}

pub struct DevicePanel {
    pub device: Device,
    visible: bool,
    bounds: gpui::Bounds<gpui::Pixels>,
    status: String,
    #[cfg(target_os = "macos")]
    view: std::sync::Arc<native::NativeView>,
    #[cfg(target_os = "macos")]
    sender: tokio::sync::mpsc::UnboundedSender<Input>,
    _worker: gpui::Task<()>,
    _stats: gpui::Task<()>,
}
impl DevicePanel {
    pub fn open(
        device: Device,
        window: &mut Window,
        cx: &mut gpui::App,
    ) -> anyhow::Result<gpui::Entity<Self>> {
        #[cfg(target_os = "macos")]
        {
            let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
            let view = native::NativeView::new(window, sender.clone())?;
            Ok(cx.new(move |cx: &mut Context<Self>| {
                let stream_view = view.clone();
                let target = device.clone();
                let job = gpui_tokio::Tokio::spawn_result(cx, async move {
                    if target.platform == "android" {
                        android::run(target.id, stream_view, receiver).await
                    } else {
                        let output = tokio::process::Command::new("xcode-select")
                            .arg("-p")
                            .output()
                            .await?;
                        let developer = String::from_utf8(output.stdout)?.trim().to_owned();
                        let connect_view = stream_view.clone();
                        tokio::task::spawn_blocking(move || {
                            connect_view.ios(&target.id, &developer)
                        })
                        .await??;
                        let mut receiver = receiver;
                        while let Some(input) = receiver.recv().await {
                            match input {
                                Input::Text { text } => {
                                    if let Err(error) = stream_view.text(&text) {
                                        eprintln!("[mobile] Keyboard input: {error}");
                                    }
                                }
                                Input::Key { key } => {
                                    stream_view.button(if key == "Power" { 1 } else { 0 })
                                }
                                Input::Touch { x, y, phase } => stream_view.touch(x, y, phase),
                            }
                        }
                        Ok(())
                    }
                });
                let worker = cx.spawn(async move |this, cx| {
                    if let Err(error) = job.await {
                        let _ = this.update(cx, |panel, cx| {
                            panel.status = format!("Connection failed: {error}");
                            cx.notify();
                        });
                    }
                });
                let stats = cx.spawn(async move |this, cx| {
                    let mut previous = (0, 0);
                    let mut sampled_at = std::time::Instant::now();
                    loop {
                        cx.background_executor().timer(Duration::from_secs(1)).await;
                        if this
                            .update(cx, |panel, cx| {
                                let (frames, draws, w, h) = panel.view.stats();
                                if frames > 0 && !panel.status.starts_with("Connection failed") {
                                    let elapsed = sampled_at.elapsed().as_secs_f64();
                                    let fps = draws.saturating_sub(previous.1) as f64 / elapsed;
                                    panel.status = format!("{w} × {h} · {fps:.0} fps");
                                    if std::env::var_os("VITRE_VERIFY_MOBILE").is_some() && frames > previous.0 {
                                        eprintln!("[mobile-perf] {} received={:.1}/s presented={fps:.1}/s", panel.device.platform, frames.saturating_sub(previous.0) as f64 / elapsed);
                                    }
                                    previous = (frames, draws);
                                    sampled_at = std::time::Instant::now();
                                    cx.notify();
                                }
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                });
                Self {
                    device,
                    visible: true,
                    bounds: Default::default(),
                    status: "Connecting…".into(),
                    view,
                    sender,
                    _worker: worker,
                    _stats: stats,
                }
            }))
        }
        #[cfg(not(target_os = "macos"))]
        anyhow::bail!("Native Devices requires macOS")
    }
    pub fn set_visible(&mut self, visible: bool) {
        self.visible = visible;
        #[cfg(target_os = "macos")]
        self.view.bounds(self.bounds, visible);
    }
    pub fn input(&self, input: Input) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            self.sender
                .send(input)
                .map_err(|_| "Device disconnected".into())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = input;
            Err("Native Devices requires macOS".into())
        }
    }
    #[cfg(target_os = "macos")]
    pub fn controller(&self) -> tokio::sync::mpsc::UnboundedSender<Input> {
        self.sender.clone()
    }
    pub fn status(&self) -> serde_json::Value {
        #[cfg(target_os = "macos")]
        let (frames, draws, w, h) = self.view.stats();
        #[cfg(not(target_os = "macos"))]
        let (frames, draws, w, h) = (0, 0, 0, 0);
        serde_json::json!({"device":self.device,"status":self.status,"connected":frames>0&&!self.status.starts_with("Connection failed"),"frames":frames,"presented":draws,"width":w,"height":h,"error":self.status.strip_prefix("Connection failed: ")})
    }
    pub fn snapshot(&self) -> anyhow::Result<Vec<u8>> {
        #[cfg(target_os = "macos")]
        {
            self.view.snapshot()
        }
        #[cfg(not(target_os = "macos"))]
        anyhow::bail!("Native Devices requires macOS")
    }
}
impl Render for DevicePanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let name = self.device.name.clone();
        let status = self.status.clone();
        let view = cx.entity();
        v_flex()
            .size_full()
            .child(
                h_flex()
                    .p_2()
                    .gap_2()
                    .child(gpui::div().flex_1().text_sm().child(name))
                    .child(
                        Button::new("device-home")
                            .label("Home")
                            .ghost()
                            .on_click(cx.listener(|p, _, _, _| {
                                let _ = p.input(Input::Key {
                                    key: "GoHome".into(),
                                });
                            })),
                    )
                    .when(self.device.platform == "android", |row| {
                        row.child(Button::new("device-back").label("Back").ghost().on_click(
                            cx.listener(|p, _, _, _| {
                                let _ = p.input(Input::Key {
                                    key: "GoBack".into(),
                                });
                            }),
                        ))
                    }),
            )
            .child(gpui::div().px_2().pb_2().text_xs().child(status))
            .child(
                gpui::canvas(
                    move |bounds, _, cx| {
                        view.update(cx, |p, _| {
                            p.bounds = bounds;
                            #[cfg(target_os = "macos")]
                            p.view.bounds(bounds, p.visible);
                        });
                    },
                    |_, _, _, _| {},
                )
                .size_full(),
            )
    }
}
