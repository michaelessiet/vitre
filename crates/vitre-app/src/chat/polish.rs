//! Native motion and agent-status presentation. Animation never owns task state.
use super::*;
use gpui::{Animation, AnimationExt as _};
use std::time::Duration;
use vitre_bezel_orbs::orbs::{Orb, OrbSize, OrbState};

/// Short, finite entrance; GPUI suppresses travel for Reduce Motion.
pub(super) fn reveal(id: impl Into<gpui::ElementId>, child: impl IntoElement) -> AnyElement {
    div()
        .size_full()
        .child(child)
        .with_animation(
            id,
            Animation::new(Duration::from_millis(120))
                .with_easing(gpui_component::animation::ease_out_cubic),
            |element, progress| element.opacity(progress),
        )
        .into_any_element()
}

/// Paused artwork has no animation timer; it is not a false busy indicator.
pub(super) fn welcome_orb(cx: &mut Context<ChatApp>) -> Entity<Orb> {
    cx.new(|_| {
        Orb::new()
            .state(OrbState::Breathing)
            .size(OrbSize::Hero)
            .reduced_motion(true)
    })
}

pub(super) fn activity_orb(cx: &mut Context<ChatApp>) -> Entity<Orb> {
    cx.new(|_| Orb::new().size(OrbSize::Inline).visible(false))
}

impl ChatApp {
    /// Both draft and active conversations use these exact two control rows.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn render_composer_controls(
        &self,
        model: AnyElement,
        reasoning: Option<AnyElement>,
        location: AnyElement,
        mode: AnyElement,
        runtime: AnyElement,
        context: Option<AnyElement>,
        send: AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        v_flex()
            .debug_selector(|| "composer-location-toolbar".into())
            .px_3()
            .pb_3()
            .pt_1()
            .gap_1()
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_1()
                    .items_center()
                    .child(
                        div()
                            .min_w_0()
                            .max_w(px(240.))
                            .overflow_hidden()
                            .child(model),
                    )
                    .children(reasoning)
                    .child(location),
            )
            .child(
                h_flex()
                    .debug_selector(|| "composer-action-row".into())
                    .w_full()
                    .min_w_0()
                    .gap_1()
                    .items_center()
                    .child(
                        Button::new("attach")
                            .ghost()
                            .small()
                            .icon(IconName::Plus)
                            .tooltip("Attach files")
                            .disabled(self.location_switch_blocks_turn())
                            .on_click(
                                cx.listener(|app, _, window, cx| app.attach_files(window, cx)),
                            ),
                    )
                    .child(mode)
                    .child(runtime)
                    .child(div().flex_1())
                    .children(context)
                    .child(send),
            )
            .into_any_element()
    }

    pub(super) fn render_runtime_picker(
        &self,
        current: RuntimeMode,
        compact: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (label, icon) = match current {
            RuntimeMode::ApprovalRequired => ("Supervised", IconName::Settings),
            RuntimeMode::AutoAcceptEdits => ("Auto-accept edits", IconName::SquarePen),
            RuntimeMode::Auto => ("Auto", IconName::CircleCheck),
            RuntimeMode::FullAccess => ("Full access", IconName::Globe),
            RuntimeMode::Unknown(_) => ("Permissions", IconName::Settings),
        };
        let owner = cx.entity().downgrade();
        Button::new("runtime-mode")
            .ghost()
            .small()
            .icon(icon)
            .when(!compact, |button| button.label(label))
            .tooltip(format!("Permissions: {label}"))
            .disabled(self.draft_creating || self.location_switch_blocks_turn())
            .dropdown_menu(move |mut menu, _, _| {
                for (mode, label) in [
                    (RuntimeMode::ApprovalRequired, "Supervised"),
                    (RuntimeMode::AutoAcceptEdits, "Auto-accept edits"),
                    (RuntimeMode::Auto, "Auto"),
                    (RuntimeMode::FullAccess, "Full access"),
                ] {
                    let owner = owner.clone();
                    menu = menu.item(PopupMenuItem::new(label).checked(mode == current).on_click(
                        move |_, _, cx| {
                            let _ =
                                owner.update(cx, |app, cx| app.set_runtime_mode(mode.clone(), cx));
                        },
                    ));
                }
                menu
            })
            .into_any_element()
    }

    pub(super) fn render_reasoning_picker(
        &self,
        option_descriptors: Vec<ProviderOptionDescriptor>,
        selected_model_options: HashMap<String, serde_json::Value>,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if option_descriptors.is_empty() {
            return None;
        }
        Some({
            let descriptors = option_descriptors;
            let mut current_options = selected_model_options;
            if self.composer.read(cx).value().starts_with("Ultrathink:") {
                for descriptor in &descriptors {
                    if let ProviderOptionDescriptor::SelectProviderOptionDescriptor(select) =
                        descriptor
                        && select
                            .prompt_injected_values
                            .as_ref()
                            .and_then(|v| v.as_ref())
                            .is_some_and(|values| values.iter().any(|v| v.0 == "ultrathink"))
                    {
                        current_options
                            .insert(select.id.0.clone(), serde_json::json!("ultrathink"));
                    }
                }
            }
            let chat = cx.entity().downgrade();
            Button::new("model-traits")
                .label(reasoning_label(&descriptors, &current_options))
                .tooltip("Choose model reasoning level")
                .disabled(self.draft_creating)
                .icon(Icon::new(VitreIcon::Zap))
                .ghost()
                .small()
                .dropdown_menu(move |mut menu, _, _| {
                    for descriptor in &descriptors {
                        match descriptor {
                            ProviderOptionDescriptor::SelectProviderOptionDescriptor(select) => {
                                menu = menu.item(PopupMenuItem::label(select.label.0.clone()));
                                let current = current_options
                                    .get(&select.id.0)
                                    .and_then(serde_json::Value::as_str)
                                    .map(str::to_string)
                                    .or_else(|| {
                                        select.current_value.clone().flatten().map(|value| value.0)
                                    });
                                for option in &select.options {
                                    let id = select.id.0.clone();
                                    let value = option.id.0.clone();
                                    let prompt_injected = select
                                        .prompt_injected_values
                                        .as_ref()
                                        .and_then(|values| values.as_ref())
                                        .is_some_and(|values| {
                                            values.iter().any(|candidate| candidate.0 == value)
                                        });
                                    let has_prompt_values = select
                                        .prompt_injected_values
                                        .as_ref()
                                        .and_then(|v| v.as_ref())
                                        .is_some_and(|v| !v.is_empty());
                                    let owner = chat.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(option.label.0.clone())
                                            .checked(current.as_ref() == Some(&value))
                                            .on_click(move |_, window, cx| {
                                                let id = id.clone();
                                                let value = value.clone();
                                                let _ = owner.update(cx, |this, cx| {
                                                    if prompt_injected {
                                                        this.set_prompt_effort(&value, window, cx);
                                                    } else {
                                                        if has_prompt_values {
                                                            this.set_prompt_effort(
                                                                &value, window, cx,
                                                            );
                                                        }
                                                        this.set_model_option(
                                                            id,
                                                            serde_json::Value::String(value),
                                                            cx,
                                                        )
                                                    }
                                                });
                                            }),
                                    );
                                }
                            }
                            ProviderOptionDescriptor::BooleanProviderOptionDescriptor(boolean) => {
                                let current = current_options
                                    .get(&boolean.id.0)
                                    .and_then(serde_json::Value::as_bool)
                                    .or_else(|| boolean.current_value.flatten())
                                    .unwrap_or(false);
                                let id = boolean.id.0.clone();
                                let owner = chat.clone();
                                menu = menu.item(
                                    PopupMenuItem::new(boolean.label.0.clone())
                                        .checked(current)
                                        .on_click(move |_, _, cx| {
                                            let id = id.clone();
                                            let _ = owner.update(cx, |this, cx| {
                                                this.set_model_option(
                                                    id,
                                                    serde_json::Value::Bool(!current),
                                                    cx,
                                                )
                                            });
                                        }),
                                );
                            }
                            ProviderOptionDescriptor::Unknown(_) => {}
                        }
                    }
                    menu
                })
                .into_any_element()
        })
    }

    pub(super) fn render_mode_switch(
        &self,
        plan: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let supports_plan = self
            .selected_provider()
            .and_then(|provider| provider.show_interaction_mode_toggle.flatten())
            .unwrap_or(true);
        let offset = gpui_base::motion::spring(
            "composer-mode-thumb",
            if self.ask_mode {
                if supports_plan { 7.0f32 } else { 3.5 }
            } else if plan {
                3.5
            } else {
                0.
            },
            gpui_base::motion::Spring::new(Duration::from_millis(260)),
            window,
            cx,
        );
        h_flex()
            .relative()
            .p_0p5()
            .h(gpui::rems(1.875))
            .rounded(gpui::rems(0.5625))
            .border_1()
            .border_color(cx.theme().border.opacity(0.6))
            .child(
                div()
                    .absolute()
                    .left(gpui::rems(0.125 + offset))
                    .top_0p5()
                    .bottom_0p5()
                    .w(gpui::rems(3.5))
                    .rounded(gpui::rems(0.4375))
                    .bg(cx.theme().primary.opacity(0.16)),
            )
            .children(
                [(false, "Build"), (true, "Plan"), (false, "Ask")]
                    .into_iter()
                    .filter(|(is_plan, _)| !is_plan || supports_plan)
                    .map(|(is_plan, label)| {
                        let is_ask = label == "Ask";
                        Button::new(if is_ask {
                            "composer-ask"
                        } else if is_plan {
                            "composer-plan"
                        } else {
                            "composer-build"
                        })
                        .ghost()
                        .small()
                        .w(gpui::rems(3.5))
                        .label(label)
                        .text_color(if is_ask == self.ask_mode && (is_ask || is_plan == plan) {
                            cx.theme().foreground
                        } else {
                            cx.theme().muted_foreground
                        })
                        .disabled(self.pending_interaction_mode.is_some() || self.draft_creating)
                        .tooltip(if is_ask {
                            "Ask about the codebase or request actions with tools, skills and MCP"
                        } else if is_plan {
                            "Plan the approach before making changes"
                        } else {
                            "Build and edit with the agent"
                        })
                        .on_click(cx.listener(move |app, _, _, cx| {
                            if is_ask {
                                app.set_ask_mode(cx);
                                return;
                            }
                            app.set_interaction_mode(
                                if is_plan {
                                    ProviderInteractionMode::Plan
                                } else {
                                    ProviderInteractionMode::Default
                                },
                                cx,
                            )
                        }))
                    }),
            )
            .into_any_element()
    }

    pub(super) fn lifecycle_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let thread = self.shell_thread(&self.thread.as_ref()?.id)?;
        let snoozed = thread
            .snoozed_until
            .as_ref()
            .and_then(|v| v.as_ref())
            .and_then(|v| v.as_ref());
        let settled = super::sidebar_beta::settled(thread);
        if !settled && snoozed.is_none() {
            return None;
        }
        let id = thread.id.clone();
        let snoozed = snoozed.map(|until| until.0.clone());
        let message = snoozed
            .as_ref()
            .map(|until| {
                format!(
                    "Snoozed until {}",
                    chrono::DateTime::parse_from_rfc3339(until)
                        .map(|time| time
                            .with_timezone(&chrono::Local)
                            .format("%a, %b %-d at %-I:%M %p")
                            .to_string())
                        .unwrap_or_else(|_| until.clone())
                )
            })
            .unwrap_or_else(|| {
                "This conversation is settled. Resume whenever you’re ready.".into()
            });
        Some(h_flex().w_full().max_w(px(768.)).mx_auto().p_2().gap_2().rounded_md().bg(cx.theme().muted.opacity(0.65))
            .child(Icon::new(IconName::CircleCheck).size_4().text_color(cx.theme().muted_foreground))
            .child(div().flex_1().min_w_0().text_xs().child(message))
            .child(Button::new("resume-conversation").ghost().small().label("Resume")
                .on_click(cx.listener(move |app, _, window, cx| {
                    if snoozed.is_none() { app.set_thread_settled(id.clone(), false, cx); return; }
                    let Some(client) = app.client.clone() else { return; };
                    let command = ClientOrchestrationCommand::ThreadUnsnooze {
                        command_id: CommandId(fresh_id("unsnooze")), thread_id: id.clone(),
                        reason: vitre_contracts::ClientOrchestrationCommandThreadUnsnoozeReason::User, r#type: Default::default(),
                    };
                    cx.spawn_in(window, async move |_, cx| {
                        if let Err(e) = client.dispatch(&command).await { let _ = cx.update(|window, cx| window.push_notification(Notification::error(e.user_message()), cx)); }
                    }).detach();
                }))).into_any_element())
    }

    pub(super) fn open_editor_comment(
        &self,
        comment: ReviewCommentContext,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(thread_id) = self.thread.as_ref().map(|t| t.id.clone()) else {
            return;
        };
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("What should the agent change or investigate?")
        });
        let owner = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, _| {
            let input = input.clone();
            let comment = comment.clone();
            let owner = owner.clone();
            let thread_id = thread_id.clone();
            dialog.title(format!("{} · {}", comment.file_path, comment.range_label)).w(px(520.))
                .content(move |content, _, cx| {
                    let input = input.clone(); let comment = comment.clone(); let owner = owner.clone(); let thread_id = thread_id.clone();
                    content.child(v_flex().gap_3()
                        .child(div().max_h(px(180.)).overflow_y_scrollbar().p_3().rounded_md().bg(cx.theme().muted)
                            .font_family(cx.theme().mono_font_family.clone()).text_xs().child(comment.diff.clone()))
                        .child(Textarea::new(&input))
                        .child(Button::new("editor-review-add").primary().label("Add to conversation")
                            .on_click(move |_, window, cx| {
                                let text = input.read(cx).value().trim().to_string();
                                if text.is_empty() { return; }
                                let mut comment = comment.clone(); comment.text = text;
                                let added = owner.update(cx, |app, cx| {
                                    if app.thread.as_ref().is_none_or(|t| t.id != thread_id) { return false; }
                                    app.add_review_comment(comment, cx); true
                                }).unwrap_or(false);
                                if added { window.close_dialog(cx); } else { window.push_notification(Notification::warning("Return to the original thread to add this comment."), cx); }
                            })))
                })
        });
    }

    pub(super) fn render_welcome(&self, cx: &mut Context<Self>) -> AnyElement {
        v_flex().size_full().items_center().justify_center().gap_4().px_8()
            .child(self.welcome_orb.clone())
            .child(v_flex().items_center().gap_2()
                .child(div().text_size(px(26.)).font_semibold().child("Make room for your next idea."))
                .child(div().text_sm().text_color(cx.theme().muted_foreground)
                    .child("Explore a question. Shape a plan. Build something useful.")))
            .child(h_flex().gap_2().mt_2().flex_wrap().justify_center()
                .child(Button::new("welcome-explore").icon(IconName::Search).label("Explore this project")
                    .outline().on_click(cx.listener(|app, _, window, cx| {
                        app.composer.update(cx, |input, cx| {
                            let draft = input.value().to_string();
                            let prompt = "Explain this project's architecture and suggest where to start.";
                            input.set_value(if draft.trim().is_empty() { prompt.into() } else { format!("{draft}\n\n{prompt}") }, window, cx);
                            input.focus(window, cx);
                        });
                    })))
                .child(Button::new("welcome-plan").icon(IconName::SquarePen).label("Shape a plan")
                    .outline().on_click(cx.listener(|app, _, window, cx| {
                        app.set_interaction_mode(ProviderInteractionMode::Plan, cx);
                        app.composer.update(cx, |input, cx| { if input.value().trim().is_empty() { input.set_value("Help me plan ", window, cx); } input.focus(window, cx); });
                    }))))
            .child(div().text_xs().text_color(cx.theme().muted_foreground.opacity(0.65))
                .child("@ files    ·    / commands    ·    ⇧↵ new line"))
            .into_any_element()
    }
}

fn reasoning_label(
    descriptors: &[ProviderOptionDescriptor],
    options: &HashMap<String, serde_json::Value>,
) -> String {
    for descriptor in descriptors {
        if let ProviderOptionDescriptor::SelectProviderOptionDescriptor(select) = descriptor {
            let id = select.id.0.to_ascii_lowercase();
            if !id.contains("reasoning") && !id.contains("effort") {
                continue;
            }
            let current = options
                .get(&select.id.0)
                .and_then(serde_json::Value::as_str)
                .or_else(|| {
                    select
                        .current_value
                        .as_ref()
                        .and_then(|v| v.as_ref())
                        .map(|v| v.0.as_str())
                });
            if let Some(option) = select
                .options
                .iter()
                .find(|o| Some(o.id.0.as_str()) == current)
            {
                return option.label.0.clone();
            }
        }
    }
    "Reasoning".into()
}

#[cfg(test)]
mod reasoning_tests {
    use super::*;

    #[test]
    fn reasoning_label_uses_selected_effort_and_ignores_other_traits() {
        let descriptor = |id: &str| {
            serde_json::from_value(serde_json::json!({
                "type":"select", "id":id, "label":id, "currentValue":"medium",
                "options":[{"id":"medium","label":"Medium"},{"id":"high","label":"High"}]
            }))
            .unwrap()
        };
        let descriptors = vec![descriptor("serviceTier"), descriptor("reasoningEffort")];
        assert_eq!(reasoning_label(&descriptors, &HashMap::new()), "Medium");
        let options = HashMap::from([("reasoningEffort".into(), serde_json::json!("high"))]);
        assert_eq!(reasoning_label(&descriptors, &options), "High");
        assert_eq!(reasoning_label(&[], &options), "Reasoning");
    }
}
