// @effect-diagnostics cryptoRandomUUID:off - R2 CAS markers require a fresh nonce, including identical wakeups.
import type { CloudState } from "./state.ts";

export const IDLE_RECONCILIATION_MS = 60 * 60 * 1000;
export const reconciliationKey = (userId: string) =>
  `cloud-scheduler/${encodeURIComponent(userId)}.json`;

export function needsFrequentReconciliation(state: CloudState): boolean {
  return (
    Object.keys(state.operations).length > 0 ||
    Object.values(state.accounts).some((account) => account.leasedBy !== null) ||
    Object.values(state.jobs ?? {}).some((job) => !job.deleted) ||
    Object.values(state.publications).some((item) =>
      ["queued", "publishing"].includes(item.state),
    ) ||
    Object.values(state.tasks).some(
      (task) =>
        ["queued", "preparing", "running", "waiting_for_input"].includes(task.state) ||
        (task.worker !== null && !["stopped", "deleted"].includes(task.worker.state)),
    )
  );
}

export interface ReconciliationBucket {
  get(key: string): Promise<{ etag: string; text(): Promise<string> } | null>;
  put(
    key: string,
    body: string,
    options?: { onlyIf: { etagMatches?: string; etagDoesNotMatch?: string } },
  ): Promise<unknown>;
}

export async function wakeReconciliation(bucket: ReconciliationBucket, userId: string) {
  await bucket.put(
    reconciliationKey(userId),
    JSON.stringify({ nextCheckAt: 0, nonce: crypto.randomUUID() }),
  );
}

/** Snapshot is taken BEFORE reading SQL so a racing wake cannot be overwritten. */
export async function beginReconciliation(
  bucket: ReconciliationBucket,
  userId: string,
  now: number,
  force = false,
) {
  const key = reconciliationKey(userId);
  let etag: string | undefined;
  try {
    const object = await bucket.get(key);
    etag = object?.etag;
    if (object) {
      const marker: unknown = JSON.parse(await object.text());
      if (
        !force &&
        typeof marker === "object" &&
        marker !== null &&
        "nextCheckAt" in marker &&
        typeof marker.nextCheckAt === "number" &&
        marker.nextCheckAt > now &&
        marker.nextCheckAt <= now + IDLE_RECONCILIATION_MS
      )
        return null;
    }
  } catch {
    // Storage outages/corrupt markers must never disable execution monitoring.
    return { complete: async (_active: boolean) => {} };
  }
  return {
    complete: async (active: boolean) => {
      try {
        await bucket.put(
          key,
          JSON.stringify({
            nextCheckAt: active ? 0 : now + IDLE_RECONCILIATION_MS,
            nonce: crypto.randomUUID(),
          }),
          {
            onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
          },
        );
      } catch {
        // A failed idle write leaves monitoring enabled. SQL remains authoritative.
      }
    },
  };
}
