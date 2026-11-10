//! Plan limits for the dock's Usage surface and the limit warnings.
//!
//! The server streams one `ProviderUsageLimits` per provider instance. This
//! module decides which warnings a new snapshot deserves (each threshold once
//! per window and reset period) and formats reset times the way Claude Code's
//! `/usage` does ("Resets 3:40pm (in 2h 10m)").

use std::collections::HashSet;

use chrono::{DateTime, Local, Utc};
use vitre_contracts::generated::{ProviderUsageLimits, UsageLimitStatus, UsageLimitWindow};

use crate::wire_opt::defined2;

/// Used shares that raise a warning, lowest first.
pub const WARNING_THRESHOLDS: [u8; 2] = [80, 95];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageAlertLevel {
    Warning,
    Exceeded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageAlert {
    pub level: UsageAlertLevel,
    pub title: String,
    pub message: String,
}

pub fn used_percent(window: &UsageLimitWindow) -> Option<f64> {
    defined2(&window.used_percent).and_then(|value| value.as_millis_f64())
}

pub fn resets_at(window: &UsageLimitWindow) -> Option<DateTime<Utc>> {
    defined2(&window.resets_at)
        .and_then(|value| DateTime::parse_from_rfc3339(&value.0).ok())
        .map(|time| time.with_timezone(&Utc))
}

pub fn is_exceeded(window: &UsageLimitWindow) -> bool {
    matches!(window.status, UsageLimitStatus::Exceeded)
        || used_percent(window).is_some_and(|percent| percent >= 100.0)
}

/// `2h 10m`, `3d 4h`, `12m`, `under a minute`.
pub fn format_remaining(seconds: i64) -> String {
    if seconds < 60 {
        return "under a minute".into();
    }
    let minutes = seconds / 60;
    let (days, hours, mins) = (minutes / 1_440, (minutes / 60) % 24, minutes % 60);
    if days > 0 {
        if hours > 0 {
            format!("{days}d {hours}h")
        } else {
            format!("{days}d")
        }
    } else if hours > 0 {
        if mins > 0 {
            format!("{hours}h {mins}m")
        } else {
            format!("{hours}h")
        }
    } else {
        format!("{mins}m")
    }
}

fn clock(time: DateTime<Local>) -> String {
    time.format("%-I:%M%P").to_string().replace(":00", "")
}

/// "Resets 3:40pm (in 2h 10m)" today, "Resets Thu 9am (in 2d 4h)" later.
pub fn reset_label(resets: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let remaining = (resets - now).num_seconds();
    if remaining <= 0 {
        return "Resetting now".into();
    }
    let local = resets.with_timezone(&Local);
    let same_day = local.date_naive() == now.with_timezone(&Local).date_naive();
    let when = if same_day {
        clock(local)
    } else if remaining < 7 * 86_400 {
        format!("{} {}", local.format("%a"), clock(local))
    } else {
        format!("{} {}", local.format("%b %-d"), clock(local))
    };
    format!("Resets {when} (in {})", format_remaining(remaining))
}

/// The provider's heading: `Claude · Max`.
pub fn provider_heading(limits: &ProviderUsageLimits) -> String {
    match defined2(&limits.plan_label) {
        Some(plan) => format!("{} · {}", limits.display_name.0, plan.0),
        None => limits.display_name.0.clone(),
    }
}

/// Remembers which warnings were shown, so a threshold alerts once per
/// window and reset period. The first snapshot only seeds it: limits restored
/// from disk at launch are old news.
#[derive(Debug, Default)]
pub struct UsageAlertTracker {
    seeded: bool,
    shown: HashSet<String>,
}

impl UsageAlertTracker {
    pub fn observe(&mut self, all: &[ProviderUsageLimits]) -> Vec<UsageAlert> {
        let mut alerts = Vec::new();
        for limits in all {
            let provider = provider_heading(limits);
            for window in &limits.windows {
                let period = defined2(&window.resets_at)
                    .map(|reset| reset.0.as_str())
                    .unwrap_or("");
                let key = |what: &str| {
                    format!(
                        "{}\u{1f}{}\u{1f}{period}\u{1f}{what}",
                        limits.instance_id.0, window.id.0
                    )
                };
                let reset = resets_at(window)
                    .map(|reset| format!(" {}.", reset_label(reset, Utc::now())))
                    .unwrap_or_default();
                if is_exceeded(window) {
                    if self.shown.insert(key("exceeded")) && self.seeded {
                        alerts.push(UsageAlert {
                            level: UsageAlertLevel::Exceeded,
                            title: format!("{provider} limit reached"),
                            message: format!("{} is used up.{reset}", window.label.0),
                        });
                    }
                    continue;
                }
                let Some(percent) = used_percent(window) else {
                    continue;
                };
                // Only the highest threshold crossed alerts; lower ones are marked shown.
                let crossed: Vec<u8> = WARNING_THRESHOLDS
                    .iter()
                    .copied()
                    .filter(|threshold| percent >= f64::from(*threshold))
                    .collect();
                let mut fresh = None;
                for threshold in &crossed {
                    if self.shown.insert(key(&threshold.to_string())) {
                        fresh = Some(*threshold);
                    }
                }
                if let (Some(_), true) = (fresh, self.seeded) {
                    alerts.push(UsageAlert {
                        level: UsageAlertLevel::Warning,
                        title: format!("{provider} usage at {}%", percent.round() as i64),
                        message: format!(
                            "{} is {}% used.{reset}",
                            window.label.0,
                            percent.round() as i64
                        ),
                    });
                }
            }
            if let Some(reached) = defined2(&limits.limit_reached) {
                let key = format!(
                    "{}\u{1f}reached\u{1f}{}",
                    limits.instance_id.0, reached.at.0
                );
                if self.shown.insert(key) && self.seeded {
                    alerts.push(UsageAlert {
                        level: UsageAlertLevel::Exceeded,
                        title: format!("{provider} limit reached"),
                        message: reached.message.0.clone(),
                    });
                }
            }
        }
        self.seeded = true;
        alerts
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn limits(windows: serde_json::Value, extra: serde_json::Value) -> ProviderUsageLimits {
        let mut value = json!({
            "instanceId": "claudeAgent",
            "driver": "claudeAgent",
            "displayName": "Claude",
            "planLabel": "Max",
            "reportsWindows": true,
            "windows": windows,
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    fn window(percent: f64) -> serde_json::Value {
        json!([{
            "id": "five_hour",
            "label": "Current session",
            "usedPercent": percent,
            "resetsAt": "2100-01-01T00:00:00.000Z",
            "status": if percent >= 80.0 { "warning" } else { "ok" },
        }])
    }

    #[test]
    fn warns_once_per_threshold_after_seeding() {
        let mut tracker = UsageAlertTracker::default();
        assert!(
            tracker
                .observe(&[limits(window(85.0), json!({}))])
                .is_empty()
        );
        assert!(
            tracker
                .observe(&[limits(window(88.0), json!({}))])
                .is_empty()
        );
        let alerts = tracker.observe(&[limits(window(96.0), json!({}))]);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].title, "Claude · Max usage at 96%");
        assert!(
            alerts[0]
                .message
                .starts_with("Current session is 96% used. Resets ")
        );
        assert!(
            tracker
                .observe(&[limits(window(97.0), json!({}))])
                .is_empty()
        );
    }

    #[test]
    fn a_jump_past_both_thresholds_alerts_once() {
        let mut tracker = UsageAlertTracker::default();
        tracker.observe(&[limits(window(10.0), json!({}))]);
        assert_eq!(tracker.observe(&[limits(window(99.0), json!({}))]).len(), 1);
    }

    #[test]
    fn exceeded_windows_and_limit_failures_alert() {
        let mut tracker = UsageAlertTracker::default();
        tracker.observe(&[limits(window(50.0), json!({}))]);
        let alerts = tracker.observe(&[limits(
            window(100.0),
            json!({ "limitReached": { "at": "2026-11-10T12:00:00Z", "message": "Usage limit hit" } }),
        )]);
        assert_eq!(
            alerts.iter().map(|alert| alert.level).collect::<Vec<_>>(),
            [UsageAlertLevel::Exceeded, UsageAlertLevel::Exceeded]
        );
        assert_eq!(alerts[1].message, "Usage limit hit");
    }

    #[test]
    fn formats_remaining_time_like_claude_code() {
        assert_eq!(format_remaining(30), "under a minute");
        assert_eq!(format_remaining(12 * 60), "12m");
        assert_eq!(format_remaining(2 * 3600 + 10 * 60), "2h 10m");
        assert_eq!(format_remaining(3 * 86_400 + 4 * 3600), "3d 4h");
        let now = Utc::now();
        assert_eq!(
            reset_label(now - chrono::Duration::minutes(1), now),
            "Resetting now"
        );
        assert!(reset_label(now + chrono::Duration::hours(30), now).ends_with("(in 1d 6h)"));
    }
}
