//! Capture the app before a popup opens and blur it on a worker. The backdrop
//! stays frozen for the lifetime of that popup; this is not a live GPU filter.

use std::sync::Arc;

use gpui::{App, RenderImage, Task, Window};
use gpui_component::ActiveTheme as _;
use image::{RgbaImage, imageops};

const MAX_EDGE: u32 = 800;
const BLUR_RADIUS: f32 = 24.;

pub(super) fn install(cx: &mut App) {
    gpui_component::frosted_surface::set_capture(cx, capture);
}

fn capture(window: &Window, cx: &App) -> Option<Task<Arc<RenderImage>>> {
    let viewport = window.viewport_size();
    let logical_width = f32::from(viewport.width);
    let logical_height = f32::from(viewport.height);
    if !logical_width.is_finite()
        || !logical_height.is_finite()
        || logical_width <= 0.
        || logical_height <= 0.
    {
        return None;
    }
    // Only the completed pre-popup scene is captured. The shared surface
    // invokes this once per mount, before adding itself to the next scene.
    let snapshot = window.render_to_image().ok()?;
    if snapshot.width() == 0 || snapshot.height() == 0 {
        return None;
    }
    let background = gpui::Rgba::from(cx.theme().background);
    let background = [background.r, background.g, background.b]
        .map(|channel| (channel.clamp(0., 1.) * 255.).round() as u8);
    Some(cx.background_executor().spawn(async move {
        let pixels = prepare_snapshot(snapshot, logical_width, background);
        crate::image_render::from_dynamic(image::DynamicImage::ImageRgba8(pixels))
    }))
}

fn prepare_snapshot(mut snapshot: RgbaImage, logical_width: f32, background: [u8; 3]) -> RgbaImage {
    if snapshot.width() == 0 || snapshot.height() == 0 {
        return snapshot;
    }

    // Metal's source-alpha blending already premultiplies the captured RGB.
    // Fill the uncovered area without multiplying those channels a second
    // time. Opaque pixels replace the sharp app content behind the blur.
    for pixel in snapshot.pixels_mut() {
        let uncovered = 255 - u16::from(pixel[3]);
        for channel in 0..3 {
            let fill = (u16::from(background[channel]) * uncovered + 127) / 255;
            pixel[channel] = (u16::from(pixel[channel]) + fill).min(255) as u8;
        }
        pixel[3] = 255;
    }

    let scale = (MAX_EDGE as f32 / snapshot.width().max(snapshot.height()) as f32).min(1.);
    let width = ((snapshot.width() as f32 * scale).round() as u32).max(1);
    let height = ((snapshot.height() as f32 * scale).round() as u32).max(1);
    let reduced = if snapshot.dimensions() == (width, height) {
        snapshot
    } else {
        imageops::resize(&snapshot, width, height, imageops::FilterType::Triangle)
    };
    // Derive the worker-image sigma from logical width so Retina scale and
    // downsampling produce the same apparent blur radius on screen.
    let sigma = BLUR_RADIUS * width as f32 / logical_width.max(1.);
    imageops::blur(&reduced, sigma)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn backdrop_flattens_premultiplied_pixels_without_darkening_them_twice() {
        let snapshot = RgbaImage::from_pixel(4, 4, Rgba([128, 64, 0, 128]));
        let result = prepare_snapshot(snapshot, 4., [40, 80, 120]);
        assert_eq!(result.get_pixel(2, 2).0, [148, 104, 60, 255]);

        let transparent = RgbaImage::new(1, 1);
        let result = prepare_snapshot(transparent, 1., [30, 60, 90]);
        assert_eq!(result.get_pixel(0, 0).0, [30, 60, 90, 255]);
    }

    #[test]
    fn backdrop_is_opaque_and_blurs_sharp_edges() {
        let snapshot = RgbaImage::from_fn(160, 80, |x, _| {
            if x < 80 {
                Rgba([0, 0, 0, 120])
            } else {
                Rgba([255, 255, 255, 255])
            }
        });
        let result = prepare_snapshot(snapshot, 160., [0, 0, 0]);
        assert!(result.pixels().all(|pixel| pixel[3] == 255));
        assert!(
            result.get_pixel(70, 40)[0] > 40,
            "blur spreads across the dark side"
        );
        assert!(
            result.get_pixel(90, 40)[0] < 215,
            "blur spreads across the light side"
        );
        assert!(result.get_pixel(10, 40)[0] < result.get_pixel(70, 40)[0]);
    }

    #[test]
    fn backdrop_bounds_worker_images_without_upscaling() {
        let large = RgbaImage::from_pixel(1600, 400, Rgba([60, 80, 100, 255]));
        let result = prepare_snapshot(large, 800., [0, 0, 0]);
        assert_eq!(result.dimensions(), (800, 200));
        let small = RgbaImage::from_pixel(12, 6, Rgba([60, 80, 100, 255]));
        assert_eq!(
            prepare_snapshot(small, 12., [0, 0, 0]).dimensions(),
            (12, 6)
        );
        assert_eq!(
            prepare_snapshot(RgbaImage::new(0, 0), 1., [0, 0, 0]).dimensions(),
            (0, 0)
        );
    }

    #[test]
    fn backdrop_blur_is_consistent_across_display_scales() {
        let edge = |width, height| {
            RgbaImage::from_fn(width, height, |x, _| {
                if x < width / 2 {
                    Rgba([0, 0, 0, 255])
                } else {
                    Rgba([255, 255, 255, 255])
                }
            })
        };
        let standard = prepare_snapshot(edge(200, 100), 200., [0, 0, 0]);
        let retina = prepare_snapshot(edge(400, 200), 200., [0, 0, 0]);
        let standard_sample = i16::from(standard.get_pixel(90, 50)[0]);
        let retina_sample = i16::from(retina.get_pixel(180, 100)[0]);
        assert!((standard_sample - retina_sample).abs() <= 4);
    }
}
