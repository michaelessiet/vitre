//! Android EmulatorController gRPC. Raw RGBA frames go straight to Metal.
//! No screenshot polling, PNG/base64 video, browser, or device-side helper.
//! MMAP is deliberately avoided: Emulator 36.5.11 on macOS crashes in that path.
use super::{Device, Input, native::NativeView};
use anyhow::{Context as _, Result};
use prost::Message;
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tonic::{Request, client::Grpc, codec::ProstCodec, transport::Channel};

#[derive(Clone)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}
// Minimal wire definitions from the SDK's lib/emulator_controller.proto.
#[derive(Clone, PartialEq, Message)]
struct Empty {}
#[derive(Clone, PartialEq, Message)]
struct Format {
    #[prost(message, optional, tag = "2")]
    rotation: Option<Rotation>,
    #[prost(int32, tag = "1")]
    format: i32,
    #[prost(uint32, tag = "3")]
    width: u32,
    #[prost(uint32, tag = "4")]
    height: u32,
}
#[derive(Clone, PartialEq, Message)]
struct Rotation {
    #[prost(int32, tag = "1")]
    rotation: i32,
}
#[derive(Clone, PartialEq, Message)]
struct Display {
    #[prost(uint32, tag = "1")]
    width: u32,
    #[prost(uint32, tag = "2")]
    height: u32,
    #[prost(uint32, tag = "5")]
    id: u32,
}
#[derive(Clone, PartialEq, Message)]
struct Displays {
    #[prost(message, repeated, tag = "1")]
    displays: Vec<Display>,
}
#[derive(Clone, PartialEq, Message)]
struct Frame {
    #[prost(message, optional, tag = "1")]
    format: Option<Format>,
    #[prost(bytes = "bytes", tag = "4")]
    image: prost::bytes::Bytes,
    #[prost(uint32, tag = "5")]
    seq: u32,
    #[prost(uint64, tag = "6")]
    timestamp_us: u64,
}
#[derive(Clone, PartialEq, Message)]
struct Touch {
    #[prost(int32, tag = "1")]
    x: i32,
    #[prost(int32, tag = "2")]
    y: i32,
    #[prost(int32, tag = "3")]
    identifier: i32,
    #[prost(int32, tag = "4")]
    pressure: i32,
}
#[derive(Clone, PartialEq, Message)]
struct TouchEvent {
    #[prost(message, repeated, tag = "1")]
    touches: Vec<Touch>,
}
#[derive(Clone, PartialEq, Message)]
struct KeyEvent {
    #[prost(int32, tag = "1")]
    code_type: i32,
    #[prost(int32, tag = "2")]
    event_type: i32,
    #[prost(uint32, tag = "3")]
    key_code: u32,
    #[prost(string, tag = "4")]
    key: String,
    #[prost(string, tag = "5")]
    text: String,
}

fn ini(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|s| s.split_once('='))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect()
}
fn registry() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
        .join("Library/Caches/TemporaryItems/avd/running")
}
pub fn devices() -> Vec<Device> {
    let Ok(entries) = std::fs::read_dir(registry()) else {
        return vec![];
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension()?.to_str()? != "ini" {
                return None;
            }
            let properties = ini(&std::fs::read_to_string(path).ok()?);
            let serial = properties.get("port.serial")?.parse::<u16>().ok()?;
            properties.get("grpc.port")?.parse::<u16>().ok()?;
            Some(Device {
                id: format!("emulator-{serial}"),
                name: properties
                    .get("avd.name")
                    .or(properties.get("avd.id"))?
                    .clone(),
                platform: "android".into(),
            })
        })
        .collect()
}
fn endpoint(id: &str) -> Result<Endpoint> {
    for entry in std::fs::read_dir(registry())
        .context("No Android emulator is running")?
        .flatten()
    {
        if entry.path().extension().and_then(|s| s.to_str()) != Some("ini") {
            continue;
        }
        let p = ini(&std::fs::read_to_string(entry.path())?);
        if p.get("port.serial")
            .is_some_and(|s| id == format!("emulator-{s}"))
        {
            return Ok(Endpoint {
                port: p
                    .get("grpc.port")
                    .context("Emulator has no gRPC endpoint")?
                    .parse()?,
                token: p
                    .get("grpc.token")
                    .context("Emulator has no local authentication token")?
                    .clone(),
            });
        }
    }
    anyhow::bail!("The emulator is no longer running. Refresh Devices.")
}
fn request<T>(endpoint: &Endpoint, input: T) -> Result<Request<T>> {
    let mut req = Request::new(input);
    req.metadata_mut().insert(
        "authorization",
        format!("Bearer {}", endpoint.token).parse()?,
    );
    Ok(req)
}
async fn unary<T: Message + Default + Send + Sync + 'static>(
    client: &mut Grpc<Channel>,
    endpoint: &Endpoint,
    method: &'static str,
    input: T,
) -> Result<()> {
    client.ready().await?;
    let _: tonic::Response<Empty> = client
        .unary(
            request(endpoint, input)?,
            tonic::codegen::http::uri::PathAndQuery::from_static(method),
            ProstCodec::default(),
        )
        .await?;
    Ok(())
}
const SCREEN: &str = "/android.emulation.control.EmulatorController/streamScreenshot";
const TOUCH: &str = "/android.emulation.control.EmulatorController/sendTouch";
const KEY: &str = "/android.emulation.control.EmulatorController/sendKey";

// Cancellation must release the guest contact even when a panel closes in the
// middle of an agent gesture or an input RPC fails.
struct ContactRelease {
    client: Grpc<Channel>,
    endpoint: Endpoint,
    contact: Option<(i32, i32)>,
}
impl Drop for ContactRelease {
    fn drop(&mut self) {
        let Some((x, y)) = self.contact else { return };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let mut client = self.client.clone();
        let endpoint = self.endpoint.clone();
        runtime.spawn(async move {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                unary(
                    &mut client,
                    &endpoint,
                    TOUCH,
                    TouchEvent {
                        touches: vec![Touch {
                            x,
                            y,
                            identifier: 0,
                            pressure: 0,
                        }],
                    },
                ),
            )
            .await;
        });
    }
}

pub async fn run(
    id: String,
    view: Arc<NativeView>,
    mut inputs: mpsc::UnboundedReceiver<Input>,
) -> Result<()> {
    let endpoint = endpoint(&id)?;
    let channel = Channel::from_shared(format!("http://127.0.0.1:{}", endpoint.port))?
        .connect_timeout(Duration::from_secs(5))
        .http2_adaptive_window(true)
        .initial_stream_window_size(16 * 1024 * 1024)
        .initial_connection_window_size(32 * 1024 * 1024)
        .connect()
        .await?;
    let mut client = Grpc::new(channel.clone()).max_decoding_message_size(64 * 1024 * 1024 + 1024);
    client.ready().await?;
    let display_reply: tonic::Response<Displays> = client
        .unary(
            request(&endpoint, Empty {})?,
            tonic::codegen::http::uri::PathAndQuery::from_static(
                "/android.emulation.control.EmulatorController/getDisplayConfigurations",
            ),
            ProstCodec::default(),
        )
        .await?;
    let display = display_reply
        .into_inner()
        .displays
        .into_iter()
        .find(|d| d.id == 0)
        .context("Emulator has no main display")?;
    frame_bytes(display.width, display.height)?;
    let format = Format {
        format: 1,
        // Preview resolution bounds per-frame IPC bandwidth. Input still uses
        // native display coordinates, independent of this scaling.
        width: 1280,
        height: 1280,
        rotation: None,
    };
    client.ready().await?;
    let response: tonic::Response<tonic::Streaming<Frame>> = client
        .server_streaming(
            request(&endpoint, format)?,
            tonic::codegen::http::uri::PathAndQuery::from_static(SCREEN),
            ProstCodec::default(),
        )
        .await?;
    let mut stream = response.into_inner();
    let mut control = Grpc::new(channel);
    use std::sync::atomic::{AtomicU64, Ordering};
    let dimensions = AtomicU64::new(0);
    let frames = async {
        loop {
            let frame = stream.message().await?.context("Emulator disconnected")?;
            let f = frame.format.context("Missing emulator frame dimensions")?;
            if f.width == 0 || f.height == 0 {
                continue;
            }
            let len = frame_bytes(f.width, f.height)?;
            anyhow::ensure!(frame.image.len() == len, "Incomplete emulator frame");
            let (native_w, native_h) = oriented_size(
                display.width,
                display.height,
                f.rotation.as_ref().map_or(0, |r| r.rotation),
            );
            dimensions.store(
                ((native_w as u64) << 32) | native_h as u64,
                Ordering::Relaxed,
            );
            let accepted = view.rgba(&frame.image, f.width, f.height);
            if view.stats().0 == 0 {
                anyhow::ensure!(
                    accepted,
                    "Metal could not allocate an emulator pixel buffer"
                );
            }
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    // Input RPC latency must never hold up frame reception or drawing.
    let controls = async {
        let mut release = ContactRelease {
            client: control.clone(),
            endpoint: endpoint.clone(),
            contact: None,
        };
        while let Some(input) = inputs.recv().await {
            let d = dimensions.load(Ordering::Relaxed);
            let (width, height) = ((d >> 32) as u32, d as u32);
            let operation = async {
                match input {
                    Input::Touch { x, y, phase } if width > 0 => {
                        let (x, y) = pixel_point(x, y, width, height);
                        release.contact = Some((x, y));
                        unary(
                            &mut control,
                            &endpoint,
                            TOUCH,
                            TouchEvent {
                                touches: vec![Touch {
                                    x,
                                    y,
                                    identifier: 0,
                                    pressure: if phase == 2 { 0 } else { 1024 },
                                }],
                            },
                        )
                        .await?;
                        if phase == 2 {
                            release.contact = None;
                        }
                    }
                    Input::Key { key } => {
                        unary(
                            &mut control,
                            &endpoint,
                            KEY,
                            KeyEvent {
                                key,
                                event_type: 2,
                                ..Default::default()
                            },
                        )
                        .await?
                    }
                    Input::Text { text } => {
                        let key = match text.as_str() {
                            "\r" | "\n" => "Enter",
                            "\u{7f}" | "\u{8}" => "Backspace",
                            "\u{1b}" => "Escape",
                            _ => "",
                        };
                        unary(
                            &mut control,
                            &endpoint,
                            KEY,
                            KeyEvent {
                                event_type: 2,
                                key: key.into(),
                                text: if key.is_empty() { text } else { String::new() },
                                ..Default::default()
                            },
                        )
                        .await?;
                    }
                    _ => {}
                }
                Ok::<(), anyhow::Error>(())
            };
            tokio::time::timeout(Duration::from_secs(3), operation).await??;
        }
        Ok::<(), anyhow::Error>(())
    };
    tokio::select! { result=frames=>result, result=controls=>result }
}

fn oriented_size(w: u32, h: u32, rotation: i32) -> (u32, u32) {
    if rotation == 1 || rotation == 3 {
        (h, w)
    } else {
        (w, h)
    }
}
fn frame_bytes(w: u32, h: u32) -> Result<usize> {
    if w == 0 || h == 0 || w > 4096 || h > 4096 {
        anyhow::bail!("Unsupported emulator frame size {w}×{h}");
    }
    Ok(w as usize * h as usize * 4)
}
fn pixel_point(x: f64, y: f64, w: u32, h: u32) -> (i32, i32) {
    (
        (x.clamp(0., 1.) * (w - 1) as f64).round() as i32,
        (y.clamp(0., 1.) * (h - 1) as f64).round() as i32,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn android_frame_bounds_and_touch_edges() {
        assert!(frame_bytes(0, 100).is_err());
        assert!(frame_bytes(4097, 100).is_err());
        assert_eq!(frame_bytes(1080, 2424).unwrap(), 10_471_680);
        assert_eq!(pixel_point(1., 1., 1080, 2424), (1079, 2423));
        assert_eq!(pixel_point(-2., 2., 1080, 2424), (0, 2423));
    }
    #[test]
    fn scaled_preview_input_uses_native_rotated_coordinates() {
        let (w, h) = oriented_size(1080, 2424, 1);
        assert_eq!(pixel_point(1., 1., w, h), (2423, 1079));
        assert_eq!(oriented_size(1080, 2424, 2), (1080, 2424));
        // Image scaling must not substitute the 570 × 1280 preview size here.
        assert_eq!(pixel_point(0.5, 0.5, 1080, 2424), (540, 1212));
    }
    #[test]
    fn android_registry_preserves_token_values() {
        let p = ini("grpc.port=8554\ngrpc.token=a=b==\navd.name=Pixel 10");
        assert_eq!(p["grpc.token"], "a=b==");
    }
}
