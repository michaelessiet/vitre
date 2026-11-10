import type { ProviderEvent, ProviderRuntimeEvent } from "@t3tools/contracts";
import { EventId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  codexCollabTaskEvents,
  codexSubagentRuntimeEvents,
  codexSubagentTranscriptEntries,
} from "./CodexSubagents.ts";

const base = {
  eventId: EventId.make("evt"),
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies Omit<ProviderRuntimeEvent, "type" | "payload">;

const event = (method: string, item: Record<string, unknown>, extra: Partial<ProviderEvent> = {}) =>
  ({
    id: EventId.make("evt"),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread-1"),
    createdAt: base.createdAt,
    method,
    payload: { item },
    ...extra,
  }) satisfies ProviderEvent;

describe("codexSubagentTranscriptEntries", () => {
  it("turns a command into a call and a failed result", () => {
    expect(
      codexSubagentTranscriptEntries({
        type: "commandExecution",
        id: "c1",
        command: "cargo test\n  -p x",
        aggregatedOutput: "1 failed",
        exitCode: 101,
      }),
    ).toEqual([
      { kind: "tool", toolUseId: "c1", toolName: "Shell", detail: "cargo test -p x" },
      { kind: "tool_result", toolUseId: "c1", isError: true, output: "1 failed" },
    ]);
  });

  it("lists edited paths and ignores unknown items", () => {
    expect(
      codexSubagentTranscriptEntries({
        type: "fileChange",
        id: "f1",
        changes: [{ path: "a.rs" }, { path: "b.rs" }],
        status: "completed",
      })[0],
    ).toEqual({ kind: "tool", toolUseId: "f1", toolName: "Edit", detail: "a.rs, b.rs" });
    expect(codexSubagentTranscriptEntries({ type: "somethingNew", id: "x" })).toEqual([]);
  });
});

describe("codexSubagentRuntimeEvents", () => {
  it("keeps only finished items, with unique event ids", () => {
    const subagent = { threadId: "child-1", toolCallId: "call_1" };
    const item = { type: "commandExecution", id: "c1", command: "ls", exitCode: 0 };
    expect(codexSubagentRuntimeEvents(event("item/started", item, { subagent }), base)).toEqual([]);
    const events = codexSubagentRuntimeEvents(event("item/completed", item, { subagent }), base);
    expect(events.map((entry) => entry.eventId)).toEqual(["evt", "evt:1"]);
    expect(events[0]?.payload).toMatchObject({ taskId: "child-1", toolUseId: "call_1" });
  });
});

describe("codexCollabTaskEvents", () => {
  it("completes agents that a later call reports in a terminal state", () => {
    const events = codexCollabTaskEvents(
      event("item/completed", {
        type: "collabAgentToolCall",
        id: "call_wait",
        tool: "wait",
        receiverThreadIds: ["child-1", "child-2"],
        agentsStates: {
          "child-1": { status: "completed", message: "All reducers pure" },
          "child-2": { status: "running" },
          "child-3": { status: "errored" },
        },
      }),
      base,
    );
    expect(events.map((entry) => [entry.type, entry.payload])).toEqual([
      ["task.completed", { taskId: "child-1", status: "completed", summary: "All reducers pure" }],
      ["task.completed", { taskId: "child-3", status: "failed" }],
    ]);
  });

  it("maps subAgentActivity completion and ignores the subagent's own collab calls", () => {
    expect(
      codexCollabTaskEvents(
        event("item/completed", {
          type: "subAgentActivity",
          agentThreadId: "c",
          kind: "interrupted",
        }),
        base,
      )[0]?.payload,
    ).toEqual({ taskId: "c", status: "stopped" });
    expect(
      codexCollabTaskEvents(
        event(
          "item/started",
          { type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["d"] },
          { subagent: { threadId: "c" } },
        ),
        base,
      ),
    ).toEqual([]);
  });
});
