//! The few inputs the cloud flow still needs a card for: repository setup
//! commands, a pasted Claude token, the PR title/body, the monthly allowance,
//! and a delete confirmation. Both ChatApp and Settings → Cloud draw
//! these, so the card knows how to submit itself against the store.
use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Entity, IntoElement, ParentElement as _,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_component::{
    ActiveTheme as _, Disableable as _, Sizable as _, StyledExt as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputState, Textarea, TextareaState},
    v_flex,
};
use vitre_contracts::{CloudCommandPublicationCreateKind, CloudRepository, CloudResultRevision};

use super::store::{CloudStore, Op, repository_with_setup};

pub(crate) enum Sheet {
    Repository {
        base: CloudRepository,
        is_new: bool,
        branch: Entity<InputState>,
        setup: Entity<InputState>,
        test: Entity<InputState>,
    },
    ClaudeToken {
        token: Entity<InputState>,
    },
    Publish {
        task_id: String,
        revision: CloudResultRevision,
        kind: CloudCommandPublicationCreateKind,
        title: Entity<InputState>,
        body: Entity<TextareaState>,
    },
    Limit {
        amount: Entity<InputState>,
    },
    ConfirmDelete {
        task_id: String,
        title: String,
    },
}

impl Sheet {
    pub fn repository(
        base: CloudRepository,
        is_new: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> Self {
        let branch = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("main")
                .default_value(base.default_branch.clone())
        });
        let setup = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("e.g. pnpm install")
                .default_value(base.setup_command.clone())
        });
        let test = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("e.g. pnpm test")
                .default_value(base.test_command.clone())
        });
        Sheet::Repository {
            base,
            is_new,
            branch,
            setup,
            test,
        }
    }

    pub fn claude_token(window: &mut Window, cx: &mut App) -> Self {
        let token = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder("Paste the token from `claude setup-token`")
        });
        Sheet::ClaudeToken { token }
    }

    pub fn publish(
        task_id: String,
        revision: CloudResultRevision,
        kind: CloudCommandPublicationCreateKind,
        default_title: String,
        default_body: String,
        window: &mut Window,
        cx: &mut App,
    ) -> Self {
        let title = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Title")
                .default_value(default_title)
        });
        let body = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Description")
                .default_value(default_body)
                .auto_grow(6, 16)
        });
        Sheet::Publish {
            task_id,
            revision,
            kind,
            title,
            body,
        }
    }

    pub fn limit(current_micro_dollars: i64, window: &mut Window, cx: &mut App) -> Self {
        let amount = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("25.00")
                .default_value(format!("{:.2}", current_micro_dollars as f64 / 1_000_000.))
        });
        Sheet::Limit { amount }
    }

    pub fn confirm_delete(task_id: String, title: String) -> Self {
        Sheet::ConfirmDelete { task_id, title }
    }

    fn op(&self) -> Op {
        match self {
            Sheet::Repository { base, .. } => Op::SaveRepository(base.id.clone()),
            Sheet::ClaudeToken { .. } => Op::Provider(vitre_contracts::CloudProvider::Claude),
            Sheet::Publish { task_id, .. } => Op::Publish(task_id.clone()),
            Sheet::Limit { .. } => Op::Limits,
            Sheet::ConfirmDelete { task_id, .. } => Op::Task(task_id.clone(), "delete"),
        }
    }

    pub fn is_pending(&self, store: &CloudStore) -> bool {
        store.is_pending(&self.op())
    }

    /// Read the inputs and hand the store the matching command.
    pub fn submit(self, store: &Entity<CloudStore>, cx: &mut App) {
        match self {
            Sheet::Repository {
                base,
                branch,
                setup,
                test,
                ..
            } => {
                let mut branch = branch.read(cx).value().trim().to_string();
                if branch.is_empty() {
                    branch = base.default_branch.clone();
                }
                let repository = repository_with_setup(
                    &base,
                    branch,
                    setup.read(cx).value().trim().to_string(),
                    test.read(cx).value().trim().to_string(),
                );
                store.update(cx, |store, cx| store.save_repository(repository, cx));
            }
            Sheet::ClaudeToken { token } => {
                let token = token.read(cx).value().trim().to_string();
                if token.is_empty() {
                    return;
                }
                store.update(cx, |store, cx| store.save_claude_credential(token, cx));
            }
            Sheet::Publish {
                task_id,
                revision,
                kind,
                title,
                body,
            } => {
                let title = title.read(cx).value().trim().to_string();
                let body = body.read(cx).value().trim().to_string();
                store.update(cx, |store, cx| {
                    store.publish(
                        task_id,
                        revision.id.clone(),
                        revision.sha256.clone(),
                        kind,
                        title,
                        body,
                        cx,
                    )
                });
            }
            Sheet::Limit { amount } => {
                let Ok(dollars) = amount.read(cx).value().trim().parse::<f64>() else {
                    return;
                };
                let micro = (dollars.max(0.) * 1_000_000.).round() as i64;
                store.update(cx, |store, cx| store.update_limit(micro, cx));
            }
            Sheet::ConfirmDelete { task_id, .. } => {
                store.update(cx, |store, cx| store.delete_task(task_id, cx));
            }
        }
    }
}

fn field(
    label: &'static str,
    hint: Option<&'static str>,
    input: AnyElement,
    cx: &App,
) -> AnyElement {
    v_flex()
        .gap_1()
        .child(div().text_xs().font_medium().child(label))
        .child(input)
        .when_some(hint, |col, hint| {
            col.child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(hint),
            )
        })
        .into_any_element()
}

/// The card itself. `submit`/`close` are the owner's listeners.
pub(crate) fn render_sheet(
    sheet: &Sheet,
    pending: bool,
    submit: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    close: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let (title, subtitle, action, danger, body): (
        String,
        Option<String>,
        &'static str,
        bool,
        Vec<AnyElement>,
    ) = match sheet {
        Sheet::Repository {
            base,
            is_new,
            branch,
            setup,
            test,
        } => (
            format!("{}/{}", base.owner, base.name),
            Some(if *is_new {
                "Tell the worker how to prepare this repository. Both commands are optional."
                    .into()
            } else {
                "Setup runs after the clone; tests run after the agent finishes.".into()
            }),
            if *is_new { "Connect" } else { "Save" },
            false,
            vec![
                field(
                    "Base branch",
                    None,
                    Input::new(branch).small().into_any_element(),
                    cx,
                ),
                field(
                    "Setup command",
                    Some("Runs once in the fresh clone before the agent starts."),
                    Input::new(setup).small().into_any_element(),
                    cx,
                ),
                field(
                    "Test command",
                    Some("Runs after the agent finishes; its output lands in the Tests tab."),
                    Input::new(test).small().into_any_element(),
                    cx,
                ),
            ],
        ),
        Sheet::ClaudeToken { token } => (
            "Connect Claude".into(),
            Some(
                "Run `claude setup-token` on a machine signed in to your subscription and paste the result. The token is stored encrypted in your deployment."
                    .into(),
            ),
            "Connect",
            false,
            vec![field(
                "Subscription token",
                None,
                Input::new(token).small().into_any_element(),
                cx,
            )],
        ),
        Sheet::Publish {
            kind, title, body, ..
        } => (
            match kind {
                CloudCommandPublicationCreateKind::IssueComment => "Comment on the issue".into(),
                _ => "Open a draft pull request".into(),
            },
            Some(match kind {
                CloudCommandPublicationCreateKind::IssueComment => {
                    "Posted as you, exactly as written below.".into()
                }
                _ => "The task's branch is pushed and a draft PR is opened against the base branch."
                    .into(),
            }),
            match kind {
                CloudCommandPublicationCreateKind::IssueComment => "Post comment",
                _ => "Create draft PR",
            },
            false,
            {
                let mut fields = Vec::new();
                if !matches!(kind, CloudCommandPublicationCreateKind::IssueComment) {
                    fields.push(field(
                        "Title",
                        None,
                        Input::new(title).small().into_any_element(),
                        cx,
                    ));
                }
                fields.push(field(
                    "Description",
                    None,
                    Textarea::new(body).into_any_element(),
                    cx,
                ));
                fields
            },
        ),
        Sheet::Limit { amount } => (
            "Monthly compute allowance".into(),
            Some(
                "Tasks stop scheduling once the month's estimate reaches this amount. Storage and hosting are billed separately."
                    .into(),
            ),
            "Save",
            false,
            vec![field(
                "Allowance (USD)",
                None,
                Input::new(amount).small().into_any_element(),
                cx,
            )],
        ),
        Sheet::ConfirmDelete { title, .. } => (
            "Delete this task?".into(),
            Some(format!(
                "“{title}” and its saved diff are removed from your deployment. A published PR stays on GitHub."
            )),
            "Delete",
            true,
            vec![],
        ),
    };
    v_flex()
        .gap_4()
        .p_5()
        .rounded_xl()
        .border_1()
        .border_color(cx.theme().border)
        .bg(crate::glass::elevated(cx))
        .shadow_lg()
        .child(
            v_flex()
                .gap_1()
                .child(div().text_base().font_semibold().child(title))
                .when_some(subtitle, |col, text| {
                    col.child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(text),
                    )
                }),
        )
        .when(!body.is_empty(), |col| {
            col.child(v_flex().gap_3().children(body))
        })
        .child(
            h_flex()
                .justify_end()
                .gap_2()
                .child(
                    Button::new("cloud-sheet-cancel")
                        .ghost()
                        .small()
                        .label("Cancel")
                        .on_click(close),
                )
                .child(
                    Button::new("cloud-sheet-submit")
                        .small()
                        .map(|b| if danger { b.danger() } else { b.primary() })
                        .label(action)
                        .loading(pending)
                        .disabled(pending)
                        .on_click(submit),
                ),
        )
        .min_h(px(0.))
        .into_any_element()
}
