/**
 * Codex subagents as runtime tasks.
 *
 * Codex spawns a subagent as its own thread through a `collabAgentToolCall`
 * item (`spawnAgent`) in the parent thread; the session runtime then tags the
 * child thread's notifications with `subagent`. Here the spawn call becomes
 * `task.started` per new thread, agent states reported by later collab calls
 * (or `subAgentActivity` items) become `task.completed`, and the child's
 * finished items become `task.transcript` entries of that task.
 */
import type {
  ProviderEvent,
  ProviderRuntimeEvent,
  RuntimeTaskTranscriptEntry,
} from "@t3tools/contracts";
import { RuntimeTaskId } from "@t3tools/contracts";

type RuntimeEventBase = Omit<ProviderRuntimeEvent, "type" | "payload">;

const TEXT_LIMIT = 4_000;
const DETAIL_LIMIT = 200;
const OUTPUT_LIMIT = 1_200;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

function oneLine(value: string, limit = DETAIL_LIMIT): string {
  return clip(value.replace(/\s+/g, " ").trim(), limit);
}

function itemOf(event: ProviderEvent): Record<string, unknown> | undefined {
  return record(record(event.payload)?.item);
}

function joinedText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return text(value);
  return text(value.filter((part): part is string => typeof part === "string").join("\n"));
}

/** The transcript entries in one finished item of a subagent's thread. */
export function codexSubagentTranscriptEntries(
  item: Record<string, unknown>,
): RuntimeTaskTranscriptEntry[] {
  const id = text(item.id);
  switch (item.type) {
    case "agentMessage": {
      const body = text(item.text);
      return body ? [{ kind: "text", text: clip(body, TEXT_LIMIT) }] : [];
    }
    case "reasoning": {
      const body = joinedText(item.summary) ?? joinedText(item.content);
      return body ? [{ kind: "reasoning", text: clip(body, TEXT_LIMIT) }] : [];
    }
    case "commandExecution": {
      if (!id) return [];
      const command = text(item.command);
      const output = text(item.aggregatedOutput);
      const failed =
        item.status === "failed" ||
        item.status === "declined" ||
        (typeof item.exitCode === "number" && item.exitCode !== 0);
      return [
        {
          kind: "tool",
          toolUseId: id,
          toolName: "Shell",
          ...(command ? { detail: oneLine(command) } : {}),
        },
        {
          kind: "tool_result",
          toolUseId: id,
          isError: failed,
          ...(output ? { output: clip(output, OUTPUT_LIMIT) } : {}),
        },
      ];
    }
    case "fileChange": {
      if (!id) return [];
      const paths = Array.isArray(item.changes)
        ? item.changes.flatMap((change) => {
            const path = text(record(change)?.path);
            return path ? [path] : [];
          })
        : [];
      return [
        {
          kind: "tool",
          toolUseId: id,
          toolName: "Edit",
          ...(paths.length > 0 ? { detail: oneLine(paths.join(", ")) } : {}),
        },
        { kind: "tool_result", toolUseId: id, isError: item.status === "failed" },
      ];
    }
    case "mcpToolCall": {
      if (!id) return [];
      const server = text(item.server);
      const tool = text(item.tool) ?? "tool";
      return [
        { kind: "tool", toolUseId: id, toolName: server ? `${server}.${tool}` : tool },
        { kind: "tool_result", toolUseId: id, isError: item.status === "failed" },
      ];
    }
    case "webSearch": {
      if (!id) return [];
      const query = text(item.query);
      return [
        {
          kind: "tool",
          toolUseId: id,
          toolName: "WebSearch",
          ...(query ? { detail: oneLine(query) } : {}),
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Runtime events for a notification from a subagent's own thread. Only
 * finished items are kept; deltas and starts are superseded by them, and
 * none of it may enter the parent conversation.
 */
export function codexSubagentRuntimeEvents(
  event: ProviderEvent,
  base: RuntimeEventBase,
): ReadonlyArray<ProviderRuntimeEvent> {
  const subagent = event.subagent;
  if (!subagent || event.method !== "item/completed") return [];
  const item = itemOf(event);
  if (!item) return [];
  const identity = {
    taskId: RuntimeTaskId.make(subagent.threadId),
    ...(subagent.toolCallId ? { toolUseId: subagent.toolCallId } : {}),
  };
  return codexSubagentTranscriptEntries(item).map(
    (entry, index) =>
      ({
        ...base,
        // One notification can yield a call and its result; keep ids unique.
        eventId: index === 0 ? base.eventId : (`${base.eventId}:${index}` as typeof base.eventId),
        type: "task.transcript",
        payload: { ...identity, entry },
      }) satisfies ProviderRuntimeEvent,
  );
}

function terminalStatus(status: unknown): "completed" | "failed" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
    case "notFound":
      return "failed";
    case "interrupted":
    case "shutdown":
      return "stopped";
    default:
      return undefined;
  }
}

/**
 * Task lifecycle events implied by a parent-thread collab item: a spawn
 * starts one task per new thread, and any call that reports agent states
 * (wait, closeAgent, ...) completes the ones that reached a terminal state.
 */
export function codexCollabTaskEvents(
  event: ProviderEvent,
  base: RuntimeEventBase,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.subagent) return [];
  if (event.method !== "item/started" && event.method !== "item/completed") return [];
  const item = itemOf(event);
  if (!item) return [];

  if (item.type === "subAgentActivity") {
    const threadId = text(item.agentThreadId);
    const status =
      item.kind === "completed" ? "completed" : item.kind === "interrupted" ? "stopped" : undefined;
    if (event.method !== "item/completed" || !threadId || !status) return [];
    return [
      {
        ...base,
        type: "task.completed",
        payload: { taskId: RuntimeTaskId.make(threadId), status },
      },
    ];
  }

  if (item.type !== "collabAgentToolCall") return [];
  const toolUseId = text(item.id);
  const receivers = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const events: ProviderRuntimeEvent[] = [];

  if (event.method === "item/started" && item.tool === "spawnAgent") {
    const prompt = text(item.prompt);
    const model = text(item.model);
    receivers.forEach((threadId, index) => {
      events.push({
        ...base,
        eventId: index === 0 ? base.eventId : (`${base.eventId}:${index}` as typeof base.eventId),
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.make(threadId),
          ...(toolUseId ? { toolUseId } : {}),
          agentType: "subagent",
          ...(prompt
            ? { description: oneLine(prompt, 120), prompt: clip(prompt, TEXT_LIMIT) }
            : {}),
          ...(model ? { model } : {}),
        },
      });
    });
    return events;
  }

  if (event.method === "item/completed") {
    const states = record(item.agentsStates) ?? {};
    for (const [threadId, state] of Object.entries(states)) {
      const status = terminalStatus(record(state)?.status);
      if (!status) continue;
      const message = text(record(state)?.message);
      events.push({
        ...base,
        eventId: `${base.eventId}:${threadId}` as typeof base.eventId,
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(threadId),
          status,
          ...(message ? { summary: clip(message, TEXT_LIMIT) } : {}),
        },
      });
    }
  }
  return events;
}
