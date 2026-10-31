//! Account-wide Lens surface. Model output can only propose cleanup; the user approves a card.
use gpui::{prelude::FluentBuilder as _, *};
use gpui_component::{
    ActiveTheme as _, Disableable as _, Icon, IconName, Selectable as _, Sizable as _,
    StyledExt as _, WindowExt as _,
    button::{Button, ButtonVariants as _},
    command::{Command, CommandItem, CommandState},
    h_flex,
    input::{Input, InputEvent, InputState},
    scroll::ScrollableElement as _,
    text::{TextView, TextViewState},
    v_flex,
};
use gpui_tokio::Tokio;
use std::{collections::HashMap, sync::Arc, time::Duration};
use vitre_client::{EnvironmentClient, cloud::CloudClient};
use vitre_contracts::{
    LensCommand, LensCommandDecideDecision, LensModel, LensOverview, LensRecommendation,
    LensRecommendationKind, LensRecommendationStatus, LensScheduleFrequency, LensSettings,
};

pub(crate) struct LensOpenTarget {
    pub source: String,
    pub target: String,
}
pub(crate) struct LensPanel {
    cloud: Option<CloudClient>,
    data: Option<LensOverview>,
    error: Option<String>,
    busy: bool,
    retry: Option<LensCommand>,
    input: Entity<InputState>,
    form: Option<LensForm>,
    _poll: Option<Task<()>>,
    _submit: Subscription,
    scroll: ScrollHandle,
    tab: LensTab,
    rows: Vec<ReviewRow>,
    review_list: ListState,
    chat_list: ListState,
    markdown: HashMap<String, (Entity<TextViewState>, Subscription)>,
    show_history: bool,
}
#[derive(Clone, Copy, PartialEq)]
enum LensTab {
    Review,
    Chat,
}
#[derive(Clone)]
enum ReviewRow {
    Summary,
    Section(&'static str, usize),
    Action(usize),
    Empty,
    Footer,
}
struct LensForm {
    revision: i64,
    settings: LensSettings,
    time: Entity<InputState>,
    zone: Entity<InputState>,
    conversation_days: Entity<InputState>,
    project_days: Entity<InputState>,
}
impl EventEmitter<LensOpenTarget> for LensPanel {}

fn key() -> String {
    format!(
        "lens-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    )
}
fn input(value: &str, placeholder: &str, window: &mut Window, cx: &mut App) -> Entity<InputState> {
    cx.new(|cx| {
        InputState::new(window, cx)
            .default_value(value)
            .placeholder(placeholder)
    })
}
fn time_label(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|at| {
            at.with_timezone(&chrono::Local)
                .format("%a %d %b, %H:%M")
                .to_string()
        })
        .unwrap_or_else(|_| value.to_owned())
}
impl LensPanel {
    pub(crate) fn new(
        client: Option<Arc<EnvironmentClient>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let composer = input(
            "",
            "Ask Lens about your week, follow-ups, or cleanup…",
            window,
            cx,
        );
        let submit = cx.subscribe_in(
            &composer,
            window,
            |panel, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. })
                    && !panel.data.as_ref().is_some_and(|data| data.running)
                {
                    panel.send(window, cx);
                }
            },
        );
        let mut panel = Self {
            cloud: client.map(CloudClient::new),
            data: None,
            error: None,
            busy: false,
            retry: None,
            input: composer,
            form: None,
            _poll: None,
            _submit: submit,
            scroll: ScrollHandle::new(),
            tab: LensTab::Review,
            rows: Vec::new(),
            review_list: ListState::new(0, ListAlignment::Top, px(300.)),
            chat_list: ListState::new(0, ListAlignment::Top, px(300.)),
            markdown: HashMap::new(),
            show_history: false,
        };
        panel.chat_list.set_follow_mode(FollowMode::Tail);
        panel.poll(cx);
        panel
    }
    pub(crate) fn attach(&mut self, client: Arc<EnvironmentClient>, cx: &mut Context<Self>) {
        if self.cloud.is_none() {
            self.cloud = Some(CloudClient::new(client));
            self.poll(cx);
        }
    }
    fn accept(&mut self, data: LensOverview) -> bool {
        if self
            .data
            .as_ref()
            .is_some_and(|current| data.revision < current.revision || *current == data)
        {
            return false;
        }
        if self
            .data
            .as_ref()
            .is_none_or(|current| current.messages != data.messages)
        {
            let old_messages = self.chat_list.item_count();
            self.chat_list.splice(0..old_messages, data.messages.len());
        }
        self.markdown
            .retain(|id, _| data.messages.iter().any(|message| &message.id == id));
        self.data = Some(data);
        self.rebuild_review();
        true
    }
    fn rebuild_review(&mut self) {
        self.rows = vec![ReviewRow::Summary];
        if let Some(data) = &self.data {
            for (title, cleanup) in [("Needs your attention", false), ("Room to tidy up", true)] {
                let actions: Vec<_> = data
                    .recommendations
                    .iter()
                    .enumerate()
                    .filter(|(_, action)| {
                        is_cleanup(action) == cleanup
                            && matches!(
                                action.status,
                                LensRecommendationStatus::Pending
                                    | LensRecommendationStatus::Approved
                                    | LensRecommendationStatus::Failed
                                    | LensRecommendationStatus::Stale
                            )
                    })
                    .map(|(index, _)| index)
                    .collect();
                if !actions.is_empty() {
                    self.rows.push(ReviewRow::Section(title, actions.len()));
                    self.rows.extend(actions.into_iter().map(ReviewRow::Action));
                }
            }
            if self.rows.len() == 1 {
                self.rows.push(ReviewRow::Empty);
            }
            if self.show_history {
                let done: Vec<_> = data
                    .recommendations
                    .iter()
                    .enumerate()
                    .filter(|(_, a)| {
                        matches!(
                            a.status,
                            LensRecommendationStatus::Applied | LensRecommendationStatus::Dismissed
                        )
                    })
                    .map(|(i, _)| i)
                    .collect();
                if !done.is_empty() {
                    self.rows
                        .push(ReviewRow::Section("Recently handled", done.len()));
                    self.rows.extend(done.into_iter().map(ReviewRow::Action));
                }
            }
            self.rows.push(ReviewRow::Footer);
        }
        self.review_list
            .splice(0..self.review_list.item_count(), self.rows.len());
    }
    fn poll(&mut self, cx: &mut Context<Self>) {
        let Some(cloud) = self.cloud.clone() else {
            self.error = Some("Waiting for the desktop service.".into());
            return;
        };
        self._poll = Some(cx.spawn(async move |this, cx| {
            loop {
                let cloud = cloud.clone();
                let response = cx
                    .update(|cx| Tokio::spawn_result(cx, async move { Ok(cloud.lens().await?) }))
                    .await;
                if this
                    .update(cx, |panel, cx| {
                        let previous_error = panel.error.clone();
                        let changed = match response {
                            Ok(data) => {
                                if panel.retry.is_none() {
                                    panel.error = None;
                                }
                                panel.accept(data)
                            }
                            Err(error) => {
                                panel.error = Some(error.to_string());
                                false
                            }
                        };
                        if changed || panel.error != previous_error {
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    return;
                }
                cx.background_executor().timer(Duration::from_secs(8)).await;
            }
        }));
    }
    fn request(&mut self, command: LensCommand, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(cloud) = self.cloud.clone() else {
            return;
        };
        if matches!(command, LensCommand::Chat { .. }) {
            self.tab = LensTab::Chat;
        }
        self.busy = true;
        self.error = None;
        self.retry = Some(command.clone());
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let sent = command.clone();
            let Ok(task) = cx.update(|_, cx| {
                Tokio::spawn_result(cx, async move { Ok(cloud.lens_command(&sent).await?) })
            }) else {
                return;
            };
            let result = task.await;
            let _ = this.update_in(cx, |panel, window, cx| {
                panel.busy = false;
                match result {
                    Ok(data) => {
                        panel.accept(data);
                        panel.retry = None;
                        if matches!(command, LensCommand::Chat { .. }) {
                            panel
                                .input
                                .update(cx, |input, cx| input.set_value("", window, cx));
                        }
                        if matches!(command, LensCommand::SettingsUpdate { .. }) {
                            panel.form = None;
                        }
                    }
                    Err(error) => panel.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let message = self.input.read(cx).value().trim().to_owned();
        if !message.is_empty() && self.retry.is_none() {
            self.request(
                LensCommand::Chat {
                    idempotency_key: key(),
                    message,
                },
                window,
                cx,
            );
        }
    }
    fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(data) = &self.data else {
            return;
        };
        let settings = data.settings.clone();
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.form = Some(LensForm {
            revision: data.settings_revision,
            time: input(
                &format!(
                    "{:02}:{:02}",
                    settings.schedule.hour, settings.schedule.minute
                ),
                "09:00",
                window,
                cx,
            ),
            zone: input(&settings.schedule.time_zone, "Africa/Lagos", window, cx),
            conversation_days: input(
                &settings.stale_conversation_days.to_string(),
                "14",
                window,
                cx,
            ),
            project_days: input(&settings.stale_project_days.to_string(), "30", window, cx),
            settings,
        });
        cx.notify();
    }
    fn save_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = &self.form else {
            return;
        };
        let mut settings = form.settings.clone();
        let value = form.time.read(cx).value().to_string();
        let parts: Vec<_> = value.split(':').collect();
        let numbers = (
            parts.first().and_then(|n| n.parse::<i64>().ok()),
            parts.get(1).and_then(|n| n.parse::<i64>().ok()),
            form.conversation_days.read(cx).value().parse::<i64>().ok(),
            form.project_days.read(cx).value().parse::<i64>().ok(),
        );
        let (Some(hour), Some(minute), Some(conversation_days), Some(project_days)) = numbers
        else {
            self.error = Some("Use HH:MM for the time and whole numbers for days.".into());
            cx.notify();
            return;
        };
        if !(0..24).contains(&hour)
            || !(0..60).contains(&minute)
            || !(1..=365).contains(&conversation_days)
            || !(1..=730).contains(&project_days)
        {
            self.error =
                Some("Use a valid time, 1–365 conversation days, and 1–730 project days.".into());
            cx.notify();
            return;
        }
        settings.schedule.hour = hour;
        settings.schedule.minute = minute;
        settings.schedule.time_zone = form.zone.read(cx).value().trim().to_owned();
        settings.stale_conversation_days = conversation_days;
        settings.stale_project_days = project_days;
        self.request(
            LensCommand::SettingsUpdate {
                idempotency_key: key(),
                expected_revision: form.revision,
                settings,
            },
            window,
            cx,
        );
    }
    fn choose_model(&self, window: &mut Window, cx: &mut Context<Self>) {
        let models = self
            .data
            .as_ref()
            .map(|data| data.models.clone())
            .unwrap_or_default();
        let owner = cx.weak_entity();
        let state = cx.new(|cx| CommandState::new(window, cx));
        let focus = state.clone();
        window.open_dialog(cx, move |dialog, _, _| {
            let models = models.clone();
            let owner = owner.clone();
            let state = state.clone();
            dialog
                .close_button(false)
                .p_0()
                .w(px(576.))
                .content(move |content, _, _| {
                    let mut items = vec![CommandItem::new().label("Most used connected model")];
                    items.extend(models.iter().map(|model| {
                        CommandItem::new().label(format!(
                            "{} · {}",
                            model.model,
                            match model.provider {
                                vitre_contracts::LensModelProvider::Claude => "Claude",
                                _ => "Codex",
                            }
                        ))
                    }));
                    let models = models.clone();
                    let owner = owner.clone();
                    content.child(
                        Command::new(&state)
                            .bordered(false)
                            .placeholder("Search models…")
                            .cancel_clears_query(false)
                            .max_h(px(300.))
                            .header(|_, _, cx| {
                                div()
                                    .px_3()
                                    .pt_3()
                                    .pb_1()
                                    .text_sm()
                                    .text_color(cx.theme().muted_foreground)
                                    .child("Lens model")
                            })
                            .empty(|_, _, cx| {
                                div()
                                    .px_4()
                                    .py_8()
                                    .text_sm()
                                    .text_color(cx.theme().muted_foreground)
                                    .child("No models match your search.")
                            })
                            .footer(|_, _, cx| {
                                crate::palette::chrome::footer(cx)
                                    .child(crate::palette::chrome::key_hint("↑↓", "navigate", cx))
                                    .child(crate::palette::chrome::key_hint("↵", "select", cx))
                                    .child(crate::palette::chrome::key_hint("esc", "close", cx))
                            })
                            .items(items)
                            .on_confirm(move |index, window, cx| {
                                let model: Option<LensModel> = index
                                    .row
                                    .checked_sub(1)
                                    .and_then(|i| models.get(i).cloned());
                                let _ = owner.update(cx, |panel, cx| {
                                    if let Some(form) = &mut panel.form {
                                        form.settings.model = model;
                                    }
                                    cx.notify();
                                });
                                window.close_dialog(cx);
                            })
                            .on_cancel(|window, cx| window.close_dialog(cx)),
                    )
                })
        });
        window.defer(cx, move |window, cx| {
            focus.update(cx, |state, cx| state.focus(window, cx))
        });
    }
    fn approve(&self, action: LensRecommendation, window: &mut Window, cx: &mut Context<Self>) {
        let project = action.kind == LensRecommendationKind::RemoveProject;
        let owner = cx.weak_entity();
        let description = format!(
            "{}\n\n{}{}",
            action.title.0,
            if project {
                "This removes the project, its conversations, and saved cloud snapshots from Vitre. Repository and desktop files stay in place. This cannot be undone in Vitre."
            } else {
                "This hides the conversation from your active list. You can restore it from the archive."
            },
            if action.source_id == "cloud" {
                ""
            } else {
                "\n\nYour desktop will apply this when it connects, if the item is still unchanged."
            }
        );
        window.open_alert_dialog(cx, move |dialog, _, _| {
            let owner = owner.clone();
            let action = action.clone();
            dialog
                .confirm()
                .title(if project {
                    "Remove this project?"
                } else {
                    "Archive this conversation?"
                })
                .description(description.clone())
                .button_props(
                    gpui_component::dialog::DialogButtonProps::default()
                        .show_cancel(true)
                        .ok_text(if project { "Remove project" } else { "Archive" }),
                )
                .on_ok(move |_, window, cx| {
                    let _ = owner.update(cx, |panel, cx| {
                        panel.request(
                            LensCommand::Decide {
                                idempotency_key: key(),
                                recommendation_id: action.id.clone(),
                                decision: LensCommandDecideDecision::Approve,
                            },
                            window,
                            cx,
                        )
                    });
                    true
                })
        });
    }

    fn render_form(&self, cx: &mut Context<Self>) -> AnyElement {
        let form = self.form.as_ref().unwrap();
        let weekly = form.settings.schedule.frequency == LensScheduleFrequency::Weekly;
        let fields = [
            ("Time", &form.time),
            ("Time zone", &form.zone),
            ("Inactive conversation days", &form.conversation_days),
            ("Stale project days", &form.project_days),
        ];
        v_flex().gap_3().p_4().rounded_lg().bg(crate::glass::control(cx))
            .child(h_flex().gap_2().child(div().flex_1().child("Schedule & model"))
                .child(Button::new("lens-enabled").small().outline().label(if form.settings.enabled { "Scheduled reviews on" } else { "Scheduled reviews off" }).on_click(cx.listener(|panel, _, _, cx| { if let Some(form) = &mut panel.form { form.settings.enabled = !form.settings.enabled; } cx.notify(); }))))
            .child(div().text_xs().text_color(cx.theme().muted_foreground).child("Lens uses project titles and recent conversation excerpts from your connected workspaces for reviews. Cleanup always needs approval."))
            .child(h_flex().gap_2().child(Button::new("lens-frequency").small().outline().label(if weekly { "Weekly" } else { "Daily" }).on_click(cx.listener(|panel, _, _, cx| { if let Some(form) = &mut panel.form { form.settings.schedule.frequency = if form.settings.schedule.frequency == LensScheduleFrequency::Weekly { LensScheduleFrequency::Daily } else { LensScheduleFrequency::Weekly }; } cx.notify(); })))
                .when(weekly, |row| row.children(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].iter().enumerate().map(|(i, label)| Button::new(format!("lens-day-{i}")).xsmall().when(form.settings.schedule.weekday == i as i64, |b| b.primary()).label(*label).on_click(cx.listener(move |panel, _, _, cx| { if let Some(form) = &mut panel.form { form.settings.schedule.weekday = i as i64; } cx.notify(); }))))))
            .children(fields.iter().map(|(label, field)| v_flex().gap_1().child(div().text_xs().text_color(cx.theme().muted_foreground).child(*label)).child(Input::new(field))))
            .child(Button::new("lens-model").small().outline().label(form.settings.model.as_ref().map(|model| model.model.clone()).unwrap_or_else(|| "Most used connected model".into())).on_click(cx.listener(|panel, _, window, cx| panel.choose_model(window, cx))))
            .child(h_flex().gap_2().child(Button::new("lens-save").small().primary().label("Save").disabled(self.busy || self.retry.is_some()).on_click(cx.listener(|panel, _, window, cx| panel.save_settings(window, cx))))
                .child(Button::new("lens-cancel-settings").small().ghost().label("Cancel").on_click(cx.listener(|panel, _, _, cx| { panel.form = None; cx.notify(); }))))
            .into_any_element()
    }
}

fn is_cleanup(action: &LensRecommendation) -> bool {
    matches!(
        action.kind,
        LensRecommendationKind::ArchiveConversation | LensRecommendationKind::RemoveProject
    )
}
fn action_label(action: &LensRecommendation) -> &'static str {
    match action.kind {
        LensRecommendationKind::Unread => "Unread reply",
        LensRecommendationKind::FollowUp => "Waiting for you",
        LensRecommendationKind::ArchiveConversation => "Inactive conversation",
        LensRecommendationKind::RemoveProject => "Stale project",
        _ => "Recommendation",
    }
}
fn column() -> Div {
    div().w_full().max_w(px(840.)).px_8()
}
impl LensPanel {
    fn switch_tab(&mut self, tab: LensTab, window: &mut Window, cx: &mut Context<Self>) {
        self.tab = tab;
        self.form = None;
        if tab == LensTab::Chat {
            self.input.update(cx, |input, cx| input.focus(window, cx));
        }
        cx.notify();
    }
    fn render_summary(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(data) = &self.data else {
            return div().child("Loading your review…").into_any_element();
        };
        let count = |kind| {
            data.recommendations
                .iter()
                .filter(|a| a.kind == kind && a.status == LensRecommendationStatus::Pending)
                .count()
        };
        let unread = count(LensRecommendationKind::Unread);
        let follow_up = count(LensRecommendationKind::FollowUp);
        let cleanup = count(LensRecommendationKind::ArchiveConversation)
            + count(LensRecommendationKind::RemoveProject);
        let peak = data
            .activity
            .iter()
            .map(|day| day.conversations)
            .max()
            .unwrap_or(1)
            .max(1) as f32;
        let active: i64 = data.activity.iter().map(|day| day.conversations).sum();
        let latest = data
            .messages
            .iter()
            .rev()
            .find(|m| m.role == vitre_contracts::LensMessageRole::Assistant);
        let summary = latest.map(|message| {
            message
                .text
                .split("```")
                .next()
                .unwrap_or("")
                .split("\n\n")
                .next()
                .unwrap_or("")
                .replace("**", "")
                .chars()
                .take(320)
                .collect::<String>()
        });
        v_flex()
            .gap_5()
            .pt_8()
            .pb_4()
            .child(
                h_flex()
                    .gap_6()
                    .items_start()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_2()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child("ACROSS YOUR WORKSPACE"),
                            )
                            .child(
                                div()
                                    .text_2xl()
                                    .font_semibold()
                                    .child("Your week, in focus."),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(if data.running {
                                        "Lens is reviewing your work…".to_owned()
                                    } else {
                                        data.last_run_at
                                            .as_ref()
                                            .map(|at| format!("Last reviewed {}", time_label(at)))
                                            .unwrap_or_else(|| {
                                                "A little perspective on what needs you next."
                                                    .into()
                                            })
                                    }),
                            ),
                    )
                    .child(
                        v_flex()
                            .w(px(152.))
                            .flex_shrink_0()
                            .gap_2()
                            .child(h_flex().h(px(40.)).items_end().gap_2().children(
                                data.activity.iter().map(|day| {
                                    div()
                                        .flex_1()
                                        .h(px(4. + 36. * day.conversations as f32 / peak))
                                        .rounded_sm()
                                        .bg(if day.conversations > 0 {
                                            cx.theme().primary
                                        } else {
                                            cx.theme().border
                                        })
                                }),
                            ))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(format!("{active} recent conversations")),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child("Last activity · 7 days, UTC"),
                            ),
                    ),
            )
            .child(
                h_flex().gap_3().children(
                    [
                        (unread, "Unread replies"),
                        (follow_up, "Waiting for you"),
                        (cleanup, "Cleanup suggestions"),
                    ]
                    .into_iter()
                    .map(|(count, label)| {
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_2()
                            .py_4()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(label),
                            )
                            .child(div().text_3xl().font_semibold().child(count.to_string()))
                    }),
                ),
            )
            .when_some(summary, |body, summary| {
                body.child(
                    v_flex()
                        .gap_2()
                        .pl_4()
                        .border_l_2()
                        .border_color(cx.theme().primary)
                        .child(div().text_sm().child(summary))
                        .child(
                            h_flex().child(
                                Button::new("lens-read-review")
                                    .xsmall()
                                    .ghost()
                                    .label("Discuss with Lens")
                                    .icon(IconName::ChevronRight)
                                    .on_click(cx.listener(|panel, _, window, cx| {
                                        panel.switch_tab(LensTab::Chat, window, cx)
                                    })),
                            ),
                        ),
                )
            })
            .into_any_element()
    }
    fn render_action(&self, action: &LensRecommendation, cx: &mut Context<Self>) -> AnyElement {
        let open = action.clone();
        let approve = action.clone();
        let dismiss = action.clone();
        let detail = action.clone();
        let blocked =
            self.busy || self.retry.is_some() || self.data.as_ref().is_some_and(|d| d.running);
        let pending = action.status == LensRecommendationStatus::Pending;
        v_flex()
            .gap_2()
            .py_4()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                h_flex()
                    .gap_3()
                    .items_start()
                    .child(
                        div()
                            .mt_1()
                            .size_8()
                            .flex_shrink_0()
                            .rounded_lg()
                            .bg(crate::glass::control(cx))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                Icon::new(if is_cleanup(action) {
                                    IconName::Archive
                                } else {
                                    IconName::Eye
                                })
                                .size_4()
                                .text_color(cx.theme().muted_foreground),
                            ),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(action_label(action)),
                            )
                            .child(div().text_sm().font_medium().child(action.title.0.clone()))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .line_clamp(2)
                                    .child(action.reason.clone()),
                            ),
                    )
                    .when(pending, |row| {
                        row.child(
                            Button::new(format!("lens-act-{}", action.id))
                                .small()
                                .outline()
                                .label(if is_cleanup(action) { "Review" } else { "Open" })
                                .disabled(blocked)
                                .on_click(cx.listener(move |panel, _, window, cx| {
                                    if is_cleanup(&approve) {
                                        panel.approve(approve.clone(), window, cx);
                                    } else {
                                        cx.emit(LensOpenTarget {
                                            source: open.source_id.clone(),
                                            target: open.target_id.clone(),
                                        });
                                    }
                                })),
                        )
                    })
                    .when(pending, |row| {
                        row.child(
                            Button::new(format!("lens-dismiss-{}", action.id))
                                .xsmall()
                                .ghost()
                                .icon(IconName::Close)
                                .tooltip("Dismiss recommendation")
                                .disabled(blocked)
                                .on_click(cx.listener(move |panel, _, window, cx| {
                                    panel.request(
                                        LensCommand::Decide {
                                            idempotency_key: key(),
                                            recommendation_id: dismiss.id.clone(),
                                            decision: LensCommandDecideDecision::Dismiss,
                                        },
                                        window,
                                        cx,
                                    )
                                })),
                        )
                    }),
            )
            .when(action.reason.chars().count() > 160, |row| {
                row.child(
                    h_flex().pl_11().child(
                        Button::new(format!("lens-detail-{}", action.id))
                            .xsmall()
                            .ghost()
                            .label("Read details")
                            .on_click(move |_, window, cx| {
                                let detail = detail.clone();
                                window.open_alert_dialog(cx, move |dialog, _, _| {
                                    dialog
                                        .title(detail.title.0.clone())
                                        .description(detail.reason.clone())
                                });
                            }),
                    ),
                )
            })
            .children(action.error.iter().map(|error| {
                div()
                    .pl_11()
                    .text_xs()
                    .text_color(cx.theme().danger)
                    .child(error.clone())
            }))
            .when(!pending, |row| {
                row.child(
                    div()
                        .pl_11()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(match action.status {
                            LensRecommendationStatus::Approved => "Approved · waiting for desktop",
                            LensRecommendationStatus::Applied => "Done",
                            LensRecommendationStatus::Stale => {
                                "Changed since review · review again"
                            }
                            LensRecommendationStatus::Failed => "Could not apply · review again",
                            _ => "Dismissed",
                        }),
                )
            })
            .into_any_element()
    }
    fn render_review_row(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let Some(row) = self.rows.get(index) else {
            return div().into_any_element();
        };
        let content = match row {
            ReviewRow::Summary => self.render_summary(cx),
            ReviewRow::Section(title, count) => v_flex().gap_1().pt_6().pb_1()
                .child(h_flex().gap_2().child(div().text_sm().font_semibold().child(*title)).child(div().text_xs().text_color(cx.theme().muted_foreground).child(count.to_string())))
                .when(*title == "Room to tidy up", |row| row.child(div().text_xs().text_color(cx.theme().muted_foreground).child("Review each suggestion. You decide what goes."))).into_any_element(),
            ReviewRow::Action(index) => self.render_action(&self.data.as_ref().unwrap().recommendations[*index], cx),
            ReviewRow::Empty => v_flex().gap_2().py_8().items_center()
                .child(Icon::new(IconName::CircleCheck).size_6().text_color(cx.theme().muted_foreground))
                .child(div().text_sm().child(if self.data.as_ref().is_some_and(|d| d.last_run_at.is_some()) { "You're all caught up." } else { "Ready when you are." }))
                .child(div().text_xs().text_color(cx.theme().muted_foreground).child("Run a review to find unread replies, follow-ups, and things to tidy up.")).into_any_element(),
            ReviewRow::Footer => {
                let data = self.data.as_ref().unwrap();
                v_flex().gap_2().pt_6().pb_8()
                    .child(h_flex().gap_2().child(div().flex_1().text_xs().text_color(cx.theme().muted_foreground).child(data.next_run_at.as_ref().map(|at| format!("Next review {} · local time", time_label(at))).unwrap_or_else(|| "Scheduled reviews are off".into())))
                        .child(Button::new("lens-history").xsmall().ghost().label(if self.show_history { "Hide handled" } else { "Recently handled" }).on_click(cx.listener(|panel, _, _, cx| { panel.show_history = !panel.show_history; panel.rebuild_review(); cx.notify(); }))))
                    .child(div().text_xs().text_color(cx.theme().muted_foreground).child(data.selected_model.as_ref().map(|model| format!("{}{}", model.model, if data.settings.model.is_none() { " · most used connected model" } else { "" })).unwrap_or_else(|| "Connect an AI account to start reviewing.".into())))
                    .children(data.sources.iter().map(|source| div().text_xs().text_color(cx.theme().muted_foreground).child(format!("{} · synced {}", source.label.0, time_label(&source.synced_at)))))
                    .into_any_element()
            }
        };
        div()
            .w_full()
            .flex()
            .justify_center()
            .child(column().child(content))
            .into_any_element()
    }
    fn render_chat_row(&mut self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let Some(message) = self
            .data
            .as_ref()
            .and_then(|data| data.messages.get(index))
            .cloned()
        else {
            return div().into_any_element();
        };
        let state = if let Some((state, _)) = self.markdown.get(&message.id) {
            let state = state.clone();
            state.update(cx, |state, cx| state.set_text(&message.text, cx));
            state
        } else {
            let state = cx.new(|cx| TextViewState::markdown(&message.text, cx));
            let id = message.id.clone();
            let subscription = cx.observe(&state, move |panel, _, cx| {
                if let Some(index) = panel
                    .data
                    .as_ref()
                    .and_then(|data| data.messages.iter().position(|m| m.id == id))
                {
                    panel.chat_list.splice(index..index + 1, 1);
                    cx.notify();
                }
            });
            self.markdown
                .insert(message.id.clone(), (state.clone(), subscription));
            state
        };
        let user = message.role == vitre_contracts::LensMessageRole::User;
        div()
            .w_full()
            .flex()
            .justify_center()
            .child(
                column().py_4().child(
                    v_flex()
                        .gap_2()
                        .child(
                            div()
                                .text_xs()
                                .font_medium()
                                .text_color(cx.theme().muted_foreground)
                                .child(if user { "You" } else { "Lens" }),
                        )
                        .child(
                            TextView::new(&state)
                                .markdown_extensions(crate::visuals::markdown_extensions())
                                .text_sm(),
                        ),
                ),
            )
            .into_any_element()
    }
}
impl Render for LensPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let blocked =
            self.busy || self.retry.is_some() || self.data.as_ref().is_none_or(|data| data.running);
        let error = self
            .error
            .as_ref()
            .or_else(|| self.data.as_ref().and_then(|data| data.error.as_ref()))
            .cloned();
        let header = h_flex()
            .h(px(52.))
            .px_6()
            .gap_2()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                Icon::new(IconName::Eye)
                    .size_4()
                    .text_color(cx.theme().primary),
            )
            .child(div().text_sm().font_semibold().mr_4().child("Lens"))
            .children(
                [(LensTab::Review, "Overview"), (LensTab::Chat, "Chat")].map(|(tab, label)| {
                    Button::new(format!("lens-tab-{label}"))
                        .small()
                        .ghost()
                        .selected(self.tab == tab && self.form.is_none())
                        .label(label)
                        .on_click(cx.listener(move |panel, _, window, cx| {
                            panel.switch_tab(tab, window, cx)
                        }))
                }),
            )
            .child(div().flex_1())
            .child(
                Button::new("lens-sweep")
                    .small()
                    .outline()
                    .label(if self.data.as_ref().is_some_and(|d| d.running) {
                        "Reviewing…"
                    } else {
                        "Review now"
                    })
                    .disabled(blocked)
                    .on_click(cx.listener(|panel, _, window, cx| {
                        panel.request(
                            LensCommand::Sweep {
                                idempotency_key: key(),
                            },
                            window,
                            cx,
                        )
                    })),
            )
            .child(
                Button::new("lens-settings")
                    .small()
                    .ghost()
                    .icon(IconName::Settings)
                    .tooltip("Lens schedule and model")
                    .disabled(self.data.is_none() || self.busy)
                    .on_click(cx.listener(|panel, _, window, cx| panel.open_settings(window, cx))),
            );
        let content: AnyElement = if self.form.is_some() {
            div()
                .id("lens-settings-scroll")
                .track_scroll(&self.scroll)
                .size_full()
                .overflow_y_scroll()
                .child(
                    column()
                        .mx_auto()
                        .py_6()
                        .max_w(px(640.))
                        .child(self.render_form(cx)),
                )
                .into_any_element()
        } else if self.tab == LensTab::Review {
            div()
                .size_full()
                .child(
                    list(
                        self.review_list.clone(),
                        cx.processor(|panel, index, _, cx| panel.render_review_row(index, cx)),
                    )
                    .size_full(),
                )
                .vertical_scrollbar(&self.review_list)
                .into_any_element()
        } else if self
            .data
            .as_ref()
            .is_none_or(|data| data.messages.is_empty())
        {
            column().mx_auto().h_full().flex().flex_col().justify_center().gap_4()
                .child(Icon::new(IconName::Eye).size_8().text_color(cx.theme().primary))
                .child(div().text_2xl().font_semibold().child("Make sense of your week."))
                .child(div().text_sm().text_color(cx.theme().muted_foreground).child("Ask about progress, loose ends, or what to clean up across your projects."))
                .child(h_flex().flex_wrap().gap_2().children(["What did I do this week?", "What needs my attention?", "What can I clean up?"].iter().enumerate().map(|(i, prompt)| Button::new(format!("lens-starter-{i}")).small().outline().label(*prompt).disabled(blocked).on_click(cx.listener(move |panel, _, window, cx| panel.request(LensCommand::Chat { idempotency_key: key(), message: (*prompt).into() }, window, cx))))))
                .into_any_element()
        } else {
            div()
                .size_full()
                .child(
                    list(
                        self.chat_list.clone(),
                        cx.processor(|panel, index, _, cx| panel.render_chat_row(index, cx)),
                    )
                    .size_full(),
                )
                .vertical_scrollbar(&self.chat_list)
                .into_any_element()
        };
        v_flex()
            .size_full()
            .min_w_0()
            .bg(crate::glass::background(cx))
            .child(header)
            .when_some(error, |body, error| {
                body.child(
                    h_flex()
                        .px_6()
                        .py_2()
                        .gap_2()
                        .child(
                            div()
                                .flex_1()
                                .text_xs()
                                .text_color(cx.theme().danger)
                                .child(error),
                        )
                        .when(self.retry.is_some(), |row| {
                            row.child(
                                Button::new("lens-retry")
                                    .xsmall()
                                    .outline()
                                    .label("Retry")
                                    .disabled(self.busy)
                                    .on_click(cx.listener(|panel, _, window, cx| {
                                        if let Some(command) = panel.retry.clone() {
                                            panel.request(command, window, cx);
                                        }
                                    })),
                            )
                            .child(
                                Button::new("lens-dismiss-error")
                                    .xsmall()
                                    .ghost()
                                    .label("Dismiss")
                                    .disabled(self.busy)
                                    .on_click(cx.listener(|panel, _, _, cx| {
                                        panel.retry = None;
                                        panel.error = None;
                                        cx.notify();
                                    })),
                            )
                        }),
                )
            })
            .when(
                cfg!(debug_assertions) && std::env::var("VITRE_LENS_PREVIEW").as_deref() == Ok("1"),
                |body| {
                    body.child(
                        h_flex()
                            .px_6()
                            .gap_2()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .flex_1()
                                    .child("Interface preview · sample data"),
                            )
                            .child(
                                Button::new("lens-qa-devices")
                                    .xsmall()
                                    .ghost()
                                    .label("Device QA")
                                    .on_click(cx.listener(|_, _, _, cx| {
                                        cx.emit(LensOpenTarget {
                                            source: "qa:devices".into(),
                                            target: "".into(),
                                        })
                                    })),
                            )
                            .child(
                                Button::new("lens-qa-capture")
                                    .xsmall()
                                    .ghost()
                                    .label("Capture")
                                    .on_click(|_, window, _| {
                                        if let Ok(snapshot) = window.render_to_image() {
                                            let _ =
                                                snapshot.save("/tmp/vitre-lens-qa/native-lens.png");
                                        }
                                    }),
                            ),
                    )
                },
            )
            .child(div().flex_1().min_h_0().child(content))
            .when(self.tab == LensTab::Chat && self.form.is_none(), |body| {
                body.when(
                    self.data.as_ref().is_some_and(|data| data.running),
                    |body| {
                        body.child(
                            column()
                                .mx_auto()
                                .py_2()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child("Lens is thinking…"),
                        )
                    },
                )
                .child(
                    column().mx_auto().pb_5().pt_3().child(
                        h_flex()
                            .gap_2()
                            .child(div().flex_1().min_w_0().child(Input::new(&self.input)))
                            .child(
                                Button::new("lens-send")
                                    .primary()
                                    .label("Send")
                                    .disabled(blocked)
                                    .on_click(
                                        cx.listener(|panel, _, window, cx| panel.send(window, cx)),
                                    ),
                            ),
                    ),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::{LensPanel, LensTab};
    use gpui::TestAppContext;
    use std::{cell::Cell, rc::Rc, time::Duration};

    #[gpui::test]
    fn long_lens_chat_virtualizes_and_does_not_reparse_unchanged_frames(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (panel, cx) = cx.add_window_view(|window, cx| LensPanel::new(None, window, cx));
        let messages: Vec<_> = (0..200).map(|index| serde_json::json!({
            "id": format!("message-{index}"), "role": "assistant", "createdAt": "2026-10-31T12:00:00.000Z",
            "text": format!("Review {index}\n\nHere is your progress.\n\n```vitre-visual\n{{\"version\":1,\"title\":\"Week {index}\",\"views\":[{{\"label\":\"Progress\",\"kind\":\"line\",\"points\":[{{\"label\":\"Mon\",\"value\":1}},{{\"label\":\"Fri\",\"value\":4}}]}}]}}\n```")
        })).collect();
        let data = serde_json::from_value(serde_json::json!({
            "revision": 1, "settingsRevision": 0, "settings": { "enabled": false, "model": null,
                "schedule": { "frequency": "weekly", "weekday": 1, "hour": 9, "minute": 0, "timeZone": "UTC" },
                "staleConversationDays": 14, "staleProjectDays": 30 },
            "nextRunAt": null, "lastRunAt": null, "running": false, "error": null,
            "selectedModel": null, "models": [], "messages": messages, "recommendations": [], "sources": [], "activity": []
        })).unwrap();
        panel.update(cx, |panel, cx| {
            panel.error = None;
            assert!(panel.accept(data));
            panel.tab = LensTab::Chat;
            cx.notify();
        });
        for _ in 0..20 {
            cx.run_until_parked();
            cx.executor().advance_clock(Duration::from_millis(16));
            cx.update(|window, cx| window.draw(cx).clear(cx));
        }
        let notifications = Rc::new(Cell::new(0));
        let subscriptions = panel.update(cx, |panel, cx| {
            assert!(!panel.markdown.is_empty());
            assert!(
                panel.markdown.len() < 20,
                "only visible messages should parse, not all 200"
            );
            assert!(
                !panel.accept(panel.data.as_ref().unwrap().clone()),
                "unchanged polls are no-ops"
            );
            panel
                .markdown
                .values()
                .map(|(state, _)| {
                    let notifications = notifications.clone();
                    cx.observe(state, move |_, _, _| {
                        notifications.set(notifications.get() + 1)
                    })
                })
                .collect::<Vec<_>>()
        });
        for _ in 0..40 {
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            });
            cx.run_until_parked();
        }
        assert_eq!(
            notifications.get(),
            0,
            "scroll redraws must reuse the parsed document"
        );
        drop(subscriptions);
    }
}
