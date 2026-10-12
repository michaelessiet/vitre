//! Chat attachments use signed HTTP URLs or optimistic base64 data URLs.
//! Load them explicitly: GPUI's default HTTP client is a NullHttpClient.
use std::{
    collections::HashMap,
    io::Cursor,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context as _, ensure};
use base64::Engine as _;
use gpui::{App, Asset, ImageCacheError, ImageSource, RenderImage, SharedString};

const MAX_BYTES: usize = 32 * 1024 * 1024;
// Bound peak decoder scratch space even when a viewport contains many images.
static DECODES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[cfg(debug_assertions)]
mod verification;

pub(super) fn source(url: SharedString) -> ImageSource {
    cached_source(url, false)
}

pub(super) fn full_source(url: SharedString) -> ImageSource {
    cached_source(url, true)
}

#[derive(Default)]
struct ImageBudget(HashMap<(SharedString, bool), (usize, Instant)>);
impl gpui::Global for ImageBudget {}

fn cached_source(url: SharedString, full: bool) -> ImageSource {
    ImageSource::Custom(Arc::new(move |window, cx| {
        let result = if full {
            window.use_asset::<ChatImage>(&url, cx)
        } else {
            window.use_asset::<ChatThumbnail>(&url, cx)
        };
        if !cx.has_global::<ImageBudget>() {
            cx.set_global(ImageBudget::default());
        }
        let bytes = result
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .and_then(|image| image.as_bytes(0))
            .map_or(0, |pixels| pixels.len());
        let cache = &mut cx.global_mut::<ImageBudget>().0;
        cache.insert((url.clone(), full), (bytes, Instant::now()));
        let mut evicted = Vec::new();
        while cache.len() > 32
            || cache.values().map(|(bytes, _)| bytes).sum::<usize>() > 64 * 1024 * 1024
        {
            // Active viewport/lightbox pixels are pinned; evict reusable assets.
            let key = cache
                .iter()
                .filter(|(_, (_, used))| used.elapsed() > Duration::from_millis(250))
                .min_by_key(|(_, (_, used))| *used)
                .map(|(key, _)| key.clone());
            let Some(key) = key else {
                break;
            };
            cache.remove(&key);
            evicted.push(key);
        }
        for (url, full) in evicted {
            if full {
                cx.remove_asset::<ChatImage>(&url);
            } else {
                cx.remove_asset::<ChatThumbnail>(&url);
            }
        }
        result
    }))
}

pub(super) struct ChatImage;
struct ChatThumbnail;

impl Asset for ChatThumbnail {
    type Source = SharedString;
    type Output = Result<Arc<RenderImage>, ImageCacheError>;
    fn load(
        url: SharedString,
        cx: &mut App,
    ) -> impl Future<Output = Self::Output> + Send + 'static {
        load_image(url, 1024, cx)
    }
}

impl Asset for ChatImage {
    type Source = SharedString;
    type Output = Result<Arc<RenderImage>, ImageCacheError>;

    fn load(
        url: Self::Source,
        cx: &mut App,
    ) -> impl Future<Output = Self::Output> + Send + 'static {
        load_image(url, 4096, cx)
    }
}

fn load_image(
    url: SharedString,
    edge: u32,
    cx: &mut App,
) -> impl Future<Output = Result<Arc<RenderImage>, ImageCacheError>> + Send + 'static {
    let task = gpui_tokio::Tokio::spawn_result(cx, async move {
        let permit = DECODES.acquire().await?;
        let bytes = load_bytes(&url).await?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            decode_sized(&bytes, edge)
        })
        .await?
    });
    async move { task.await.map_err(Into::into) }
}

async fn load_bytes(url: &str) -> anyhow::Result<Vec<u8>> {
    if url.starts_with("data:") {
        let (header, encoded) = url.split_once(',').context("Invalid image data URL")?;
        ensure!(
            header.starts_with("data:image/") && header.ends_with(";base64"),
            "Unsupported image data URL"
        );
        ensure!(
            encoded.len() <= MAX_BYTES.div_ceil(3) * 4,
            "Image exceeds 32 MB"
        );
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
        ensure!(bytes.len() <= MAX_BYTES, "Image exceeds 32 MB");
        return Ok(bytes);
    }
    let url = reqwest::Url::parse(url).context("Invalid image URL")?;
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "Unsupported image URL"
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?;
    // Signed attachment URLs need no ambient credentials. Do not include the
    // URL (which carries a capability token) in errors shown by the renderer.
    let mut response = client.get(url).send().await.map_err(|e| e.without_url())?;
    ensure!(
        response.status().is_success(),
        "Image request failed ({})",
        response.status()
    );
    ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= MAX_BYTES as u64),
        "Image exceeds 32 MB"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.without_url())? {
        ensure!(
            bytes.len() + chunk.len() <= MAX_BYTES,
            "Image exceeds 32 MB"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
fn decode(bytes: &[u8]) -> anyhow::Result<Arc<RenderImage>> {
    decode_sized(bytes, 4096)
}

fn decode_sized(bytes: &[u8], edge: u32) -> anyhow::Result<Arc<RenderImage>> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    reader.limits(limits);
    // Match the explorer's bounded first-frame preview and texture dimensions.
    let decoded = reader.decode()?;
    let decoded = if decoded.width() > edge || decoded.height() > edge {
        decoded.thumbnail(edge, edge)
    } else {
        decoded
    };
    Ok(crate::image_render::from_dynamic(decoded))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(32, 16, image::Rgba([80, 140, 220, 255]))
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    #[tokio::test]
    async fn pasted_image_data_url_decodes() {
        let url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png())
        );
        let image = decode(&load_bytes(&url).await.unwrap()).unwrap();
        assert_eq!(
            image.size(0),
            gpui::size(gpui::DevicePixels(32), gpui::DevicePixels(16))
        );
    }

    #[tokio::test]
    async fn saved_attachment_loads_over_http_without_gpui_http_client() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/api/assets/image?token=test",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let count = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.contains("/api/assets/image?token=test"));
            assert!(!request.to_lowercase().contains("authorization:"));
            let bytes = png();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            stream.write_all(&bytes).await.unwrap();
        });
        let image = decode(&load_bytes(&url).await.unwrap()).unwrap();
        assert_eq!(
            image.size(0),
            gpui::size(gpui::DevicePixels(32), gpui::DevicePixels(16))
        );
        server.await.unwrap();
    }

    #[test]
    fn thumbnail_limits_pixels_while_full_preview_keeps_detail() {
        let mut bytes = Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(2048, 1024, image::Rgba([80, 140, 220, 128]))
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let thumbnail = decode_sized(bytes.get_ref(), 1024).unwrap();
        let full = decode_sized(bytes.get_ref(), 4096).unwrap();
        assert_eq!(
            thumbnail.size(0),
            gpui::size(gpui::DevicePixels(1024), gpui::DevicePixels(512))
        );
        assert_eq!(
            full.size(0),
            gpui::size(gpui::DevicePixels(2048), gpui::DevicePixels(1024))
        );
        assert_eq!(thumbnail.as_bytes(0).unwrap().len(), 1024 * 512 * 4);
    }

    #[tokio::test]
    async fn malformed_images_fail_without_panicking() {
        assert!(load_bytes("data:image/png;base64,invalid!").await.is_err());
        assert!(load_bytes("file:///tmp/image.png").await.is_err());
        assert!(decode(b"not an image").is_err());
    }
}
