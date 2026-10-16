use super::*;
use vitre_contracts::{CloudPublication, CloudPublicationState};
#[cfg(test)]
pub(crate) fn usage_label(usage: &vitre_contracts::CloudUsageSummary) -> String {
    let spent = store::dollars(usage.spent_micro_dollars);
    let limit = store::dollars(usage.limit_micro_dollars);
    if usage.reserved_micro_dollars > 0 {
        format!(
            "{spent} used · {} held · {limit} limit",
            store::dollars(usage.reserved_micro_dollars)
        )
    } else {
        format!("{spent} used of {limit} this month")
    }
}

/// Time since an ISO timestamp, compact ("48s", "3m 05s", "1h 12m").
#[cfg(test)]
pub(crate) fn elapsed_since(iso: &str) -> Option<String> {
    let then = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    let seconds = chrono::Utc::now()
        .signed_duration_since(then.with_timezone(&chrono::Utc))
        .num_seconds()
        .max(0);
    Some(if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h {:02}m", seconds / 3600, (seconds % 3600) / 60)
    })
}

/// Still consuming a worker (or about to).
pub(crate) fn is_active(state: &CloudTaskState) -> bool {
    matches!(
        state,
        CloudTaskState::Queued
            | CloudTaskState::Preparing
            | CloudTaskState::Running
            | CloudTaskState::WaitingForInput
    )
}

/// Blocked on the user rather than on the worker.
pub(crate) fn needs_attention(state: &CloudTaskState) -> bool {
    matches!(
        state,
        CloudTaskState::WaitingForInput | CloudTaskState::NeedsAuth | CloudTaskState::UsageLimited
    )
}

pub(crate) fn provider_label(provider: &CloudProvider) -> &'static str {
    match provider {
        CloudProvider::Codex => "Codex",
        CloudProvider::Claude => "Claude",
        CloudProvider::Unknown(_) => "Provider",
    }
}

pub(crate) fn provider_icon(provider: &CloudProvider, cx: &App) -> Icon {
    crate::icons::provider_icon(
        match provider {
            CloudProvider::Codex => "codex",
            CloudProvider::Claude => "claudeAgent",
            CloudProvider::Unknown(_) => "",
        },
        cx,
    )
}

/// A task's one-line title: the first line of its prompt, trimmed.
pub(crate) fn task_title(task: &CloudTask, max: usize) -> String {
    let prompt = crate::chat::displayed_user_prompt(&task.prompt);
    let title = task
        .title
        .as_deref()
        .filter(|title| !title.starts_with("<vitre_ask_mode>"));
    let line = title
        .unwrap_or(prompt)
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("Untitled task");
    let line = line.trim();
    if line.chars().count() > max {
        let mut out: String = line.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    } else {
        line.to_owned()
    }
}

pub(crate) fn repo_label(task: &CloudTask) -> String {
    format!("{}/{}", task.repository.owner, task.repository.name)
}

pub(crate) fn render_publication_chip(
    publication: &CloudPublication,
    task_id: &str,
    cx: &App,
) -> AnyElement {
    let (color, label): (Hsla, String) = match publication.state {
        CloudPublicationState::Published => (
            cx.theme().success,
            match publication.kind {
                vitre_contracts::CloudPublicationKind::PullRequest => "PR opened".into(),
                _ => "Comment posted".into(),
            },
        ),
        CloudPublicationState::Queued | CloudPublicationState::Publishing => {
            (cx.theme().info, "Publishing…".into())
        }
        _ => (cx.theme().danger, "Publish failed".into()),
    };
    let mut chip = h_flex()
        .gap_1()
        .items_center()
        .child(div().size(px(6.)).rounded_full().bg(color))
        .child(label);
    if let Some(url) = publication.url.clone() {
        let open = url.clone();
        chip = chip.child(
            Button::new(SharedString::from(format!("pub-open-{}", publication.id)))
                .link()
                .xsmall()
                .label(url)
                .on_click(move |_, _, cx| cx.open_url(&open)),
        );
    }
    if matches!(publication.state, CloudPublicationState::Failed) {
        let id = publication.id.clone();
        let task_id = task_id.to_owned();
        chip = chip.child(
            Button::new(SharedString::from(format!("pub-retry-{}", publication.id)))
                .outline()
                .xsmall()
                .label("Retry")
                .on_click(move |_, _, cx| {
                    let store = CloudStore::global(cx);
                    store.update(cx, |store, cx| {
                        store.retry_publication(task_id.clone(), id.clone(), cx)
                    });
                }),
        );
    }
    Tag::custom(color.opacity(0.1), color, color.opacity(0.25))
        .small()
        .rounded_full()
        .child(chip)
        .into_any_element()
}

pub(crate) fn onboarding_card(
    icon: IconName,
    title: &'static str,
    body: &'static str,
    actions: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
    v_flex()
        .gap_4()
        .p_5()
        .rounded_xl()
        .border_1()
        .border_color(cx.theme().border)
        .bg(crate::glass::control(cx))
        .child(
            h_flex()
                .gap_3()
                .items_start()
                .child(
                    div()
                        .flex_shrink_0()
                        .size_9()
                        .rounded_lg()
                        .bg(cx.theme().muted)
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(Icon::new(icon).size_4()),
                )
                .child(
                    v_flex()
                        .gap_1()
                        .min_w_0()
                        .child(div().text_base().font_semibold().child(title))
                        .child(
                            div()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(body),
                        ),
                ),
        )
        .children(actions)
        .into_any_element()
}

/// The device-code step of a Codex login, with the code big enough to read
/// across the room.
pub(crate) fn render_codex_login(
    login: &vitre_contracts::CloudLoginStatus,
    cx: &App,
) -> AnyElement {
    use vitre_contracts::CloudLoginStatusState as S;
    let code = login.user_code.as_ref().map(|c| c.0.clone());
    let url = login.verification_url.as_ref().map(|u| u.0.clone());
    let status: AnyElement = match &login.state {
        S::Completed => div()
            .text_xs()
            .text_color(cx.theme().success)
            .child("Codex connected.")
            .into_any_element(),
        S::Failed => div()
            .text_xs()
            .text_color(cx.theme().danger)
            .child(
                login
                    .error
                    .as_ref()
                    .map(|e| e.0.clone())
                    .unwrap_or_else(|| "Codex login failed. Try again.".into()),
            )
            .into_any_element(),
        _ => div()
            .text_xs()
            .text_color(cx.theme().muted_foreground)
            .child("Enter this code on the Codex page, then come back; the account connects on its own.")
            .into_any_element(),
    };
    h_flex()
        .gap_3()
        .items_center()
        .flex_wrap()
        .when_some(code, |row, code| {
            row.child(
                div()
                    .px_2p5()
                    .py_1()
                    .rounded_md()
                    .bg(cx.theme().muted)
                    .font_family("monospace")
                    .text_base()
                    .font_semibold()
                    .child(code),
            )
        })
        .when_some(url, |row, url| {
            row.child(
                Button::new("cloud-codex-open")
                    .outline()
                    .xsmall()
                    .icon(IconName::ExternalLink)
                    .label("Open Codex")
                    .on_click(move |_, _, cx| cx.open_url(&url)),
            )
        })
        .child(div().flex_1().min_w_0().child(status))
        .when(matches!(login.state, S::Completed | S::Failed), |row| {
            row.child(
                Button::new("cloud-codex-dismiss")
                    .ghost()
                    .xsmall()
                    .icon(IconName::Close)
                    .on_click(|_, _, cx| {
                        CloudStore::global(cx).update(cx, |store, cx| store.dismiss_login(cx))
                    }),
            )
        })
        .into_any_element()
}
