// @effect-diagnostics globalDate:off - Promise coordinator boundary; clock is injectable through ports.
import type { CloudExecutionTarget, CloudHandoffPhase } from "@t3tools/contracts/cloud";

export interface HandoffJournal {
  id: string;
  conversationId: string;
  from: CloudExecutionTarget;
  to: CloudExecutionTarget;
  generation: number;
  phase: CloudHandoffPhase;
  checkpoint: string | null;
  destination: string | null;
  error: string | null;
  cancelRequested: boolean;
  revision?: number;
  startedAt?: string;
  updatedAt?: string;
  waitReason?:
    | "active-turn"
    | "cloud-preparation"
    | "cloud-activation"
    | "ownership-confirmation"
    | "conflict";
  errorDisposition?: "retryable" | "terminal" | "unknown";
}

/** Every side effect is keyed by operation id. Persistence precedes the next phase. */
export interface HandoffPorts {
  now?(): Promise<string>;
  read(id: string): Promise<HandoffJournal>;
  save(previous: HandoffJournal, next: HandoffJournal): Promise<void>;
  isSourceIdle(operation: HandoffJournal): Promise<boolean>;
  prepare(operation: HandoffJournal): Promise<void>;
  freezeAndCapture(operation: HandoffJournal): Promise<string>;
  transfer(operation: HandoffJournal): Promise<string>;
  verify(operation: HandoffJournal): Promise<void>;
  /** Authoritative compare-and-swap; retries return the original commit. */
  commit(operation: HandoffJournal): Promise<void>;
  activate(operation: HandoffJournal): Promise<void>;
  release(operation: HandoffJournal): Promise<void>;
  /** Must consult authoritative ownership before unfreezing, even after a lost commit reply. */
  rollback(operation: HandoffJournal): Promise<void>;
}

export class HandoffWait extends Error {
  readonly reason: NonNullable<HandoffJournal["waitReason"]>;
  constructor(reason: NonNullable<HandoffJournal["waitReason"]>) {
    super(reason);
    this.reason = reason;
  }
}

export class HandoffFailure extends Error {
  readonly disposition: "retryable" | "terminal";
  constructor(message: string, disposition: "retryable" | "terminal" = "terminal") {
    super(message);
    this.disposition = disposition;
  }
}

/** Rollback discovered this exact operation already committed; finish activation. */
export class HandoffCommitConfirmed extends Error {}

const terminal = new Set<CloudHandoffPhase>(["completed", "cancelled", "failed"]);

/** Advances one durable step; a restart retries that same idempotent step. */
export async function advanceHandoffCoordinator(
  ports: HandoffPorts,
  id: string,
): Promise<HandoffJournal> {
  const operation = await ports.read(id);
  if (terminal.has(operation.phase)) return operation;
  if (operation.errorDisposition === "terminal" && !operation.cancelRequested) return operation;
  const { waitReason: _wait, errorDisposition: _disposition, ...clean } = operation;
  let next: HandoffJournal = { ...clean, error: null };
  try {
    if (operation.cancelRequested && !["activating", "releasing"].includes(operation.phase)) {
      await ports.rollback(operation);
      next.phase = "cancelled";
    } else
      switch (operation.phase) {
        case "waiting":
          if (!(await ports.isSourceIdle(operation))) throw new HandoffWait("active-turn");
          next.phase = "preparing";
          break;
        case "preparing":
          await ports.prepare(operation);
          next.phase = "checkpointing";
          break;
        case "checkpointing":
          next.checkpoint = await ports.freezeAndCapture(operation);
          next.phase = "transferring";
          break;
        case "transferring":
          if (!operation.checkpoint) throw new Error("Switch checkpoint is missing");
          next.destination = await ports.transfer(operation);
          next.phase = "verifying";
          break;
        case "verifying":
          if (!operation.checkpoint || !operation.destination)
            throw new Error("Switch destination is missing");
          await ports.verify(operation);
          // Persist commit intent before issuing the authoritative ownership CAS.
          next.phase = "activating";
          break;
        case "activating":
          await ports.commit(operation);
          await ports.activate(operation);
          next.phase = "releasing";
          break;
        case "releasing":
          await ports.release(operation);
          next.phase = "completed";
          break;
        default:
          throw new Error("Unknown switch phase; source remains fenced");
      }
  } catch (error) {
    // Never guess whether an ambiguous commit succeeded, and never thaw on a network error.
    if (error instanceof HandoffCommitConfirmed) {
      next = {
        ...clean,
        phase: "activating",
        cancelRequested: false,
        error: null,
        waitReason: "ownership-confirmation",
      };
    } else if (error instanceof HandoffWait) {
      next = { ...clean, error: null, waitReason: error.reason };
    } else {
      // Once activation intent is durable, even a definite request rejection does
      // not prove source ownership. Keep reconciling instead of offering rollback.
      const ownershipUnknown = ["activating", "releasing"].includes(operation.phase);
      next = {
        ...clean,
        error: error instanceof Error ? error.message : "Switch interrupted; retry",
        errorDisposition: ownershipUnknown
          ? "unknown"
          : error instanceof HandoffFailure
            ? error.disposition
            : "unknown",
        ...(ownershipUnknown ? { waitReason: "ownership-confirmation" as const } : {}),
      };
    }
  }
  const updatedAt = await (ports.now?.() ?? Promise.resolve(new Date().toISOString()));
  next = {
    ...next,
    revision: (operation.revision ?? 0) + 1,
    startedAt: operation.startedAt ?? updatedAt,
    updatedAt,
  };
  await ports.save(operation, next);
  return next;
}
