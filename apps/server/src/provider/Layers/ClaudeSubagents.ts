/**
 * Claude subagent bookkeeping: which task a subagent message belongs to, and
 * how its messages become transcript entries.
 *
 * The SDK announces a subagent with `task_started` (carrying the launching
 * `Agent` tool call's id) and then streams the subagent's own messages with
 * `parent_tool_use_id` set to that call. Those messages must not land in the
 * main conversation; they become `task.transcript` entries of their task.
 */
import type {
  RuntimeTaskStatus,
  RuntimeTaskTranscriptEntry,
  TaskStartedPayload,
} from "@t3tools/contracts";
import { RuntimeTaskId } from "@t3tools/contracts";

/** Longest text kept per transcript entry; the subagent's full output lives in the provider's files. */
export const SUBAGENT_TRANSCRIPT_TEXT_LIMIT = 4_000;
const TOOL_DETAIL_LIMIT = 200;
const TOOL_OUTPUT_LIMIT = 1_200;

interface ClaudeSubagentTask {
  readonly taskId: RuntimeTaskId;
  readonly toolUseId: string | undefined;
  readonly agentType: string | undefined;
  background: boolean | undefined;
}

export interface ClaudeTaskIdentity {
  readonly taskId: RuntimeTaskId;
  readonly toolUseId?: string;
  readonly agentType?: string;
  readonly background?: boolean;
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Tracks the subagent and background tasks of one Claude session.
 * Housekeeping tasks the SDK marks `skip_transcript` are remembered only so
 * their later events can be dropped.
 */
export class ClaudeSubagentTasks {
  private readonly byTaskId = new Map<string, ClaudeSubagentTask>();
  private readonly taskIdByToolUseId = new Map<string, RuntimeTaskId>();
  private readonly hidden = new Set<string>();

  start(message: {
    readonly task_id: string;
    readonly tool_use_id?: string | undefined;
    readonly subagent_type?: string | undefined;
    readonly skip_transcript?: boolean | undefined;
  }): ClaudeTaskIdentity | undefined {
    if (message.skip_transcript) {
      this.hidden.add(message.task_id);
      return undefined;
    }
    const task: ClaudeSubagentTask = {
      taskId: RuntimeTaskId.make(message.task_id),
      toolUseId: nonEmpty(message.tool_use_id),
      agentType: nonEmpty(message.subagent_type),
      background: undefined,
    };
    this.byTaskId.set(message.task_id, task);
    if (task.toolUseId) {
      this.taskIdByToolUseId.set(task.toolUseId, task.taskId);
    }
    return this.identity(message.task_id);
  }

  isHidden(taskId: string): boolean {
    return this.hidden.has(taskId);
  }

  setBackground(taskId: string, background: boolean): void {
    const task = this.byTaskId.get(taskId);
    if (task) task.background = background;
  }

  /** The fields every event of this task carries. Unknown tasks get only their id. */
  identity(taskId: string): ClaudeTaskIdentity {
    const task = this.byTaskId.get(taskId);
    return {
      taskId: task?.taskId ?? RuntimeTaskId.make(taskId),
      ...(task?.toolUseId ? { toolUseId: task.toolUseId } : {}),
      ...(task?.agentType ? { agentType: task.agentType } : {}),
      ...(task?.background !== undefined ? { background: task.background } : {}),
    };
  }

  /**
   * The task a subagent message belongs to. A message whose `task_started`
   * has not arrived yet is keyed by its tool call, which clients also group by.
   */
  identityForToolUse(parentToolUseId: string): ClaudeTaskIdentity {
    const taskId = this.taskIdByToolUseId.get(parentToolUseId);
    if (taskId) return this.identity(taskId);
    return { taskId: RuntimeTaskId.make(parentToolUseId), toolUseId: parentToolUseId };
  }

  forget(taskId: string): void {
    const task = this.byTaskId.get(taskId);
    if (task?.toolUseId) this.taskIdByToolUseId.delete(task.toolUseId);
    this.byTaskId.delete(taskId);
    this.hidden.delete(taskId);
  }
}

/** The `task.started` payload for an SDK `task_started` message. */
export function claudeTaskStartedPayload(
  identity: ClaudeTaskIdentity,
  message: {
    readonly description?: string | undefined;
    readonly task_type?: string | undefined;
    readonly workflow_name?: string | undefined;
    readonly prompt?: string | undefined;
  },
): TaskStartedPayload {
  const description = nonEmpty(message.description);
  const taskType = nonEmpty(message.task_type);
  const prompt = nonEmpty(message.prompt);
  return {
    ...identity,
    ...(description ? { description } : {}),
    ...(taskType ? { taskType } : {}),
    ...(prompt ? { prompt: truncate(prompt, SUBAGENT_TRANSCRIPT_TEXT_LIMIT) } : {}),
  };
}

/** SDK task patch statuses in runtime terms; `killed` is a user or model stop. */
export function claudeTaskStatus(
  status: "pending" | "running" | "completed" | "failed" | "killed" | "paused" | undefined,
): RuntimeTaskStatus | undefined {
  switch (status) {
    case undefined:
      return undefined;
    case "killed":
      return "stopped";
    default:
      return status;
  }
}

/** A one-line rendering of a tool call's input: the command, path, pattern or query. */
export function claudeToolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of [
    "command",
    "cmd",
    "file_path",
    "path",
    "notebook_path",
    "pattern",
    "url",
    "query",
    "description",
    "prompt",
  ]) {
    const value = nonEmpty(record[key]);
    if (value) return truncate(value.replace(/\s+/g, " "), TOOL_DETAIL_LIMIT);
  }
  return undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

/**
 * The transcript entries in one subagent `assistant` or `user` message:
 * its text, reasoning, tool calls and tool results, in order.
 */
export function claudeSubagentTranscriptEntries(message: {
  readonly type: string;
  readonly message?: unknown;
}): RuntimeTaskTranscriptEntry[] {
  if (message.type !== "assistant" && message.type !== "user") return [];
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    // A string body on a subagent `user` message is the prompt it was given,
    // which `task.started` already carries.
    const text = nonEmpty(content);
    return message.type === "assistant" && text
      ? [{ kind: "text", text: truncate(text, SUBAGENT_TRANSCRIPT_TEXT_LIMIT) }]
      : [];
  }
  if (!Array.isArray(content)) return [];

  const entries: RuntimeTaskTranscriptEntry[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case "text": {
        const text = message.type === "assistant" ? nonEmpty(block.text) : undefined;
        if (text)
          entries.push({ kind: "text", text: truncate(text, SUBAGENT_TRANSCRIPT_TEXT_LIMIT) });
        break;
      }
      case "thinking": {
        const text = nonEmpty(block.thinking);
        if (text) {
          entries.push({ kind: "reasoning", text: truncate(text, SUBAGENT_TRANSCRIPT_TEXT_LIMIT) });
        }
        break;
      }
      case "tool_use": {
        const toolUseId = nonEmpty(block.id);
        const toolName = nonEmpty(block.name);
        if (!toolUseId || !toolName) break;
        const detail = claudeToolDetail(block.input);
        entries.push({ kind: "tool", toolUseId, toolName, ...(detail ? { detail } : {}) });
        break;
      }
      case "tool_result": {
        const toolUseId = nonEmpty(block.tool_use_id);
        if (!toolUseId) break;
        const output = nonEmpty(toolResultText(block.content));
        entries.push({
          kind: "tool_result",
          toolUseId,
          isError: block.is_error === true,
          ...(output ? { output: truncate(output, TOOL_OUTPUT_LIMIT) } : {}),
        });
        break;
      }
    }
  }
  return entries;
}
