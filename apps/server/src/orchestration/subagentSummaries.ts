/**
 * When to summarize a running subagent, and from what.
 *
 * Providers report subagent progress sparsely (Claude's own summaries reuse
 * the subagent's model, so Vitre leaves them off). Instead, each subagent's
 * transcript is buffered here and summarized on a small model at most once per
 * interval, and only when something new happened since the last summary.
 *
 * Pure bookkeeping: the reactor owns time, generation and dispatch.
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/** Shortest gap between two summaries of the same subagent. */
export const SUBAGENT_SUMMARY_INTERVAL_MS = 20_000;
/** Transcript lines kept per subagent; summaries describe recent work. */
const TRANSCRIPT_LINE_LIMIT = 40;
const LINE_LIMIT = 400;
/** Tasks tracked at once; the oldest is dropped beyond this. */
const TASK_LIMIT = 64;

export interface SubagentSummaryRequest {
  readonly threadId: string;
  readonly taskId: string;
  readonly identity: Readonly<Record<string, unknown>>;
  readonly task: string;
  readonly transcript: string;
}

interface TrackedTask {
  readonly threadId: string;
  readonly identity: Record<string, unknown>;
  task: string;
  readonly lines: string[];
  /** Lines added since the last summary was requested. */
  fresh: number;
  lastSummaryAt: number | undefined;
  inFlight: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clip(line: string): string {
  const single = line.replace(/\s+/g, " ").trim();
  return single.length <= LINE_LIMIT ? single : `${single.slice(0, LINE_LIMIT - 1)}…`;
}

/** One transcript entry as a line a small model can read. */
export function renderTranscriptEntry(entry: Record<string, unknown>): string | undefined {
  switch (entry.kind) {
    case "text": {
      const body = text(entry.text);
      return body ? clip(`agent: ${body}`) : undefined;
    }
    case "reasoning": {
      const body = text(entry.text);
      return body ? clip(`thinking: ${body}`) : undefined;
    }
    case "tool": {
      const name = text(entry.toolName);
      if (!name) return undefined;
      const detail = text(entry.detail);
      return clip(detail ? `tool ${name}: ${detail}` : `tool ${name}`);
    }
    case "tool_result": {
      const output = text(entry.output);
      const label = entry.isError === true ? "tool failed" : "tool result";
      return clip(output ? `${label}: ${output}` : label);
    }
    default:
      return undefined;
  }
}

function identityOf(payload: Record<string, unknown>): Record<string, unknown> {
  const identity: Record<string, unknown> = { taskId: payload.taskId };
  for (const key of ["toolUseId", "agentType", "background"] as const) {
    if (payload[key] !== undefined) identity[key] = payload[key];
  }
  return identity;
}

export class SubagentSummaryTracker {
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly intervalMs: number;

  constructor(intervalMs = SUBAGENT_SUMMARY_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  private key(threadId: string, taskId: string): string {
    return `${threadId}\u0000${taskId}`;
  }

  private ensure(threadId: string, payload: Record<string, unknown>): TrackedTask | undefined {
    const taskId = text(payload.taskId);
    if (!taskId) return undefined;
    const key = this.key(threadId, taskId);
    let tracked = this.tasks.get(key);
    if (!tracked) {
      tracked = {
        threadId,
        identity: identityOf(payload),
        task: "",
        lines: [],
        fresh: 0,
        lastSummaryAt: undefined,
        inFlight: false,
      };
      this.tasks.set(key, tracked);
      if (this.tasks.size > TASK_LIMIT) {
        const oldest = this.tasks.keys().next().value;
        if (oldest !== undefined) this.tasks.delete(oldest);
      }
    }
    return tracked;
  }

  /**
   * Record a task activity. Returns a request when this subagent is due a
   * summary: something new happened and the interval since the last one has
   * passed. The caller must report back with `settle`.
   */
  observe(
    threadId: string,
    activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
    now: number,
  ): SubagentSummaryRequest | undefined {
    const payload = record(activity.payload);
    if (!payload) return undefined;
    const taskId = text(payload.taskId);
    if (!taskId) return undefined;

    switch (activity.kind) {
      case "task.started": {
        // Only subagents get summaries; plan and shell tasks report themselves.
        if (!text(payload.agentType) && !text(payload.toolUseId)) return undefined;
        const tracked = this.ensure(threadId, payload);
        if (tracked) {
          tracked.task = text(payload.prompt) ?? text(payload.detail) ?? tracked.task;
          // The first summary waits a full interval: the start row already says what it does.
          tracked.lastSummaryAt = now;
        }
        return undefined;
      }
      case "task.completed":
        this.tasks.delete(this.key(threadId, taskId));
        return undefined;
      case "task.updated": {
        const status = text(payload.status);
        if (status === "completed" || status === "failed" || status === "stopped") {
          this.tasks.delete(this.key(threadId, taskId));
        }
        return undefined;
      }
      case "task.transcript": {
        const entry = record(payload.entry);
        const line = entry ? renderTranscriptEntry(entry) : undefined;
        if (!line) return undefined;
        const tracked = this.ensure(threadId, payload);
        if (!tracked) return undefined;
        tracked.lines.push(line);
        if (tracked.lines.length > TRANSCRIPT_LINE_LIMIT) tracked.lines.shift();
        tracked.fresh += 1;
        return this.due(taskId, tracked, now);
      }
      default:
        return undefined;
    }
  }

  private due(taskId: string, tracked: TrackedTask, now: number) {
    if (tracked.inFlight || tracked.fresh === 0) return undefined;
    if (tracked.lastSummaryAt !== undefined && now - tracked.lastSummaryAt < this.intervalMs) {
      return undefined;
    }
    tracked.inFlight = true;
    tracked.fresh = 0;
    tracked.lastSummaryAt = now;
    return {
      threadId: tracked.threadId,
      taskId,
      identity: { ...tracked.identity },
      task: tracked.task || "(not given)",
      transcript: tracked.lines.join("\n"),
    } satisfies SubagentSummaryRequest;
  }

  /**
   * The summary for `taskId` finished (or failed). Returns false when the task
   * ended meanwhile, so the caller drops a summary that arrived too late.
   */
  settle(threadId: string, taskId: string): boolean {
    const tracked = this.tasks.get(this.key(threadId, taskId));
    if (!tracked) return false;
    tracked.inFlight = false;
    return true;
  }

  get size(): number {
    return this.tasks.size;
  }
}
