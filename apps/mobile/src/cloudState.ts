import type { CloudOverview, CloudTask, CloudTaskFeed } from "@t3tools/contracts/cloud";
import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";
import { historicalActivityIds } from "@t3tools/shared/historyActivities";

export function acceptOverview(current: CloudOverview | null, next: CloudOverview) {
  return current?.revision !== undefined &&
    next.revision !== undefined &&
    next.revision < current.revision
    ? current
    : next;
}
export function acceptHistory(current: OrchestrationThread | null, next: OrchestrationThread) {
  if (!current || current.id !== next.id) return next;
  const accepted = current.updatedAt > next.updatedAt ? current : next;
  const other = accepted === current ? next : current;
  const acceptedHistory = historicalActivityIds(accepted.activities);
  const otherHistory = historicalActivityIds(other.activities);
  const requestId = (activity: OrchestrationThread["activities"][number]) => {
    const payload = activity.payload;
    return payload &&
      typeof payload === "object" &&
      "requestId" in payload &&
      typeof payload.requestId === "string"
      ? payload.requestId
      : null;
  };
  const unresolved = new Set<string>();
  for (const activity of accepted.activities) {
    if (acceptedHistory.has(activity.id)) continue;
    const id = requestId(activity);
    if (
      id !== null &&
      (activity.kind === "approval.requested" || activity.kind === "user-input.requested")
    )
      unresolved.add(id);
  }
  for (const activity of accepted.activities) {
    if (acceptedHistory.has(activity.id)) continue;
    const id = requestId(activity);
    if (id !== null && isRequestResolution(activity)) unresolved.delete(id);
  }
  if (unresolved.size === 0) return accepted;

  // Relay mirrors and live events can share timestamps. Preserve known terminal
  // evidence without rolling back new messages, turns, or unrelated activities.
  const present = new Set(accepted.activities.map((activity) => activity.id));
  const retained = other.activities.filter((activity) => {
    const id = requestId(activity);
    if (
      id === null ||
      otherHistory.has(activity.id) ||
      !unresolved.has(id) ||
      present.has(activity.id) ||
      !isRequestResolution(activity)
    )
      return false;
    unresolved.delete(id);
    present.add(activity.id);
    return true;
  });
  return retained.length
    ? { ...accepted, activities: [...accepted.activities, ...retained] }
    : accepted;
}

export function liveConversationKey(task: CloudTask | null, generation = 0) {
  if (!task?.worker || !["ready", "starting"].includes(task.worker.state)) return null;
  // Starting and ready share an endpoint; the supervisor already retries while it boots.
  return JSON.stringify([
    task.id,
    task.worker.id,
    task.worker.environmentId,
    task.attempt?.id,
    generation,
  ]);
}

export const busyTask = (task: CloudTask) =>
  !!task.publicationPreparation ||
  ["queued", "preparing", "waiting_for_input"].includes(task.state) ||
  (task.state === "running" && !task.idle);
export function taskStatus(task: CloudTask) {
  if (task.publicationPreparation) return "Saving for PR review";
  if (task.state === "running") return task.idle ? "Ready" : "Working";
  if (task.state === "preparing")
    return {
      failed: "Workspace preparation failed",
      restoring: "Restoring saved workspace",
      cloning: "Cloning repository",
      dependencies: "Installing dependencies",
      backend: "Starting cloud computer",
      provider: "Connecting provider",
      ready: "Ready",
    }[task.preparation?.phase ?? "backend"];
  return {
    queued: "Queued",
    waiting_for_input: "Needs your input",
    completed: "Completed",
    cancelled: "Stopped",
    interrupted: "Interrupted",
    failed: "Failed",
    needs_auth: "Provider sign-in required",
    usage_limited: "Usage limit reached",
  }[task.state];
}
export function cloudOwned(overview: CloudOverview | null, task: CloudTask) {
  const binding = overview?.bindings?.find(
    (binding) => binding.cloudTaskId === task.id || binding.aliases?.includes(task.id),
  );
  if (!binding) return !task.handoff;
  return (
    binding.target !== "local" &&
    binding.cloudTaskId === task.id &&
    (!task.handoff || binding.generation > task.handoff.generation) &&
    !overview?.handoffs?.some(
      (operation) =>
        operation.conversationId === binding.conversationId &&
        !["completed", "cancelled", "failed"].includes(operation.phase),
    )
  );
}
export interface Question {
  id: string;
  question: string;
  options?: { label: string; description?: string }[];
}
export function approvalDetails(payload: {
  requestKind?: unknown;
  requestType?: unknown;
  detail?: unknown;
}) {
  const kind = payload.requestKind ?? payload.requestType;
  const label =
    kind === "command" || kind === "command_execution_approval"
      ? "Command"
      : kind === "file-read" || kind === "file_read_approval"
        ? "File to read"
        : kind === "file-change" || kind === "file_change_approval"
          ? "File change"
          : "Requested action";
  return {
    label,
    detail: typeof payload.detail === "string" && payload.detail.trim() ? payload.detail : null,
  };
}

export function isRequestResolution(activity: OrchestrationThreadActivity): boolean {
  if (["approval.resolved", "user-input.resolved"].includes(activity.kind)) return true;
  if (
    !["provider.approval.respond.failed", "provider.user-input.respond.failed"].includes(
      activity.kind,
    )
  )
    return false;
  const payload = activity.payload as { detail?: unknown } | null;
  if (typeof payload?.detail !== "string") return false;
  const detail = payload.detail.toLowerCase();
  return [
    "stale pending approval request",
    "unknown pending approval request",
    "unknown pending permission request",
    "stale pending user-input request",
    "unknown pending user-input request",
    "unknown pending user input request",
    "unknown pending codex user input request",
  ].some((reason) => detail.includes(reason));
}

export function pendingRequests(thread: OrchestrationThread | null, task?: CloudTask) {
  const requests = new Map<
    string,
    {
      id: string;
      kind: "approval" | "question";
      summary: string;
      questions: Question[];
      approval: ReturnType<typeof approvalDetails>;
    }
  >();
  if (!thread || (task && !busyTask(task))) return [];
  const latest = thread.latestTurn;
  if (latest && latest.state !== "running") return [];
  if (task?.turnRequestId) {
    const message = thread.messages.find(
      (message) => message.role === "user" && message.id === `${task.turnRequestId}-message`,
    );
    // The relay can start a follow-up while the cached thread still describes
    // its previous turn. Wait for this message to be adopted by the provider.
    if (
      !message ||
      !latest ||
      (message.turnId !== latest.turnId &&
        !(Date.parse(latest.requestedAt) >= Date.parse(message.createdAt)))
    )
      return [];
  }
  const history = historicalActivityIds(thread?.activities ?? []);
  const resolved = new Set<string>();
  // Resolution is terminal for a request ID, even if a mirror reorders events
  // or replays the original request after the response.
  for (const activity of thread.activities) {
    if (history.has(activity.id) || !isRequestResolution(activity)) continue;
    const payload = activity.payload as { requestId?: unknown } | null;
    if (typeof payload?.requestId === "string") resolved.add(payload.requestId);
  }
  for (const activity of thread.activities) {
    if (history.has(activity.id) || !activity.payload || typeof activity.payload !== "object")
      continue;
    const payload = activity.payload as {
      requestId?: unknown;
      questions?: unknown;
      requestKind?: unknown;
      requestType?: unknown;
      detail?: unknown;
    };
    if (typeof payload.requestId !== "string" || resolved.has(payload.requestId)) continue;
    if (
      latest &&
      (activity.turnId
        ? activity.turnId !== latest.turnId
        : !(Date.parse(activity.createdAt) >= Date.parse(latest.requestedAt)))
    )
      continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested")
      requests.set(payload.requestId, {
        id: payload.requestId,
        kind: activity.kind === "approval.requested" ? "approval" : "question",
        summary: activity.summary,
        approval: approvalDetails(payload),
        questions: Array.isArray(payload.questions)
          ? payload.questions.filter(
              (question): question is Question =>
                typeof question?.id === "string" && typeof question?.question === "string",
            )
          : [],
      });
  }
  return [...requests.values()];
}
export function relativeTime(date: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60_000));
  return minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
}
export function diffFiles(diff: string) {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((part) => part.startsWith("diff --git "))
    .map((text) => {
      const name =
        /^\+\+\+ b\/(.+)$/m.exec(text)?.[1] ??
        /^--- a\/(.+)$/m.exec(text)?.[1] ??
        text.split("\n")[0]!;
      const lines = text.split("\n");
      return {
        name,
        text,
        additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
        deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
      };
    });
}

export function taskProgress(
  events: (typeof CloudTaskFeed.Type)["events"],
  task: CloudTask | null,
): string {
  return (
    events.findLast(
      (event) =>
        event.detail &&
        event.attemptId === task?.attempt?.id &&
        (!["failed", "needs_auth", "usage_limited"].includes(event.phase) ||
          event.phase === task?.state),
    )?.detail ?? ""
  );
}
