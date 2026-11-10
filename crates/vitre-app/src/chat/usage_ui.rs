//! The dock's Usage surface: each provider's plan limits, laid out like
//! Claude Code's `/usage` — a label, a bar with "N% used", and when it resets.
//!
//! Providers that don't report windows (Cursor, Grok, OpenCode) say so, show
//! a limit failure if one happened, and link to their own usage page. The
//! data arrives as `usageLimits` events on the server-config stream.

use gpui::{App, Hsla};
use vitre_contracts::generated::{ProviderUsageLimits, UsageLimitStatus, UsageLimitWindow};
use vitre_state::usage_limits::{
    UsageAlertLevel, is_exceeded, provider_heading, reset_label, resets_at, used_percent,
};
use vitre_state::wire_opt::defined2;

use super::*;

fn bar_color(window: &UsageLimitWindow, cx: &App) -> Hsla {
    if is_exceeded(window) {
        return cx.theme().danger;
    }
    match window.status {
        UsageLimitStatus::Warning => cx.theme().warning,
        _ if used_percent(window).is_some_and(|percent| percent >= 80.0) => cx.theme().warning,
        _ => cx.theme().primary,
    }
}

impl ChatApp {
    /// A new limits snapshot from the server: store it and queue any warnings.
    pub(super) fn set_usage_limits(
        &mut self,
        limits: Vec<ProviderUsageLimits>,
        cx: &mut Context<Self>,
    ) {
        let alerts = self.usage_alerts.observe(&limits);
        self.pending_usage_alerts.extend(alerts);
        self.usage_limits = limits;
        cx.notify();
    }

    /// Pushes queued limit warnings; called from render, which has the window.
    pub(super) fn flush_usage_alerts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for alert in std::mem::take(&mut self.pending_usage_alerts) {
            let notification = match alert.level {
                UsageAlertLevel::Warning => Notification::warning(alert.message),
                UsageAlertLevel::Exceeded => Notification::error(alert.message),
            }
            .title(alert.title);
            window.push_notification(notification, cx);
        }
    }

    pub(super) fn render_dock_usage(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.usage_limits.is_empty() {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_1()
                .p_6()
                .child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().foreground)
                        .child("No providers yet"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("Plan limits appear here once a provider is set up."),
                )
                .into_any_element();
        }
        let now = chrono::Utc::now();
        let mut content = v_flex().w_full().gap_6().p_4();
        for limits in &self.usage_limits {
            content = content.child(self.render_provider_usage(limits, now, cx));
        }
        div()
            .id("dock-usage")
            .size_full()
            .overflow_y_scrollbar()
            .child(content)
            .into_any_element()
    }

    fn render_provider_usage(
        &self,
        limits: &ProviderUsageLimits,
        now: chrono::DateTime<chrono::Utc>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let dashboard = defined2(&limits.dashboard_url).map(|url| url.0.clone());
        let updated = defined2(&limits.updated_at)
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(&at.0).ok())
            .map(|at| {
                let seconds = (now - at.with_timezone(&chrono::Utc)).num_seconds();
                if seconds < 60 {
                    "Updated just now".to_string()
                } else {
                    format!(
                        "Updated {} ago",
                        vitre_state::usage_limits::format_remaining(seconds)
                    )
                }
            });
        let header = h_flex()
            .gap_2()
            .items_center()
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .text_sm()
                    .font_semibold()
                    .text_color(cx.theme().foreground)
                    .child(provider_heading(limits)),
            )
            .children(updated.map(|updated| {
                div()
                    .flex_shrink_0()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(updated)
            }))
            .children(dashboard.map(|url| {
                Button::new(SharedString::from(format!(
                    "usage-open-{}",
                    limits.instance_id.0
                )))
                .ghost()
                .xsmall()
                .icon(Icon::new(IconName::ExternalLink))
                .tooltip("Open the provider's usage page")
                .on_click(move |_, _, cx| cx.open_url(&url))
            }));

        let mut section = v_flex().gap_3().child(header);
        if let Some(reached) = defined2(&limits.limit_reached) {
            section = section.child(
                h_flex()
                    .gap_1p5()
                    .items_start()
                    .text_xs()
                    .text_color(cx.theme().danger)
                    .child(
                        Icon::new(VitreIcon::CircleAlert)
                            .size_3p5()
                            .flex_shrink_0()
                            .mt_0p5(),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .whitespace_normal()
                            .child(chat_text(format!("Limit reached: {}", reached.message.0))),
                    ),
            );
        }
        if limits.windows.is_empty() {
            let note = defined2(&limits.note)
                .map(|note| note.0.clone())
                .unwrap_or_else(|| {
                    if limits.reports_windows {
                        "Limits appear after the next turn with this provider.".into()
                    } else {
                        "This provider doesn't report plan limits.".into()
                    }
                });
            section = section.child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .whitespace_normal()
                    .child(note),
            );
        }
        for window in &limits.windows {
            section = section.child(render_window(window, now, cx));
        }
        section.into_any_element()
    }
}

/// `Current session` / bar + `41% used` / `Resets 3:40pm (in 2h 10m)`.
fn render_window(
    window: &UsageLimitWindow,
    now: chrono::DateTime<chrono::Utc>,
    cx: &App,
) -> AnyElement {
    let percent = used_percent(window);
    let fill = percent.unwrap_or(if is_exceeded(window) { 100.0 } else { 0.0 });
    let used = match percent {
        Some(percent) => format!("{}% used", percent.round() as i64),
        None if is_exceeded(window) => "Limit reached".into(),
        None if matches!(window.status, UsageLimitStatus::Warning) => "Nearing limit".into(),
        None => "Within limit".into(),
    };
    let color = bar_color(window, cx);
    v_flex()
        .gap_1()
        .child(
            div()
                .text_sm()
                .text_color(cx.theme().foreground)
                .child(chat_text(window.label.0.clone())),
        )
        .child(
            h_flex()
                .gap_3()
                .items_center()
                .child(
                    div()
                        .flex_1()
                        .h(px(8.))
                        .rounded_full()
                        .bg(cx.theme().muted)
                        .border_1()
                        .border_color(cx.theme().border.opacity(0.6))
                        .child(
                            div()
                                .h_full()
                                .rounded_full()
                                .bg(color)
                                .w(relative((fill / 100.0).clamp(0.0, 1.0) as f32)),
                        ),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .min_w(px(72.))
                        .text_right()
                        .text_xs()
                        .text_color(if is_exceeded(window) {
                            cx.theme().danger
                        } else {
                            cx.theme().foreground.opacity(0.82)
                        })
                        .child(used),
                ),
        )
        .children(resets_at(window).map(|reset| {
            div()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(reset_label(reset, now))
        }))
        .into_any_element()
}
