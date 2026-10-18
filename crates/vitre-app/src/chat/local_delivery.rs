//! Durable local turn delivery. A retry is the original command, never a new turn.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum LocalDelivery {
    Submitting,
    Accepted,
    Unknown,
    Rejected,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct LocalPendingSend {
    pub thread_id: ThreadId,
    pub command: ClientOrchestrationCommand,
    #[serde(default)]
    pub create: Option<ClientOrchestrationCommand>,
    #[serde(default)]
    previous_turn: Option<vitre_contracts::TurnId>,
    #[serde(default)]
    steering: bool,
    #[serde(default)]
    previous_session_update: Option<String>,
    pub recovery: PendingSend,
    pub optimistic: OrchestrationMessage,
    pub delivery: LocalDelivery,
    pub error: Option<String>,
}
impl LocalPendingSend {
    pub(super) fn for_plan(
        create: ClientOrchestrationCommand,
        command: ClientOrchestrationCommand,
    ) -> Self {
        let ClientOrchestrationCommand::ThreadTurnStart {
            thread_id,
            message,
            created_at,
            ..
        } = &command
        else {
            unreachable!("plan starts a turn")
        };
        let recovery = PendingSend {
            message_id: message.message_id.clone(),
            raw_text: message.text.0.clone(),
            attachments: vec![],
            review_comments: vec![],
            terminal_contexts: vec![],
        };
        let optimistic = OrchestrationMessage {
            id: message.message_id.clone(),
            role: OrchestrationMessageRole::User,
            text: message.text.clone(),
            attachments: None,
            streaming: false,
            turn_id: None,
            created_at: created_at.clone(),
            updated_at: created_at.clone(),
        };
        Self {
            thread_id: thread_id.clone(),
            command,
            create: Some(create),
            previous_turn: None,
            steering: false,
            previous_session_update: None,
            recovery,
            optimistic,
            delivery: LocalDelivery::Submitting,
            error: None,
        }
    }
    pub fn command_id(&self) -> &str {
        match &self.command {
            ClientOrchestrationCommand::ThreadTurnStart { command_id, .. } => &command_id.0,
            _ => "",
        }
    }
    pub fn acknowledged(&self, view: &vitre_contracts::OrchestrationThread) -> bool {
        view.messages.iter().any(|message| {
            message.id == self.optimistic.id
                && message.role == OrchestrationMessageRole::User
                && message.text == self.optimistic.text
        })
    }
    fn execution_observed(&self, view: &vitre_contracts::OrchestrationThread) -> bool {
        // A steer joins an existing turn; its exact projected message is the
        // acknowledgement. Waiting for a new turn ID would fence every later send.
        (self.steering && self.acknowledged(view))
            || view
                .latest_turn
                .as_ref()
                .is_some_and(|turn| Some(&turn.turn_id) != self.previous_turn.as_ref())
            || view.session.as_ref().is_some_and(|session| {
                session.status == OrchestrationSessionStatus::Error
                    && self.previous_session_update.as_ref() != Some(&session.updated_at.0)
            })
    }
    fn restored(mut self) -> Self {
        if self.delivery == LocalDelivery::Submitting {
            self.delivery = LocalDelivery::Unknown;
        }
        self
    }
}

pub(super) fn rejected_error(
    error: &vitre_rpc::TypedError<vitre_contracts::methods::OrchestrationDispatchCommandErrorX>,
) -> bool {
    match error {
        vitre_rpc::TypedError::Failed(error) => {
            serde_json::to_value(error).ok().is_some_and(|value| {
                value.get("requestDisposition").and_then(|v| v.as_str()) == Some("rejected")
            })
        }
        _ => false,
    }
}

fn restored_text(rejected: &str, current: &str) -> String {
    if rejected.is_empty() {
        current.into()
    } else if current.is_empty() {
        rejected.into()
    } else {
        format!("{rejected}\n\n{current}")
    }
}

impl ChatApp {
    pub(super) fn begin_local_delivery(
        &mut self,
        thread_id: ThreadId,
        command: ClientOrchestrationCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(recovery), Some(optimistic)) = (
            self.pending_send.clone(),
            self.optimistic_user_messages.last().cloned(),
        ) else {
            return;
        };
        let pending = LocalPendingSend {
            thread_id: thread_id.clone(),
            command,
            create: None,
            previous_turn: self
                .thread
                .as_ref()
                .and_then(|open| open.state.view.as_ref())
                .and_then(|view| view.latest_turn.as_ref())
                .map(|turn| turn.turn_id.clone()),
            steering: self
                .thread
                .as_ref()
                .and_then(|open| open.state.view.as_ref())
                .is_some_and(|view| {
                    view.latest_turn.as_ref().is_some_and(|turn| {
                        turn.state == OrchestrationLatestTurnState::Running
                            && view.session.as_ref().is_some_and(|session| {
                                session.active_turn_id.as_ref() == Some(&turn.turn_id)
                            })
                    })
                }),
            previous_session_update: self
                .thread
                .as_ref()
                .and_then(|open| open.state.view.as_ref())
                .and_then(|view| view.session.as_ref())
                .map(|session| session.updated_at.0.clone()),
            recovery,
            optimistic,
            delivery: LocalDelivery::Submitting,
            error: None,
        };
        let mut draft = self.capture_composer_draft(cx);
        draft.pending_local = Some(pending.clone());
        self.queue_local_delivery(pending, draft, window, cx);
    }

    pub(super) fn queue_local_delivery(
        &mut self,
        pending: LocalPendingSend,
        draft: drafts::ComposerDraft,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let thread_id = pending.thread_id.clone();
        self.local_outbox.insert(thread_id.clone(), pending.clone());
        // Confirm the complete immutable payload is durable before any network request.
        let persisted = self.drafts.save_confirmed(&thread_id.0, &draft);
        let client = self.client.clone();
        let executor = cx.background_executor().clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = match persisted.await {
                Ok(Ok(())) => {
                    if let Some(client) = client {
                        dispatch_pending(&client, &pending, &executor).await
                    } else {
                        (LocalDelivery::Unknown, Some("Desktop service is disconnected. Check delivery after reconnecting.".into()))
                    }
                }
                error => (LocalDelivery::Rejected, Some(format!("Could not save your message before sending: {error:?}"))),
            };
            let _ = this.update_in(cx, |app, window, cx| {
                app.finish_local_delivery(&pending.thread_id, pending.command_id(), result, window, cx);
            });
        }).detach();
    }

    fn finish_local_delivery(
        &mut self,
        thread_id: &ThreadId,
        command_id: &str,
        (delivery, error): (LocalDelivery, Option<String>),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(pending) = self
            .local_outbox
            .get_mut(thread_id)
            .filter(|pending| pending.command_id() == command_id)
        else {
            return;
        };
        // Once acceptance is confirmed, a delayed transport error cannot undo it.
        if pending.delivery == LocalDelivery::Accepted && delivery != LocalDelivery::Accepted {
            return;
        }
        pending.delivery = delivery;
        pending.error = error;
        let implementing_plan = matches!(
            &pending.command,
            ClientOrchestrationCommand::ThreadTurnStart {
                source_proposed_plan: Some(_),
                ..
            }
        );
        self.drafts
            .update_local_pending(thread_id, command_id, Some(pending));
        if self
            .thread
            .as_ref()
            .is_some_and(|open| &open.id == thread_id)
        {
            if delivery == LocalDelivery::Rejected {
                self.restore_rejected_local_send(window, cx);
            } else {
                self.reconcile_local_dispatch();
                if delivery == LocalDelivery::Accepted && implementing_plan {
                    self.open_workspace_surface(
                        vitre_state::right_panel::SurfaceKind::Plan,
                        window,
                        cx,
                    );
                }
            }
            self.rebuild_timeline(cx);
            cx.notify();
        }
    }

    pub(super) fn restore_local_outbox(
        &mut self,
        saved: Option<LocalPendingSend>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(open) = self
            .thread
            .as_ref()
            .filter(|open| matches!(open.feed, ThreadFeed::Local { .. }))
        else {
            return;
        };
        let thread_id = open.id.clone();
        if let Some(saved) = saved.filter(|p| p.thread_id == thread_id) {
            self.local_outbox
                .entry(thread_id.clone())
                .or_insert_with(|| saved.restored());
        }
        self.reconcile_local_dispatch();
        if self
            .local_outbox
            .get(&thread_id)
            .is_some_and(|p| p.delivery == LocalDelivery::Rejected)
        {
            self.restore_rejected_local_send(window, cx);
            return;
        }
        let Some(pending) = self.local_outbox.get(&thread_id) else {
            return;
        };
        self.pending_send = Some(pending.recovery.clone());
        self.local_dispatch = self
            .thread
            .as_ref()
            .and_then(|open| open.state.view.as_ref())
            .map(|view| {
                LocalDispatchSnapshot::capture(view, pending.optimistic.created_at.clone())
            });
        if !self
            .optimistic_user_messages
            .iter()
            .any(|m| m.id == pending.optimistic.id)
        {
            self.optimistic_user_messages
                .push(pending.optimistic.clone());
        }
        if let Some(attachments) = pending
            .optimistic
            .attachments
            .as_ref()
            .and_then(|a| a.as_ref())
        {
            for (attachment, recovery) in attachments.iter().zip(&pending.recovery.attachments) {
                let id = match attachment {
                    ChatAttachment::ChatImageAttachment(a) => &a.id.0,
                    ChatAttachment::ChatFileAttachment(a) => &a.id.0,
                    _ => continue,
                };
                self.attachment_urls
                    .insert(id.clone(), recovery.data_url.clone().into());
            }
        }
        self.rebuild_timeline(cx);
    }

    pub(super) fn reconcile_local_dispatch(&mut self) {
        let Some(open) = self.thread.as_ref() else {
            return;
        };
        let Some(view) = open.state.view.as_ref() else {
            return;
        };
        self.optimistic_user_messages.retain(|optimistic| {
            !view
                .messages
                .iter()
                .any(|message| message.id == optimistic.id)
        });
        let Some(pending) = self.local_outbox.get_mut(&open.id) else {
            return;
        };
        if !pending.acknowledged(view) {
            return;
        }
        if !pending.execution_observed(view) {
            // The user-message projection precedes provider startup. Acceptance is known,
            // but the old settled turn must not enable a second send during this gap.
            if pending.delivery != LocalDelivery::Accepted {
                pending.delivery = LocalDelivery::Accepted;
                pending.error = None;
                self.drafts
                    .update_local_pending(&open.id, pending.command_id(), Some(pending));
            }
            return;
        }
        let pending = self.local_outbox.remove(&open.id).unwrap();
        self.drafts
            .update_local_pending(&open.id, pending.command_id(), None);
        self.local_dispatch = None;
        self.pending_send = None;
    }

    fn restore_rejected_local_send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(thread_id) = self.thread.as_ref().map(|open| open.id.clone()) else {
            return;
        };
        if !self
            .local_outbox
            .get(&thread_id)
            .is_some_and(|p| p.delivery == LocalDelivery::Rejected)
        {
            return;
        }
        let pending = self.local_outbox.remove(&thread_id).unwrap();
        self.local_dispatch = None;
        self.pending_send = None;
        self.optimistic_user_messages
            .retain(|m| m.id != pending.optimistic.id);
        let text = restored_text(
            &pending.recovery.raw_text,
            self.composer.read(cx).value().as_ref(),
        );
        self.composer
            .update(cx, |input, cx| input.set_value(text, window, cx));
        // Restore before newer context; never erase input added while the send was in flight.
        let mut attachments = pending.recovery.attachments;
        attachments.append(&mut self.pending_attachments);
        self.pending_attachments = attachments;
        let mut comments = pending.recovery.review_comments;
        comments.append(&mut self.pending_review_comments);
        self.pending_review_comments = comments;
        let mut terminals = pending.recovery.terminal_contexts;
        terminals.append(&mut self.pending_terminal_contexts);
        self.pending_terminal_contexts = terminals;
        self.last_error = pending.error.map(Into::into);
        self.save_composer_draft(cx);
        self.rebuild_timeline(cx);
    }

    pub(super) fn retry_pending_local_send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(thread_id) = self.thread.as_ref().map(|open| open.id.clone()) else {
            return;
        };
        let Some(client) = self.client.clone() else {
            return;
        };
        let Some(pending) = self
            .local_outbox
            .get_mut(&thread_id)
            .filter(|p| matches!(p.delivery, LocalDelivery::Unknown | LocalDelivery::Accepted))
        else {
            return;
        };
        let was_accepted = pending.delivery == LocalDelivery::Accepted;
        if !was_accepted {
            pending.delivery = LocalDelivery::Submitting;
        }
        let pending = pending.clone();
        self.drafts
            .update_local_pending(&thread_id, pending.command_id(), Some(&pending));
        let executor = cx.background_executor().clone();
        cx.spawn_in(window, async move |this, cx| {
            // A new subscription yields an authoritative snapshot before a retry is considered.
            let subscription = client.open_thread(thread_id.clone());
            let mut states = subscription.state();
            let snapshot = async {
                loop {
                    let state = states.borrow().clone();
                    if state.phase == SyncPhase::Live && state.view.is_some() {
                        break state.view;
                    }
                    if states.changed().await.is_err() {
                        break None;
                    }
                }
            };
            let timeout = executor.timer(Duration::from_secs(10));
            futures::pin_mut!(snapshot, timeout);
            let view = match futures::future::select(snapshot, timeout).await {
                futures::future::Either::Left((view, _)) => view,
                futures::future::Either::Right(_) => None,
            };
            let result = if let Some(view) = view {
                if pending.acknowledged(&view) || was_accepted {
                    (LocalDelivery::Accepted, None)
                } else {
                    // Server command receipts deduplicate this unchanged command ID and payload.
                    dispatch_with_timeout(&client, &pending.command, &executor).await
                }
            } else if was_accepted {
                (LocalDelivery::Accepted, None)
            } else if pending.create.is_some() {
                dispatch_pending(&client, &pending, &executor).await
            } else {
                (
                    LocalDelivery::Unknown,
                    Some(
                        "Unable to confirm delivery while disconnected. Your message is saved."
                            .into(),
                    ),
                )
            };
            let _ = this.update_in(cx, |app, window, cx| {
                app.finish_local_delivery(&thread_id, pending.command_id(), result, window, cx);
            });
        })
        .detach();
        cx.notify();
    }
}

async fn dispatch_pending(
    client: &vitre_client::EnvironmentClient,
    pending: &LocalPendingSend,
    executor: &gpui::BackgroundExecutor,
) -> (LocalDelivery, Option<String>) {
    if let Some(create) = pending.create.as_ref() {
        let result = dispatch_with_timeout(client, create, executor).await;
        if result.0 != LocalDelivery::Accepted {
            return result;
        }
    }
    dispatch_with_timeout(client, &pending.command, executor).await
}

async fn dispatch_with_timeout(
    client: &vitre_client::EnvironmentClient,
    command: &ClientOrchestrationCommand,
    executor: &gpui::BackgroundExecutor,
) -> (LocalDelivery, Option<String>) {
    let request = client.dispatch(command);
    let timeout = executor.timer(Duration::from_secs(30));
    futures::pin_mut!(request, timeout);
    match futures::future::select(request, timeout).await {
        futures::future::Either::Left((Ok(_), _)) => (LocalDelivery::Accepted, None),
        futures::future::Either::Left((Err(error), _)) => (
            if rejected_error(&error) { LocalDelivery::Rejected } else { LocalDelivery::Unknown },
            Some(error.user_message()),
        ),
        futures::future::Either::Right(_) => (LocalDelivery::Unknown, Some("Delivery confirmation timed out. Your message is saved; check delivery before retrying.".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    fn pending(id: &str) -> LocalPendingSend {
        let at = tnes("2026-10-16T10:00:00Z");
        let message_id = MessageId(format!("{id}-message"));
        LocalPendingSend {
            thread_id: ThreadId("local-thread".into()),
            create: None,
            previous_turn: None,
            steering: false,
            previous_session_update: None,
            command: ClientOrchestrationCommand::ThreadTurnStart {
                bootstrap: None,
                command_id: CommandId(id.into()),
                created_at: at.clone(),
                interaction_mode: ProviderInteractionMode::Default,
                message: vitre_contracts::ClientOrchestrationCommandThreadTurnStartMessage {
                    attachments: vec![],
                    message_id: message_id.clone(),
                    role: Default::default(),
                    text: tnes("original request"),
                },
                model_selection: None,
                runtime_mode: RuntimeMode::FullAccess,
                source_proposed_plan: None,
                thread_id: ThreadId("local-thread".into()),
                title_seed: None,
                r#type: Default::default(),
            },
            recovery: PendingSend {
                message_id: message_id.clone(),
                raw_text: "original request".into(),
                attachments: vec![],
                review_comments: vec![],
                terminal_contexts: vec![],
            },
            optimistic: OrchestrationMessage {
                attachments: None,
                created_at: at.clone(),
                updated_at: at,
                id: message_id,
                role: OrchestrationMessageRole::User,
                streaming: false,
                text: tnes("original request"),
                turn_id: None,
            },
            delivery: LocalDelivery::Submitting,
            error: None,
        }
    }

    #[test]
    fn restart_retains_the_immutable_command_and_never_assumes_acceptance() {
        let original = pending("original-command");
        let bytes = serde_json::to_vec(&original).unwrap();
        let restored: LocalPendingSend = serde_json::from_slice(&bytes).unwrap();
        let restored = restored.restored();
        assert_eq!(restored.delivery, LocalDelivery::Unknown);
        assert_eq!(
            serde_json::to_value(&restored.command).unwrap(),
            serde_json::to_value(&original.command).unwrap()
        );
        let mut view = crate::cloud::tests::fixtures::thread();
        assert!(!restored.acknowledged(&view));
        let mut unrelated = restored.optimistic.clone();
        unrelated.id = MessageId("another-request".into());
        view.messages.push(unrelated);
        assert!(
            !restored.acknowledged(&view),
            "another identical prompt is not acceptance"
        );
        view.messages.push(restored.optimistic.clone());
        assert!(restored.acknowledged(&view));
    }

    #[test]
    fn new_plan_persists_creation_and_turn_intent_with_original_keys() {
        let original = pending("plan-command");
        let mut view = crate::cloud::tests::fixtures::thread();
        view.id = original.thread_id.clone();
        let create = ClientOrchestrationCommand::ThreadCreate {
            additional_roots: None,
            branch: view.branch.clone(),
            command_id: CommandId("create-command".into()),
            created_at: original.optimistic.created_at.clone(),
            interaction_mode: Some(Some(ProviderInteractionMode::Default)),
            model_selection: view.model_selection.clone(),
            project_id: view.project_id.clone(),
            runtime_mode: RuntimeMode::FullAccess,
            thread_id: original.thread_id.clone(),
            title: tnes("Implement plan"),
            r#type: Default::default(),
            worktree_path: None,
        };
        let planned = LocalPendingSend::for_plan(create.clone(), original.command.clone());
        let restored: LocalPendingSend =
            serde_json::from_slice(&serde_json::to_vec(&planned).unwrap()).unwrap();
        assert_eq!(restored.create, Some(create));
        assert_eq!(restored.command, original.command);
        assert_eq!(restored.restored().delivery, LocalDelivery::Unknown);
        let mut accepted = original;
        accepted.delivery = LocalDelivery::Accepted;
        assert_eq!(accepted.restored().delivery, LocalDelivery::Accepted);
    }
    #[test]
    fn matching_message_accepts_delivery_but_does_not_end_the_startup_fence() {
        let pending = pending("starting");
        let mut view = crate::cloud::tests::fixtures::thread();
        view.messages.push(pending.optimistic.clone());
        assert!(pending.acknowledged(&view));
        assert!(!pending.execution_observed(&view));
        view.latest_turn = Some(serde_json::from_value(serde_json::json!({
            "turnId":"provider-turn", "state":"running", "requestedAt":"2026-10-16T10:00:00Z",
            "startedAt":null, "completedAt":null, "assistantMessageId":null, "sourceProposedPlan":null
        })).unwrap());
        assert!(pending.execution_observed(&view));
    }
    #[test]
    fn steering_acknowledges_the_exact_message_without_a_new_turn() {
        let mut pending = pending("steering");
        let mut view = crate::cloud::tests::fixtures::thread();
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId":"same-turn", "state":"running", "requestedAt":"2026-10-16T10:00:00Z",
                "startedAt":"2026-10-16T10:00:01Z", "completedAt":null,
                "assistantMessageId":null, "sourceProposedPlan":null
            }))
            .unwrap(),
        );
        pending.previous_turn = view.latest_turn.as_ref().map(|turn| turn.turn_id.clone());
        pending.steering = true;
        let pending: LocalPendingSend =
            serde_json::from_slice(&serde_json::to_vec(&pending).unwrap()).unwrap();
        assert!(!pending.execution_observed(&view));
        let mut unrelated = pending.optimistic.clone();
        unrelated.id = MessageId("different-message".into());
        view.messages.push(unrelated);
        assert!(!pending.execution_observed(&view));
        view.messages.push(pending.optimistic.clone());
        assert!(pending.execution_observed(&view));
        // Providers may finish the original turn before the message projection arrives.
        view.latest_turn.as_mut().unwrap().state = OrchestrationLatestTurnState::Completed;
        assert!(pending.execution_observed(&view));
    }
    #[test]
    fn only_explicit_rejection_restores_a_draft() {
        type E =
            vitre_rpc::TypedError<vitre_contracts::methods::OrchestrationDispatchCommandErrorX>;
        for disposition in [None, Some("unknown"), Some("rejected")] {
            let mut value = serde_json::json!({"_tag":"OrchestrationDispatchCommandError", "message":"Request failed"});
            if let Some(disposition) = disposition {
                value["requestDisposition"] = disposition.into();
            }
            let error = E::Failed(serde_json::from_value(value).unwrap());
            assert_eq!(rejected_error(&error), disposition == Some("rejected"));
        }
        assert!(!rejected_error(&E::Rpc(
            vitre_rpc::RpcError::ConnectionClosed
        )));
        assert_eq!(
            restored_text("old request", "new typing"),
            "old request\n\nnew typing"
        );
    }

    #[test]
    fn disk_updates_are_scoped_to_the_original_command_and_preserve_new_input() {
        let home = std::env::temp_dir().join(fresh_id("vitre-local-outbox"));
        let store = drafts::DraftStore::new(&home);
        let first = pending("first");
        let draft: drafts::ComposerDraft = serde_json::from_value(serde_json::json!({
            "text":"new typing", "pending_local":first,
        }))
        .unwrap();
        futures::executor::block_on(store.save_confirmed("local-thread", &draft))
            .unwrap()
            .unwrap();
        let mut accepted = first.clone();
        accepted.delivery = LocalDelivery::Accepted;
        store.update_local_pending(&first.thread_id, "first", Some(&accepted));
        let saved = store.load("local-thread");
        let value = serde_json::to_value(&saved).unwrap();
        assert_eq!(value["text"], "new typing");
        assert_eq!(
            saved.pending_local.unwrap().delivery,
            LocalDelivery::Accepted
        );
        store.update_local_pending(&first.thread_id, "older-command", None);
        assert!(store.load("local-thread").pending_local.is_some());
        store.update_local_pending(&first.thread_id, "first", None);
        assert!(store.load("local-thread").pending_local.is_none());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[gpui::test]
    fn delayed_rejection_after_navigation_restores_once_and_keeps_new_input(
        cx: &mut TestAppContext,
    ) {
        let home = std::env::temp_dir().join(fresh_id("vitre-local-delivery-ui"));
        cx.update(|cx| {
            gpui_component::init(cx);
            ClientSettings::init(cx, &home);
        });
        let holder = std::rc::Rc::new(std::cell::RefCell::new(None));
        let capture = holder.clone();
        let (_, cx) = cx.add_window_view(move |window, cx| {
            let (_, status) = watch::channel(SupervisorStatus::Idle);
            let app = cx.new(|cx| ChatApp::new_with_backend(&home, status, false, window, cx));
            *capture.borrow_mut() = Some(app.clone());
            Root::new(app, window, cx)
        });
        let app = holder.borrow_mut().take().unwrap();
        app.update_in(cx, |app, window, cx| {
            let first = pending("first");
            app.local_outbox
                .insert(first.thread_id.clone(), first.clone());
            app.composer.update(cx, |input, cx| {
                input.set_value("other conversation draft", window, cx)
            });
            // No thread selected: this result belongs to a conversation left in the background.
            app.finish_local_delivery(
                &first.thread_id,
                "first",
                (LocalDelivery::Rejected, Some("rejected".into())),
                window,
                cx,
            );
            assert_eq!(
                app.composer.read(cx).value().as_ref(),
                "other conversation draft"
            );
            assert_eq!(
                app.local_outbox[&first.thread_id].delivery,
                LocalDelivery::Rejected
            );
            app.thread = Some(OpenThread {
                id: first.thread_id.clone(),
                feed: ThreadFeed::Cloud(cloud_thread::CloudThreadFeed {
                    task_id: "fixture".into(),
                    source: cloud_thread::CloudSource::Mirror,
                    live: None,
                    live_task: None,
                    connect_seq: 0,
                    connection_identity: None,
                    connection_phase: SyncPhase::Disconnected,
                }),
                state: ThreadState {
                    view: Some(Arc::new(crate::cloud::tests::fixtures::thread())),
                    ..Default::default()
                },
            });
            app.composer
                .update(cx, |input, cx| input.set_value("new typing", window, cx));
            app.restore_rejected_local_send(window, cx);
            assert_eq!(
                app.composer.read(cx).value().as_ref(),
                "original request\n\nnew typing"
            );
            app.restore_rejected_local_send(window, cx);
            assert_eq!(
                app.composer.read(cx).value().as_ref(),
                "original request\n\nnew typing"
            );
            assert!(app.local_outbox.is_empty());
            app.local_outbox
                .insert(first.thread_id.clone(), first.clone());
            app.finish_local_delivery(
                &first.thread_id,
                "different-command",
                (LocalDelivery::Rejected, None),
                window,
                cx,
            );
            assert_eq!(
                app.local_outbox[&first.thread_id].delivery,
                LocalDelivery::Submitting
            );
            app.finish_local_delivery(
                &first.thread_id,
                "first",
                (LocalDelivery::Accepted, None),
                window,
                cx,
            );
            app.finish_local_delivery(
                &first.thread_id,
                "first",
                (LocalDelivery::Unknown, Some("late timeout".into())),
                window,
                cx,
            );
            assert_eq!(
                app.local_outbox[&first.thread_id].delivery,
                LocalDelivery::Accepted
            );
        });
    }
}

/// Native acceptance using the disposable icon fixture. Never starts a provider.
#[cfg(debug_assertions)]
pub(super) async fn verify_steering(
    this: &WeakEntity<ChatApp>,
    cx: &mut gpui::AsyncWindowContext,
) -> Result<(), String> {
    ui_verification::float_fixture(cx).await?;
    let client = this
        .update_in(cx, |app, window, cx| {
            window.resize(gpui::size(px(1200.), px(800.)));
            if app.dock_open() {
                app.toggle_right_panel(window, cx);
            }
            let open = app.thread.as_mut().unwrap();
            let view = Arc::make_mut(open.state.view.as_mut().unwrap());
            let at = now_iso();
            view.latest_turn = Some(
                serde_json::from_value(serde_json::json!({
                    "turnId":"steering-fixture", "state":"running", "requestedAt":at,
                    "startedAt":at, "completedAt":null, "assistantMessageId":null
                }))
                .unwrap(),
            );
            view.session = Some(
                serde_json::from_value(serde_json::json!({
                    "threadId":view.id, "status":"running", "activeTurnId":"steering-fixture",
                    "updatedAt":at, "lastError":null
                }))
                .unwrap(),
            );
            app.rebuild_timeline(cx);
            // Keep the real projection, but prevent fixture prompts from reaching a provider.
            app.client.take().unwrap()
        })
        .map_err(|e| e.to_string())?;
    let mut previous_command = String::new();
    for prompt in [
        "Also check the regression tests",
        "Use the existing helper instead",
    ] {
        this.update_in(cx, |app, window, cx| {
            app.composer.update(cx, |input, cx| {
                input.set_value(prompt, window, cx);
                input.focus(window, cx);
            });
            let status = app.conversation_status(cx);
            assert!(status.can_send && status.can_stop);
            cx.notify();
        })
        .map_err(|e| e.to_string())?;
        cx.background_executor()
            .timer(Duration::from_millis(300))
            .await;
        if previous_command.is_empty() {
            ui_verification::capture("steering-send-and-stop", cx).await?;
        }
        ui_verification::key("enter", cx).await?;
        previous_command = this
            .update(cx, |app, cx| {
                let id = app.thread.as_ref().unwrap().id.clone();
                let pending = app
                    .local_outbox
                    .get(&id)
                    .expect("Enter must send during a running turn")
                    .clone();
                assert_ne!(pending.command_id(), previous_command);
                assert!(pending.steering);
                assert_eq!(pending.recovery.raw_text, prompt);
                assert!(app.composer.read(cx).value().is_empty());
                assert!(!app.conversation_status(cx).can_send);
                // The server echoes this exact message without changing the turn ID.
                Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap())
                    .messages
                    .push(pending.optimistic.clone());
                app.reconcile_local_dispatch();
                assert!(app.local_outbox.is_empty());
                assert!(app.local_dispatch.is_none());
                assert!(app.conversation_status(cx).can_send);
                app.rebuild_timeline(cx);
                cx.notify();
                pending.command_id().to_owned()
            })
            .map_err(|e| e.to_string())?;
    }
    this.update_in(cx, |app, window, cx| {
        app.client = Some(client);
        app.composer.update(cx, |input, cx| {
            input.set_value("Keep this draft", window, cx)
        });
        app.stop_turn(cx);
        let id = &app.thread.as_ref().unwrap().id;
        assert_eq!(app.local_stops[id].turn_id.0, "steering-fixture");
        assert_eq!(
            app.conversation_status(cx).facts.turn,
            conversation_status::Turn::Stopping
        );
        assert!(!app.conversation_status(cx).can_send);
        assert_eq!(app.composer.read(cx).value(), "Keep this draft");
    })
    .map_err(|e| e.to_string())?;
    eprintln!(
        "[vitre-steering-test] PASS: native Enter sends two follow-ups in the same turn; exact projection releases each outbox; Stop targets the active turn and preserves the draft"
    );
    cx.update(|_, cx| cx.quit()).map_err(|e| e.to_string())?;
    Ok(())
}
