//! Turn rail data is built with the timeline, leaving only active-marker
//! selection on the per-frame render path.

use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TimelineMarker {
    pub item_ix: usize,
    pub preview: SharedString,
}

pub(super) fn derive_markers(
    rows: &[TimelineRow],
    messages: &[OrchestrationMessage],
) -> Vec<TimelineMarker> {
    let mut next_assistant: Option<String> = None;
    let mut markers = Vec::new();
    for (item_ix, row) in rows.iter().enumerate().rev() {
        let TimelineRow::Message(message_ix) = row else {
            continue;
        };
        let Some(message) = messages.get(*message_ix) else {
            continue;
        };
        match message.role {
            OrchestrationMessageRole::Assistant => {
                next_assistant = Some(
                    message
                        .text
                        .0
                        .split_whitespace()
                        .take(10)
                        .collect::<Vec<_>>()
                        .join(" "),
                );
            }
            OrchestrationMessageRole::User => {
                let prompt = displayed_user_prompt(&message.text.0)
                    .split_whitespace()
                    .take(12)
                    .collect::<Vec<_>>()
                    .join(" ");
                let preview = next_assistant
                    .as_ref()
                    .filter(|reply| !reply.is_empty())
                    .map_or_else(
                        || prompt.clone(),
                        |reply| format!("{prompt}\n\nAssistant: {reply}"),
                    );
                markers.push(TimelineMarker {
                    item_ix,
                    preview: preview.into(),
                });
            }
            _ => {}
        }
    }
    markers.reverse();
    let count = markers.len();
    let step = count.div_ceil(40).max(1);
    markers
        .into_iter()
        .enumerate()
        .filter_map(|(index, marker)| (index % step == 0 || index + 1 == count).then_some(marker))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: usize, role: OrchestrationMessageRole, text: &str) -> OrchestrationMessage {
        let stamp = tnes("2026-01-01T00:00:00Z");
        OrchestrationMessage {
            attachments: None,
            created_at: stamp.clone(),
            id: MessageId(format!("marker-{id}")),
            role,
            streaming: false,
            text: tnes(text),
            turn_id: None,
            updated_at: stamp,
        }
    }

    #[test]
    fn previews_follow_the_next_assistant_even_with_other_rows_between() {
        let messages = vec![
            message(0, OrchestrationMessageRole::User, "first question"),
            message(1, OrchestrationMessageRole::User, "second question"),
            message(2, OrchestrationMessageRole::Assistant, "final answer"),
            message(3, OrchestrationMessageRole::User, "last question"),
        ];
        let rows = vec![
            TimelineRow::Message(0),
            TimelineRow::Message(1),
            TimelineRow::Message(2),
            TimelineRow::Message(3),
        ];
        let markers = derive_markers(&rows, &messages);
        assert_eq!(
            markers.iter().map(|m| m.item_ix).collect::<Vec<_>>(),
            vec![0, 1, 3]
        );
        assert_eq!(
            markers[0].preview.as_ref(),
            "first question\n\nAssistant: final answer"
        );
        assert_eq!(
            markers[1].preview.as_ref(),
            "second question\n\nAssistant: final answer"
        );
        assert_eq!(markers[2].preview.as_ref(), "last question");
    }

    #[test]
    fn preview_uses_the_same_user_prompt_shown_in_the_timeline() {
        let wrapped = ask_mode_prompt(true, "What changed in the workspace?");
        let messages = vec![message(0, OrchestrationMessageRole::User, &wrapped)];
        let markers = derive_markers(&[TimelineRow::Message(0)], &messages);
        assert_eq!(
            markers[0].preview.as_ref(),
            "What changed in the workspace?"
        );
    }

    #[test]
    fn long_thread_samples_first_and_last_and_rebuilds_for_appends() {
        let mut messages = (0..100)
            .map(|i| message(i, OrchestrationMessageRole::User, "prompt"))
            .collect::<Vec<_>>();
        let mut rows = (0..messages.len())
            .map(TimelineRow::Message)
            .collect::<Vec<_>>();
        let initial = derive_markers(&rows, &messages);
        assert_eq!(initial.first().unwrap().item_ix, 0);
        assert_eq!(initial.last().unwrap().item_ix, 99);
        assert!(initial.len() <= 41);

        messages.push(message(100, OrchestrationMessageRole::User, "appended"));
        rows.push(TimelineRow::Message(100));
        assert_eq!(
            derive_markers(&rows, &messages).last().unwrap().item_ix,
            100
        );
        assert!(
            derive_markers(&[], &[]).is_empty(),
            "a switched-to empty thread has no markers"
        );
    }
}
