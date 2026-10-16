import type { CloudOverview, CloudTask } from "@t3tools/contracts/cloud";
import type { OrchestrationThread } from "@t3tools/contracts";

export interface PendingCloudSend {
  readonly accountId: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly prompt: string;
  readonly createdAt: string;
  readonly disposition: "submitting" | "uncertain";
}

/** Polling can finish after a command. The account revision is authoritative. */
export function acceptCloudOverview(
  current: CloudOverview | null,
  incoming: CloudOverview,
): CloudOverview {
  if (current?.revision !== undefined && incoming.revision !== undefined) {
    return incoming.revision <= current.revision ? current : incoming;
  }
  return incoming;
}

/** A reconnect with no history keeps the last readable transcript. */
export function acceptCloudHistory(
  current: OrchestrationThread | null,
  incoming: OrchestrationThread | null,
): OrchestrationThread | null {
  if (incoming === null) return current;
  if (current === null) return incoming;
  return Date.parse(incoming.updatedAt) < Date.parse(current.updatedAt) ? current : incoming;
}

export function cloudSendAccepted(
  pending: PendingCloudSend,
  task: CloudTask | null,
  history: OrchestrationThread | null,
): boolean {
  if (task?.turnRequestId === pending.idempotencyKey) return true;
  return (
    history?.messages.some(
      (message) =>
        message.role === "user" &&
        message.text === pending.prompt &&
        Date.parse(message.createdAt) >= Date.parse(pending.createdAt),
    ) ?? false
  );
}

export function cloudTurnBusy(
  task: CloudTask | null,
  _history: OrchestrationThread | null,
): boolean {
  if (!task) return false;
  if (task.state === "queued" || task.state === "preparing" || task.state === "waiting_for_input")
    return true;
  if (task.state !== "running") return false;
  // A warm computer can be running while no conversation turn is active.
  return task.idle !== true;
}

/** A saved cloud task can remain visible after its conversation moves elsewhere. */
export function cloudTaskOwnership(
  overview: CloudOverview | null,
  task: CloudTask | null,
): "cloud" | "local" | "moving" | "recovering" {
  if (!task) return "recovering";
  const binding = overview?.bindings?.find(
    (item) => item.cloudTaskId === task.id || item.aliases?.includes(task.id),
  );
  if (!binding) return task.handoff ? "recovering" : "cloud";
  if (binding.target === "local" || binding.cloudTaskId !== task.id) return "local";
  if (task.handoff && binding.generation <= task.handoff.generation) return "recovering";
  const operation = overview?.handoffs?.find(
    (item) => item.conversationId === binding.conversationId,
  );
  if (
    operation &&
    [
      "waiting",
      "preparing",
      "checkpointing",
      "transferring",
      "verifying",
      "activating",
      "releasing",
    ].includes(operation.phase)
  )
    return "moving";
  if (operation?.phase === "failed" && operation.errorDisposition !== "terminal")
    return "recovering";
  return "cloud";
}

export function cloudStopSettled(task: CloudTask | null, turnRequestId: string | null): boolean {
  if (!task) return false;
  if ((task.turnRequestId ?? null) !== turnRequestId) return true;
  return (
    ["cancelled", "completed", "failed", "interrupted"].includes(task.state) &&
    (!task.worker || ["stopped", "deleted"].includes(task.worker.state))
  );
}

export function cloudTaskStatus(task: CloudTask): string {
  if (task.state === "running" && task.idle === true) return "Ready";
  switch (task.state) {
    case "queued":
      return "Waiting for cloud computer";
    case "preparing": {
      const phase = task.preparation?.phase;
      return phase === "restoring"
        ? "Restoring workspace"
        : phase === "cloning"
          ? "Cloning repository"
          : phase === "dependencies"
            ? "Installing dependencies"
            : phase === "backend"
              ? "Starting backend"
              : phase === "provider"
                ? "Connecting provider"
                : "Preparing cloud computer";
    }
    case "running":
      return "Working";
    case "waiting_for_input":
      return "Waiting for approval or input";
    case "needs_auth":
      return "Provider sign-in required";
    case "usage_limited":
      return "Usage limit reached";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
    case "interrupted":
      return "Interrupted";
  }
}

export function cloudDiffSummary(diff: string) {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+") && !line.startsWith("+++ ")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("--- ")) removed += 1;
  }
  return { files, added, removed };
}
