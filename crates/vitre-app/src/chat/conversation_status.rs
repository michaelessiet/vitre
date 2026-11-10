//! Conversation presentation is derived from facts, never from animation or log copy.
use super::*;
use std::borrow::Cow;
use std::time::Instant;
use vitre_state::sidebar::ThreadStatus;

pub(super) const STATUS_HEIGHT: f32 = 28.;
pub(super) const FADE: Duration = Duration::from_millis(120);
pub(super) const BUSY_DELAY: Duration = Duration::from_millis(150);

pub(super) struct LocalStop {
    pub turn_id: vitre_contracts::TurnId,
    pub command_id: CommandId,
    pub acknowledged: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Connection {
    #[default]
    Dormant,
    Synchronizing,
    Live,
    Disconnected,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Transcript {
    #[default]
    Empty,
    Cached,
    Current,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Delivery {
    #[default]
    None,
    Submitting,
    Accepted,
    Uncertain,
    Rejected,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Turn {
    #[default]
    Idle,
    Preparing,
    Working,
    Approval,
    Input,
    Stopping,
    Finished,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Attention {
    #[default]
    None,
    Error,
    Auth,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Art {
    #[default]
    None,
    Connecting,
    Working,
    Approval,
    Input,
    Warning,
    Error,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Action {
    #[default]
    None,
    Retry,
    CheckDelivery,
    Reconnect,
    RetryConnection,
}

impl Action {
    fn label(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Retry => Some("Dismiss"),
            Self::CheckDelivery => Some("Check delivery"),
            Self::Reconnect | Self::RetryConnection => Some("Reconnect"),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct Facts {
    pub identity: String,
    pub connection: Connection,
    pub transcript: Transcript,
    pub delivery: Delivery,
    pub turn: Turn,
    pub attention: Attention,
    pub detail: Option<String>,
    pub preparation: Option<String>,
    pub started_at: Option<String>,
    pub execution_available: bool,
    pub supports_steering: bool,
    pub stop_error: bool,
}
#[derive(Clone, Debug, Default)]
pub(super) struct ConversationStatus {
    pub facts: Facts,
    pub label: String,
    pub art: Art,
    pub action: Action,
    pub can_send: bool,
    pub can_stop: bool,
    pub can_respond: bool,
    pub show_requests: bool,
}
impl ConversationStatus {
    pub(super) fn derive(facts: Facts) -> Self {
        let (mut label, mut art, mut action) = if facts.delivery == Delivery::Uncertain {
            (
                "Checking whether your message was received…".into(),
                Art::Warning,
                Action::CheckDelivery,
            )
        } else if facts.delivery == Delivery::Rejected {
            (
                facts
                    .detail
                    .clone()
                    .unwrap_or_else(|| "Message was not sent".into()),
                Art::Error,
                Action::None,
            )
        } else if facts.stop_error {
            (
                "Stop not confirmed".into(),
                Art::Warning,
                Action::RetryConnection,
            )
        } else {
            match facts.attention {
                Attention::Auth => (
                    "Reconnect your provider to continue".into(),
                    Art::Warning,
                    Action::Reconnect,
                ),
                Attention::Error => (
                    facts
                        .detail
                        .clone()
                        .unwrap_or_else(|| "Conversation needs attention".into()),
                    Art::Error,
                    Action::Retry,
                ),
                Attention::None => match facts.turn {
                    Turn::Stopping => ("Stopping…".into(), Art::Connecting, Action::None),
                    Turn::Approval => ("Approval required".into(), Art::Approval, Action::None),
                    Turn::Input => ("Waiting for your answer".into(), Art::Input, Action::None),
                    Turn::Preparing => (
                        facts
                            .preparation
                            .clone()
                            .unwrap_or_else(|| "Starting your request…".into()),
                        Art::Connecting,
                        Action::None,
                    ),
                    Turn::Idle | Turn::Finished if facts.delivery == Delivery::Accepted => (
                        "Starting your request…".into(),
                        Art::Connecting,
                        Action::None,
                    ),
                    _ if facts.delivery == Delivery::Submitting => {
                        ("Sending message…".into(), Art::Connecting, Action::None)
                    }
                    _ => match facts.connection {
                        Connection::Synchronizing => (
                            "Synchronizing conversation…".into(),
                            Art::Connecting,
                            Action::None,
                        ),
                        Connection::Disconnected => (
                            "Connection lost · reconnecting…".into(),
                            Art::Warning,
                            Action::RetryConnection,
                        ),
                        _ if facts.turn == Turn::Working => {
                            ("Working on your request".into(), Art::Working, Action::None)
                        }
                        _ => (String::new(), Art::None, Action::None),
                    },
                },
            }
        };
        if facts.attention == Attention::None
            && !facts.stop_error
            && !matches!(facts.delivery, Delivery::Uncertain | Delivery::Rejected)
            && matches!(
                facts.connection,
                Connection::Disconnected | Connection::Synchronizing
            )
        {
            let disconnected = facts.connection == Connection::Disconnected;
            let connection = if disconnected {
                "Connection lost"
            } else {
                "Synchronizing"
            };
            (label, art) = match facts.turn {
                Turn::Approval => (format!("{connection} · approval is waiting"), Art::Approval),
                Turn::Input => (format!("{connection} · your answer is waiting"), Art::Input),
                Turn::Stopping => (
                    format!(
                        "Stopping… · {}",
                        if disconnected {
                            "connection lost"
                        } else {
                            "synchronizing"
                        }
                    ),
                    if disconnected {
                        Art::Warning
                    } else {
                        Art::Connecting
                    },
                ),
                _ if facts.delivery == Delivery::Accepted => (
                    format!(
                        "Request accepted · {}",
                        if disconnected {
                            "reconnecting…"
                        } else {
                            "synchronizing…"
                        }
                    ),
                    if disconnected {
                        Art::Warning
                    } else {
                        Art::Connecting
                    },
                ),
                _ => (
                    if disconnected {
                        "Connection lost · reconnecting…"
                    } else {
                        "Synchronizing conversation…"
                    }
                    .into(),
                    if disconnected {
                        Art::Warning
                    } else {
                        Art::Connecting
                    },
                ),
            };
            action = if disconnected {
                Action::RetryConnection
            } else {
                Action::None
            };
        }
        let settled_turn = matches!(facts.turn, Turn::Idle | Turn::Finished);
        let can_send = matches!(facts.attention, Attention::None | Attention::Error)
            && matches!(facts.delivery, Delivery::None | Delivery::Rejected)
            && ((settled_turn
                && (facts.execution_available || facts.connection == Connection::Dormant))
                || (facts.turn == Turn::Working
                    && facts.supports_steering
                    && facts.execution_available));
        let execution_interrupted = facts.attention == Attention::Auth;
        let can_stop = !execution_interrupted
            && facts.execution_available
            && matches!(
                facts.turn,
                Turn::Working | Turn::Approval | Turn::Input | Turn::Preparing
            )
            && facts.delivery != Delivery::Uncertain;
        let can_respond = !execution_interrupted
            && facts.execution_available
            && matches!(facts.turn, Turn::Approval | Turn::Input);
        let show_requests =
            !execution_interrupted && matches!(facts.turn, Turn::Approval | Turn::Input);
        Self {
            facts,
            label,
            art,
            action,
            can_send,
            can_stop,
            can_respond,
            show_requests,
        }
    }
    pub(super) fn busy(&self) -> bool {
        matches!(self.art, Art::Connecting | Art::Working)
    }
    pub(super) fn sidebar(&self) -> Option<ThreadStatus> {
        match self.art {
            Art::Approval => Some(ThreadStatus::PendingApproval),
            Art::Input => Some(ThreadStatus::AwaitingInput),
            Art::Warning | Art::Error => Some(ThreadStatus::NeedsAttention),
            Art::Working => Some(ThreadStatus::Working),
            Art::Connecting => Some(ThreadStatus::Connecting),
            Art::None => None,
        }
    }
}

#[derive(Default)]
pub(super) struct StatusMotion {
    key: Option<String>,
    busy_since: Option<Instant>,
}
impl StatusMotion {
    fn update(&mut self, key: &str, busy: bool, visible: bool, now: Instant) -> bool {
        if !visible || !busy {
            self.key = None;
            self.busy_since = None;
            return false;
        }
        if self.key.as_deref() != Some(key) {
            self.key = Some(key.into());
            self.busy_since = Some(now);
            return true;
        }
        false
    }
    fn ready(&self, now: Instant, reduced: bool) -> bool {
        !reduced
            && self
                .busy_since
                .is_some_and(|since| now.saturating_duration_since(since) >= BUSY_DELAY)
    }
}

pub(super) fn infrastructure_activity(kind: &str) -> bool {
    matches!(kind, "thread.execution.changed" | "thread.history.imported")
}
fn active_turn(view: &vitre_contracts::OrchestrationThread) -> bool {
    view.latest_turn.as_ref().is_some_and(|turn| {
        turn.state == OrchestrationLatestTurnState::Running
            && view
                .session
                .as_ref()
                .is_some_and(|session| session.active_turn_id.as_ref() == Some(&turn.turn_id))
    })
}
fn execution_turn(view: &vitre_contracts::OrchestrationThread) -> Option<Turn> {
    view.latest_turn
        .as_ref()
        .filter(|turn| turn.state == OrchestrationLatestTurnState::Running)
        .map(|_| {
            if active_turn(view) {
                Turn::Working
            } else {
                Turn::Preparing
            }
        })
}
fn phase_connection(phase: SyncPhase) -> Connection {
    match phase {
        SyncPhase::Live => Connection::Live,
        SyncPhase::Synchronizing => Connection::Synchronizing,
        SyncPhase::Disconnected => Connection::Disconnected,
    }
}
pub(super) fn current_request_activities(
    view: &OrchestrationThread,
) -> Cow<'_, [vitre_contracts::OrchestrationThreadActivity]> {
    let Some(latest) = view.latest_turn.as_ref() else {
        return Cow::Borrowed(&view.activities);
    };
    let requested_at = chrono::DateTime::parse_from_rfc3339(&latest.requested_at.0).ok();
    Cow::Owned(
        view.activities
            .iter()
            .filter(|activity| {
                activity.kind.0 == "thread.history.imported"
                    || match activity.turn_id.as_ref() {
                        Some(turn) => turn == &latest.turn_id,
                        None => requested_at.is_some_and(|requested| {
                            chrono::DateTime::parse_from_rfc3339(&activity.created_at.0)
                                .is_ok_and(|created| created >= requested)
                        }),
                    }
            })
            .cloned()
            .collect(),
    )
}

/// The portions of a thread view needed by chat chrome. Recompute once when
/// the projection is published, rather than cloning and scanning the entire
/// activity history on every scroll repaint.
pub(super) fn derive_thread_presentation(
    view: &OrchestrationThread,
) -> (
    Vec<PendingApproval>,
    Vec<PendingUserInput>,
    Option<ContextWindowSnapshot>,
) {
    let request_activities = current_request_activities(view);
    (
        derive_pending_approvals(&request_activities),
        derive_pending_user_inputs(&request_activities),
        derive_latest_context_window_snapshot(&view.activities),
    )
}
fn status_frame() -> gpui::Stateful<gpui::Div> {
    h_flex()
        .id("conversation-status")
        .debug_selector(|| "conversation-status".into())
        .w_full()
        .max_w(px(768.))
        .mx_auto()
        .px_3()
        .h(px(STATUS_HEIGHT))
        .flex_shrink_0()
        .gap_2()
}
fn status_opacity(
    identity: &str,
    channel: &'static str,
    target: f32,
    visible: bool,
    window: &mut Window,
    cx: &mut gpui::App,
) -> f32 {
    gpui_base::motion::transition(
        (SharedString::from(identity.to_string()), channel),
        target,
        gpui_base::motion::Transition::new(if visible { FADE } else { Duration::ZERO }),
        window,
        cx,
    )
}

fn status_elapsed(started_at: &str, now: chrono::DateTime<chrono::Utc>) -> Option<String> {
    let started_at = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    let seconds = now.signed_duration_since(started_at).num_seconds().max(0);
    Some(if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    })
}

impl ChatApp {
    pub(super) fn conversation_status(&self, cx: &gpui::App) -> ConversationStatus {
        let Some(open) = self.thread.as_ref() else {
            return self.draft_conversation_status();
        };
        let view = open.state.view.as_deref();
        let connection = phase_connection(open.state.phase);
        let live = connection == Connection::Live;
        let mut facts = Facts {
            identity: format!(
                "{}:{}",
                open.id.0,
                view.and_then(|v| v.latest_turn.as_ref())
                    .map(|turn| turn.turn_id.0.as_str())
                    .unwrap_or("idle")
            ),
            connection,
            transcript: if view.is_none() {
                Transcript::Empty
            } else if live {
                Transcript::Current
            } else {
                Transcript::Cached
            },
            execution_available: live,
            supports_steering: true,
            detail: self.last_error.as_ref().map(ToString::to_string),
            ..Facts::default()
        };
        if let Some(view) = view {
            if live {
                if let Some(turn) = execution_turn(view) {
                    facts.turn = turn;
                    if turn == Turn::Preparing {
                        facts.preparation = Some("Starting your request…".into());
                    }
                } else {
                    facts.turn = Turn::Finished;
                }
            }
            if !self.presentation_pending_approvals.is_empty() {
                facts.turn = Turn::Approval;
            } else if !self.presentation_pending_inputs.is_empty() {
                facts.turn = Turn::Input;
            }
            if facts.turn == Turn::Working {
                facts.started_at = view.latest_turn.as_ref().map(|turn| {
                    turn.started_at
                        .as_ref()
                        .unwrap_or(&turn.requested_at)
                        .0
                        .clone()
                });
            }
            if facts.detail.is_none() {
                facts.detail = view
                    .session
                    .as_ref()
                    .and_then(|s| s.last_error.as_ref())
                    .map(|e| e.0.clone());
            }
        }
        if let Some(pending) = self.local_outbox.get(&open.id) {
            facts.identity = format!("{}:{}", open.id.0, pending.command_id());
            facts.started_at = Some(pending.optimistic.created_at.0.clone());
            facts.delivery = match pending.delivery {
                local_delivery::LocalDelivery::Submitting => Delivery::Submitting,
                local_delivery::LocalDelivery::Accepted => Delivery::Accepted,
                local_delivery::LocalDelivery::Unknown => Delivery::Uncertain,
                local_delivery::LocalDelivery::Rejected => Delivery::Rejected,
            };
            // A prior session error does not describe this new immutable request.
            facts.detail = pending.error.clone();
            facts.attention = Attention::None;
        }
        if let Some(stop) = self.local_stops.get(&open.id).filter(|stop| {
            view.and_then(|view| view.latest_turn.as_ref())
                .is_some_and(|turn| {
                    turn.turn_id == stop.turn_id
                        && turn.state == OrchestrationLatestTurnState::Running
                })
        }) {
            facts.turn = Turn::Stopping;
            if stop.error.is_some() {
                facts.detail = stop.error.clone();
                facts.stop_error = true;
            }
        }
        if let Some(provider) = self.selected_provider(cx)
            && provider.auth.status == vitre_contracts::ServerProviderAuthStatus::Unauthenticated
        {
            facts.attention = Attention::Auth;
            facts.detail = provider.message.clone().flatten().map(|message| message.0);
        }
        // Operation-specific error details belong in the disclosure, never a second banner.
        if facts.attention == Attention::None
            && !facts.stop_error
            && facts.detail.is_some()
            && facts.turn != Turn::Working
        {
            facts.attention = Attention::Error;
        }
        ConversationStatus::derive(facts)
    }

    fn draft_conversation_status(&self) -> ConversationStatus {
        if self.draft_creating {
            return ConversationStatus::derive(Facts {
                identity: format!("draft-local:{:?}", self.draft_project),
                delivery: Delivery::Submitting,
                ..Facts::default()
            });
        }
        let mut status = ConversationStatus::derive(Facts {
            identity: "draft:draft".into(),
            ..Facts::default()
        });
        status.facts.detail = self.last_error.as_ref().map(ToString::to_string);
        if status.facts.detail.is_some() && status.label.is_empty() {
            status.label = "Could not start this conversation".into();
            status.art = Art::Error;
        }
        status
    }

    pub(super) fn sidebar_conversation_status(
        &self,
        thread: &OrchestrationThreadShell,
        visited: Option<&str>,
    ) -> Option<ThreadStatus> {
        vitre_state::sidebar::resolve_thread_status(thread, visited)
    }

    pub(super) fn sync_status_motion(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let status = self.conversation_status(cx);
        if let Some(open) = self
            .thread
            .as_ref()
            .filter(|open| open.state.phase == SyncPhase::Live)
            && let Some(stop) = self.local_stops.get(&open.id)
            && open
                .state
                .view
                .as_ref()
                .and_then(|view| view.latest_turn.as_ref())
                .is_some_and(|turn| {
                    turn.turn_id != stop.turn_id
                        || turn.state != OrchestrationLatestTurnState::Running
                })
        {
            self.local_stops.remove(&open.id);
        }
        let visible = self.settings.is_none()
            && (self.thread.is_some() || self.draft_project.is_some())
            && window.is_window_active();
        self.status_surface_visible = visible;
        let now = cx.background_executor().now();
        if self
            .status_motion
            .update(&status.facts.identity, status.busy(), visible, now)
            && !cx.reduce_motion()
        {
            self.status_art_timer = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(BUSY_DELAY).await;
                let _ = this.update(cx, |_, cx| cx.notify());
            }));
        } else if !visible || !status.busy() || cx.reduce_motion() {
            self.status_art_timer = None;
        }
        let artwork = visible && status.busy() && self.status_motion.ready(now, cx.reduce_motion());
        self.activity_orb.update(cx, |orb, cx| {
            orb.set_state(vitre_bezel_orbs::orbs::OrbState::Working, cx);
            orb.set_paused(!artwork, cx);
            orb.set_visible(artwork && status.art == Art::Working, cx);
        });
        let ticking = visible && status.busy() && status.facts.started_at.is_some();
        if ticking && self.working_tick.is_none() {
            self.working_tick = Some(cx.spawn_in(window, async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    let keep = this
                        .update_in(cx, |app, window, cx| {
                            let status = app.conversation_status(cx);
                            let keep = app.settings.is_none()
                                && window.is_window_active()
                                && status.busy()
                                && status.facts.started_at.is_some();
                            if keep {
                                cx.notify();
                            } else {
                                app.working_tick = None;
                            }
                            keep
                        })
                        .unwrap_or(false);
                    if !keep {
                        break;
                    }
                }
            }));
        } else if !ticking {
            self.working_tick = None;
        }
    }

    pub(super) fn render_conversation_status(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let status = self.conversation_status(cx);
        let active = !status.label.is_empty();
        let opacity = status_opacity(
            &status.facts.identity,
            "status-opacity",
            if active { 1. } else { 0. },
            self.status_surface_visible,
            window,
            cx,
        );
        let artwork = self.status_surface_visible
            && self
                .status_motion
                .ready(cx.background_executor().now(), cx.reduce_motion());
        let art_opacity = status_opacity(
            &status.facts.identity,
            "busy-art-opacity",
            if artwork { 1. } else { 0. },
            self.status_surface_visible,
            window,
            cx,
        );
        let art_color = match status.art {
            Art::Error => cx.theme().danger,
            Art::Warning | Art::Approval => cx.theme().warning,
            Art::Input => cx.theme().info,
            _ => cx.theme().muted_foreground,
        };
        let icon = match status.art {
            Art::Error => IconName::CircleX,
            Art::Warning => IconName::TriangleAlert,
            Art::Approval => IconName::Settings,
            Art::Input => IconName::Info,
            Art::Working | Art::Connecting => IconName::LoaderCircle,
            _ => IconName::CircleCheck,
        };
        let icon = if artwork && status.art == Art::Working {
            div()
                .opacity(art_opacity)
                .child(self.activity_orb.clone())
                .into_any_element()
        } else if artwork && status.art == Art::Connecting {
            div()
                .opacity(art_opacity)
                .child(
                    ProgressCircle::new(SharedString::from(format!(
                        "conversation-connecting:{}",
                        status.facts.identity
                    )))
                    .loading(true)
                    .small(),
                )
                .into_any_element()
        } else {
            Icon::new(icon).size_3p5().into_any_element()
        };
        let elapsed = status
            .facts
            .started_at
            .as_ref()
            .filter(|_| status.busy())
            .and_then(|at| status_elapsed(at, chrono::Utc::now()));
        let action_label = status.action.label();
        let action = status.action;
        status_frame()
            .text_xs()
            .text_color(cx.theme().muted_foreground)
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_2()
                    .opacity(opacity)
                    .when(active, |row| {
                        row.child(
                            div()
                                .size(px(16.))
                                .flex_shrink_0()
                                .text_color(art_color)
                                .child(icon),
                        )
                    })
                    .child(div().flex_1().min_w_0().truncate().child(status.label))
                    .children(elapsed.map(|elapsed| {
                        div()
                            .font_family(cx.theme().mono_font_family.clone())
                            .child(elapsed)
                    })),
            )
            .when_some(action_label, |row, label| {
                row.child(
                    Button::new("conversation-recovery")
                        .ghost()
                        .xsmall()
                        .label(label)
                        .on_click(cx.listener(move |app, _, window, cx| match action {
                            Action::Retry => {
                                app.last_error = None;
                                cx.notify();
                            }
                            Action::CheckDelivery => app.retry_pending_local_send(window, cx),
                            Action::RetryConnection => {
                                if let Some(client) = app.workspace_client() {
                                    client.retry_connection();
                                }
                                cx.notify();
                            }
                            Action::Reconnect => app.toggle_settings(window, cx),
                            Action::None => {}
                        })),
                )
            })
            .child(
                Button::new("conversation-details")
                    .ghost()
                    .xsmall()
                    .icon(IconName::Info)
                    .tooltip("Conversation details and activity")
                    .on_click(
                        cx.listener(|app, _, window, cx| app.open_conversation_details(window, cx)),
                    ),
            )
            .into_any_element()
    }

    pub(super) fn open_conversation_details(&self, window: &mut Window, cx: &mut Context<Self>) {
        let status = self.conversation_status(cx);
        let mut lines = Vec::new();
        lines.push(format!(
            "Connection: {:?} · History: {:?}",
            status.facts.connection, status.facts.transcript
        ));
        if let Some(detail) = status.facts.detail {
            lines.push(detail);
        }
        if let Some(root) = self.open_project_root() {
            lines.push(format!("Workspace: {root}"));
        }
        if let Some(view) = self.thread.as_ref().and_then(|t| t.state.view.as_ref()) {
            for activity in &view.activities {
                if infrastructure_activity(&activity.kind.0) {
                    lines.push(format!(
                        "{} · {}",
                        activity.created_at.0, activity.summary.0
                    ));
                }
            }
        }
        window.open_dialog(cx, move |dialog, _, _| {
            let lines = lines.clone();
            dialog
                .title("Conversation details")
                .w(px(560.))
                .content(move |content, _, cx| {
                    content.child(
                        v_flex()
                            .gap_3()
                            .max_h(px(420.))
                            .overflow_y_scrollbar()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .children(lines.iter().map(|line| div().child(line.clone()))),
                    )
                })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn working() -> Facts {
        Facts {
            identity: "conversation:turn-1".into(),
            turn: Turn::Working,
            connection: Connection::Live,
            transcript: Transcript::Current,
            execution_available: true,
            supports_steering: true,
            ..Facts::default()
        }
    }
    #[test]
    fn running_local_turn_allows_followups_and_stop_independently() {
        let status = ConversationStatus::derive(working());
        assert!(status.can_send);
        assert!(status.can_stop);
        for delivery in [
            Delivery::Submitting,
            Delivery::Accepted,
            Delivery::Uncertain,
        ] {
            assert!(
                !ConversationStatus::derive(Facts {
                    delivery,
                    ..working()
                })
                .can_send
            );
        }
        for facts in [
            Facts {
                supports_steering: false,
                ..working()
            },
            Facts {
                execution_available: false,
                ..working()
            },
        ] {
            assert!(!ConversationStatus::derive(facts).can_send);
        }
    }
    #[test]
    fn primary_elapsed_label_changes_only_at_whole_seconds() {
        let started_at = "2026-10-16T10:00:00Z";
        let start = chrono::DateTime::parse_from_rfc3339(started_at)
            .unwrap()
            .with_timezone(&chrono::Utc);
        for (milliseconds, expected) in [
            (-1, "0s"),
            (0, "0s"),
            (427, "0s"),
            (999, "0s"),
            (1_000, "1s"),
            (1_999, "1s"),
            (59_999, "59s"),
            (60_000, "1m 00s"),
            (61_999, "1m 01s"),
        ] {
            assert_eq!(
                status_elapsed(
                    started_at,
                    start + chrono::Duration::milliseconds(milliseconds)
                )
                .as_deref(),
                Some(expected)
            );
        }
        assert_eq!(status_elapsed("invalid", start), None);
    }
    #[test]
    fn running_projection_fences_send_before_provider_session_arrives() {
        let mut view = super::super::thread_feed::thread_fixture();
        view.latest_turn = Some(serde_json::from_value(serde_json::json!({
            "turnId":"turn-starting", "state":"running", "requestedAt":"2026-10-16T10:00:00Z",
            "startedAt":null, "completedAt":null, "assistantMessageId":null, "sourceProposedPlan":null
        })).unwrap());
        if let Some(session) = view.session.as_mut() {
            session.active_turn_id = None;
        }
        assert_eq!(execution_turn(&view), Some(Turn::Preparing));
        let status = ConversationStatus::derive(Facts {
            turn: execution_turn(&view).unwrap(),
            ..working()
        });
        assert!(!status.can_send);
        assert_ne!(status.art, Art::Working);
    }
    #[test]
    fn current_request_scope_excludes_old_questions_including_untagged_legacy_events() {
        let mut view = super::super::thread_feed::thread_fixture();
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId":"current", "state":"running", "requestedAt":"2026-10-16T11:00:00Z",
                "startedAt":"2026-10-16T11:00:00Z", "completedAt":null,
                "assistantMessageId":null, "sourceProposedPlan":null
            }))
            .unwrap(),
        );
        view.activities = [
            ("old", Some("previous"), "2026-10-16T10:00:01Z"),
            ("legacy-old", None, "2026-10-16T10:00:02Z"),
            ("late-old", Some("previous"), "2026-10-16T11:00:01Z"),
            ("current", Some("current"), "2026-10-16T11:00:01Z"),
            ("legacy-current", None, "2026-10-16T11:00:02Z"),
        ].into_iter().map(|(id, turn, created)| {
            serde_json::from_value(serde_json::json!({
                "id":id, "kind":"user-input.requested", "createdAt":created,
                "summary":"Choose an option", "tone":"info", "turnId":turn,
                "payload":{"requestId":id, "questions":[{"id":"choice", "header":"Choose", "question":"Which option?", "options":[]}]}
            })).unwrap()
        }).collect();
        let requests = derive_pending_user_inputs(&current_request_activities(&view));
        assert_eq!(
            requests
                .iter()
                .map(|request| request.request_id.as_str())
                .collect::<Vec<_>>(),
            ["current", "legacy-current"]
        );
        assert_eq!(view.activities.len(), 5);
    }
    #[test]
    fn current_request_scope_retains_import_markers_that_fence_historical_actions() {
        let mut view = super::super::thread_feed::thread_fixture();
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId":"restored-turn", "state":"running", "requestedAt":"2026-10-16T11:00:00Z",
                "startedAt":"2026-10-16T11:00:00Z", "completedAt":null,
                "assistantMessageId":null, "sourceProposedPlan":null
            }))
            .unwrap(),
        );
        view.activities = vec![
            serde_json::from_value(serde_json::json!({
                "id":"historical-approval", "kind":"approval.requested", "createdAt":"2026-10-16T11:00:01Z",
                "summary":"Command approval requested", "tone":"tool", "turnId":"restored-turn",
                "payload":{"requestId":"reused", "requestKind":"command"}
            })).unwrap(),
            serde_json::from_value(serde_json::json!({
                "id":"import", "kind":"thread.history.imported", "createdAt":"2026-10-16T10:00:00Z",
                "summary":"History restored", "tone":"info", "turnId":null,
                "payload":{"historicalActivityIds":["historical-approval"]}
            })).unwrap(),
        ];
        assert!(derive_pending_approvals(&current_request_activities(&view)).is_empty());
        let mut current = view.activities[0].clone();
        current.id = vitre_contracts::EventId("current-approval".into());
        current.created_at = tnes("2026-10-16T11:00:02Z");
        view.activities.push(current);
        assert_eq!(
            derive_pending_approvals(&current_request_activities(&view)).len(),
            1
        );
        assert_eq!(view.activities.len(), 3);
    }
    #[test]
    fn presentation_snapshot_tracks_requests_resolutions_and_rehydration() {
        let mut view = super::super::thread_feed::thread_fixture();
        view.latest_turn = Some(
            serde_json::from_value(serde_json::json!({
                "turnId":"active", "state":"running", "requestedAt":"2026-10-16T11:00:00Z",
                "startedAt":"2026-10-16T11:00:00Z", "completedAt":null,
                "assistantMessageId":null, "sourceProposedPlan":null
            }))
            .unwrap(),
        );
        let activity = |id: &str, kind: &str, payload: serde_json::Value| {
            serde_json::from_value(serde_json::json!({
                "id": id, "kind": kind, "createdAt": "2026-10-16T11:00:01Z",
                "summary": id, "tone": "info", "turnId": "active", "payload": payload
            }))
            .unwrap()
        };
        view.activities = vec![
            activity(
                "approval",
                "approval.requested",
                serde_json::json!({
                    "requestId":"approve", "requestKind":"command"
                }),
            ),
            activity(
                "question",
                "user-input.requested",
                serde_json::json!({
                    "requestId":"answer", "questions":[{
                        "id":"choice", "header":"Choose", "question":"Which?", "options":[]
                    }]
                }),
            ),
            activity(
                "context",
                "context-window.updated",
                serde_json::json!({
                    "usedTokens": 250.0, "maxTokens": 1000.0
                }),
            ),
        ];
        let (approvals, inputs, context) = derive_thread_presentation(&view);
        assert_eq!(approvals[0].request_id, "approve");
        assert_eq!(inputs[0].request_id, "answer");
        assert_eq!(context.unwrap().used_percentage, Some(25.0));

        // Rebuilding from a restored view gives the same UI state. A later
        // projection update drops both resolved panels without a render scan.
        let restored = view.clone();
        assert_eq!(derive_thread_presentation(&restored).0, approvals);
        view.activities.push(activity(
            "approval-done",
            "approval.resolved",
            serde_json::json!({
                "requestId":"approve"
            }),
        ));
        view.activities.push(activity(
            "question-done",
            "user-input.resolved",
            serde_json::json!({
                "requestId":"answer"
            }),
        ));
        let (approvals, inputs, context) = derive_thread_presentation(&view);
        assert!(approvals.is_empty());
        assert!(inputs.is_empty());
        assert_eq!(context.unwrap().used_percentage, Some(25.0));
    }
    #[test]
    fn disconnect_and_sync_are_visible_even_while_waiting_for_approval_or_startup() {
        for turn in [Turn::Approval, Turn::Input, Turn::Preparing, Turn::Stopping] {
            for connection in [Connection::Disconnected, Connection::Synchronizing] {
                let status = ConversationStatus::derive(Facts {
                    turn,
                    connection,
                    execution_available: false,
                    ..working()
                });
                assert!(!status.can_send);
                assert!(!status.can_stop);
                assert!(status.label.to_lowercase().contains(
                    if connection == Connection::Disconnected {
                        "connection lost"
                    } else {
                        "synchronizing"
                    }
                ));
                if matches!(turn, Turn::Approval | Turn::Input) {
                    assert!(!status.busy());
                }
            }
        }
    }
    #[test]
    fn accepted_delivery_stays_pending_until_the_execution_feed_confirms_it() {
        let status = ConversationStatus::derive(Facts {
            delivery: Delivery::Accepted,
            turn: Turn::Finished,
            ..working()
        });
        assert_eq!(status.label, "Starting your request…");
        assert!(!status.can_send);
        assert!(status.busy());
    }
    #[test]
    fn cached_history_never_makes_a_connection_live() {
        let status = ConversationStatus::derive(Facts {
            connection: Connection::Disconnected,
            transcript: Transcript::Cached,
            turn: Turn::Working,
            ..Facts::default()
        });
        assert_eq!(status.facts.transcript, Transcript::Cached);
        assert_eq!(status.art, Art::Warning);
        assert!(!status.busy());
        assert!(!status.can_send);
        assert!(!status.can_stop);
        let synchronized = ConversationStatus::derive(Facts {
            connection: Connection::Synchronizing,
            transcript: Transcript::Cached,
            ..Facts::default()
        });
        assert_eq!(synchronized.label, "Synchronizing conversation…");
    }
    #[test]
    fn idle_resident_computer_is_not_a_working_turn() {
        let status = ConversationStatus::derive(Facts {
            connection: Connection::Live,
            transcript: Transcript::Current,
            execution_available: true,
            turn: Turn::Finished,
            ..Facts::default()
        });
        assert_eq!(status.art, Art::None);
        assert_eq!(status.sidebar(), None);
        assert!(status.can_send);
        assert!(!status.can_stop);
    }
    #[test]
    fn required_user_actions_stop_busy_motion_immediately() {
        for (turn, art) in [(Turn::Approval, Art::Approval), (Turn::Input, Art::Input)] {
            let status = ConversationStatus::derive(Facts { turn, ..working() });
            assert_eq!(status.art, art);
            assert!(!status.busy());
            assert!(!status.can_send);
            assert!(status.show_requests);
        }
        for attention in [Attention::Auth, Attention::Error] {
            let status = ConversationStatus::derive(Facts {
                attention,
                ..working()
            });
            assert!(!status.busy());
        }
    }
    #[test]
    fn auth_attention_fences_actions_and_dismiss_clears_errors() {
        let status = ConversationStatus::derive(Facts {
            attention: Attention::Auth,
            turn: Turn::Approval,
            ..working()
        });
        assert!(!status.can_respond);
        assert!(!status.can_stop);
        assert!(!status.can_send);
        assert!(!status.show_requests);
        assert_eq!(status.action, Action::Reconnect);
        assert_eq!(Action::Retry.label(), Some("Dismiss"));
        assert_eq!(Action::RetryConnection.label(), Some("Reconnect"));
        assert_eq!(Action::CheckDelivery.label(), Some("Check delivery"));
        // A notification error does not establish that live execution has stopped.
        let notification_error = ConversationStatus::derive(Facts {
            attention: Attention::Error,
            ..working()
        });
        assert!(notification_error.can_stop);
        assert!(notification_error.can_send);
    }
    #[test]
    fn sidebar_keeps_user_questions_distinct_from_warnings_and_errors() {
        let input = ConversationStatus::derive(Facts {
            turn: Turn::Input,
            ..working()
        });
        assert_eq!(input.sidebar(), Some(ThreadStatus::AwaitingInput));
        for attention in [Attention::Auth, Attention::Error] {
            let status = ConversationStatus::derive(Facts {
                attention,
                ..working()
            });
            assert_eq!(status.sidebar(), Some(ThreadStatus::NeedsAttention));
            assert!(!status.busy());
        }
    }
    #[test]
    fn uncertain_delivery_is_preserved_and_does_not_offer_a_new_send() {
        let status = ConversationStatus::derive(Facts {
            delivery: Delivery::Uncertain,
            ..working()
        });
        assert_eq!(status.action, Action::CheckDelivery);
        assert!(!status.can_send);
        assert!(!status.can_stop);
        assert!(!status.busy());
    }
    #[test]
    fn uncertain_delivery_wins_over_a_transport_error_and_never_retries_a_new_turn() {
        let status = ConversationStatus::derive(Facts {
            delivery: Delivery::Uncertain,
            attention: Attention::Error,
            detail: Some("The connection timed out".into()),
            ..working()
        });
        assert_eq!(status.action, Action::CheckDelivery);
        assert!(!status.can_send);
        let rejected = ConversationStatus::derive(Facts {
            delivery: Delivery::Rejected,
            attention: Attention::Error,
            detail: Some("Message attachment was rejected".into()),
            ..working()
        });
        assert_eq!(rejected.action, Action::None);
        assert_eq!(rejected.label, "Message attachment was rejected");
    }
    #[test]
    fn stop_acknowledgement_is_not_turn_completion() {
        for _acknowledged in [false, true] {
            let status = ConversationStatus::derive(Facts {
                turn: Turn::Stopping,
                ..working()
            });
            assert_eq!(status.label, "Stopping…");
            assert!(!status.can_send);
            assert!(!status.can_stop);
        }
        let settled = ConversationStatus::derive(Facts {
            turn: Turn::Finished,
            ..working()
        });
        assert!(settled.can_send);
        assert!(!settled.busy());
    }
    #[test]
    fn busy_art_starts_at_150ms_but_state_and_actions_are_immediate() {
        let mut motion = StatusMotion::default();
        let now = Instant::now();
        let status = ConversationStatus::derive(working());
        assert!(status.can_stop);
        assert_eq!(status.label, "Working on your request");
        assert!(motion.update(&status.facts.identity, true, true, now));
        assert!(!motion.ready(now + Duration::from_millis(149), false));
        assert!(motion.ready(now + BUSY_DELAY, false));
        // Polls and elapsed updates retain the same clock.
        assert!(!motion.update(
            &status.facts.identity,
            true,
            true,
            now + Duration::from_secs(1)
        ));
        assert!(motion.ready(now + Duration::from_secs(1), false));
        assert!(!motion.ready(now + Duration::from_secs(1), true));
    }
    #[test]
    fn hidden_completed_and_replaced_operations_discard_busy_clock() {
        let now = Instant::now();
        for (busy, visible) in [(false, true), (true, false)] {
            let mut motion = StatusMotion::default();
            motion.update("first", true, true, now);
            motion.update("first", busy, visible, now + BUSY_DELAY);
            assert!(!motion.ready(now + Duration::from_secs(10), false));
            assert!(motion.key.is_none());
        }
        let mut motion = StatusMotion::default();
        motion.update("first", true, true, now);
        motion.update("second", true, true, now + Duration::from_secs(1));
        assert!(!motion.ready(now + Duration::from_secs(1), false));
        assert!(motion.ready(now + Duration::from_secs(1) + BUSY_DELAY, false));
    }
    #[test]
    fn only_infrastructure_events_move_out_of_the_timeline() {
        assert!(infrastructure_activity("thread.execution.changed"));
        assert!(infrastructure_activity("thread.history.imported"));
        for kind in [
            "thread.execution.failed",
            "tool.started",
            "approval.requested",
            "reasoning.delta",
            "message.created",
        ] {
            assert!(!infrastructure_activity(kind));
        }
    }

    struct StatusProbe {
        target: f32,
        visible: bool,
        sampled: f32,
        label: &'static str,
    }
    impl Render for StatusProbe {
        fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            self.sampled = status_opacity("probe", "fade", self.target, self.visible, window, cx);
            v_flex()
                .w(px(400.))
                .child(status_frame().opacity(self.sampled).child(self.label))
                .child(div().debug_selector(|| "probe-composer".into()).h(px(100.)))
        }
    }
    #[gpui::test]
    fn status_fades_retarget_without_moving_the_composer(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (probe, cx) = cx.add_window_view(|_, _| StatusProbe {
            target: 0.,
            visible: true,
            sampled: 0.,
            label: "",
        });
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let before = cx.debug_bounds("probe-composer").unwrap();
        assert_eq!(
            cx.debug_bounds("conversation-status").unwrap().size.height,
            px(STATUS_HEIGHT)
        );
        probe.update(cx, |probe, cx| {
            probe.target = 1.;
            probe.label = "Working";
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.executor().advance_clock(Duration::from_millis(60));
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        let halfway = probe.read_with(cx, |probe, _| probe.sampled);
        assert!(halfway > 0. && halfway < 1.);
        probe.update(cx, |probe, cx| {
            probe.target = 0.;
            probe.label = "";
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(probe.read_with(cx, |probe, _| probe.sampled), halfway);
        cx.executor().advance_clock(FADE);
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        assert_eq!(probe.read_with(cx, |probe, _| probe.sampled), 0.);
        assert_eq!(cx.debug_bounds("probe-composer").unwrap(), before);
        cx.update(|_, cx| cx.set_reduce_motion(true));
        probe.update(cx, |probe, cx| {
            probe.target = 1.;
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(probe.read_with(cx, |probe, _| probe.sampled), 1.);
        cx.update(|_, cx| cx.set_reduce_motion(false));
        probe.update(cx, |probe, cx| {
            probe.target = 0.;
            probe.visible = false;
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(probe.read_with(cx, |probe, _| probe.sampled), 0.);
    }
}
