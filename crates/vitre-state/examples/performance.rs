//! Release microbenchmarks comparing retained-buffer replay with event playback,
//! and owned conversation snapshots with shared settled snapshots.
use serde_json::json;
use std::{hint::black_box, time::Instant};
use vitre_contracts::{
    OrchestrationThreadDetailSnapshot, TerminalAttachStreamEvent, TrimmedNonEmptyString,
};
use vitre_state::{
    ThreadProjection,
    terminal::{TerminalBufferState, TerminalPlayback, apply_attach_event, apply_playback_event},
};

fn main() {
    let mut results = Vec::new();
    for run in 1..=3 {
        let events: Vec<_> = (0..512)
            .map(|i| TerminalAttachStreamEvent::Output {
                data: TrimmedNonEmptyString(
                    format!("\x1b[31mline {i:04} café\x1b[0m\r\n").repeat(256),
                ),
                sequence: None,
                terminal_id: "terminal-1".into(),
                thread_id: "thread-1".into(),
            })
            .collect();
        let mut old = TerminalBufferState::default();
        let mut previous = old.clone();
        let start = Instant::now();
        let mut old_bytes = 0;
        for event in &events {
            apply_attach_event(black_box(&mut old), black_box(event));
            let current = old.clone();
            old_bytes += if current.buffer.starts_with(&previous.buffer) {
                black_box(&current.buffer[previous.buffer.len()..]).len()
            } else {
                black_box(&current.buffer).len()
            };
            previous = current;
        }
        let old_us = start.elapsed().as_micros();
        let mut new = TerminalBufferState::default();
        let start = Instant::now();
        let mut new_bytes = 0;
        for event in &events {
            if let TerminalPlayback::Append(bytes) =
                apply_playback_event(black_box(&mut new), black_box(event))
            {
                new_bytes += black_box(bytes).len();
            }
        }
        results.push(json!({"scenario":"terminal-output", "run":run,
            "old_fold_us":old_us, "new_fold_us":start.elapsed().as_micros(),
            "old_parser_input_bytes":old_bytes,"new_parser_input_bytes":new_bytes,
            "note":"Counts parser input; does not time actual VT parsing or painting."}));

        for count in [100, 1000, 10000] {
            let messages: Vec<_> = (0..count).map(|i| json!({
                "id":format!("message-{i}"), "role":"assistant", "text":"hello world ".repeat(32),
                "turnId":null,"streaming":false,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z",
            })).collect();
            let snapshot: OrchestrationThreadDetailSnapshot = serde_json::from_value(json!({
                "snapshotSequence":1,"thread":{
                    "id":"thread-1","projectId":"project-1","title":"Benchmark",
                    "modelSelection":{"provider":"codex","model":"gpt-5"},
                    "runtimeMode":"full-access","interactionMode":"default",
                    "branch":null,"worktreePath":null,"latestTurn":null,
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z",
                    "deletedAt":null,"archivedAt":null,"messages":messages,"proposedPlans":[],
                    "activities":[],"checkpoints":[],"session":null
                }
            }))
            .unwrap();
            let mut projection = ThreadProjection::new();
            projection.seed(&snapshot);
            let start = Instant::now();
            for _ in 0..100 {
                black_box(projection.view());
            }
            let owned_us = start.elapsed().as_micros();
            let start = Instant::now();
            for _ in 0..100 {
                black_box(projection.shared_view());
            }
            results.push(json!({"scenario":"settled-snapshots","run":run,"messages":count,
                "iterations":100,"owned_us":owned_us,"shared_us":start.elapsed().as_micros(),
                "note":"Settled snapshots only; active overlays still materialize a view at the coalesced cadence."}));
            let deltas: Vec<vitre_contracts::OrchestrationThreadStreamItem> = (0..256)
                .map(|i| {
                    serde_json::from_value(json!({
                "kind":"ephemeral-delta","threadId":"thread-1","messageId":"streaming-newest",
                "turnId":"turn-1","offset":i * 6,"delta":"hello ","createdAt":"2026-01-01T00:00:01Z"
            })).unwrap()
                })
                .collect();
            let start = Instant::now();
            for delta in &deltas {
                projection.apply_item(delta);
                black_box(projection.view());
            }
            let per_item_us = start.elapsed().as_micros();
            let expected = projection.view().unwrap();
            projection.seed(&snapshot);
            let start = Instant::now();
            for batch in deltas.chunks(16) {
                projection.apply_batch(batch);
                black_box(projection.shared_view());
            }
            let batched_us = start.elapsed().as_micros();
            assert_eq!(
                expected.messages.last().unwrap().text,
                projection
                    .shared_view()
                    .unwrap()
                    .messages
                    .last()
                    .unwrap()
                    .text
            );
            results.push(json!({"scenario":"streaming-snapshots","run":run,"messages":count,
                "deltas":256,"batch_size":16,"per_item_us":per_item_us,"batched_us":batched_us,
                "note":"Synthetic batches, not measured UI cadence; active snapshots still copy history."}));
        }
    }
    println!("{}", serde_json::to_string_pretty(&results).unwrap());
}
