//! Native device workspace. Rendering stays in the desktop process; the server
//! brokers agent requests only and never carries the live video stream.
#[cfg(target_os = "macos")]
mod android;
#[cfg(target_os = "macos")]
mod android_devices;
#[cfg(target_os = "macos")]
mod ios;
#[cfg(target_os = "macos")]
mod native;
use gpui::{Context, Window, prelude::*};
use gpui_component::{
    ActiveTheme as _, Disableable as _, Sizable as _,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default)]
    pub running: bool,
    #[serde(skip)]
    avd: Option<String>,
}
impl Device {
    pub fn same_target(&self, other: &Self) -> bool {
        self.platform == other.platform
            && match (&self.avd, &other.avd) {
                (Some(a), Some(b)) => a == b,
                _ => self.id == other.id,
            }
    }
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
        let (android, ios) = tokio::join!(android_devices::devices(), ios::devices());
        let mut devices = match (android, ios) {
            (Ok(mut android), Ok(ios)) => {
                android.extend(ios);
                android
            }
            (Ok(devices), Err(_)) | (Err(_), Ok(devices)) if !devices.is_empty() => devices,
            (Err(error), _) | (_, Err(error)) => return Err(error),
        };
        devices.sort_by(|a, b| {
            b.running
                .cmp(&a.running)
                .then(a.platform.cmp(&b.platform))
                .then(a.name.cmp(&b.name))
                .then(a.runtime.cmp(&b.runtime))
                .then(a.id.cmp(&b.id))
        });
        Ok(devices)
    }
    #[cfg(not(target_os = "macos"))]
    anyhow::bail!("Native Devices currently requires macOS")
}

#[cfg(target_os = "macos")]
async fn command_output(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[&str],
) -> anyhow::Result<Vec<u8>> {
    use anyhow::Context as _;
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(program)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("Device discovery timed out")?
    .context("Could not run the device tools")?;
    anyhow::ensure!(
        output.status.success(),
        "Device tools failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(output.stdout)
}

#[cfg(target_os = "macos")]
async fn prepare(device: Device) -> anyhow::Result<Device> {
    use anyhow::Context as _;
    tokio::time::timeout(Duration::from_secs(180), async {
        match device.platform.as_str() {
            "android" => android_devices::prepare(device).await,
            "ios" => ios::prepare(device).await,
            _ => anyhow::bail!("Unsupported device platform"),
        }
    })
    .await
    .context("Device did not finish starting within 3 minutes. Reopen Devices to try again.")?
}

pub struct DevicePanel {
    pub device: Device,
    visible: bool,
    bounds: gpui::Bounds<gpui::Pixels>,
    status: String,
    starting: bool,
    stopping: bool,
    stopped: bool,
    #[cfg(target_os = "macos")]
    view: Option<std::sync::Arc<native::NativeView>>,
    #[cfg(target_os = "macos")]
    sender: tokio::sync::mpsc::UnboundedSender<Input>,
    _worker: Option<gpui::Task<()>>,
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
                let (ready_sender, ready_receiver) = tokio::sync::oneshot::channel();
                let job = gpui_tokio::Tokio::spawn_result(cx, async move {
                    let target = prepare(target).await?;
                    let _ = ready_sender.send(target.clone());
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
                    if let Ok(device) = ready_receiver.await {
                        let _ = this.update(cx, |panel, cx| {
                            panel.device = device;
                            panel.starting = false;
                            panel.status = "Connecting display…".into();
                            cx.notify();
                        });
                    }
                    if let Err(error) = job.await {
                        let _ = this.update(cx, |panel, cx| {
                            panel.starting = false;
                            panel.status = format!("Connection failed: {error:#}");
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
                                let Some(view) = &panel.view else { return };
                                let (frames, draws, w, h) = view.stats();
                                if frames > 0 && panel.error().is_none() && !panel.starting {
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
                let status = if device.running { "Waiting for device…" } else { "Starting device…" }.into();
                Self {
                    device,
                    visible: true,
                    bounds: Default::default(),
                    status,
                    starting: true,
                    stopping: false,
                    stopped: false,
                    view: Some(view),
                    sender,
                    _worker: Some(worker),
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
        if let Some(view) = &self.view {
            view.bounds(self.bounds, visible);
        }
    }
    fn error(&self) -> Option<&str> {
        self.status
            .strip_prefix("Connection failed: ")
            .or_else(|| self.status.strip_prefix("Stop failed: "))
    }
    fn accepts_input(&self) -> bool {
        !self.starting && !self.stopping && !self.stopped && self.error().is_none()
    }
    pub fn can_reuse(&self) -> bool {
        !self.stopped && self.error().is_none()
    }
    pub fn stop(&mut self, cx: &mut Context<Self>) -> Result<(), String> {
        if self.stopping || self.stopped {
            return Ok(());
        }
        if self.starting {
            return Err("Wait for the device to finish starting before stopping it.".into());
        }
        #[cfg(target_os = "macos")]
        {
            self.stopping = true;
            self.status = "Stopping device…".into();
            // Release display/input before shutdown. Cancelling the stream also
            // prevents a disconnect error from overwriting the shutdown result.
            self._worker.take();
            if let Some(view) = self.view.take() {
                view.bounds(self.bounds, false);
            }
            let device = self.device.clone();
            let job = gpui_tokio::Tokio::spawn_result(cx, async move {
                use anyhow::Context as _;
                tokio::time::timeout(Duration::from_secs(60), async {
                    match device.platform.as_str() {
                        "android" => android_devices::stop(&device).await,
                        "ios" => ios::stop(&device).await,
                        _ => anyhow::bail!("Unsupported device platform"),
                    }
                })
                .await
                .context("Shutdown timed out. Try Stop again.")?
            });
            // Once requested, shutdown completes even if the tab is closed.
            cx.spawn(async move |this, cx| {
                let result = job.await;
                let _ = this.update(cx, |panel, cx| {
                    panel.stopping = false;
                    match result {
                        Ok(()) => {
                            panel.stopped = true;
                            panel.device.running = false;
                            panel.status = "Stopped · Open Devices to start again.".into();
                        }
                        Err(error) => panel.status = format!("Stop failed: {error:#}"),
                    }
                    cx.notify();
                });
            })
            .detach();
            cx.notify();
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        Err("Native Devices requires macOS".into())
    }
    pub fn input(&self, input: Input) -> Result<(), String> {
        if !self.accepts_input() {
            return Err("Device is not connected".into());
        }
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
    pub fn controller(&self) -> Result<tokio::sync::mpsc::UnboundedSender<Input>, String> {
        if !self.accepts_input() {
            return Err("Device is not connected".into());
        }
        Ok(self.sender.clone())
    }
    pub fn status(&self) -> serde_json::Value {
        #[cfg(target_os = "macos")]
        let (frames, draws, w, h) = self.view.as_ref().map_or((0, 0, 0, 0), |view| view.stats());
        #[cfg(not(target_os = "macos"))]
        let (frames, draws, w, h) = (0, 0, 0, 0);
        serde_json::json!({"device":self.device,"status":self.status,"starting":self.starting,"stopping":self.stopping,"stopped":self.stopped,"connected":frames>0&&self.accepts_input(),"frames":frames,"presented":draws,"width":w,"height":h,"error":self.error()})
    }
    pub fn snapshot(&self) -> anyhow::Result<Vec<u8>> {
        #[cfg(target_os = "macos")]
        {
            anyhow::ensure!(self.accepts_input(), "Device is not connected");
            self.view
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Device is not connected"))?
                .snapshot()
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
                    .child(
                        gpui::div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_sm()
                            .child(name),
                    )
                    .child(
                        Button::new("device-home")
                            .label("Home")
                            .ghost()
                            .xsmall()
                            .disabled(!self.accepts_input())
                            .on_click(cx.listener(|p, _, _, _| {
                                let _ = p.input(Input::Key {
                                    key: "GoHome".into(),
                                });
                            })),
                    )
                    .when(self.device.platform == "android", |row| {
                        row.child(
                            Button::new("device-back")
                                .label("Back")
                                .ghost()
                                .xsmall()
                                .disabled(!self.accepts_input())
                                .on_click(cx.listener(|p, _, _, _| {
                                    let _ = p.input(Input::Key {
                                        key: "GoBack".into(),
                                    });
                                })),
                        )
                    })
                    .child(
                        Button::new("device-stop")
                            .label(if self.stopping { "Stopping…" } else { "Stop" })
                            .ghost()
                            .xsmall()
                            .tooltip("Shut down this device")
                            .disabled(self.starting || self.stopping || self.stopped)
                            .on_click(cx.listener(|p, _, _, cx| {
                                let _ = p.stop(cx);
                            })),
                    ),
            )
            .child(
                gpui::div()
                    .px_2()
                    .pb_2()
                    .text_xs()
                    .text_color(if self.error().is_some() {
                        cx.theme().danger
                    } else {
                        cx.theme().muted_foreground
                    })
                    .child(status),
            )
            .child(
                gpui::canvas(
                    move |bounds, _, cx| {
                        view.update(cx, |p, _| {
                            p.bounds = bounds;
                            #[cfg(target_os = "macos")]
                            if let Some(view) = &p.view {
                                view.bounds(bounds, p.visible);
                            }
                        });
                    },
                    |_, _, _, _| {},
                )
                .size_full(),
            )
    }
}
