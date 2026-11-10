//! Subagent cards: inline at the tool call that launched them, and listed in
//! the dock's Agents surface.
//!
//! A card shows the agent type and task, a status, elapsed time, tool count
//! and tokens, and one live line (Vitre's small-model summary, else the last
//! tool). Expanding it shows the subagent's own transcript; a running agent
//! can be stopped without interrupting the turn. State comes from
//! `vitre_state::subagents`, rebuilt with the timeline.

use std::hash::{Hash, Hasher};

use gpui::{App, Hsla};

use super::*;
use vitre_contracts::generated::{ClientOrchestrationCommand, CommandId, RuntimeTaskId};
use vitre_state::subagents::{
    Subagent, SubagentKind, SubagentStatus, SubagentTranscriptEntry, active_subagent_count,
};

/// Transcript entries shown before "Show N earlier".
const TRANSCRIPT_TAIL: usize = 12;

/// Where a card renders, which decides how it remeasures and keys its state.
#[derive(Clone, Copy)]
pub(super) enum CardPlace {
    /// In the timeline row at this index.
    Timeline(usize),
    Dock,
}

impl CardPlace {
    fn key(self, task_id: &str) -> String {
        match self {
            Self::Timeline(_) => format!("agent:{task_id}"),
            Self::Dock => format!("dock-agent:{task_id}"),
        }
    }
}

fn status_color(status: SubagentStatus, cx: &App) -> Hsla {
    match status {
        SubagentStatus::Running => cx.theme().primary,
        SubagentStatus::Pending | SubagentStatus::Paused => cx.theme().warning,
        SubagentStatus::Completed => cx.theme().success,
        SubagentStatus::Failed => cx.theme().danger,
        SubagentStatus::Stopped => cx.theme().muted_foreground,
    }
}

fn status_icon(status: SubagentStatus) -> Icon {
    Icon::new(match status {
        SubagentStatus::Running | SubagentStatus::Pending => IconName::LoaderCircle,
        SubagentStatus::Paused => IconName::Minus,
        SubagentStatus::Completed => IconName::CircleCheck,
        SubagentStatus::Failed => IconName::CircleX,
        SubagentStatus::Stopped => IconName::Close,
    })
}

fn compact_tokens(tokens: u64) -> String {
    match tokens {
        0..1_000 => format!("{tokens} tokens"),
        1_000..1_000_000 => format!("{:.1}k tokens", tokens as f64 / 1_000.0),
        _ => format!("{:.1}M tokens", tokens as f64 / 1_000_000.0),
    }
}

fn parse_millis(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|time| time.timestamp_millis())
}

/// `Running · 1m 12s · 8 tools · 14.2k tokens`.
fn meta_line(agent: &Subagent) -> String {
    let mut parts = vec![agent.status.label().to_string()];
    if agent.background && agent.status.is_active() {
        parts[0] = "In background".into();
    }
    let elapsed = agent.duration_ms.map(|ms| ms as i64).or_else(|| {
        let start = parse_millis(&agent.started_at)?;
        let end = match agent.ended_at.as_deref() {
            Some(end) => parse_millis(end)?,
            None => chrono::Utc::now().timestamp_millis(),
        };
        Some(end - start)
    });
    if let Some(ms) = elapsed.filter(|ms| *ms >= 1_000) {
        parts.push(work_log::format_duration(ms));
    }
    let tools = agent.tool_count();
    if tools > 0 {
        parts.push(format!("{tools} tool{}", if tools == 1 { "" } else { "s" }));
    }
    if let Some(tokens) = agent.total_tokens.filter(|tokens| *tokens > 0) {
        parts.push(compact_tokens(tokens));
    }
    parts.join(" · ")
}

/// Hashes what a card shows, so the timeline remeasures it when it changes.
pub(super) fn hash_agents(
    agents: &[&Subagent],
    expanded: &HashSet<String>,
    hasher: &mut impl Hasher,
) {
    for agent in agents {
        agent.task_id.hash(hasher);
        agent.title().hash(hasher);
        meta_line(agent).hash(hasher);
        agent.status_line().hash(hasher);
        agent.transcript.len().hash(hasher);
        let open = expanded.contains(&CardPlace::Timeline(0).key(&agent.task_id));
        open.hash(hasher);
    }
}

impl ChatApp {
    /// The subagents launched by this tool call (several for a parallel spawn).
    pub(super) fn subagents_for_tool_call(&self, tool_call_id: &str) -> Vec<&Subagent> {
        self.subagents
            .iter()
            .filter(|agent| agent.tool_use_id.as_deref() == Some(tool_call_id))
            .collect()
    }

    pub(super) fn active_subagent_count(&self) -> usize {
        active_subagent_count(&self.subagents)
    }

    /// Ask the provider to stop one subagent; its card says "Stopping…"
    /// until the provider reports the end.
    pub(super) fn stop_subagent(&mut self, task_id: String, cx: &mut Context<Self>) {
        let Some(client) = self.workspace_client() else {
            return;
        };
        let Some(open) = &self.thread else {
            return;
        };
        if !self.stopping_subagents.insert(task_id.clone()) {
            return;
        }
        let command = ClientOrchestrationCommand::ThreadTaskStop {
            command_id: CommandId(fresh_id("vitre-stop-agent")),
            created_at: tnes(now_iso()),
            task_id: RuntimeTaskId(task_id.clone()),
            thread_id: open.id.clone(),
            r#type: Default::default(),
        };
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = client.dispatch(&command).await;
            let _ = this.update(cx, |app, cx| {
                if let Err(error) = result {
                    app.stopping_subagents.remove(&task_id);
                    app.last_error = Some(error.user_message().into());
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn toggle_agent_card(&mut self, place: CardPlace, task_id: &str, cx: &mut Context<Self>) {
        let key = place.key(task_id);
        let set = match place {
            CardPlace::Timeline(_) => &mut self.expanded_work_entries,
            CardPlace::Dock => &mut self.expanded_dock_agents,
        };
        if !set.remove(&key) {
            set.insert(key);
        }
        match place {
            // Local UI state: remeasure by hand, as work rows do.
            CardPlace::Timeline(index) => self.remeasure_row(index, cx),
            CardPlace::Dock => cx.notify(),
        }
    }

    /// The cards for one launching tool call, stacked under a count header
    /// when the model started several at once.
    pub(super) fn render_subagent_cards(
        &self,
        row_index: usize,
        agents: &[&Subagent],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut stack = v_flex().gap_1().py_0p5();
        if agents.len() > 1 {
            let running = agents
                .iter()
                .filter(|agent| agent.status.is_active())
                .count();
            let label = if running > 0 {
                format!("Running {running} of {} agents", agents.len())
            } else {
                format!("{} agents", agents.len())
            };
            stack = stack.child(
                div()
                    .px_0p5()
                    .text_size(px(12.))
                    .font_medium()
                    .text_color(cx.theme().muted_foreground)
                    .child(label),
            );
        }
        for agent in agents {
            stack =
                stack.child(self.render_subagent_card(CardPlace::Timeline(row_index), agent, cx));
        }
        stack.into_any_element()
    }

    pub(super) fn render_subagent_card(
        &self,
        place: CardPlace,
        agent: &Subagent,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = place.key(&agent.task_id);
        let expanded = match place {
            CardPlace::Timeline(_) => self.expanded_work_entries.contains(&key),
            CardPlace::Dock => self.expanded_dock_agents.contains(&key),
        };
        let stopping = self.stopping_subagents.contains(&agent.task_id) && agent.status.is_active();
        let color = status_color(agent.status, cx);
        let task_id = agent.task_id.clone();

        let icon = if agent.kind == SubagentKind::Agent {
            Icon::new(IconName::Bot)
        } else {
            Icon::new(IconName::SquareTerminal)
        };
        let header = h_flex()
            .id(SharedString::from(format!("{key}-header")))
            .gap_2()
            .items_center()
            .cursor_pointer()
            .on_click(cx.listener({
                let task_id = task_id.clone();
                move |this, _, _, cx| this.toggle_agent_card(place, &task_id, cx)
            }))
            .child(
                icon.size_4()
                    .flex_shrink_0()
                    .text_color(cx.theme().muted_foreground),
            )
            .child(
                v_flex()
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_sm()
                            .font_medium()
                            .text_color(cx.theme().foreground)
                            .child(chat_text(agent.title())),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .items_center()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(status_icon(agent.status).size_3().text_color(color))
                            .child(div().min_w_0().truncate().child(if stopping {
                                "Stopping…".to_string()
                            } else {
                                meta_line(agent)
                            })),
                    ),
            )
            .when(agent.status.is_active(), |row| {
                let task_id = task_id.clone();
                row.child(
                    Button::new(SharedString::from(format!("{key}-stop")))
                        .ghost()
                        .xsmall()
                        .label(if stopping { "Stopping…" } else { "Stop" })
                        .disabled(stopping)
                        .tooltip("Stop this agent; the turn keeps going")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.stop_subagent(task_id.clone(), cx);
                        })),
                )
            })
            .child(
                Icon::new(if expanded {
                    IconName::ChevronUp
                } else {
                    IconName::ChevronDown
                })
                .size_3()
                .flex_shrink_0()
                .text_color(cx.theme().muted_foreground),
            );

        let mut card = v_flex()
            .id(SharedString::from(key.clone()))
            .w_full()
            .min_w_0()
            .gap_1()
            .px_3()
            .py_2()
            .rounded(cx.theme().radius)
            .border_1()
            .border_color(cx.theme().border.opacity(0.8))
            .bg(cx.theme().muted.opacity(0.5))
            .child(header);
        if let Some(line) = agent.status_line() {
            card = card.child(
                div()
                    .pl_6()
                    .min_w_0()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .when(!expanded, |line| line.truncate())
                    .when(expanded, |line| line.whitespace_normal())
                    .child(chat_text(line.to_string())),
            );
        }
        if expanded {
            card = card.child(self.render_subagent_transcript(&key, agent, cx));
        }
        card.into_any_element()
    }

    fn render_subagent_transcript(
        &self,
        key: &str,
        agent: &Subagent,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut body = v_flex()
            .ml_6()
            .mt_1()
            .pl_3()
            .gap_1()
            .border_l_1()
            .border_color(cx.theme().border.opacity(0.45));
        if let Some(prompt) = agent.prompt.as_deref() {
            body = body.child(transcript_text("Task", prompt, cx));
        }
        if agent.transcript.is_empty() {
            body = body.child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(if agent.status.is_active() {
                        "Waiting for the agent's first step…"
                    } else {
                        "This agent left no transcript."
                    }),
            );
        }
        let hidden = agent.transcript.len().saturating_sub(TRANSCRIPT_TAIL);
        let show_all = self.expanded_work_entries.contains(&format!("{key}:all"))
            || self.expanded_dock_agents.contains(&format!("{key}:all"));
        if hidden > 0 && !show_all {
            let all_key = format!("{key}:all");
            body = body.child(
                div()
                    .id(SharedString::from(format!("{key}-earlier")))
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .cursor_pointer()
                    .hover(|style| style.text_color(cx.theme().foreground))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.expanded_dock_agents.insert(all_key.clone());
                        this.expanded_work_entries.insert(all_key.clone());
                        this.rebuild_hashes_for_agents(cx);
                    }))
                    .child(format!("Show {hidden} earlier steps")),
            );
        }
        let skip = if show_all { 0 } else { hidden };
        for entry in agent.transcript.iter().skip(skip) {
            body = body.child(match entry {
                SubagentTranscriptEntry::Text(text) => transcript_text("Agent", text, cx),
                SubagentTranscriptEntry::Reasoning(text) => transcript_text("Thinking", text, cx),
                SubagentTranscriptEntry::Tool {
                    tool_name,
                    detail,
                    result,
                    ..
                } => {
                    let failed = result.as_ref().is_some_and(|result| result.is_error);
                    h_flex()
                        .gap_1p5()
                        .items_center()
                        .min_w_0()
                        .text_xs()
                        .child(
                            Icon::new(VitreIcon::Wrench)
                                .size_3()
                                .flex_shrink_0()
                                .text_color(cx.theme().muted_foreground.opacity(0.7)),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .font_medium()
                                .text_color(cx.theme().foreground.opacity(0.82))
                                .child(chat_text(tool_name.clone())),
                        )
                        .children(detail.clone().map(|detail| {
                            div()
                                .min_w_0()
                                .flex_1()
                                .truncate()
                                .font_family(cx.theme().mono_font_family.clone())
                                .text_color(cx.theme().muted_foreground)
                                .child(chat_text(detail))
                        }))
                        .child(
                            match result {
                                None => Icon::new(IconName::LoaderCircle)
                                    .text_color(cx.theme().muted_foreground),
                                Some(_) if failed => {
                                    Icon::new(IconName::Close).text_color(cx.theme().danger)
                                }
                                Some(_) => Icon::new(IconName::Check)
                                    .text_color(cx.theme().muted_foreground),
                            }
                            .size_3()
                            .flex_shrink_0(),
                        )
                        .into_any_element()
                }
            });
        }
        body.into_any_element()
    }

    /// Expanding "earlier steps" changes a card's height in both places.
    fn rebuild_hashes_for_agents(&mut self, cx: &mut Context<Self>) {
        let rows: Vec<usize> = self
            .timeline
            .iter()
            .enumerate()
            .filter_map(|(index, row)| matches!(row, TimelineRow::Work(_)).then_some(index))
            .collect();
        for index in rows {
            self.remeasure_row(index, cx);
        }
        cx.notify();
    }

    /// The dock's Agents surface: running and background agents first, then
    /// finished ones, newest first within each.
    pub(super) fn render_dock_agents(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.subagents.is_empty() {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_1()
                .p_6()
                .child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().foreground)
                        .child("No agents yet"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("Subagents and background tasks this thread starts appear here."),
                )
                .into_any_element();
        }
        let mut active: Vec<&Subagent> = Vec::new();
        let mut finished: Vec<&Subagent> = Vec::new();
        for agent in self.subagents.iter().rev() {
            if agent.status.is_active() {
                active.push(agent);
            } else {
                finished.push(agent);
            }
        }
        let section = |title: String, agents: &[&Subagent], cx: &mut Context<Self>| {
            let mut column = v_flex().gap_1p5().child(
                div()
                    .text_xs()
                    .font_semibold()
                    .text_color(cx.theme().muted_foreground)
                    .child(title),
            );
            for agent in agents {
                column = column.child(self.render_subagent_card(CardPlace::Dock, agent, cx));
            }
            column
        };
        let mut content = v_flex().w_full().gap_4().p_3();
        if !active.is_empty() {
            content = content.child(section(format!("Running · {}", active.len()), &active, cx));
        }
        if !finished.is_empty() {
            content = content.child(section(
                format!("Finished · {}", finished.len()),
                &finished,
                cx,
            ));
        }
        div()
            .id("dock-agents")
            .size_full()
            .overflow_y_scrollbar()
            .child(content)
            .into_any_element()
    }
}

fn transcript_text(label: &'static str, text: &str, cx: &App) -> AnyElement {
    let shown: String = text.lines().take(6).collect::<Vec<_>>().join("\n");
    h_flex()
        .gap_1p5()
        .items_start()
        .min_w_0()
        .text_xs()
        .child(
            div()
                .flex_shrink_0()
                .font_medium()
                .text_color(cx.theme().muted_foreground)
                .child(label),
        )
        .child(
            div()
                .min_w_0()
                .flex_1()
                .whitespace_normal()
                .text_color(cx.theme().foreground.opacity(0.82))
                .child(chat_text(shown)),
        )
        .into_any_element()
}
