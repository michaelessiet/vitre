// @effect-diagnostics globalDate:off - Pure accounting uses the injected clock.
import type { CloudTask } from "@t3tools/contracts/cloud";
import type { CloudState } from "./state.ts";
import { CLOUD_POLICY, CloudError, iso, month } from "./policy.ts";

export interface CloudJob {
  id: string;
  kind: "login" | "publication" | "lens";
  provider?: "codex" | "claude";
  publicationId: string | null;
  state: "starting" | "running" | "completed" | "failed";
  deleted: boolean;
  startedAt: string;
  deadlineAt: string;
  billedThrough: string;
  reservedMicroDollars: number;
  sequence: number;
  credentialVersion: number;
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  claimUntil: string | null;
  claimToken: string | null;
  publicationAttempted?: boolean;
  commit?: string | null;
}
export type PublicationInput = CloudTask;
export const activeJobs = (state: CloudState) =>
  Object.values(state.jobs ?? {}).filter((job) => !job.deleted);
export function reserveJob(
  state: CloudState,
  id: string,
  kind: CloudJob["kind"],
  now: number,
  publicationId: string | null = null,
  provider: "codex" | "claude" = "codex",
): CloudJob {
  const jobs = (state.jobs ??= {});
  if (jobs[id]) return jobs[id];
  const account = state.accounts[provider];
  if ((kind === "login" || kind === "lens") && account.leasedBy)
    throw new CloudError(
      "provider_busy",
      "This AI account is busy. Wait for its current run to finish and try again.",
    );
  const tasks = Object.values(state.tasks).filter(
    (task) => task.worker && !["stopped", "deleted"].includes(task.worker.state),
  );
  if (tasks.length + activeJobs(state).length >= CLOUD_POLICY.maxExecuting)
    throw new CloudError("workers_busy", "Wait for an executing worker to stop");
  const reservation = 1080 * CLOUD_POLICY.computeMicroDollarsPerSecond;
  const reserved =
    tasks.reduce((sum, task) => sum + (task.attempt?.reservedMicroDollars ?? 0), 0) +
    activeJobs(state).reduce((sum, job) => sum + job.reservedMicroDollars, 0);
  if ((state.usage[month(now)] ?? 0) + reserved + reservation > state.monthlyLimit)
    throw new CloudError("budget_exhausted", "Insufficient compute allowance");
  jobs[id] = {
    id,
    kind,
    provider,
    publicationId,
    state: "starting",
    deleted: false,
    startedAt: iso(now),
    deadlineAt: iso(now + 900_000),
    billedThrough: iso(now),
    reservedMicroDollars: reservation,
    sequence: 0,
    credentialVersion: account.credentialVersion,
    verificationUrl: null,
    userCode: null,
    error: null,
    claimUntil: null,
    claimToken: null,
  };
  if (kind === "login" || kind === "lens") account.leasedBy = id;
  return jobs[id];
}
export function accrueJobs(state: CloudState, now: number): void {
  for (const job of activeJobs(state)) {
    let from = Date.parse(job.billedThrough);
    while (from < now) {
      const date = new Date(from);
      const end = Math.min(now, Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
      const cost = Math.ceil((end - from) / 1000) * CLOUD_POLICY.computeMicroDollarsPerSecond;
      state.usage[month(from)] = (state.usage[month(from)] ?? 0) + cost;
      job.reservedMicroDollars = Math.max(0, job.reservedMicroDollars - cost);
      from = end;
    }
    job.billedThrough = iso(now);
    if (
      ["starting", "running"].includes(job.state) &&
      (now >= Date.parse(job.deadlineAt) ||
        (state.usage[month(now)] ?? 0) >= state.monthlyLimit ||
        ((job.kind === "login" || job.kind === "lens") &&
          state.accounts[job.provider ?? "codex"].credentialVersion !== job.credentialVersion))
    ) {
      job.state = "failed";
      job.error = "Operation expired, was disconnected, or reached its compute allowance";
    }
  }
}
