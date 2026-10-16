// @effect-diagnostics globalDate:off - Pure UTC formatting with an explicit injected timestamp.
/** Money is integer micro-dollars; do not round hourly prices to cents. */
export const CLOUD_POLICY = {
  cpu: 8,
  memoryGiB: 16,
  diskGiB: 100,
  maxExecuting: 2,
  monthlyComputeMicroDollars: 25_000_000,
  // Historical per-run accounting retained for old records; resident machines
  // are billed independently and do not accrue this estimate.
  computeMicroDollarsPerSecond: 183,
  setupTimeoutMs: 15 * 60_000,
  runTimeoutMs: 2 * 60 * 60_000,
  heartbeatMs: 30_000,
  staleMs: 2 * 60_000,
  settledGraceMs: 5 * 60_000,
  shutdownCheckpointMs: 90_000,
  waitingTimeoutMs: 15 * 60_000,
  sandboxRetentionMs: 7 * 24 * 60 * 60_000,
  resultRetentionMs: 30 * 24 * 60 * 60_000,
  minimumFreeDiskBytes: 512 * 1024 * 1024,
} as const;

export const runReservation =
  ((CLOUD_POLICY.runTimeoutMs +
    CLOUD_POLICY.settledGraceMs +
    CLOUD_POLICY.shutdownCheckpointMs +
    120_000) /
    1000) *
  CLOUD_POLICY.computeMicroDollarsPerSecond;

export function iso(time: number): string {
  return new Date(time).toISOString();
}
export function month(time: number): string {
  return iso(time).slice(0, 7);
}

export class CloudError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestDisposition: "rejected" | "unknown";
  readonly retryable: boolean;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "CloudError";
    this.code = code;
    this.status = status;
    // Business state and even HTTP 4xx can follow a lost successful response.
    // Only an immutable key/payload conflict proves this payload was rejected.
    this.requestDisposition = code === "idempotency_conflict" ? "rejected" : "unknown";
    this.retryable =
      status >= 500 || ["concurrent_update", "revision_conflict", "worker_busy"].includes(code);
  }
}
