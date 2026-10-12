//! Stateful reply forms for clarification questions delivered as assistant text.

use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TextQuestion {
    pub prompt: String,
    pub options: Vec<String>,
}

pub(super) fn parse_text_questions(text: &str) -> Vec<TextQuestion> {
    let mut questions = Vec::<TextQuestion>::new();
    let mut paragraph = String::new();
    let mut fence = None;
    let flush = |paragraph: &mut String, questions: &mut Vec<TextQuestion>| {
        let prompt = std::mem::take(paragraph);
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return;
        }
        if let Some(prompt) = question_prompt(prompt) {
            questions.push(TextQuestion {
                prompt: prompt.to_string(),
                options: inline_choices(prompt),
            });
        } else if !is_reply_hint(prompt) && questions.last().is_some_and(|q| q.options.is_empty()) {
            // An answer paragraph following a rhetorical question isn't a
            // clarification request. Keep explicit choice groups, however.
            questions.pop();
        }
    };
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            flush(&mut paragraph, &mut questions);
            let marker = &line[..3];
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if line.is_empty() {
            flush(&mut paragraph, &mut questions);
            continue;
        }
        if let Some(item) = list_item(line) {
            flush(&mut paragraph, &mut questions);
            if question_prompt(item).is_some() {
                paragraph.push_str(item);
            } else if let Some(question) = questions.last_mut() {
                question.options.push(plain_label(item));
            }
        } else {
            if question_prompt(&paragraph).is_some() {
                flush(&mut paragraph, &mut questions);
            }
            if !paragraph.is_empty() {
                paragraph.push(' ');
            }
            paragraph.push_str(line);
        }
    }
    flush(&mut paragraph, &mut questions);
    for question in &mut questions {
        question.options.retain(|option| !option.is_empty());
        question.options.dedup();
    }
    questions
}

fn list_item(line: &str) -> Option<&str> {
    for prefix in ["- ", "* ", "+ ", "• "] {
        if let Some(item) = line.strip_prefix(prefix) {
            return Some(item.trim());
        }
    }
    let (prefix, rest) = line.split_once(['.', ')'])?;
    let numbered = !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit());
    let lettered = prefix.len() == 1 && prefix.chars().all(|c| c.is_ascii_alphabetic());
    ((numbered || lettered) && rest.starts_with(' ')).then(|| rest.trim())
}

fn plain_label(text: &str) -> String {
    text.replace("**", "").replace("__", "").replace('`', "")
}

fn question_prompt(text: &str) -> Option<&str> {
    let end = text.rfind('?')? + 1;
    let suffix = text[end..].trim_matches([' ', '*', '_', '`']);
    if suffix.is_empty() {
        Some(text)
    } else if is_reply_hint(suffix) {
        Some(&text[..end])
    } else {
        None
    }
}

fn is_reply_hint(text: &str) -> bool {
    let lower = plain_label(text).to_lowercase();
    [
        "you can reply",
        "you can answer",
        "please reply",
        "please choose",
        "let me know",
        "i'll wait",
        "a brief description",
        "options:",
        "choose one",
        "pick one",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

fn inline_choices(prompt: &str) -> Vec<String> {
    // Only expose alternatives the model explicitly labels. Splitting arbitrary
    // prose on "or" could change the meaning of a decision about code or funds.
    for marker in ["**", "__"] {
        let spans = prompt.split(marker).collect::<Vec<_>>();
        if spans.len() == 5 && spans[2].to_lowercase().contains(" or ") {
            return vec![plain_label(spans[1]), plain_label(spans[3])];
        }
    }
    Vec::new()
}

pub(super) fn pending_text_questions(
    messages: &[OrchestrationMessage],
    answered_through: Option<&str>,
) -> Option<(MessageId, Vec<TextQuestion>)> {
    messages
        .iter()
        .rev()
        .take_while(|message| message.role != OrchestrationMessageRole::User)
        .filter(|message| message.role == OrchestrationMessageRole::Assistant && !message.streaming)
        .filter(|message| answered_through.is_none_or(|at| message.updated_at.0.as_str() > at))
        .find_map(|message| {
            let questions = parse_text_questions(&message.text.0);
            (!questions.is_empty()).then(|| (message.id.clone(), questions))
        })
}

#[cfg(debug_assertions)]
type QuestionOptionBounds =
    std::rc::Rc<std::cell::RefCell<HashMap<(usize, usize), gpui::Bounds<gpui::Pixels>>>>;

pub(super) struct TextQuestionForm {
    pub message_id: MessageId,
    pub questions: Vec<TextQuestion>,
    pub inputs: Vec<Entity<TextareaState>>,
    _subscriptions: Vec<Subscription>,
    #[cfg(debug_assertions)]
    pub option_bounds: QuestionOptionBounds,
}

impl ChatApp {
    pub(super) fn sync_text_question_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let candidate = if self.active_pending_user_input().is_some() {
            None
        } else {
            // Native question replies are activities, not user messages. Do
            // not resurrect their preceding text when the request resolves.
            let answered_through = self
                .thread
                .as_ref()
                .and_then(|thread| thread.state.view.as_ref())
                .and_then(|view| {
                    view.activities
                        .iter()
                        .filter(|activity| activity.kind.0 == "user-input.resolved")
                        .map(|activity| activity.created_at.0.as_str())
                        .max()
                });
            pending_text_questions(&self.display_messages, answered_through)
        };
        if self
            .text_question_form
            .as_ref()
            .map(|f| (&f.message_id, &f.questions))
            == candidate.as_ref().map(|(id, questions)| (id, questions))
        {
            return;
        }
        let previous = self.text_question_form.take();
        self.text_question_form = candidate.map(|(message_id, questions)| {
            let mut subscriptions = Vec::new();
            let inputs = questions
                .iter()
                .map(|question| {
                    // Preserve answers when the same message gains more questions.
                    let saved = previous
                        .as_ref()
                        .filter(|old| old.message_id == message_id)
                        .and_then(|old| {
                            old.questions
                                .iter()
                                .position(|q| q == question)
                                .map(|i| old.inputs[i].read(cx).value().to_string())
                        });
                    let input = cx.new(|cx| {
                        let mut input = TextareaState::new(window, cx)
                            .placeholder("Type your answer…")
                            .auto_grow(2, 5);
                        if let Some(saved) = saved {
                            input.set_value(saved, window, cx);
                        }
                        input
                    });
                    let id = message_id.clone();
                    subscriptions.push(cx.subscribe(
                        &input,
                        move |this, _, event: &InputEvent, cx| {
                            if matches!(event, InputEvent::Change) {
                                this.remeasure_text_question(&id, cx);
                            }
                        },
                    ));
                    input
                })
                .collect();
            TextQuestionForm {
                message_id,
                questions,
                inputs,
                _subscriptions: subscriptions,
                #[cfg(debug_assertions)]
                option_bounds: Default::default(),
            }
        });
        if let Some(old) = previous {
            self.remeasure_text_question(&old.message_id, cx);
        }
        if let Some(form) = &self.text_question_form {
            self.remeasure_text_question(&form.message_id.clone(), cx);
        }
    }

    fn remeasure_text_question(&mut self, id: &MessageId, cx: &mut Context<Self>) {
        if let Some(index) = self.timeline.iter().position(|row| match row {
            TimelineRow::Message(i) => self.display_messages.get(*i).is_some_and(|m| &m.id == id),
            _ => false,
        }) {
            self.remeasure_row(index, cx);
        }
        cx.notify();
    }

    pub(super) fn text_question_answers(&self, cx: &Context<Self>) -> Option<String> {
        let form = self.text_question_form.as_ref()?;
        let mut reply = String::from("Answers to your questions:");
        for (question, input) in form.questions.iter().zip(&form.inputs) {
            let value = input.read(cx).value();
            let answer = value.trim();
            if answer.is_empty() {
                return None;
            }
            reply.push_str(&format!(
                "\n\n{}\n{}",
                plain_label(&question.prompt),
                answer
            ));
        }
        Some(reply)
    }

    pub(super) fn can_send_text_answers(&self, cx: &Context<Self>) -> bool {
        self.client.is_some()
            && self.local_dispatch.is_none()
            && self.text_question_answers(cx).is_some()
            && self
                .thread
                .as_ref()
                .and_then(|t| t.state.view.as_ref())
                .is_some_and(|view| {
                    !view
                        .session
                        .as_ref()
                        .is_some_and(|s| s.status == OrchestrationSessionStatus::Running)
                        && derive_pending_approvals(&view.activities).is_empty()
                        && derive_pending_user_inputs(&view.activities).is_empty()
                })
    }

    fn send_text_answers(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_send_text_answers(cx) {
            return;
        }
        let Some(reply) = self.text_question_answers(cx) else {
            return;
        };
        let existing = self.composer.read(cx).value().to_string();
        let text = if existing.trim().is_empty() {
            reply
        } else {
            format!("{existing}\n\n{reply}")
        };
        self.composer
            .update(cx, |input, cx| input.set_value(text, window, cx));
        self.send(window, cx);
    }

    pub(super) fn render_text_question_card(
        &self,
        message_id: &MessageId,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let form = self
            .text_question_form
            .as_ref()
            .filter(|form| &form.message_id == message_id)?;
        let mut card = v_flex()
            .w_full()
            .min_w_0()
            .mt_2()
            .gap_3()
            .rounded(cx.theme().radius)
            .border_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().secondary)
            .p_3()
            .child(
                div()
                    .text_xs()
                    .font_semibold()
                    .text_color(cx.theme().muted_foreground)
                    .child("Questions for you"),
            );
        for (question_index, (question, input)) in
            form.questions.iter().zip(&form.inputs).enumerate()
        {
            let mut group = v_flex()
                .w_full()
                .min_w_0()
                .gap_2()
                .child(assistant_markdown(
                    SharedString::from(format!("question-{}-{question_index}", message_id.0)),
                    SharedString::from(question.prompt.clone()),
                    Some(cx.entity().downgrade()),
                ));
            let selected = input.read(cx).value().to_string();
            for (option_index, option) in question.options.iter().enumerate() {
                let answer = option.clone();
                let input = input.clone();
                group = group.child(
                    div()
                        .id(SharedString::from(format!(
                            "question-option-{}-{question_index}-{option_index}",
                            message_id.0
                        )))
                        .w_full()
                        .min_w_0()
                        .rounded(cx.theme().radius)
                        .border_1()
                        .border_color(if selected == *option {
                            cx.theme().primary
                        } else {
                            cx.theme().border
                        })
                        .bg(if selected == *option {
                            cx.theme().primary.opacity(0.1)
                        } else {
                            cx.theme().background
                        })
                        .px_3()
                        .py_2()
                        .text_sm()
                        .cursor_pointer()
                        .hover(|s| s.bg(cx.theme().accent))
                        .child(chat_text(option.clone()))
                        .map(|row| {
                            #[cfg(debug_assertions)]
                            {
                                let bounds = form.option_bounds.clone();
                                row.relative().child(
                                    gpui::canvas(
                                        move |area, _, _| {
                                            bounds
                                                .borrow_mut()
                                                .insert((question_index, option_index), area);
                                        },
                                        |_, _, _, _| {},
                                    )
                                    .absolute()
                                    .top_0()
                                    .left_0()
                                    .size_full(),
                                )
                            }
                            #[cfg(not(debug_assertions))]
                            {
                                row
                            }
                        })
                        .on_click(cx.listener(move |_, _, window, cx| {
                            input.update(cx, |state, cx| {
                                state.replace_all(answer.clone(), window, cx)
                            });
                            input.focus_handle(cx).focus(window, cx);
                            cx.notify();
                        })),
                );
            }
            group = group
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(if question.options.is_empty() {
                            "Your answer"
                        } else {
                            "Your answer — choose above or write your own"
                        }),
                )
                .child(
                    div()
                        .w_full()
                        .min_w_0()
                        .rounded(cx.theme().radius)
                        .border_1()
                        .border_color(cx.theme().border)
                        .bg(cx.theme().background)
                        .px_2()
                        .py_1()
                        .child(Textarea::new(input).appearance(false)),
                );
            card = card.child(group);
        }
        Some(
            card.child(
                h_flex().justify_end().child(
                    Button::new("send-question-answers")
                        .label("Send answers")
                        .primary()
                        .small()
                        .disabled(!self.can_send_text_answers(cx))
                        .on_click(
                            cx.listener(|this, _, window, cx| this.send_text_answers(window, cx)),
                        ),
                ),
            )
            .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_choice_and_free_text_questions() {
        let text = "When should I ask?\n- One at a time\n- All together\n\nWhat next?";
        let questions = parse_text_questions(text);
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].options, ["One at a time", "All together"]);
        assert!(questions[1].options.is_empty());
    }

    #[test]
    fn excludes_questions_inside_finished_explanation() {
        assert!(
            parse_text_questions("Why did it fail?\nBecause the event was missing.").is_empty()
        );
    }

    #[test]
    fn recognizes_screenshot_alternatives_and_wrapped_markdown() {
        let questions = parse_text_questions(
            "No—the contracts cannot change.\n\nSince nothing is publicly deployed yet, we can change this. Should upgrades affect **existing pools**, or should\nnew versions apply **only to future pools**, leaving active pools unchanged?",
        );
        assert_eq!(questions.len(), 1);
        assert_eq!(
            questions[0].options,
            ["existing pools", "only to future pools"]
        );
    }

    #[test]
    fn accepts_numbered_choices_bold_questions_and_reply_hint() {
        let questions = parse_text_questions(
            "**Which mode?**\n1. **Build**\n2. Ask\n\nWhere are the resources?\n\nYou can reply with a path.",
        );
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].options, ["Build", "Ask"]);
    }

    #[test]
    fn does_not_invent_choices_or_parse_code_examples() {
        let questions = parse_text_questions(
            "Which changes should apply to old or new pools?\n\n```text\nWhich mode?\n- Build\n- Ask\n```",
        );
        assert_eq!(questions.len(), 1);
        assert!(questions[0].options.is_empty());
    }

    #[test]
    fn accepts_free_text_question_with_inline_reply_hint() {
        let questions = parse_text_questions("What next? A brief description is enough.");
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].prompt, "What next?");
    }

    #[test]
    fn unanswered_card_survives_followup_but_stops_at_user_reply() {
        let make_message = |id: &str, role, text: &str| OrchestrationMessage {
            id: MessageId(id.into()),
            role,
            text: tnes(text),
            streaming: false,
            attachments: None,
            created_at: tnes("2026-09-26T00:00:00Z"),
            updated_at: tnes("2026-09-26T00:00:00Z"),
            turn_id: None,
        };
        let mut messages = vec![
            make_message(
                "question",
                OrchestrationMessageRole::Assistant,
                "Which mode?\n- Build\n- Ask",
            ),
            make_message(
                "followup",
                OrchestrationMessageRole::Assistant,
                "I’ll wait for your answer.",
            ),
        ];
        assert_eq!(
            pending_text_questions(&messages, None).unwrap().0.0,
            "question"
        );
        assert!(
            pending_text_questions(&messages, Some("2026-09-26T00:00:01Z")).is_none(),
            "native answers must also dismiss the text fallback"
        );
        messages.push(make_message(
            "reply",
            OrchestrationMessageRole::User,
            "Build",
        ));
        assert!(pending_text_questions(&messages, None).is_none());
        messages.push(make_message(
            "streaming",
            OrchestrationMessageRole::Assistant,
            "Which mode?",
        ));
        messages.last_mut().unwrap().streaming = true;
        assert!(pending_text_questions(&messages, None).is_none());
    }
}
