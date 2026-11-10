import { describe, expect, it } from "vite-plus/test";

import { sanitizeSubagentSummary } from "../textGeneration/TextGenerationPrompts.ts";
import { renderTranscriptEntry, SubagentSummaryTracker } from "./subagentSummaries.ts";

const identity = { taskId: "t1", toolUseId: "toolu_1", agentType: "Explore" };
const started = { kind: "task.started", payload: { ...identity, prompt: "Find reducers" } };
const tool = (name: string) => ({
  kind: "task.transcript",
  payload: { ...identity, entry: { kind: "tool", toolUseId: name, toolName: name, detail: "x" } },
});

describe("SubagentSummaryTracker", () => {
  it("waits an interval after the start, then summarizes only new work", () => {
    const tracker = new SubagentSummaryTracker(1_000);
    expect(tracker.observe("th", started, 0)).toBeUndefined();
    expect(tracker.observe("th", tool("Grep"), 500)).toBeUndefined();

    const request = tracker.observe("th", tool("Read"), 1_200);
    expect(request).toEqual({
      threadId: "th",
      taskId: "t1",
      identity,
      task: "Find reducers",
      transcript: "tool Grep: x\ntool Read: x",
    });
    // One summary at a time per agent, even after the interval.
    expect(tracker.observe("th", tool("Bash"), 2_500)).toBeUndefined();
    expect(tracker.settle("th", "t1")).toBe(true);
    expect(tracker.observe("th", tool("Edit"), 2_600)?.transcript).toContain("tool Edit: x");
  });

  it("forgets finished tasks so late summaries are dropped", () => {
    const tracker = new SubagentSummaryTracker(0);
    tracker.observe("th", started, 0);
    expect(tracker.observe("th", tool("Grep"), 1)).toBeDefined();
    tracker.observe(
      "th",
      { kind: "task.completed", payload: { ...identity, status: "completed" } },
      2,
    );
    expect(tracker.settle("th", "t1")).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it("ignores tasks that are not subagents", () => {
    const tracker = new SubagentSummaryTracker(0);
    expect(
      tracker.observe(
        "th",
        { kind: "task.started", payload: { taskId: "plan", taskType: "plan" } },
        0,
      ),
    ).toBeUndefined();
    expect(tracker.size).toBe(0);
  });
});

describe("renderTranscriptEntry and sanitizeSubagentSummary", () => {
  it("renders each entry kind on one line", () => {
    expect(renderTranscriptEntry({ kind: "text", text: "a\n b" })).toBe("agent: a b");
    expect(renderTranscriptEntry({ kind: "tool_result", isError: true })).toBe("tool failed");
    expect(renderTranscriptEntry({ kind: "unknown" })).toBeUndefined();
  });

  it("keeps one unquoted line without a trailing period", () => {
    expect(sanitizeSubagentSummary('"Reading the reducers."\nmore')).toBe("Reading the reducers");
    expect(sanitizeSubagentSummary("x".repeat(200))).toHaveLength(140);
  });
});
