use super::*;

/// Retain both presentations so scrolling and toggling never restart parsing.
pub(super) struct PlanMarkdown {
    source: SharedString,
    preview: SharedString,
    title: SharedString,
    collapsible: bool,
    collapsed: Option<text::MessageMarkdown>,
    expanded: Option<text::MessageMarkdown>,
}

type PlanContent = (
    SharedString,
    bool,
    SharedString,
    Entity<gpui_component::text::TextViewState>,
    SharedString,
);

impl ChatApp {
    pub(super) fn plan_content(
        &mut self,
        row: TimelineRow,
        cx: &mut Context<Self>,
    ) -> Option<PlanContent> {
        let TimelineRow::ProposedPlan(i) = row else {
            return None;
        };
        let plan = self
            .thread
            .as_ref()?
            .state
            .view
            .as_ref()?
            .proposed_plans
            .as_ref()?
            .as_ref()?
            .get(i)?;
        let id = plan.id.clone();
        let expanded = self.expanded_plans.contains(&id);
        let cached = self
            .plan_markdown
            .entry(id.clone())
            .or_insert_with(|| PlanMarkdown::new(&plan.plan_markdown));
        if cached.source.as_ref() != plan.plan_markdown.as_str() {
            *cached = PlanMarkdown::new(&plan.plan_markdown);
        }
        let source = if cached.collapsible && !expanded {
            cached.preview.clone()
        } else {
            cached.source.clone()
        };
        let slot = if cached.collapsible && expanded {
            &mut cached.expanded
        } else {
            &mut cached.collapsed
        };
        let markdown = slot.get_or_insert_with(|| {
            let state =
                cx.new(|cx| gpui_component::text::TextViewState::markdown(source.as_ref(), cx));
            let subscription = cx.observe(&state, move |app, _, cx| {
                // Markdown finishes parsing after the row is first laid out.
                // Recompute its height for both the preview and full plan.
                let index = app.timeline.iter().position(|row| {
                    let TimelineRow::ProposedPlan(i) = row else {
                        return false;
                    };
                    app.thread
                        .as_ref()
                        .and_then(|t| t.state.view.as_ref())
                        .and_then(|v| v.proposed_plans.as_ref())
                        .and_then(|p| p.as_ref())
                        .and_then(|p| p.get(*i))
                        .is_some_and(|p| p.id == id)
                });
                if let Some(index) = index {
                    app.remeasure_row(index, cx);
                }
            });
            text::MessageMarkdown {
                state,
                _subscription: subscription,
                touched: std::time::Instant::now(),
                source_bytes: source.len(),
            }
        });
        Some((
            cached.title.clone(),
            cached.collapsible,
            source,
            markdown.state.clone(),
            cached.source.clone(),
        ))
    }

    pub(super) fn toggle_plan(&mut self, id: &str, index: usize, cx: &mut Context<Self>) {
        // Explicitly leave tail-following before changing height; otherwise
        // expanding the last row pulls the reader to its bottom.
        if self.timeline_list.logical_scroll_top().item_ix >= self.timeline.len() {
            // Bottom alignment represents the viewport by an end sentinel.
            // Convert it to the actual top before invalidating row heights.
            self.timeline_list
                .scroll_by(-self.timeline_list.viewport_bounds().size.height);
        }
        self.timeline_list.pause_following_tail();
        if !self.expanded_plans.remove(id) {
            self.expanded_plans.insert(id.to_string());
        }
        self.remeasure_row(index, cx);
    }
}

impl PlanMarkdown {
    fn new(source: &str) -> Self {
        let collapsible = source.chars().take(901).count() > 900
            || source
                .lines()
                .filter(|line| !line.trim().is_empty())
                .take(9)
                .count()
                > 8;
        Self {
            source: source.to_owned().into(),
            preview: collapsed_plan_markdown(source).into(),
            title: proposed_plan_title(source)
                .unwrap_or_else(|| "Proposed plan".into())
                .into(),
            collapsible,
            collapsed: None,
            expanded: None,
        }
    }
}

/// Anchor plans to the turn that produced them, including collapsed turns.
/// Creation time is the fallback for older projections without turn IDs;
/// updated_at must never move a plan past subsequent conversation turns.
pub(super) fn insert_plans(
    rows: &mut Vec<TimelineRow>,
    plans: &[OrchestrationThreadProposedPlans],
    messages: &[OrchestrationMessage],
    work: &[WorkLogEntry],
    folds: &[TurnFoldData],
) {
    let mut ordered = plans.iter().enumerate().collect::<Vec<_>>();
    ordered.sort_by(|(_, a), (_, b)| a.created_at.0.cmp(&b.created_at.0));
    for (index, plan) in ordered {
        if proposed_plan_is_implemented(plan) {
            continue;
        }
        let turn_end = plan.turn_id.as_deref().and_then(|turn| {
            rows.iter().rposition(|row| {
                let row_turn = match *row {
                    TimelineRow::Message(i) => messages[i].turn_id.as_ref().map(|id| id.0.as_str()),
                    TimelineRow::Work(i) => work[i].turn_id.as_deref(),
                    TimelineRow::TurnFold(i) => Some(folds[i].turn_id.as_str()),
                    TimelineRow::ProposedPlan(i) => plans[i].turn_id.as_deref(),
                    _ => None,
                };
                row_turn == Some(turn)
            })
        });
        let insert_at = turn_end.map(|i| i + 1).unwrap_or_else(|| {
            rows.iter()
                .position(|row| {
                    let created_at = match *row {
                        TimelineRow::Message(i) => &messages[i].created_at.0,
                        TimelineRow::Work(i) => &work[i].created_at,
                        TimelineRow::ProposedPlan(i) => &plans[i].created_at.0,
                        TimelineRow::TurnFold(i) => {
                            let turn = folds[i].turn_id.as_str();
                            let stamp = messages
                                .iter()
                                .filter(|m| m.turn_id.as_ref().is_some_and(|id| id.0 == turn))
                                .map(|m| &m.created_at.0)
                                .chain(
                                    work.iter()
                                        .filter(|w| w.turn_id.as_deref() == Some(turn))
                                        .map(|w| &w.created_at),
                                )
                                .min();
                            let Some(stamp) = stamp else {
                                return false;
                            };
                            stamp
                        }
                        TimelineRow::Running => return true,
                        TimelineRow::WorkToggle(_) => return false,
                    };
                    created_at > &plan.created_at.0
                })
                .unwrap_or(rows.len())
        });
        rows.insert(insert_at, TimelineRow::ProposedPlan(index));
    }
}

#[cfg(debug_assertions)]
pub(super) async fn verify(
    app: &WeakEntity<ChatApp>,
    cx: &mut gpui::AsyncWindowContext,
) -> Result<(), String> {
    ui_verification::float_fixture(cx).await?;
    for follow_up in [false, true] {
        app.update_in(cx, |app, window, cx| {
            window.resize(gpui::size(px(1200.), px(1000.)));
            if app.dock_open() { app.toggle_right_panel(window, cx); }
            let view = Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap());
            view.messages = vec![serde_json::from_value(serde_json::json!({
                "id": "planning-response", "role": "assistant", "text": "Here is the proposed plan.",
                "turnId": "planning", "streaming": false,
                "createdAt": "2026-09-18T12:00:00.000Z", "updatedAt": "2026-09-18T12:00:00.000Z"
            })).unwrap()];
            view.proposed_plans = Some(Some(vec![serde_json::from_value(serde_json::json!({
                "id": "position-plan", "planMarkdown": "# Keep plans in place\n\n1. Anchor the plan to its turn.\n2. Keep follow-up messages below it.",
                "turnId": "planning", "createdAt": "2026-09-18T12:00:01.000Z", "updatedAt": "2026-09-18T12:10:00.000Z"
            })).unwrap()]));
            if follow_up {
                view.messages.push(serde_json::from_value(serde_json::json!({
                    "id": "follow-up", "role": "user", "text": "This follow-up should remain below the plan.",
                    "turnId": null, "streaming": false,
                    "createdAt": "2026-09-18T12:01:00.000Z", "updatedAt": "2026-09-18T12:01:00.000Z"
                })).unwrap());
            }
            app.rebuild_timeline(cx);
            let expected = if follow_up {
                vec![TimelineRow::Message(0), TimelineRow::ProposedPlan(0), TimelineRow::Message(1)]
            } else {
                vec![TimelineRow::Message(0), TimelineRow::ProposedPlan(0)]
            };
            if app.timeline != expected { return Err(format!("Unexpected plan position: {:?}", app.timeline)); }
            cx.notify();
            Ok(())
        }).map_err(|e| e.to_string())??;
        cx.background_executor()
            .timer(Duration::from_millis(800))
            .await;
    }
    if let Err(error) = ui_verification::capture("plan-timeline", cx).await {
        eprintln!("[vitre-plan-test] capture unavailable: {error}");
    }
    verify_scrolling(app, cx).await?;
    cx.update(|_, cx| cx.quit()).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(debug_assertions)]
async fn verify_scrolling(
    app: &WeakEntity<ChatApp>,
    cx: &mut gpui::AsyncWindowContext,
) -> Result<(), String> {
    app.update(cx, |app, cx| {
        let view = Arc::make_mut(app.thread.as_mut().unwrap().state.view.as_mut().unwrap());
        view.messages[0].text = tnes("Here is the proposed plan.");
        let plan = &mut view.proposed_plans.as_mut().unwrap().as_mut().unwrap()[0];
        plan.plan_markdown = (0..12).map(|i| format!("## Step {i}\n\nKeep the complete plan readable in the conversation.\n\n```rust\nlet step = {i};\n```\n\n")).collect();
        app.rebuild_timeline(cx);
        app.timeline_list.scroll_to(ListOffset { item_ix: 0, offset_in_item: px(0.) });
        cx.notify();
    }).map_err(|e| e.to_string())?;
    cx.background_executor()
        .timer(Duration::from_millis(300))
        .await;
    cx.update(|w, cx| {
        w.refresh();
        w.draw(cx).clear(cx)
    })
    .map_err(|e| e.to_string())?;
    app.update(cx, |app, cx| {
        app.timeline_list.scroll_to_end();
        app.toggle_plan("position-plan", 1, cx);
    })
    .map_err(|e| e.to_string())?;
    cx.background_executor()
        .timer(Duration::from_millis(900))
        .await;
    cx.update(|w, cx| {
        w.refresh();
        w.draw(cx).clear(cx)
    })
    .map_err(|e| e.to_string())?;
    app.update(cx, |app, _| {
        app.timeline_list.scroll_to(ListOffset {
            item_ix: 1,
            offset_in_item: px(0.),
        });
    })
    .map_err(|e| e.to_string())?;
    cx.update(|w, cx| w.draw(cx).clear(cx))
        .map_err(|e| e.to_string())?;
    let identity = app
        .update(cx, |app, _| {
            let bounds = app.timeline_list.bounds_for_item(1).unwrap();
            assert!(
                bounds.size.height > px(500.),
                "Expanded plan did not grow to show its full content"
            );
            assert!(
                !app.timeline_list.is_following_tail(),
                "Expansion resumed tail following"
            );
            app.plan_markdown["position-plan"]
                .expanded
                .as_ref()
                .unwrap()
                .state
                .entity_id()
        })
        .map_err(|e| e.to_string())?;
    let (inside, before) = app
        .update(cx, |app, _| {
            app.timeline_list.scroll_to(ListOffset {
                item_ix: 1,
                offset_in_item: px(0.),
            });
            let viewport = app.timeline_list.viewport_bounds();
            (
                gpui::point(viewport.center().x, viewport.center().y),
                app.timeline_list.scroll_px_offset_for_scrollbar().y,
            )
        })
        .map_err(|e| e.to_string())?;
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        window.dispatch_event(
            gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                position: inside,
                ..Default::default()
            }),
            cx,
        );
        window.dispatch_event(
            gpui::PlatformInput::ScrollWheel(gpui::ScrollWheelEvent {
                position: inside,
                delta: gpui::ScrollDelta::Pixels(gpui::point(px(0.), px(-180.))),
                ..Default::default()
            }),
            cx,
        );
        window.draw(cx).clear(cx);
    })
    .map_err(|e| e.to_string())?;
    app.update(cx, |app, _| {
        assert!(
            (app.timeline_list.scroll_px_offset_for_scrollbar().y - before).abs() > px(50.),
            "Wheel over the expanded plan did not scroll the conversation"
        );
    })
    .map_err(|e| e.to_string())?;
    if let Err(error) = ui_verification::capture("plan-expanded-scrolled", cx).await {
        eprintln!("[vitre-plan-test] capture unavailable: {error}");
    }
    for _ in 0..3 {
        for _ in 0..2 {
            app.update(cx, |app, cx| app.toggle_plan("position-plan", 1, cx))
                .map_err(|e| e.to_string())?;
            cx.background_executor()
                .timer(Duration::from_millis(100))
                .await;
            cx.update(|w, cx| {
                w.refresh();
                w.draw(cx).clear(cx)
            })
            .map_err(|e| e.to_string())?;
        }
    }
    app.update(cx, |app, _| {
        assert_eq!(
            app.plan_markdown["position-plan"]
                .expanded
                .as_ref()
                .unwrap()
                .state
                .entity_id(),
            identity,
            "Toggling reparsed the full plan"
        );
    })
    .map_err(|e| e.to_string())?;
    eprintln!(
        "[vitre-plan-test] PASS: full plan height, conversation scrolling inside card, retained parse across six toggles"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_preview_bounds_a_single_long_unicode_line() {
        let source = "世界🙂".repeat(1000);
        let preview = collapsed_plan_markdown(&source);
        assert_eq!(preview.chars().count(), 901);
        assert!(preview.ends_with('…'));
        assert!(source.starts_with(preview.trim_end_matches('…')));
        assert_eq!(
            collapsed_plan_markdown("# Short plan\n\nOne step."),
            "# Short plan\n\nOne step."
        );
    }

    fn message(id: &str, turn: Option<&str>, time: &str) -> OrchestrationMessage {
        serde_json::from_value(serde_json::json!({
            "id": id, "role": "assistant", "text": id, "turnId": turn,
            "createdAt": time, "updatedAt": time, "streaming": false
        }))
        .unwrap()
    }

    fn plan(turn: Option<&str>) -> OrchestrationThreadProposedPlans {
        serde_json::from_value(serde_json::json!({
            "id": "plan", "planMarkdown": "# Plan", "turnId": turn,
            "createdAt": "2026-09-18T12:00:01.000Z",
            "updatedAt": "2026-09-18T12:10:00.000Z"
        }))
        .unwrap()
    }

    #[test]
    fn plan_timeline_stays_before_follow_up_messages_even_when_updated() {
        for turn in [Some("original"), None] {
            let messages = [
                message("original", turn, "2026-09-18T12:00:00.000Z"),
                message("follow-up", Some("next"), "2026-09-18T12:01:00.000Z"),
            ];
            let mut rows = vec![
                TimelineRow::Message(0),
                TimelineRow::Message(1),
                TimelineRow::Running,
            ];
            insert_plans(&mut rows, &[plan(turn)], &messages, &[], &[]);
            assert_eq!(
                rows,
                vec![
                    TimelineRow::Message(0),
                    TimelineRow::ProposedPlan(0),
                    TimelineRow::Message(1),
                    TimelineRow::Running
                ]
            );
        }
    }

    #[test]
    fn plan_timeline_anchors_to_a_collapsed_turn() {
        let folds = [TurnFoldData {
            turn_id: "original".into(),
            label: "Worked".into(),
            expanded: false,
        }];
        let messages = [message(
            "follow-up",
            Some("next"),
            "2026-09-18T12:01:00.000Z",
        )];
        let mut rows = vec![TimelineRow::TurnFold(0), TimelineRow::Message(0)];
        insert_plans(&mut rows, &[plan(Some("original"))], &messages, &[], &folds);
        assert_eq!(
            rows,
            vec![
                TimelineRow::TurnFold(0),
                TimelineRow::ProposedPlan(0),
                TimelineRow::Message(0)
            ]
        );
    }

    #[test]
    fn plan_timeline_orders_multiple_plans_by_creation_and_keeps_running_last() {
        let first = plan(None);
        let mut second = first.clone();
        second.id = "second".into();
        second.created_at = tnes("2026-09-18T12:02:00.000Z");
        let mut rows = vec![TimelineRow::Running];
        insert_plans(&mut rows, &[second, first], &[], &[], &[]);
        assert_eq!(
            rows,
            vec![
                TimelineRow::ProposedPlan(1),
                TimelineRow::ProposedPlan(0),
                TimelineRow::Running
            ]
        );
    }
}
