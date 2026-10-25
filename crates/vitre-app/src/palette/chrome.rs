//! Shared, quiet keyboard guidance for the two palette surfaces.

use gpui::{App, Div, IntoElement, div, prelude::*};
use gpui_component::{ActiveTheme as _, h_flex};

pub(super) fn footer(cx: &App) -> Div {
    h_flex()
        .w_full()
        .flex_none()
        .gap_3()
        .px_3()
        .py_2()
        .text_xs()
        .text_color(cx.theme().muted_foreground)
        .border_t_1()
        .border_color(cx.theme().border.opacity(0.6))
}

pub(super) fn key_hint(keys: &'static str, label: &'static str, cx: &App) -> impl IntoElement {
    h_flex()
        .gap_1()
        .child(
            div()
                .rounded(cx.theme().radius)
                .px_1()
                .bg(cx.theme().muted.opacity(0.35))
                .text_color(cx.theme().foreground)
                .child(keys),
        )
        .child(label)
}
