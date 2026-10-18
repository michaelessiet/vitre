import type { CloudOverview, CloudTask } from "@t3tools/contracts/cloud";
import type { OrchestrationThread } from "@t3tools/contracts";
import { historicalActivityIds } from "@t3tools/shared/historyActivities";

export function acceptOverview(current: CloudOverview | null, next: CloudOverview) {
  return current?.revision !== undefined &&
    next.revision !== undefined &&
    next.revision < current.revision
    ? current
    : next;
}
export function acceptHistory(current: OrchestrationThread | null, next: OrchestrationThread) {
  return current && current.id === next.id && current.updatedAt > next.updatedAt ? current : next;
}
export const busyTask = (task: CloudTask) =>
  ["queued", "preparing", "waiting_for_input"].includes(task.state) ||
  (task.state === "running" && !task.idle);
export function taskStatus(task: CloudTask) {
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
export function pendingRequests(thread: OrchestrationThread | null) {
  const requests = new Map<
    string,
    { id: string; kind: "approval" | "question"; summary: string; questions: Question[] }
  >();
  const history = historicalActivityIds(thread?.activities ?? []);
  for (const activity of thread?.activities ?? []) {
    if (history.has(activity.id) || !activity.payload || typeof activity.payload !== "object")
      continue;
    const payload = activity.payload as { requestId?: unknown; questions?: unknown };
    if (typeof payload.requestId !== "string") continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested")
      requests.set(payload.requestId, {
        id: payload.requestId,
        kind: activity.kind === "approval.requested" ? "approval" : "question",
        summary: activity.summary,
        questions: Array.isArray(payload.questions)
          ? payload.questions.filter(
              (question): question is Question =>
                typeof question?.id === "string" && typeof question?.question === "string",
            )
          : [],
      });
    if (["approval.resolved", "user-input.resolved"].includes(activity.kind))
      requests.delete(payload.requestId);
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
