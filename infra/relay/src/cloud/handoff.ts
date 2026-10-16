import type {
  CloudConversationBinding,
  CloudExecutionTarget,
  CloudHandoffOperation,
} from "@t3tools/contracts/cloud";
import { CloudError, iso } from "./policy.ts";

export interface HandoffState {
  bindings: Record<string, CloudConversationBinding>;
  handoffs: Record<string, CloudHandoffOperation>;
}
const terminal = new Set(["completed", "cancelled", "failed"]);
const phases = [
  "waiting",
  "preparing",
  "checkpointing",
  "transferring",
  "verifying",
  "activating",
  "releasing",
  "completed",
] as const;

/** Pure reducer, persisted by CloudStore's optimistic transaction. */
export function requestHandoff(
  state: HandoffState,
  input: {
    id: string;
    conversationId: string;
    target: CloudExecutionTarget;
    expectedGeneration: number;
    now?: number;
  },
): CloudHandoffOperation {
  const existing = state.handoffs[input.id];
  if (existing) {
    if (
      existing.conversationId !== input.conversationId ||
      existing.to !== input.target ||
      existing.generation !== input.expectedGeneration
    )
      throw new CloudError("idempotency_conflict", "Switch request was already used");
    return existing;
  }
  const binding = state.bindings[input.conversationId];
  if (!binding || binding.generation !== input.expectedGeneration)
    throw new CloudError("stale_owner", "Conversation location changed; refresh before switching");
  if (
    Object.values(state.handoffs).some(
      (op) => op.conversationId === input.conversationId && !terminal.has(op.phase),
    )
  )
    throw new CloudError("switch_pending", "This conversation is already moving");
  if (binding.target === input.target)
    throw new CloudError("already_active", "Conversation already runs here");
  const operation: CloudHandoffOperation = {
    id: input.id,
    revision: 1,
    ...(input.now !== undefined ? { startedAt: iso(input.now), updatedAt: iso(input.now) } : {}),
    conversationId: input.conversationId,
    from: binding.target,
    to: input.target,
    generation: binding.generation,
    phase: "waiting",
    checkpoint: null,
    error: null,
  };
  state.handoffs[input.id] = operation;
  return operation;
}

export function advanceHandoff(
  state: HandoffState,
  input: {
    id: string;
    expectedPhase: CloudHandoffOperation["phase"];
    nextPhase: CloudHandoffOperation["phase"];
    checkpoint?: CloudHandoffOperation["checkpoint"];
    destinationOwner?: string;
    cloudTaskId?: string;
    roots?: CloudConversationBinding["roots"];
    now: number;
    leaseMs?: number;
  },
): CloudHandoffOperation {
  const operation = state.handoffs[input.id];
  if (!operation) throw new CloudError("not_found", "Switch request not found", 404);
  if (operation.phase === input.nextPhase) return operation;
  const index = phases.indexOf(input.expectedPhase as (typeof phases)[number]);
  if (operation.phase !== input.expectedPhase || index < 0 || phases[index + 1] !== input.nextPhase)
    throw new CloudError("stale_switch", "Switch progress changed; reload its status");
  const binding = state.bindings[operation.conversationId]!;
  if (input.nextPhase === "activating") {
    if (
      !operation.checkpoint ||
      !input.destinationOwner ||
      binding.generation !== operation.generation ||
      binding.target !== operation.from
    )
      throw new CloudError(
        "unverified_destination",
        "Destination is not ready to own the conversation",
      );
    // This transaction fences the old owner before enabling destination execution.
    state.bindings[binding.conversationId] = {
      ...binding,
      target: operation.to,
      ...(input.roots ? { roots: input.roots } : {}),
      generation: binding.generation + 1,
      cloudTaskId: input.cloudTaskId ?? binding.cloudTaskId,
      aliases: [
        ...new Set([
          ...(binding.aliases ?? []),
          ...(binding.cloudTaskId ? [binding.cloudTaskId] : []),
          ...(input.cloudTaskId ? [input.cloudTaskId] : []),
        ]),
      ],
      leaseOwner: input.destinationOwner,
      leaseExpiresAt: iso(input.now + (input.leaseMs ?? 60_000)),
    };
  }
  const next = {
    ...operation,
    phase: input.nextPhase,
    revision: (operation.revision ?? 0) + 1,
    updatedAt: iso(input.now),
    checkpoint: input.checkpoint ?? operation.checkpoint,
  };
  state.handoffs[input.id] = next;
  return next;
}

export function stopHandoff(
  state: HandoffState,
  id: string,
  error?: string,
  now?: number,
): CloudHandoffOperation {
  const operation = state.handoffs[id];
  if (!operation) throw new CloudError("not_found", "Switch request not found", 404);
  if (terminal.has(operation.phase)) return operation;
  if (["activating", "releasing"].includes(operation.phase))
    throw new CloudError(
      "switch_committed",
      "The switch has committed; finish releasing the previous environment",
    );
  const next: CloudHandoffOperation = {
    ...operation,
    phase: error ? "failed" : "cancelled",
    revision: (operation.revision ?? 0) + 1,
    ...(now !== undefined ? { updatedAt: iso(now) } : {}),
    ...(error ? { errorDisposition: "terminal" as const } : {}),
    error: error ?? null,
  };
  state.handoffs[id] = next;
  return next;
}

export function ownsConversation(
  binding: CloudConversationBinding,
  owner: string,
  generation: number,
  now: number,
): boolean {
  return (
    binding.leaseOwner === owner &&
    binding.generation === generation &&
    binding.leaseExpiresAt !== null &&
    Date.parse(binding.leaseExpiresAt) > now
  );
}
