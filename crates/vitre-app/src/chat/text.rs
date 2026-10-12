//! Literal chat text participates in the same window selection as Markdown.
use super::*;
use gpui::{
    App, Bounds, Element, ElementId, GlobalElementId, Hitbox, InspectorElementId, LayoutId, Pixels,
    StyledText,
};
use gpui_base::{TextSelection, TextSelectionHandle, TextSelectionRegistration, TextSelectionRun};

pub(super) struct SelectionState {
    handle: TextSelectionHandle,
    focus: FocusHandle,
    _subscription: Subscription,
}

pub(super) struct ChatText {
    text: SharedString,
    styled: StyledText,
    id: ElementId,
}

pub(super) fn chat_text(text: impl Into<SharedString>) -> ChatText {
    let text = text.into();
    let mut hash = DefaultHasher::new();
    text.hash(&mut hash);
    ChatText {
        styled: StyledText::new(text.clone()),
        text,
        id: ("chat-text", hash.finish()).into(),
    }
}

impl IntoElement for ChatText {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for ChatText {
    type RequestLayoutState = Entity<SelectionState>;
    type PrepaintState = Hitbox;
    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let text = self.text.clone();
        let state = window.use_keyed_state("selection", cx, move |window, cx| {
            let handle = TextSelectionHandle::new(text.to_string(), cx);
            let focus = cx.focus_handle();
            let selection_focus = focus.clone();
            handle.focus_with(move |window, cx| selection_focus.focus(window, cx), cx);
            let subscription = handle.refresh_window_on_change(window, cx);
            SelectionState {
                handle,
                focus,
                _subscription: subscription,
            }
        });
        let (layout, _) = self.styled.request_layout(id, inspector, window, cx);
        (layout, state)
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Hitbox {
        self.styled
            .prepaint(id, inspector, bounds, &mut (), window, cx);
        window.set_focus_handle(&state.read(cx).focus, cx);
        let hitbox = window.insert_hitbox(bounds, gpui::HitboxBehavior::Normal);
        state.read(cx).handle.clone().register(
            TextSelectionRegistration::new(hitbox.clone(), bounds).with_text_bounds(vec![bounds]),
            window,
            cx,
        );
        hitbox
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        hitbox: &mut Hitbox,
        window: &mut Window,
        cx: &mut App,
    ) {
        window.set_cursor_style(gpui::CursorStyle::IBeam, hitbox);
        window.set_key_context(gpui::KeyContext::parse("TextView").unwrap());
        window.on_action(
            std::any::TypeId::of::<gpui_component::input::Copy>(),
            |_, phase, window, cx| {
                if phase == gpui::DispatchPhase::Bubble {
                    let text = TextSelection::selected_text(window, cx);
                    if text.is_empty() {
                        cx.propagate();
                    } else {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                    }
                }
            },
        );
        let layout = self.styled.layout().clone();
        let handle = state.read(cx).handle.clone();
        let before = TextSelection::selected_text(window, cx);
        let projection = handle.update_runs(
            &[TextSelectionRun::new(
                self.text.clone(),
                layout.clone(),
                bounds,
            )],
            cx,
        );
        if before != TextSelection::selected_text(window, cx) {
            window.refresh();
        }
        for range in projection.ranges().iter().flatten() {
            if let (Some(start), Some(end)) = (
                layout.position_for_index(range.start),
                layout.position_for_index(range.end),
            ) {
                let height = layout.line_height();
                let mut quads = Vec::new();
                if start.y == end.y {
                    quads.push(Bounds::from_corners(
                        start,
                        gpui::point(end.x, end.y + height),
                    ));
                } else {
                    quads.push(Bounds::from_corners(
                        start,
                        gpui::point(bounds.right(), start.y + height),
                    ));
                    if end.y > start.y + height {
                        quads.push(Bounds::from_corners(
                            gpui::point(bounds.left(), start.y + height),
                            gpui::point(bounds.right(), end.y),
                        ));
                    }
                    quads.push(Bounds::from_corners(
                        gpui::point(bounds.left(), end.y),
                        gpui::point(end.x, end.y + height),
                    ));
                }
                for quad in quads {
                    window.paint_quad(gpui::fill(quad, cx.theme().primary.opacity(0.25)));
                }
            }
        }
        self.styled
            .paint(id, inspector, bounds, &mut (), &mut (), window, cx);
    }
}

pub(super) struct MessageMarkdown {
    pub state: Entity<gpui_component::text::TextViewState>,
    pub(super) _subscription: Subscription,
    pub(super) touched: std::time::Instant,
    pub(super) source_bytes: usize,
}

impl ChatApp {
    pub(super) fn message_markdown_state(
        &mut self,
        id: &MessageId,
        source: &str,
        cx: &mut Context<Self>,
    ) -> Entity<gpui_component::text::TextViewState> {
        // Bound disposable parse/layout states, not conversation history. Recent
        // viewport states and selections stay pinned to preserve interaction.
        while self.message_markdown.len() >= 128
            || self
                .message_markdown
                .values()
                .map(|entry| entry.source_bytes)
                .sum::<usize>()
                > 8 * 1024 * 1024
        {
            let candidate = self
                .message_markdown
                .iter()
                .filter(|(key, entry)| {
                    *key != id
                        && entry.touched.elapsed() > std::time::Duration::from_millis(250)
                        && entry.state.read(cx).selected_text().is_empty()
                })
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(key, _)| key.clone());
            let Some(candidate) = candidate else {
                break;
            };
            self.message_markdown.remove(&candidate);
        }
        if let Some(cached) = self.message_markdown.get_mut(id) {
            cached.touched = std::time::Instant::now();
            cached.source_bytes = source.len();
            let state = cached.state.clone();
            state.update(cx, |state, cx| state.set_text(source, cx));
            return state;
        }
        let state = cx.new(|cx| gpui_component::text::TextViewState::markdown(source, cx));
        let message_id = id.clone();
        let subscription = cx.observe(&state, move |app, _, cx| {
            // Large documents parse off-thread. Their final height isn't known
            // when the virtual list first measures the row.
            if let Some(index) = app.timeline.iter().position(|row| matches!(row, TimelineRow::Message(i) if app.display_messages.get(*i).is_some_and(|m| m.id == message_id))) {
                app.remeasure_row(index, cx);
            }
        });
        self.message_markdown.insert(
            id.clone(),
            MessageMarkdown {
                state: state.clone(),
                _subscription: subscription,
                touched: std::time::Instant::now(),
                source_bytes: source.len(),
            },
        );
        state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    fn user_bubble_text_selects_in_virtualized_timeline(cx: &mut gpui::TestAppContext) {
        struct Probe {
            list: ListState,
        }
        impl Render for Probe {
            fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
                list(
                    self.list.clone(),
                    cx.processor(|_, index, _, _| {
                        h_flex()
                            .w_full()
                            .justify_end()
                            .p_3()
                            .child(
                                v_flex().max_w(relative(0.8)).p_3().child(
                                    h_flex().w_full().flex_wrap().child(
                                        div().min_w_0().child(
                                            div()
                                                .debug_selector(move || {
                                                    format!("user-text-{index}")
                                                })
                                                .child(render_user_plain_text(format!(
                                                    "user {index} literal café 世界"
                                                ))),
                                        ),
                                    ),
                                ),
                            )
                            .into_any_element()
                    }),
                )
                .size_full()
            }
        }
        cx.update(gpui_component::init);
        let (_, cx) = cx.add_window_view(|window, cx| {
            let view = cx.new(|_| Probe {
                list: ListState::new(3, ListAlignment::Bottom, px(800.)),
            });
            Root::new(view, window, cx)
        });
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
        for index in 0..3 {
            let bounds = cx
                .debug_bounds(["user-text-0", "user-text-1", "user-text-2"][index])
                .unwrap();
            cx.simulate_mouse_down(
                gpui::point(bounds.left(), bounds.top() + px(4.)),
                gpui::MouseButton::Left,
                Default::default(),
            );
            cx.update(|w, cx| w.draw(cx).clear(cx));
            cx.simulate_mouse_move(
                gpui::point(bounds.right(), bounds.bottom() - px(1.)),
                Some(gpui::MouseButton::Left),
                Default::default(),
            );
            cx.update(|w, cx| w.draw(cx).clear(cx));
            cx.simulate_mouse_up(
                gpui::point(bounds.right(), bounds.bottom() - px(1.)),
                gpui::MouseButton::Left,
                Default::default(),
            );
            cx.update(|w, cx| w.draw(cx).clear(cx));
            assert_eq!(
                cx.update(|w, cx| TextSelection::selected_text(w, cx)),
                format!("user {index} literal café 世界")
            );
        }
    }

    #[gpui::test]
    fn literal_chat_text_selects_and_copies_without_markdown_interpretation(
        cx: &mut gpui::TestAppContext,
    ) {
        struct Probe;
        impl Render for Probe {
            fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
                div().size_full().child(
                    div()
                        .w(px(400.))
                        .debug_selector(|| "literal-chat-text".into())
                        .child(chat_text("**literal** <tag> café 世界")),
                )
            }
        }
        cx.update(gpui_component::init);
        let (_, cx) = cx.add_window_view(|window, cx| {
            let content = cx.new(|_| Probe);
            Root::new(content, window, cx)
        });
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
        let bounds = cx.debug_bounds("literal-chat-text").unwrap();
        cx.simulate_mouse_down(
            gpui::point(bounds.left(), bounds.top() + px(4.)),
            gpui::MouseButton::Left,
            Default::default(),
        );
        cx.simulate_mouse_move(
            gpui::point(bounds.right(), bounds.bottom() - px(1.)),
            Some(gpui::MouseButton::Left),
            Default::default(),
        );
        cx.simulate_mouse_up(
            gpui::point(bounds.right(), bounds.bottom() - px(1.)),
            gpui::MouseButton::Left,
            Default::default(),
        );
        cx.update(|w, cx| w.draw(cx).clear(cx));
        assert_eq!(
            cx.update(|w, cx| TextSelection::selected_text(w, cx)),
            "**literal** <tag> café 世界"
        );
        cx.simulate_keystrokes("cmd-c");
        assert_eq!(
            cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
            Some("**literal** <tag> café 世界".into())
        );
    }
}
