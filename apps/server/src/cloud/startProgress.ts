// @effect-diagnostics globalDate:off - Promise-based transfer boundary; injectable wall clock for deterministic progress retention.
import { CloudRequestFailure } from "./requestFailure.ts";

export type StartPhase =
  | "collection"
  | "upload"
  | "creation"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "unknown";
export interface StartProgress {
  requestId: string;
  sequence: number;
  phase: StartPhase;
  message: string;
  startedAt: string;
  updatedAt: string;
  completedBytes?: number;
  totalBytes?: number;
}
export type StartReport = Pick<StartProgress, "phase" | "message"> &
  Partial<Pick<StartProgress, "completedBytes" | "totalBytes">>;

export function makeStartProgress(
  options: {
    now?: () => number;
    retentionMs?: number;
    maxRetained?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? 120_000;
  const maxRetained = options.maxRetained ?? 128;
  const operations = new Map<
    string,
    {
      controller: AbortController;
      progress: StartProgress;
      promise: Promise<unknown>;
      fingerprint: string | undefined;
      settledAt: number | undefined;
    }
  >();
  const prune = () => {
    const retained = [...operations].filter(([, op]) => op.settledAt !== undefined);
    for (const [key, op] of retained) {
      if (now() - op.settledAt! >= retentionMs) operations.delete(key);
    }
    const remaining = [...operations].filter(([, op]) => op.settledAt !== undefined);
    for (const [key] of remaining.slice(0, Math.max(0, remaining.length - maxRetained))) {
      operations.delete(key);
    }
  };
  const update = (operation: { progress: StartProgress }, report: StartReport) => {
    operation.progress = {
      requestId: operation.progress.requestId,
      sequence: Math.max(operation.progress.sequence + 1, now()),
      startedAt: operation.progress.startedAt,
      updatedAt: new Date(now()).toISOString(),
      ...report,
    };
  };
  return {
    status(key: string, cancel = false): StartProgress {
      prune();
      const operation = operations.get(key);
      if (
        cancel &&
        operation &&
        operation.settledAt === undefined &&
        !operation.controller.signal.aborted
      ) {
        update(operation, { phase: "cancelling", message: "Cancelling upload…" });
        operation.controller.abort(new Error("Cloud start cancelled; your draft is unchanged"));
      }
      const timestamp = new Date(now()).toISOString();
      return operation
        ? { ...operation.progress }
        : {
            requestId: key,
            sequence: 0,
            phase: "unknown",
            message: "Checking cloud conversation…",
            startedAt: timestamp,
            updatedAt: timestamp,
          };
    },
    run<T>(
      key: string,
      work: (signal: AbortSignal, report: (progress: StartReport) => void) => Promise<T>,
      fingerprint?: string,
    ): Promise<T> {
      prune();
      const existing = operations.get(key);
      if (existing && fingerprint !== undefined && existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new CloudRequestFailure(
            "This request changed during a retry. Send it again as a new request.",
            "rejected",
            "idempotency_conflict",
          ),
        );
      }
      // A successful result is retained too, so a lost RPC reply can be recovered
      // without capturing changed files under the same idempotency key.
      if (
        existing &&
        (existing.settledAt === undefined || existing.progress.phase === "completed")
      ) {
        return existing.promise as Promise<T>;
      }
      const timestamp = new Date(now()).toISOString();
      const operation = {
        controller: new AbortController(),
        progress: {
          requestId: key,
          sequence: Math.max((existing?.progress.sequence ?? 0) + 1, now()),
          phase: "collection" as StartPhase,
          message: "Preparing workspace…",
          startedAt: timestamp,
          updatedAt: timestamp,
        },
        fingerprint,
        promise: undefined as unknown as Promise<T>,
        settledAt: undefined as number | undefined,
      };
      operations.set(key, operation);
      operation.promise = Promise.resolve()
        .then(() =>
          work(operation.controller.signal, (report) => {
            if (
              !operation.controller.signal.aborted &&
              operation.settledAt === undefined &&
              !["completed", "cancelled", "failed"].includes(operation.progress.phase)
            )
              update(operation, report);
          }),
        )
        .then(
          (result) => {
            // Cancellation is only a request. A committed task wins over a late abort.
            update(operation, { phase: "completed", message: "Cloud conversation created" });
            return result;
          },
          (error) => {
            const disposition =
              error && typeof error === "object" && "requestDisposition" in error
                ? error.requestDisposition
                : undefined;
            const cancelled = operation.controller.signal.aborted && disposition === "rejected";
            update(operation, {
              phase: cancelled ? "cancelled" : "failed",
              message: cancelled
                ? "Cloud start cancelled"
                : "Cloud conversation could not be confirmed",
            });
            throw error;
          },
        )
        .finally(() => {
          operation.settledAt = now();
          prune();
        });
      return operation.promise;
    },
  };
}

export const cloudStarts = makeStartProgress();
