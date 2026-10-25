//! Cached backdrop frosting for floating surfaces.
//!
//! The host supplies an in-process renderer capture, already blurred off the
//! UI thread. Capturing only when the surface mounts keeps its own text out of
//! the backdrop and avoids a readback on every animation or keystroke.

use std::{rc::Rc, sync::Arc, time::Duration};

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, AvailableSpace, Bounds, Corners, Element,
    ElementId, Entity, Global, GlobalElementId, Hsla, InspectorElementId, IntoElement, LayoutId,
    ParentElement as _, Pixels, RenderImage, Size, Styled as _, Task, Window, canvas, div, point,
    px, size,
};

use crate::ActiveTheme as _;

type Capture = dyn Fn(&Window, &App) -> Option<Task<Arc<RenderImage>>>;
struct BackdropCapture(Rc<Capture>);
impl Global for BackdropCapture {}

/// Install the host's renderer-backed capture. The returned image must be
/// opaque BGRA, blurred, and cover the window's entire logical viewport.
/// No screen recording or native-window capture is involved.
pub fn set_capture(
    cx: &mut App,
    capture: impl Fn(&Window, &App) -> Option<Task<Arc<RenderImage>>> + 'static,
) {
    cx.set_global(BackdropCapture(Rc::new(capture)));
}

#[doc(hidden)]
pub struct BackdropState {
    viewport: Size<Pixels>,
    scale: f32,
    image: Option<Arc<RenderImage>>,
    _task: Option<Task<()>>,
}

/// Paint a rounded, frosted backdrop immediately behind a styled popup.
/// The child still owns its tint, border, shadow, content, and interactions.
/// When capture is installed, use a solid themed backing until it completes
/// (or if it fails), so
/// background text can never bleed sharply through a translucent popup.
pub struct FrostedSurface {
    id: ElementId,
    child: AnyElement,
    tint: Hsla,
    radius: Pixels,
}

impl FrostedSurface {
    pub fn new(id: impl Into<ElementId>, child: impl IntoElement, cx: &App) -> Self {
        Self {
            id: id.into(),
            child: child.into_any_element(),
            tint: cx.theme().popover,
            radius: cx.theme().radius,
        }
    }

    pub fn radius(mut self, radius: Pixels) -> Self {
        self.radius = radius;
        self
    }
}

impl IntoElement for FrostedSurface {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for FrostedSurface {
    type RequestLayoutState = ();
    type PrepaintState = (Option<Entity<BackdropState>>, Option<AnyElement>);

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let Some(capture) = cx
            .try_global::<BackdropCapture>()
            .map(|capture| capture.0.clone())
        else {
            self.child.prepaint(window, cx);
            return (None, None);
        };
        let translucent = self.tint.a < 1.;
        let state = window.use_keyed_state("backdrop", cx, move |window, cx| {
            cx.on_release_in(window, |state: &mut BackdropState, window, _| {
                if let Some(image) = state.image.take() {
                    let _ = window.drop_image(image);
                }
            })
            .detach();
            let task = translucent
                .then(|| capture(window, cx))
                .flatten()
                .map(|capture| {
                    cx.spawn(async move |state, cx| {
                        let image = capture.await;
                        // A dismissed popup releases the keyed state and cancels
                        // this task. Weak update also rejects a late completion.
                        let _ = state.update(cx, |state, cx| {
                            state.image = Some(image);
                            cx.notify();
                        });
                    })
                });
            BackdropState {
                viewport: window.viewport_size(),
                scale: window.scale_factor(),
                image: None,
                _task: task,
            }
        });
        let mut backing = None;
        if translucent {
            let snapshot = state.read(cx);
            // Never recapture a frame containing the popup itself. A resized
            // viewport uses a solid fallback until the popup is reopened.
            let image = (snapshot.viewport == window.viewport_size()
                && snapshot.scale == window.scale_factor())
            .then(|| snapshot.image.clone())
            .flatten();
            let viewport = snapshot.viewport;
            let radii = Corners::all(self.radius);
            let mut surface = div()
                .size_full()
                .rounded(self.radius)
                .bg(self.tint.alpha(1.))
                .child(
                    canvas(
                        |_, _, _| (),
                        move |bounds, _, window, _| {
                            if let Some(image) = &image {
                                let _ = window.paint_image(
                                    bounds,
                                    Bounds::new(point(px(0.), px(0.)), viewport),
                                    radii,
                                    image.clone(),
                                    0,
                                    false,
                                );
                            }
                        },
                    )
                    .size_full(),
                )
                .with_animation(
                    "frost-enter",
                    Animation::new(Duration::from_millis(150))
                        .with_easing(crate::animation::ease_out_cubic),
                    |surface, delta| surface.opacity(delta),
                )
                .into_any_element();
            surface.layout_as_root(
                size(
                    AvailableSpace::Definite(bounds.size.width),
                    AvailableSpace::Definite(bounds.size.height),
                ),
                window,
                cx,
            );
            surface.prepaint_at(bounds.origin, window, cx);
            backing = Some(surface);
        }
        self.child.prepaint(window, cx);
        (Some(state), backing)
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        state: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(backing) = &mut state.1 {
            backing.paint(window, cx);
        }
        self.child.paint(window, cx);
    }
}
