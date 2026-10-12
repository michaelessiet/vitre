//! Convert decoded pixels directly to GPUI's BGRA image representation.
use std::sync::Arc;

pub(crate) fn from_dynamic(image: image::DynamicImage) -> Arc<gpui::RenderImage> {
    let mut pixels = image.into_rgba8();
    for pixel in pixels.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    Arc::new(gpui::RenderImage::new([image::Frame::new(pixels)]))
}

#[cfg(test)]
mod tests {
    #[test]
    fn preserves_alpha_and_converts_rgba_to_bgra() {
        let pixels = image::RgbaImage::from_pixel(1, 1, image::Rgba([12, 34, 56, 78]));
        let image = super::from_dynamic(image::DynamicImage::ImageRgba8(pixels));
        assert_eq!(image.as_bytes(0).unwrap(), &[56, 34, 12, 78]);
    }
}
