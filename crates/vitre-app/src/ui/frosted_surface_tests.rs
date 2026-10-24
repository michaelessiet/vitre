use std::{cell::Cell, rc::Rc, sync::Arc};

use gpui::{Context, RenderImage, Task, VisualTestContext, Window, div, prelude::*, px, size};
use gpui_component::{
    ActiveTheme as _, Theme,
    frosted_surface::{FrostedSurface, set_capture},
};

struct FrostedProbe {
    open: bool,
}

impl Render for FrostedProbe {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().when(self.open, |root| {
            root.child(FrostedSurface::new(
                "popup",
                div().w(px(180.)).h(px(120.)).bg(cx.theme().popover),
                cx,
            ))
        })
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

fn image() -> Arc<RenderImage> {
    crate::image_render::from_dynamic(image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_pixel(4, 4, image::Rgba([40, 60, 90, 255])),
    ))
}

#[gpui::test]
fn frosted_surface_captures_once_per_mount_and_releases_its_image(cx: &mut gpui::TestAppContext) {
    let captures = Rc::new(Cell::new(0));
    let captured_image = image();
    cx.update({
        let captures = captures.clone();
        let captured_image = captured_image.clone();
        move |cx| {
            gpui_component::init(cx);
            cx.set_reduce_motion(true);
            Theme::global_mut(cx).popover.a = 0.5;
            set_capture(cx, move |_, _| {
                captures.set(captures.get() + 1);
                Some(Task::ready(captured_image.clone()))
            });
        }
    });
    let (view, cx) = cx.add_window_view(|_, _| FrostedProbe { open: true });
    draw(cx);
    cx.run_until_parked();
    for _ in 0..4 {
        draw(cx);
    }
    assert_eq!(
        captures.get(),
        1,
        "repainting must reuse the mounted backdrop"
    );
    assert!(cx.update(|window, _| window.has_image_atlas_entry(&captured_image)));

    view.update(cx, |view, cx| {
        view.open = false;
        cx.notify();
    });
    draw(cx);
    cx.run_until_parked();
    draw(cx);
    assert!(
        !cx.update(|window, _| window.has_image_atlas_entry(&captured_image)),
        "closing the surface releases its atlas allocation"
    );

    view.update(cx, |view, cx| {
        view.open = true;
        cx.notify();
    });
    draw(cx);
    cx.run_until_parked();
    draw(cx);
    assert_eq!(captures.get(), 2, "reopening captures the new app backdrop");
}

#[gpui::test]
fn frosted_surface_skips_capture_for_an_opaque_theme(cx: &mut gpui::TestAppContext) {
    let captures = Rc::new(Cell::new(0));
    cx.update({
        let captures = captures.clone();
        move |cx| {
            gpui_component::init(cx);
            cx.set_reduce_motion(true);
            Theme::global_mut(cx).popover.a = 1.;
            set_capture(cx, move |_, _| {
                captures.set(captures.get() + 1);
                Some(Task::ready(image()))
            });
        }
    });
    let (_, cx) = cx.add_window_view(|_, _| FrostedProbe { open: true });
    for _ in 0..3 {
        draw(cx);
        cx.run_until_parked();
    }
    assert_eq!(captures.get(), 0);
}

#[gpui::test]
fn frosted_surface_uses_an_opaque_fallback_while_pending_and_does_not_recapture_on_resize(
    cx: &mut gpui::TestAppContext,
) {
    let captures = Rc::new(Cell::new(0));
    cx.update({
        let captures = captures.clone();
        move |cx| {
            gpui_component::init(cx);
            cx.set_reduce_motion(true);
            Theme::global_mut(cx).popover.a = 0.5;
            set_capture(cx, move |_, cx| {
                captures.set(captures.get() + 1);
                Some(cx.background_executor().spawn(futures::future::pending()))
            });
        }
    });
    let (_, cx) = cx.add_window_view(|_, _| FrostedProbe { open: true });
    draw(cx);
    let has_opaque_backing = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            let opaque = cx.theme().popover.alpha(1.).into();
            window
                .painted_quads()
                .iter()
                .any(|quad| quad.background == opaque)
        })
    };
    assert!(
        has_opaque_backing(cx),
        "pending work cannot leak sharp background text"
    );
    let window = cx.update(|window, _| window.window_handle());
    cx.simulate_window_resize(window, size(px(760.), px(520.)));
    cx.run_until_parked();
    draw(cx);
    assert!(has_opaque_backing(cx));
    assert_eq!(
        captures.get(),
        1,
        "resize must not capture the popup itself"
    );
}

#[gpui::test]
fn frosted_surface_backing_enters_with_the_popup_instead_of_flashing_opaque(
    cx: &mut gpui::TestAppContext,
) {
    cx.update(|cx| {
        gpui_component::init(cx);
        cx.set_reduce_motion(false);
        Theme::global_mut(cx).popover.a = 0.5;
        set_capture(cx, |_, _| None);
    });
    let (_, cx) = cx.add_window_view(|_, _| FrostedProbe { open: true });
    let has_opaque_backing = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            let opaque = cx.theme().popover.alpha(1.).into();
            window
                .painted_quads()
                .iter()
                .any(|quad| quad.background == opaque)
        })
    };
    draw(cx);
    assert!(
        !has_opaque_backing(cx),
        "the backing must not flash at full strength on the first entrance frame"
    );
    // GPUI's one-shot AnimationElement reads wall-clock Instant, rather than
    // the test executor clock used by the spring helpers.
    std::thread::sleep(std::time::Duration::from_millis(170));
    draw(cx);
    assert!(
        has_opaque_backing(cx),
        "the settled fallback blocks sharp background text"
    );
}
