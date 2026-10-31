//! Settings → Cloud: account management for the shared conversation UI.
//! This page covers what you set once — sign-in,
//! provider accounts, repository setup commands and the monthly allowance.
use super::*;
use gpui::{EventEmitter, StatefulInteractiveElement as _, prelude::FluentBuilder as _};
use gpui_component::{Disableable as _, Icon, tag::Tag};
use vitre_contracts::{CloudProvider, CloudProviderAccountState, CloudRepository};

use crate::cloud::{self, CloudStore, Op, SessionState, Sheet, store::dollars};

pub(crate) struct CloudPanel {
    store: gpui::Entity<CloudStore>,
    sheet: Option<Sheet>,
    _observe: gpui::Subscription,
}

pub(crate) struct CloudPanelChanged;
impl EventEmitter<CloudPanelChanged> for CloudPanel {}

impl CloudPanel {
    pub fn new(client: Option<Arc<EnvironmentClient>>, cx: &mut Context<Self>) -> Self {
        let store = CloudStore::global(cx);
        if let Some(client) = client {
            store.update(cx, |store, cx| store.attach(client, cx));
        }
        let observe = cx.observe(&store, |_, _, cx| cx.notify());
        Self {
            store,
            sheet: None,
            _observe: observe,
        }
    }

    pub fn attach(&mut self, client: Arc<EnvironmentClient>, cx: &mut Context<Self>) {
        self.store.update(cx, |store, cx| store.attach(client, cx));
    }

    /// Kept for the settings navigation: selecting the page refreshes the
    /// overview and lists installable repositories.
    pub fn select(&mut self, _task: Option<String>, cx: &mut Context<Self>) {
        self.sheet = None;
        self.store.update(cx, |store, cx| {
            if store.session == SessionState::SignedIn {
                store.refresh(cx);
                if store
                    .overview
                    .as_ref()
                    .is_some_and(|o| o.github_manage_url.is_some())
                {
                    store.refresh_github(cx);
                } else {
                    store.load_available(cx);
                }
            }
        });
        cx.notify();
    }

    fn open_sheet(&mut self, sheet: Sheet, cx: &mut Context<Self>) {
        self.sheet = Some(sheet);
        cx.notify();
    }

    fn render_sheet(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let sheet = self.sheet.as_ref()?;
        let pending = sheet.is_pending(self.store.read(cx));
        let card = cloud::render_sheet_card(
            sheet,
            pending,
            cx.listener(|this, _, _, cx| {
                if let Some(sheet) = this.sheet.take() {
                    sheet.submit(&this.store, cx);
                }
                cx.notify();
            }),
            cx.listener(|this, _, _, cx| {
                this.sheet = None;
                cx.notify();
            }),
            cx,
        );
        Some(
            div()
                .id("settings-cloud-sheet-backdrop")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .items_start()
                .justify_center()
                .pt_8()
                .bg(gpui::black().opacity(0.35))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.sheet = None;
                    cx.notify();
                }))
                .child(
                    div()
                        .id("settings-cloud-sheet")
                        .w(px(520.))
                        .max_w_full()
                        .on_click(|_, _, cx| cx.stop_propagation())
                        .child(card),
                )
                .into_any_element(),
        )
    }

    fn card(&self, title: &'static str, body: impl IntoElement, cx: &App) -> AnyElement {
        v_flex()
            .gap_3()
            .p_4()
            .rounded_lg()
            .border_1()
            .border_color(cx.theme().border)
            .bg(crate::glass::control(cx))
            .child(div().text_sm().font_semibold().child(title))
            .child(body)
            .into_any_element()
    }

    fn render_account(&self, cx: &mut Context<Self>) -> AnyElement {
        let store = self.store.read(cx);
        let signing_in = store.session == SessionState::SigningIn;
        let (label, detail): (&'static str, String) = match store.session {
            SessionState::Unknown => ("Checking…", "Looking for a saved session.".into()),
            SessionState::Disabled => (
                "Not enabled",
                "Set VITRE_CLOUD_DESKTOP_ENABLED on the local service and point it at your relay."
                    .into(),
            ),
            SessionState::SignedOut => (
                "Signed out",
                "Sign in once; the session is kept by the local service.".into(),
            ),
            SessionState::SigningIn => (
                "Signing in",
                "Finish the authorization in your browser.".into(),
            ),
            SessionState::SignedIn => (
                "Signed in",
                match store.overview.as_ref() {
                    Some(o) if !o.enabled => "The relay has cloud execution turned off.".into(),
                    Some(o) => format!(
                        "{} repositories · {} tasks",
                        o.repositories.len(),
                        o.tasks.len()
                    ),
                    None => "Loading…".into(),
                },
            ),
        };
        let action: Option<AnyElement> = match store.session {
            SessionState::SignedOut | SessionState::SigningIn => Some(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("settings-cloud-signin")
                            .primary()
                            .small()
                            .label(if signing_in { "Try again" } else { "Sign in" })
                            .disabled(store.cancelling_signin)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.store.update(cx, |store, cx| store.sign_in(cx))
                            })),
                    )
                    .when(signing_in, |row| {
                        row.child(
                            Button::new("settings-cloud-signin-cancel")
                                .ghost()
                                .small()
                                .label("Cancel")
                                .disabled(store.cancelling_signin)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.store.update(cx, |store, cx| store.cancel_sign_in(cx))
                                })),
                        )
                    })
                    .into_any_element(),
            ),
            SessionState::SignedIn => Some(
                Button::new("settings-cloud-refresh")
                    .ghost()
                    .small()
                    .label("Refresh")
                    .loading(store.is_pending(&Op::Overview))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.store.update(cx, |store, cx| store.refresh(cx))
                    }))
                    .into_any_element(),
            ),
            _ => None,
        };
        let body = h_flex()
            .gap_3()
            .items_center()
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_0p5()
                    .child(div().text_sm().child(label))
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(detail),
                    ),
            )
            .children(action);
        self.card("Account", body, cx)
    }

    fn render_usage(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let store = self.store.read(cx);
        let usage = store.overview.as_ref()?.usage.clone();
        let committed = usage.spent_micro_dollars + usage.reserved_micro_dollars;
        let fraction = if usage.limit_micro_dollars > 0 {
            (committed as f32 / usage.limit_micro_dollars as f32).clamp(0., 1.)
        } else {
            0.
        };
        let bar_color = if usage.warning || fraction > 0.9 {
            cx.theme().warning
        } else {
            cx.theme().primary
        };
        let current = usage.limit_micro_dollars;
        let body = v_flex()
            .gap_2()
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .child(
                        div()
                            .text_sm()
                            .child(format!(
                                "{} of {} this month",
                                dollars(committed),
                                dollars(usage.limit_micro_dollars)
                            )),
                    )
                    .child(
                        Button::new("settings-cloud-limit")
                            .outline()
                            .xsmall()
                            .label("Change limit")
                            .loading(store.is_pending(&Op::Limits))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let sheet = Sheet::limit(current, window, cx);
                                this.open_sheet(sheet, cx);
                            })),
                    ),
            )
            .child(
                div()
                    .w_full()
                    .h(px(6.))
                    .rounded_full()
                    .bg(cx.theme().muted)
                    .child(
                        div()
                            .h_full()
                            .rounded_full()
                            .w(gpui::relative(fraction))
                            .bg(bar_color),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(format!(
                        "Spent {} · reserved for running tasks {}. New tasks are refused once the limit is reached.",
                        dollars(usage.spent_micro_dollars),
                        dollars(usage.reserved_micro_dollars)
                    )),
            );
        Some(self.card("Monthly allowance", body, cx))
    }

    fn render_providers(&self, cx: &mut Context<Self>) -> AnyElement {
        let store = self.store.read(cx);
        let login = store.login.clone();
        let mut rows = v_flex().gap_2();
        for provider in [CloudProvider::Codex, CloudProvider::Claude] {
            let state = store.account_state(&provider).cloned();
            let pending = store.is_pending(&Op::Provider(provider.clone()));
            let connected = state == Some(CloudProviderAccountState::Connected);
            let (color, label) = match state {
                Some(CloudProviderAccountState::Connected) => (cx.theme().success, "Connected"),
                Some(CloudProviderAccountState::NeedsAuth) => (cx.theme().warning, "Needs sign-in"),
                Some(CloudProviderAccountState::UsageLimited) => {
                    (cx.theme().warning, "Usage limit")
                }
                _ => (cx.theme().muted_foreground, "Not connected"),
            };
            let connect = provider.clone();
            let disconnect = provider.clone();
            let is_claude = provider == CloudProvider::Claude;
            let mut row = v_flex().gap_2().child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(cloud::provider_icon(&provider, cx).size_4())
                    .child(div().text_sm().child(cloud::provider_label(&provider)))
                    .child(
                        Tag::custom(color.opacity(0.12), color, color.opacity(0.25))
                            .small()
                            .rounded_full()
                            .child(label),
                    )
                    .child(div().flex_1())
                    .child(if connected {
                        Button::new(SharedString::from(format!(
                            "disconnect-{label}-{is_claude}"
                        )))
                        .ghost()
                        .xsmall()
                        .label("Disconnect")
                        .loading(pending)
                        .disabled(pending)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.store.update(cx, |store, cx| {
                                store.disconnect_provider(disconnect.clone(), cx)
                            })
                        }))
                    } else {
                        Button::new(SharedString::from(format!("connect-{is_claude}")))
                            .outline()
                            .xsmall()
                            .label(if is_claude { "Paste token" } else { "Connect" })
                            .loading(pending)
                            .disabled(pending || store.session != SessionState::SignedIn)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if connect == CloudProvider::Claude {
                                    let sheet = Sheet::claude_token(window, cx);
                                    this.open_sheet(sheet, cx);
                                } else {
                                    this.store
                                        .update(cx, |store, cx| store.start_codex_login(cx));
                                }
                            }))
                    }),
            );
            if provider == CloudProvider::Codex
                && let Some(login) = login.as_ref()
            {
                row = row.child(cloud::render_codex_login(login, cx));
            }
            rows = rows.child(row);
        }
        let body = v_flex()
            .gap_3()
            .child(rows)
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child("Credentials are stored by your deployment and leased to one worker at a time. Codex signs in with a device code; Claude takes a subscription token from `claude setup-token`."),
            );
        self.card("Providers", body, cx)
    }

    fn render_github(&self, cx: &mut Context<Self>) -> AnyElement {
        let store = self.store.read(cx);
        let overview = store.overview.as_ref();
        let manage_url = overview.and_then(|o| o.github_manage_url.clone());
        let accounts = overview.and_then(|o| o.github_accounts.as_ref());
        let mut body = v_flex().gap_3().child(div().text_xs().text_color(cx.theme().muted_foreground)
            .child("Link personal and work accounts once. Sign in with either account to use both on desktop and mobile."));
        for account in accounts.into_iter().flatten() {
            body = body.child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(Icon::new(IconName::Github).size_4())
                    .child(div().text_sm().child(format!("@{}", account.login)))
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(
                                if account.state
                                    == vitre_contracts::CloudGitHubAccountState::Connected
                                {
                                    "Connected"
                                } else {
                                    "Needs sign-in"
                                },
                            ),
                    ),
            );
        }
        if accounts.is_none_or(|accounts| accounts.is_empty()) {
            body = body.child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child("No GitHub accounts linked yet."),
            );
        }
        body = body.child(
            h_flex()
                .gap_2()
                .child(
                    Button::new("manage-github-accounts")
                        .outline()
                        .xsmall()
                        .label("Manage GitHub accounts")
                        .disabled(manage_url.is_none())
                        .on_click(move |_, _, cx| {
                            if let Some(url) = &manage_url {
                                cx.open_url(url);
                            }
                        }),
                )
                .child(
                    Button::new("refresh-github-accounts")
                        .ghost()
                        .xsmall()
                        .label("Refresh")
                        .loading(store.is_pending(&Op::GitHubAccounts))
                        .disabled(
                            store.session != SessionState::SignedIn
                                || overview.is_none_or(|o| o.github_manage_url.is_none()),
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.store.update(cx, |store, cx| store.refresh_github(cx))
                        })),
                ),
        );
        self.card("GitHub accounts", body, cx)
    }

    fn github_label(store: &CloudStore, repo: &CloudRepository) -> String {
        repo.github_account_id
            .as_ref()
            .map(|id| {
                store
                    .overview
                    .as_ref()
                    .and_then(|o| o.github_accounts.as_ref())
                    .and_then(|accounts| accounts.iter().find(|a| &a.id == id))
                    .map(|a| format!("@{}", a.login))
                    .unwrap_or_else(|| "Account needs reconnecting".into())
            })
            .unwrap_or_else(|| "Deployment access".into())
    }

    fn render_repositories(&self, cx: &mut Context<Self>) -> AnyElement {
        let store = self.store.read(cx);
        let configured: Vec<CloudRepository> = store.repositories().to_vec();
        let available: Vec<CloudRepository> = store.available.clone().unwrap_or_default();
        let loading = store.is_pending(&Op::Repositories);
        let signed_in = store.session == SessionState::SignedIn;
        let mut body = v_flex().gap_2();
        if configured.is_empty() {
            body = body.child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child("No repositories connected yet."),
            );
        }
        for repo in &configured {
            let pending = store.is_pending(&Op::SaveRepository(repo.id.clone()));
            let edit = repo.clone();
            let setup =
                if repo.setup_command.trim().is_empty() && repo.test_command.trim().is_empty() {
                    "No setup or test command".to_string()
                } else {
                    format!(
                        "setup: {} · test: {}",
                        if repo.setup_command.trim().is_empty() {
                            "—"
                        } else {
                            repo.setup_command.trim()
                        },
                        if repo.test_command.trim().is_empty() {
                            "—"
                        } else {
                            repo.test_command.trim()
                        }
                    )
                };
            body = body.child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(Icon::new(IconName::Github).size_4())
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_sm()
                                    .child(format!("{}/{}", repo.owner, repo.name)),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .truncate()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(format!(
                                        "{} · {} · {}",
                                        Self::github_label(store, repo),
                                        repo.default_branch,
                                        setup
                                    )),
                            ),
                    )
                    .child(
                        Button::new(SharedString::from(format!("edit-repo-{}", repo.id)))
                            .ghost()
                            .xsmall()
                            .label("Edit setup")
                            .loading(pending)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let sheet = Sheet::repository(edit.clone(), false, window, cx);
                                this.open_sheet(sheet, cx);
                            })),
                    ),
            );
        }
        let installable: Vec<&CloudRepository> = available
            .iter()
            .filter(|r| {
                !configured
                    .iter()
                    .any(|c| c.id == r.id && c.github_account_id == r.github_account_id)
            })
            .collect();
        if !installable.is_empty() {
            body = body.child(
                div()
                    .pt_2()
                    .text_xs()
                    .font_medium()
                    .text_color(cx.theme().muted_foreground)
                    .child("Available to connect"),
            );
            for repo in installable.into_iter().take(20) {
                let pending = store.is_pending(&Op::SaveRepository(repo.id.clone()));
                let mut add = repo.clone();
                let replacing = configured.iter().find(|c| c.id == repo.id);
                if let Some(prior) = replacing {
                    add.revision = prior.revision;
                    add.setup_command = prior.setup_command.clone();
                    add.test_command = prior.test_command.clone();
                }
                let is_new = replacing.is_none();
                body = body.child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(
                            Icon::new(IconName::Github)
                                .size_4()
                                .text_color(cx.theme().muted_foreground),
                        )
                        .child(div().flex_1().min_w_0().text_sm().child(format!(
                            "{}/{} · {}",
                            repo.owner,
                            repo.name,
                            Self::github_label(store, repo)
                        )))
                        .child(
                            Button::new(SharedString::from(format!(
                                "add-repo-{}-{}",
                                repo.id,
                                repo.github_account_id.as_deref().unwrap_or("legacy")
                            )))
                            .outline()
                            .xsmall()
                            .label(if is_new { "Connect" } else { "Use account" })
                            .loading(pending)
                            .disabled(pending)
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    let sheet = Sheet::repository(add.clone(), is_new, window, cx);
                                    this.open_sheet(sheet, cx);
                                },
                            )),
                        ),
                );
            }
        }
        body = body.child(
            h_flex()
                .pt_1()
                .gap_2()
                .items_center()
                .child(
                    Button::new("settings-cloud-repos-refresh")
                        .ghost()
                        .xsmall()
                        .label("Refresh available")
                        .loading(loading)
                        .disabled(!signed_in)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.store.update(cx, |store, cx| store.load_available(cx))
                        })),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("Install the deployment's GitHub App on a repository to make it appear here."),
                ),
        );
        self.card("Repositories", body, cx)
    }
}

impl Render for CloudPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let error = self.store.read(cx).error.clone();
        v_flex()
            .relative()
            .w_full()
            .gap_3()
            .when_some(error, |col, error| {
                col.child(
                    h_flex()
                        .gap_2()
                        .items_start()
                        .px_3()
                        .py_2()
                        .rounded_lg()
                        .border_1()
                        .border_color(cx.theme().danger.opacity(0.35))
                        .bg(cx.theme().danger.opacity(0.07))
                        .text_sm()
                        .child(div().flex_1().min_w_0().child(error))
                        .child(
                            Button::new("settings-cloud-error-close")
                                .ghost()
                                .xsmall()
                                .icon(IconName::Close)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.store.update(cx, |store, cx| store.clear_error(cx))
                                })),
                        ),
                )
            })
            .child(self.render_account(cx))
            .children(self.render_usage(cx))
            .child(self.render_github(cx))
            .child(self.render_providers(cx))
            .child(self.render_repositories(cx))
            .child(
                h_flex().child(
                    Button::new("settings-cloud-open-surface")
                        .link()
                        .small()
                        .label("New cloud conversation")
                        .on_click(|_, _, cx| {
                            cx.dispatch_action(&crate::cloud::NewCloudThread);
                        }),
                ),
            )
            .children(self.render_sheet(cx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    fn account_page_renders_in_every_session_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (panel, cx) = cx.add_window_view(|_, cx| CloudPanel::new(None, cx));
        let store = panel.read_with(cx, |p, _| p.store.clone());
        for session in [
            SessionState::Unknown,
            SessionState::Disabled,
            SessionState::SignedOut,
            SessionState::SigningIn,
            SessionState::SignedIn,
        ] {
            store.update(cx, |store, cx| {
                store.session = session;
                cx.notify();
            });
            cx.update(|window, cx| window.draw(cx).clear(cx));
        }
        store.update(cx, |store, cx| {
            store.overview = serde_json::from_value(serde_json::json!({
                "enabled": true,
                "tasks": [],
                "repositories": [{"id":"r1","owner":"acme","name":"vitre","defaultBranch":"main","installationId":"1","revision":1,"setupCommand":"pnpm i","testCommand":""}],
                "accounts": [{"provider":"codex","state":"connected","credentialVersion":1,"leasedBy":null}],
                "publications": [],
                "usage": {"spentMicroDollars":1000,"reservedMicroDollars":0,"limitMicroDollars":25000000,"month":"2026-10","warning":false}
            }))
            .ok();
            store.available = Some(vec![CloudRepository {
                github_account_id: None,
                default_branch: "main".into(),
                id: "r2".into(),
                installation_id: "1".into(),
                name: "other".into(),
                owner: "acme".into(),
                revision: 0,
                setup_command: String::new(),
                test_command: String::new(),
            }]);
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert!(
            store.read_with(cx, |s, _| s.overview.is_some()),
            "fixture overview must parse"
        );
        cx.update(|window, cx| {
            panel.update(cx, |p, cx| {
                let sheet = Sheet::limit(25_000_000, window, cx);
                p.open_sheet(sheet, cx);
            })
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert!(panel.read_with(cx, |p, _| p.sheet.is_some()));
    }
}
