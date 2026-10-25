//! Measured content: layout changes retarget a spring instead of jumping.
//! The natural content is measured independently of the visible clipping height.
use gpui::{
    AnyElement, App, AvailableSpace, Bounds, ContentMask, Element, ElementId, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, Pixels, Style, Window, px, relative, size,
};

/// A clipped, naturally measured region with spring-animated height changes.
pub struct AnimatedHeight {
    id: ElementId,
    child: AnyElement,
    expanded: bool,
    animate_initial: bool,
}

impl AnimatedHeight {
    pub fn new(id: impl Into<ElementId>, child: impl IntoElement) -> Self {
        Self {
            id: id.into(),
            child: child.into_any_element(),
            expanded: true,
            animate_initial: true,
        }
    }

    /// Whether the first measured height grows from zero. Disable this for
    /// surfaces that already have their own appearance transition.
    pub fn animate_initial(mut self, animate: bool) -> Self {
        self.animate_initial = animate;
        self
    }

    /// Collapse to zero while retaining content through the closing animation.
    pub fn expanded(mut self, expanded: bool) -> Self {
        self.expanded = expanded;
        self
    }
}
impl IntoElement for AnimatedHeight {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for AnimatedHeight {
    type RequestLayoutState = Option<LayoutId>;
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let height = window.with_element_state(id.unwrap(), |state: Option<Option<Pixels>>, _| {
            let height = state.flatten();
            (height, height)
        });
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.flex_shrink = 0.;

        if height.is_none() && self.expanded && (!self.animate_initial || cx.reduce_motion()) {
            // Include the content in the first layout so the surface opens at
            // its natural size, even when reduced motion skips the fade. Do
            // not initialize a spring at zero before this size is known.
            let child_layout = self.child.request_layout(window, cx);
            return (
                window.request_layout(style, [child_layout], cx),
                Some(child_layout),
            );
        }

        let height = gpui_base::motion::spring(
            self.id.clone(),
            if self.expanded {
                f32::from(height.unwrap_or(px(0.)))
            } else {
                0.
            },
            gpui_base::motion::Spring::new(std::time::Duration::from_millis(220)),
            window,
            cx,
        );
        style.size.height = px(height.max(0.)).into();
        (window.request_layout(style, None, cx), None)
    }
    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let measured = if let Some(child_layout) = *child_layout {
            window.layout_bounds(child_layout).size
        } else {
            self.child.layout_as_root(
                size(
                    AvailableSpace::Definite(bounds.size.width),
                    AvailableSpace::MinContent,
                ),
                window,
                cx,
            )
        };
        let changed = window.with_element_state(id.unwrap(), |state: Option<Option<Pixels>>, _| {
            (
                state.flatten() != Some(measured.height),
                Some(measured.height),
            )
        });
        if changed {
            window.request_animation_frame();
        }
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            if child_layout.is_some() {
                self.child.prepaint(window, cx)
            } else {
                self.child.prepaint_at(bounds.origin, window, cx)
            }
        });
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            self.child.paint(window, cx)
        });
    }
}
