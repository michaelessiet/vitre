//! Local action acknowledgement, independent of provider or conversation state.
use super::*;
use gpui::{Animation, AnimationExt as _, App, ElementId, RenderOnce, Task};

#[derive(Default)]
struct CopyState {
    copied: bool,
    generation: usize,
    reset: Option<Task<()>>,
}

#[derive(IntoElement)]
pub(super) struct CopyButton {
    id: ElementId,
    value: SharedString,
    label: Option<SharedString>,
    tooltip: SharedString,
}

impl CopyButton {
    pub(super) fn new(
        id: impl Into<ElementId>,
        value: impl Into<SharedString>,
        tooltip: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            value: value.into(),
            label: None,
            tooltip: tooltip.into(),
        }
    }
    pub(super) fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }
}

impl RenderOnce for CopyButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| CopyState::default());
        let copied = state.read(cx).copied;
        let generation = state.read(cx).generation;
        let content = h_flex()
            .gap_1()
            .items_center()
            .justify_center()
            .child(
                Icon::new(if copied {
                    IconName::Check
                } else {
                    IconName::Copy
                })
                .size_3(),
            )
            .when_some(self.label.clone(), |content, label| content.child(label));
        let content = content.when(copied, |content| {
            content
                .debug_selector(|| "copy-confirmation".into())
                .text_color(cx.theme().success)
        });
        let content = if generation > 0 {
            content
                .with_animation(
                    (
                        "copy-feedback",
                        generation.wrapping_mul(2).wrapping_add(usize::from(copied)),
                    ),
                    Animation::new(Duration::from_millis(180))
                        .with_easing(gpui_component::animation::ease_out_cubic),
                    |element, progress| {
                        element
                            .opacity(progress)
                            .relative()
                            .top(px(2. * (1. - progress)))
                    },
                )
                .into_any_element()
        } else {
            content.into_any_element()
        };
        Button::new(self.id)
            .ghost()
            .xsmall()
            .when(self.label.is_none(), |button| button.size_5())
            .when(self.label.is_some(), |button| button.w(gpui::rems(5.)))
            .tooltip(if copied {
                SharedString::from("Copied to clipboard")
            } else {
                self.tooltip
            })
            .child(content)
            .on_click(move |_, window, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(self.value.to_string()));
                state.update(cx, |state, cx| {
                    state.copied = true;
                    state.generation = state.generation.wrapping_add(1);
                    state.reset = Some(cx.spawn_in(window, async move |state, cx| {
                        cx.background_executor().timer(Duration::from_secs(2)).await;
                        let _ = state.update_in(cx, |state, window, cx| {
                            state.copied = false;
                            window.refresh();
                            cx.notify();
                        });
                    }));
                    cx.notify();
                });
                window.refresh();
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    fn copy_feedback_repeats_resets_and_preserves_button_size(cx: &mut gpui::TestAppContext) {
        struct Probe;
        impl Render for Probe {
            fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
                h_flex().items_start().child(
                    div()
                        .flex_none()
                        .debug_selector(|| "copy-target".into())
                        .child(CopyButton::new(
                            "copy-test",
                            "literal café 世界",
                            "Copy message",
                        )),
                )
            }
        }
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_reduce_motion(true);
        });
        let (_, cx) = cx.add_window_view(|window, cx| {
            let view = cx.new(|_| Probe);
            Root::new(view, window, cx)
        });
        cx.update(|w, cx| w.draw(cx).clear(cx));
        let before = cx.debug_bounds("copy-target").unwrap();
        assert!(before.size.width <= px(24.));
        let position = before.center();
        for _ in 0..2 {
            cx.simulate_mouse_down(position, gpui::MouseButton::Left, Default::default());
            cx.simulate_mouse_up(position, gpui::MouseButton::Left, Default::default());
            cx.update(|w, cx| w.draw(cx).clear(cx));
            assert!(cx.debug_bounds("copy-confirmation").is_some());
            assert_eq!(cx.debug_bounds("copy-target").unwrap().size, before.size);
            assert_eq!(
                cx.update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text())),
                Some("literal café 世界".into())
            );
            cx.run_until_parked();
            cx.executor().advance_clock(Duration::from_secs(1));
            cx.run_until_parked();
            cx.update(|w, cx| w.draw(cx).clear(cx));
            assert!(
                cx.debug_bounds("copy-confirmation").is_some(),
                "a repeated click must restart the reset timer"
            );
        }
        cx.executor().advance_clock(Duration::from_secs(2));
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
        assert!(cx.debug_bounds("copy-confirmation").is_none());
    }
}
