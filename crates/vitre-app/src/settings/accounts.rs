//! Provider accounts: add another account of a driver with its own credential
//! directory, and sign each instance in or out.
//!
//! An account is an ordinary provider instance. What makes it a separate
//! account is where its CLI keeps credentials: Claude gets its own
//! `CLAUDE_CONFIG_DIR`, and Codex gets a shadow `CODEX_HOME` that shares
//! sessions with the main home but keeps a private `auth.json`. Drivers whose
//! CLI cannot isolate a login use an API key in the instance environment.
use super::*;
use futures::future::Either;
use gpui::{AppContext as _, Entity};
use gpui_component::{
    Disableable as _, Icon, WindowExt as _,
    command::{Command, CommandItem, CommandState},
    input::{Input, InputState},
};
use serde_json::{Value, json};
use std::collections::HashMap;
use vitre_contracts::{
    ProviderInstanceId, ServerProviderAuthAction, ServerProviderAuthEvent, ServerProviderAuthInput,
    methods::ServerProviderAuth,
};

/// Drivers offered by "Add account", in the providers page order.
const ACCOUNT_DRIVERS: [(&str, &str, &str); 5] = [
    (
        "claudeAgent",
        "Claude",
        "Anthropic account · sign in with your browser",
    ),
    (
        "codex",
        "Codex",
        "ChatGPT or OpenAI account · sign in with your browser",
    ),
    ("cursor", "Cursor", "Cursor account · uses an API key"),
    ("grok", "Grok", "xAI account · uses an API key"),
    (
        "opencode",
        "OpenCode",
        "OpenCode server · uses its own keys",
    ),
];
/// Where new accounts keep their credentials, one folder per instance.
const ACCOUNTS_ROOT: &str = "~/.vitre/accounts";
const MAX_ACCOUNT_NAME_CHARS: usize = 40;

/// Drivers whose CLI can sign in to an isolated credential directory.
pub(super) fn supports_sign_in(driver: &str) -> bool {
    matches!(driver, "claudeAgent" | "codex")
}

fn driver_label(driver: &str) -> &'static str {
    ACCOUNT_DRIVERS
        .iter()
        .find(|(d, ..)| *d == driver)
        .map(|(_, label, _)| *label)
        .unwrap_or("Provider")
}

/// A sign-in or sign-out in flight, keyed by instance id.
pub(super) struct AuthRun {
    pub(super) action: ServerProviderAuthAction,
    pub(super) url: Option<String>,
    pub(super) line: Option<String>,
    cancel: Option<futures::channel::oneshot::Sender<()>>,
}

impl AuthRun {
    pub(super) fn is_cancelling(&self) -> bool {
        self.cancel.is_none()
    }
}

#[derive(Default)]
pub(super) struct AccountUi {
    pub(super) runs: HashMap<String, AuthRun>,
    pub(super) errors: HashMap<String, SharedString>,
    form: Option<AccountForm>,
}

struct AccountForm {
    driver: String,
    name: Entity<InputState>,
    busy: bool,
    error: Option<SharedString>,
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let out = out.trim_matches('_').to_string();
    if out.is_empty() {
        "account".into()
    } else {
        out
    }
}

/// Build a new account instance for `driver` named `name`. Returns the new
/// instance id and the full `providerInstances` map to write, preserving every
/// existing instance. `known_ids` covers built-in instances that only exist as
/// legacy settings so a new id never shadows one of them.
pub(super) fn new_account(
    settings: &Value,
    known_ids: &[String],
    driver: &str,
    name: &str,
) -> Result<(String, Value), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a name for this account, such as Work or Personal.".into());
    }
    if name.chars().count() > MAX_ACCOUNT_NAME_CHARS {
        return Err(format!(
            "Use an account name of {MAX_ACCOUNT_NAME_CHARS} characters or fewer."
        ));
    }
    if !ACCOUNT_DRIVERS.iter().any(|(d, ..)| *d == driver) {
        return Err(format!("{driver} accounts are not supported."));
    }
    let mut instances = settings["providerInstances"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let taken = |id: &str| instances.contains_key(id) || known_ids.iter().any(|k| k == id);
    let base: String = format!("{driver}_{}", slug(name))
        .chars()
        .take(56)
        .collect();
    let mut id = base.clone();
    let mut n = 2;
    while taken(&id) {
        id = format!("{base}_{n}");
        n += 1;
    }
    // Carry the main instance's executable so a custom CLI install keeps working.
    let main = settings["providerInstances"]
        .get(driver)
        .map(|i| i["config"].clone())
        .unwrap_or_else(|| settings["providers"][driver].clone());
    let mut config = json!({});
    for key in ["binaryPath", "launchArgs"] {
        if let Some(value) = main[key].as_str().filter(|v| !v.trim().is_empty()) {
            config[key] = json!(value);
        }
    }
    let home = format!("{ACCOUNTS_ROOT}/{id}");
    match driver {
        "claudeAgent" => config["homePath"] = json!(home),
        "codex" => {
            // Share sessions with the main Codex home; keep auth.json private.
            if let Some(shared) = main["homePath"].as_str().filter(|v| !v.trim().is_empty()) {
                config["homePath"] = json!(shared);
            }
            config["shadowHomePath"] = json!(home);
        }
        _ => {}
    }
    instances.insert(
        id.clone(),
        json!({
            "driver": driver,
            "displayName": format!("{} ({name})", driver_label(driver)),
            "enabled": true,
            "config": config,
        }),
    );
    Ok((id, Value::Object(instances)))
}

impl SettingsPanel {
    /// Searchable list of drivers; picking one asks for the account name.
    pub(super) fn open_account_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let owner = cx.entity().downgrade();
        let state = cx.new(|cx| CommandState::new(window, cx));
        let focus = state.clone();
        window.open_dialog(cx, move |dialog, _, _| {
            let state = state.clone();
            let owner = owner.clone();
            dialog
                .close_button(false)
                .p_0()
                .margin_top(px(72.))
                .w(px(576.))
                .max_w(px(576.))
                .content(move |content, _, cx| {
                    let owner = owner.clone();
                    let mut items = ACCOUNT_DRIVERS
                        .iter()
                        .map(|(driver, label, detail)| {
                            account_driver_item(driver, label, detail.to_string())
                        })
                        .collect::<Vec<_>>();
                    items.push(
                        CommandItem::new()
                            .label("Custom provider instance")
                            .keywords(["advanced", "driver", "instance", "custom"])
                            .child(|_, cx| {
                                let muted = cx.theme().muted_foreground;
                                h_flex()
                                    .w_full()
                                    .gap_2()
                                    .child(Icon::new(IconName::Settings).size_4().text_color(muted))
                                    .child(
                                        v_flex()
                                            .min_w_0()
                                            .flex_1()
                                            .child(div().truncate().child("Custom provider instance"))
                                            .child(div().truncate().text_xs().text_color(muted).child(
                                                "Choose the driver, binary and environment yourself",
                                            )),
                                    )
                                    .into_any_element()
                            }),
                    );
                    content.child(
                        Command::new(&state)
                            .bordered(false)
                            .bg(cx.theme().popover.opacity(0.))
                            .cancel_clears_query(false)
                            .placeholder("Search providers…")
                            .max_h(px(300.))
                            .header(|_, _, cx| {
                                v_flex()
                                    .px_3()
                                    .pt_3()
                                    .pb_1()
                                    .gap_1()
                                    .child(div().text_sm().font_semibold().child("Add account"))
                                    .child(div().text_xs().text_color(cx.theme().muted_foreground).child(
                                        "Each account keeps its own sign-in, so you can use several accounts of one provider.",
                                    ))
                            })
                            .items(items)
                            .empty(|_, _, cx| {
                                div()
                                    .px_4()
                                    .py_8()
                                    .text_sm()
                                    .text_color(cx.theme().muted_foreground)
                                    .child("No providers match your search.")
                            })
                            .footer(|_, _, cx| {
                                crate::palette::chrome::footer(cx)
                                    .child(crate::palette::chrome::key_hint("↑↓", "navigate", cx))
                                    .child(crate::palette::chrome::key_hint("↵", "choose", cx))
                                    .child(crate::palette::chrome::key_hint("esc", "close", cx))
                            })
                            .on_confirm(move |index, window, cx| {
                                window.close_dialog(cx);
                                let driver = ACCOUNT_DRIVERS.get(index.row).map(|(d, ..)| d.to_string());
                                let _ = owner.update(cx, |panel, cx| match driver {
                                    Some(driver) => panel.open_account_form(driver, window, cx),
                                    None => panel.open_form(
                                        forms::FormKind::Provider(String::new()),
                                        window,
                                        cx,
                                    ),
                                });
                            }),
                    )
                })
        });
        window.defer(cx, move |window, cx| {
            focus.update(cx, |state, cx| state.focus(window, cx));
        });
    }

    fn open_account_form(&mut self, driver: String, window: &mut Window, cx: &mut Context<Self>) {
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("Work"));
        let focus = name.clone();
        self.accounts.form = Some(AccountForm {
            driver: driver.clone(),
            name,
            busy: false,
            error: None,
        });
        let owner = cx.entity().downgrade();
        let label = driver_label(&driver);
        let signs_in = supports_sign_in(&driver);
        window.open_dialog(cx, move |dialog, _, _| {
            let owner = owner.clone();
            dialog
                .title(format!("Add {label} account"))
                .w(px(480.))
                // Enter confirms the dialog: submit, and keep it open until
                // the account is written so validation errors stay visible.
                .on_ok({
                    let owner = owner.clone();
                    move |_, window, cx| {
                        let _ = owner.update(cx, |panel, cx| panel.submit_account_form(window, cx));
                        false
                    }
                })
                .on_close({
                    let owner = owner.clone();
                    move |_, _, cx| {
                        let _ = owner.update(cx, |panel, _| {
                            if panel.accounts.form.as_ref().is_some_and(|f| !f.busy) {
                                panel.accounts.form = None;
                            }
                        });
                    }
                })
                .content(move |content, _, cx| {
                    let Some(panel) = owner.upgrade() else {
                        return content;
                    };
                    let Some(form) = panel.read(cx).accounts.form.as_ref() else {
                        return content;
                    };
                    let muted = cx.theme().muted_foreground;
                    let input = form.name.clone();
                    content.child(
                        v_flex()
                            .gap_3()
                            .child(
                                v_flex()
                                    .gap_1p5()
                                    .child(div().text_xs().font_medium().child("Account name"))
                                    .child(Input::new(&input).small().disabled(form.busy)),
                            )
                            .child(div().text_xs().text_color(muted).child(if signs_in {
                                format!(
                                    "Credentials are stored in {ACCOUNTS_ROOT}/…, separate from your other {label} accounts. Vitre opens {label} sign-in after the account is added."
                                )
                            } else {
                                format!(
                                    "{label} keeps one login per computer, so this account uses an API key. Add it in the next step."
                                )
                            }))
                            .children(form.error.clone().map(|e| {
                                div().text_sm().text_color(cx.theme().danger).child(e)
                            }))
                            .child(
                                h_flex().justify_end().child({
                                    let save = owner.clone();
                                    Button::new("add-account-save")
                                        .primary()
                                        .small()
                                        .label(match (form.busy, signs_in) {
                                            (true, _) => "Adding…",
                                            (false, true) => "Add and sign in",
                                            (false, false) => "Add account",
                                        })
                                        .disabled(form.busy)
                                        .on_click(move |_, window, cx| {
                                            let _ = save.update(cx, |panel, cx| {
                                                panel.submit_account_form(window, cx)
                                            });
                                        })
                                }),
                            ),
                    )
                })
        });
        window.defer(cx, move |window, cx| {
            focus.update(cx, |input, cx| input.focus(window, cx));
        });
    }

    fn submit_account_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let known_ids = self
            .config
            .as_ref()
            .map(|c| {
                c.providers
                    .iter()
                    .map(|p| p.instance_id.0.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let Some(form) = self.accounts.form.as_mut() else {
            return;
        };
        if form.busy {
            return;
        }
        let driver = form.driver.clone();
        let name = form.name.read(cx).value().to_string();
        if let Err(error) = new_account(&json!({}), &[], &driver, &name) {
            form.error = Some(error.into());
            cx.notify();
            return;
        }
        form.busy = true;
        form.error = None;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = async {
                let current = client
                    .call::<ServerGetSettings>(&json!({}))
                    .await
                    .map_err(|e| e.user_message())?;
                let current = serde_json::to_value(current).map_err(|e| e.to_string())?;
                let (id, instances) = new_account(&current, &known_ids, &driver, &name)?;
                let patch: ServerSettingsPatch =
                    serde_json::from_value(json!({ "providerInstances": instances }))
                        .map_err(|e| e.to_string())?;
                let settings = client
                    .call::<ServerUpdateSettings>(&ServerUpdateSettingsPayload { patch })
                    .await
                    .map_err(|e| e.user_message())?;
                // The registry builds the instance after the write; wait until
                // it is reported so sign-in can find it.
                let mut config = None;
                for _ in 0..40 {
                    if let Ok(next) = client.call::<ServerGetConfig>(&json!({})).await {
                        let ready = next.providers.iter().any(|p| p.instance_id.0 == id);
                        config = Some(next);
                        if ready {
                            break;
                        }
                    }
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(250))
                        .await;
                }
                Ok::<_, String>((id, settings, config))
            }
            .await;
            let _ = this.update_in(cx, |panel, window, cx| {
                match result {
                    Ok((id, settings, config)) => {
                        panel.server = ServerState::Loaded(Box::new(settings));
                        if let Some(config) = config {
                            panel.config = Some(Box::new(config));
                        }
                        panel.accounts.form = None;
                        window.close_dialog(cx);
                        if supports_sign_in(&driver) {
                            panel.start_provider_auth(id, ServerProviderAuthAction::SignIn, cx);
                        } else {
                            panel.open_form(forms::FormKind::Provider(id), window, cx);
                        }
                    }
                    Err(error) => {
                        if let Some(form) = panel.accounts.form.as_mut() {
                            form.busy = false;
                            form.error = Some(error.into());
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Sign one instance in or out. The run outlives the settings page so a
    /// browser sign-in can finish after the user navigates away.
    pub(super) fn start_provider_auth(
        &mut self,
        id: String,
        action: ServerProviderAuthAction,
        cx: &mut Context<Self>,
    ) {
        if self.accounts.runs.contains_key(&id) {
            return;
        }
        let Some(client) = self.client.clone() else {
            return;
        };
        let (cancel, mut cancelled) = futures::channel::oneshot::channel::<()>();
        self.accounts.errors.remove(&id);
        self.accounts.runs.insert(
            id.clone(),
            AuthRun {
                action: action.clone(),
                url: None,
                line: None,
                cancel: Some(cancel),
            },
        );
        cx.notify();
        let input = ServerProviderAuthInput {
            action,
            instance_id: ProviderInstanceId(id.clone()),
        };
        cx.spawn(async move |this, cx| {
            let result: Result<Option<Vec<vitre_contracts::ServerProvider>>, String> = async {
                let mut stream = client
                    .subscribe::<ServerProviderAuth>(&input)
                    .map_err(|e| e.to_string())?;
                let mut providers = None;
                loop {
                    let event = {
                        let next = Box::pin(stream.next());
                        match futures::future::select(next, &mut cancelled).await {
                            Either::Left((event, _)) => Some(event),
                            Either::Right(_) => None,
                        }
                    };
                    // Cancel (or a dropped sender): stop the server-side CLI.
                    let Some(event) = event else {
                        let _ = stream.interrupt();
                        return Ok(None);
                    };
                    match event {
                        None => return Ok(providers),
                        Some(vitre_rpc::TypedStreamEvent::Values(events)) => {
                            for event in events {
                                match event {
                                    ServerProviderAuthEvent::Completed { providers: next } => {
                                        providers = Some(next);
                                    }
                                    ServerProviderAuthEvent::Output { text } => {
                                        let _ = this.update(cx, |panel, cx| {
                                            if let Some(run) = panel.accounts.runs.get_mut(&id) {
                                                run.line = Some(text);
                                            }
                                            cx.notify();
                                        });
                                    }
                                    ServerProviderAuthEvent::Url { url } => {
                                        let _ = this.update(cx, |panel, cx| {
                                            if let Some(run) = panel.accounts.runs.get_mut(&id) {
                                                run.url.get_or_insert(url.0);
                                            }
                                            cx.notify();
                                        });
                                    }
                                    ServerProviderAuthEvent::Unknown(_) => {}
                                }
                            }
                            stream.ack().map_err(|e| e.to_string())?;
                        }
                        Some(vitre_rpc::TypedStreamEvent::Completed(result)) => {
                            result.map_err(|e| e.user_message())?;
                            return Ok(providers);
                        }
                    }
                }
            }
            .await;
            let _ = this.update(cx, |panel, cx| {
                panel.accounts.runs.remove(&id);
                match result {
                    Ok(Some(providers)) => {
                        if let Some(config) = panel.config.as_mut() {
                            config.providers = providers;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        panel.accounts.errors.insert(id, error.into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn cancel_provider_auth(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(cancel) = self
            .accounts
            .runs
            .get_mut(id)
            .and_then(|run| run.cancel.take())
        {
            let _ = cancel.send(());
            cx.notify();
        }
    }
}

fn account_driver_item(driver: &str, label: &str, detail: String) -> CommandItem {
    let driver = driver.to_string();
    let label = label.to_string();
    CommandItem::new()
        .label(label.clone())
        .keywords([driver.clone(), detail.clone(), "account".into()])
        .child(move |_, cx| {
            let muted = cx.theme().muted_foreground;
            h_flex()
                .w_full()
                .gap_2()
                .child(crate::icons::provider_icon(&driver, cx).size_4())
                .child(
                    v_flex()
                        .min_w_0()
                        .flex_1()
                        .child(div().truncate().child(label.clone()))
                        .child(
                            div()
                                .truncate()
                                .text_xs()
                                .text_color(muted)
                                .child(detail.clone()),
                        ),
                )
                .into_any_element()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_accounts_get_their_own_config_dir_and_keep_other_instances() {
        let settings = json!({
            "providers": {"claudeAgent": {"binaryPath": "/opt/claude", "homePath": ""}},
            "providerInstances": {"codex_personal": {"driver": "codex"}}
        });
        let (id, instances) = new_account(&settings, &[], "claudeAgent", "Work").unwrap();
        assert_eq!(id, "claudeAgent_work");
        let account = &instances[&id];
        assert_eq!(account["displayName"], "Claude (Work)");
        assert_eq!(
            account["config"]["homePath"],
            "~/.vitre/accounts/claudeAgent_work"
        );
        assert_eq!(account["config"]["binaryPath"], "/opt/claude");
        assert_eq!(
            instances["codex_personal"],
            settings["providerInstances"]["codex_personal"]
        );
    }

    #[test]
    fn codex_accounts_share_sessions_but_isolate_auth() {
        let settings = json!({"providerInstances": {"codex": {"driver": "codex", "config": {"homePath": "/data/codex"}}}});
        let (id, instances) = new_account(&settings, &[], "codex", "Side Project!").unwrap();
        assert_eq!(id, "codex_side_project");
        assert_eq!(instances[&id]["config"]["homePath"], "/data/codex");
        assert_eq!(
            instances[&id]["config"]["shadowHomePath"],
            "~/.vitre/accounts/codex_side_project"
        );
    }

    #[test]
    fn account_ids_never_collide_and_names_are_validated() {
        let settings =
            json!({"providerInstances": {"claudeAgent_work": {"driver": "claudeAgent"}}});
        let (id, _) = new_account(&settings, &[], "claudeAgent", "work").unwrap();
        assert_eq!(id, "claudeAgent_work_2");
        let (id, _) = new_account(&json!({}), &["codex_account".into()], "codex", "!!!").unwrap();
        assert_eq!(id, "codex_account_2");
        assert!(new_account(&json!({}), &[], "codex", "  ").is_err());
        assert!(new_account(&json!({}), &[], "codex", &"x".repeat(41)).is_err());
        assert!(new_account(&json!({}), &[], "future", "Work").is_err());
        let (_, instances) = new_account(&json!({}), &[], "cursor", "Work").unwrap();
        assert!(instances["cursor_work"]["config"].get("homePath").is_none());
    }
}
