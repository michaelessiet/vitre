import { it, expect } from "@effect/vitest";
import { initialState, publicOverview, schedule } from "./state.ts";
import { reserveJob, accrueJobs } from "./jobs.ts";

it("atomically reserves auxiliary capacity and excludes duplicate login leases", () => {
  const state = initialState();
  const now = Date.UTC(2026, 8, 20);
  const job = reserveJob(state, "login-a", "login", now);
  expect(state.accounts.codex.leasedBy).toBe(job.id);
  expect(reserveJob(state, "login-a", "login", now)).toBe(job);
  expect(() => reserveJob(state, "login-b", "login", now)).toThrow("Stop Codex");
  reserveJob(state, "publish-a", "publication", now, "p");
  expect(() => reserveJob(state, "publish-b", "publication", now, "p2")).toThrow("Wait");
  expect(publicOverview(state, true, now).usage.reservedMicroDollars).toBeGreaterThan(0);
  accrueJobs(state, now + 960_000);
  expect(job.state).toBe("failed");
  expect(state.accounts.codex.leasedBy).toBe(job.id);
  expect(publicOverview(state, true, now).usage.spentMicroDollars).toBeGreaterThan(0);
  schedule(state, now + 960_000, true);
});
it("refuses login provisioning when the compute allowance cannot cover it", () => {
  const state = initialState();
  state.monthlyLimit = 1;
  expect(() => reserveJob(state, "login", "login", 0)).toThrow("allowance");
  expect(state.accounts.codex.leasedBy).toBeNull();
});
