//! Android EmulatorController gRPC. Raw RGBA frames go straight to Metal.
//! No screenshot polling, PNG/base64 video, browser, or device-side helper.
//! MMAP is deliberately avoided: Emulator 36.5.11 on macOS crashes in that path.
use super::{Input, android_devices, native::NativeView};
use anyhow::{Context as _, Result};
use prost::Message;
use std::{sync::Arc, time::Duration};
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

async fn endpoint(id: &str) -> Result<Endpoint> {
    android_devices::running()
        .await?
        .into_iter()
        .find(|r| r.device.id == id)
        .map(|r| r.endpoint)
        .context("The emulator stopped. Reopen Devices to start it again.")
}

#[derive(Clone, PartialEq, Message)]
struct EmulatorStatus {
    #[prost(bool, tag = "3")]
    booted: bool,
}

#[derive(Clone, PartialEq, Message)]
struct VmRunState {
    #[prost(int32, tag = "1")]
    state: i32,
}

pub(super) async fn shutdown(endpoint: &Endpoint) -> Result<()> {
    anyhow::ensure!(
        !endpoint.token.is_empty(),
        "Emulator authentication token is missing"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        let channel = Channel::from_shared(format!("http://127.0.0.1:{}", endpoint.port))?
            .connect_timeout(Duration::from_secs(2))
            .connect()
            .await?;
        // SHUTDOWN saves the emulator state and exits gracefully. STOP merely
        // pauses the VM; TERMINATE can corrupt its disk and must not be used.
        unary(
            &mut Grpc::new(channel),
            endpoint,
            "/android.emulation.control.EmulatorController/setVmState",
            VmRunState { state: 5 },
        )
        .await
    })
    .await
    .context("Emulator did not answer the shutdown request")?
}

pub(super) async fn booted(endpoint: &Endpoint) -> Result<bool> {
    tokio::time::timeout(Duration::from_secs(2), async {
        let channel = Channel::from_shared(format!("http://127.0.0.1:{}", endpoint.port))?
            .connect_timeout(Duration::from_secs(1))
            .connect()
            .await?;
        let mut client = Grpc::new(channel);
        client.ready().await?;
        let reply: tonic::Response<EmulatorStatus> = client
            .unary(
                request(endpoint, Empty {})?,
                tonic::codegen::http::uri::PathAndQuery::from_static(
                    "/android.emulation.control.EmulatorController/getStatus",
                ),
                ProstCodec::default(),
            )
            .await?;
        Ok(reply.into_inner().booted)
    })
    .await
    .context("Emulator did not answer its readiness check")?
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
    let endpoint = endpoint(&id).await?;
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use tonic::codegen::{Body, BoxFuture, Service, StdError, http};

    #[derive(Clone)]
    struct StatusService(Arc<AtomicBool>, Arc<AtomicBool>);
    #[derive(Clone)]
    struct ShutdownService(Arc<AtomicBool>);
    impl tonic::server::UnaryService<VmRunState> for ShutdownService {
        type Response = Empty;
        type Future = BoxFuture<tonic::Response<Empty>, tonic::Status>;
        fn call(&mut self, request: Request<VmRunState>) -> Self::Future {
            let shutdown = self.0.clone();
            Box::pin(async move {
                if request
                    .metadata()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    != Some("Bearer test-token")
                {
                    return Err(tonic::Status::unauthenticated("Invalid token"));
                }
                assert_eq!(
                    request.into_inner().state,
                    5,
                    "Must request graceful shutdown"
                );
                shutdown.store(true, Ordering::SeqCst);
                Ok(tonic::Response::new(Empty {}))
            })
        }
    }
    impl tonic::server::NamedService for StatusService {
        const NAME: &'static str = "android.emulation.control.EmulatorController";
    }
    impl tonic::server::UnaryService<Empty> for StatusService {
        type Response = EmulatorStatus;
        type Future = BoxFuture<tonic::Response<EmulatorStatus>, tonic::Status>;
        fn call(&mut self, request: Request<Empty>) -> Self::Future {
            let booted = self.0.load(Ordering::SeqCst);
            Box::pin(async move {
                if request
                    .metadata()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    != Some("Bearer test-token")
                {
                    return Err(tonic::Status::unauthenticated("Invalid token"));
                }
                Ok(tonic::Response::new(EmulatorStatus { booted }))
            })
        }
    }
    impl<B> Service<http::Request<B>> for StatusService
    where
        B: Body + Send + 'static,
        B::Error: Into<StdError> + Send + 'static,
    {
        type Response = http::Response<tonic::body::BoxBody>;
        type Error = std::convert::Infallible;
        type Future = BoxFuture<Self::Response, Self::Error>;
        fn poll_ready(
            &mut self,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn call(&mut self, request: http::Request<B>) -> Self::Future {
            if request.uri().path() == "/android.emulation.control.EmulatorController/setVmState" {
                let service = ShutdownService(self.1.clone());
                return Box::pin(async move {
                    Ok(tonic::server::Grpc::new(ProstCodec::default())
                        .unary(service, request)
                        .await)
                });
            }
            assert_eq!(
                request.uri().path(),
                "/android.emulation.control.EmulatorController/getStatus"
            );
            let service = self.clone();
            Box::pin(async move {
                Ok(tonic::server::Grpc::new(ProstCodec::default())
                    .unary(service, request)
                    .await)
            })
        }
    }

    #[tokio::test]
    async fn readiness_requires_authenticated_android_boot_completion() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Endpoint {
            port: listener.local_addr().unwrap().port(),
            token: "test-token".into(),
        };
        let ready = Arc::new(AtomicBool::new(false));
        let service = StatusService(ready.clone(), Arc::new(AtomicBool::new(false)));
        let server = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(service)
                .serve_with_incoming(
                    tonic::codegen::tokio_stream::wrappers::TcpListenerStream::new(listener),
                )
                .await
                .unwrap();
        });
        assert!(
            !booted(&endpoint).await.unwrap(),
            "A live gRPC port does not mean Android is booted"
        );
        ready.store(true, Ordering::SeqCst);
        assert!(booted(&endpoint).await.unwrap());
        assert!(
            booted(&Endpoint {
                token: "wrong-token".into(),
                ..endpoint.clone()
            })
            .await
            .is_err()
        );
        server.abort();
        let _ = server.await;
        assert!(
            booted(&endpoint).await.is_err(),
            "A dead endpoint must not be ready"
        );
    }
    #[tokio::test]
    async fn shutdown_requires_authentication_and_requests_graceful_exit() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut endpoint = Endpoint {
            port: listener.local_addr().unwrap().port(),
            token: "wrong-token".into(),
        };
        let stopped = Arc::new(AtomicBool::new(false));
        let service = StatusService(Arc::new(AtomicBool::new(true)), stopped.clone());
        let server = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(service)
                .serve_with_incoming(
                    tonic::codegen::tokio_stream::wrappers::TcpListenerStream::new(listener),
                )
                .await
                .unwrap();
        });
        assert!(shutdown(&endpoint).await.is_err());
        assert!(!stopped.load(Ordering::SeqCst));
        endpoint.token.clear();
        assert!(shutdown(&endpoint).await.is_err());
        assert!(!stopped.load(Ordering::SeqCst));
        endpoint.token = "test-token".into();
        shutdown(&endpoint).await.unwrap();
        assert!(stopped.load(Ordering::SeqCst));
        server.abort();
        let _ = server.await;
        assert!(shutdown(&endpoint).await.is_err());
    }
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
        let p = android_devices::ini("grpc.port=8554\ngrpc.token=a=b==\navd.name=Pixel 10");
        assert_eq!(p["grpc.token"], "a=b==");
    }
}
