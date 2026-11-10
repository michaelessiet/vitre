import { describe, expect, it } from "vite-plus/test";

import {
  ClaudeSubagentTasks,
  claudeSubagentTranscriptEntries,
  claudeTaskStatus,
  claudeToolDetail,
  SUBAGENT_TRANSCRIPT_TEXT_LIMIT,
} from "./ClaudeSubagents.ts";

describe("ClaudeSubagentTasks", () => {
  it("attributes subagent messages to their task by the launching tool call", () => {
    const tasks = new ClaudeSubagentTasks();
    tasks.start({ task_id: "t1", tool_use_id: "toolu_1", subagent_type: "Explore" });
    tasks.setBackground("t1", true);
    expect(tasks.identityForToolUse("toolu_1")).toEqual({
      taskId: "t1",
      toolUseId: "toolu_1",
      agentType: "Explore",
      background: true,
    });
  });

  it("keys a message that arrives before its task_started by the tool call", () => {
    expect(new ClaudeSubagentTasks().identityForToolUse("toolu_9")).toEqual({
      taskId: "toolu_9",
      toolUseId: "toolu_9",
    });
  });

  it("hides housekeeping tasks until they are forgotten", () => {
    const tasks = new ClaudeSubagentTasks();
    expect(tasks.start({ task_id: "h", skip_transcript: true })).toBeUndefined();
    expect(tasks.isHidden("h")).toBe(true);
    tasks.forget("h");
    expect(tasks.isHidden("h")).toBe(false);
  });
});

describe("claudeSubagentTranscriptEntries", () => {
  it("keeps text, reasoning, tool calls and results in order", () => {
    expect(
      claudeSubagentTranscriptEntries({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Where are reducers?" },
            { type: "text", text: "Looking." },
            { type: "tool_use", id: "a", name: "Bash", input: { command: "ls\n  -la" } },
          ],
        },
      }),
    ).toEqual([
      { kind: "reasoning", text: "Where are reducers?" },
      { kind: "text", text: "Looking." },
      { kind: "tool", toolUseId: "a", toolName: "Bash", detail: "ls -la" },
    ]);
    expect(
      claudeSubagentTranscriptEntries({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "a",
              is_error: true,
              content: [{ type: "text", text: "denied" }],
            },
          ],
        },
      }),
    ).toEqual([{ kind: "tool_result", toolUseId: "a", isError: true, output: "denied" }]);
  });

  it("drops the prompt echo and truncates long text", () => {
    expect(
      claudeSubagentTranscriptEntries({ type: "user", message: { content: "prompt" } }),
    ).toEqual([]);
    const [entry] = claudeSubagentTranscriptEntries({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "x".repeat(SUBAGENT_TRANSCRIPT_TEXT_LIMIT + 50) }],
      },
    });
    expect(entry?.kind === "text" && entry.text.length).toBe(SUBAGENT_TRANSCRIPT_TEXT_LIMIT);
  });
});

describe("claudeTaskStatus and claudeToolDetail", () => {
  it("maps killed to stopped", () => {
    expect(claudeTaskStatus("killed")).toBe("stopped");
    expect(claudeTaskStatus("paused")).toBe("paused");
    expect(claudeTaskStatus(undefined)).toBeUndefined();
  });

  it("prefers the most specific input field", () => {
    expect(claudeToolDetail({ file_path: "/a.ts", description: "x" })).toBe("/a.ts");
    expect(claudeToolDetail({ other: 1 })).toBeUndefined();
  });
});
