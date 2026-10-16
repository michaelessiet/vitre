import { describe, expect, it } from "vite-plus/test";
import { applyCommand, initialState, schedule } from "./state.ts";
import {
  beginReconciliation,
  IDLE_RECONCILIATION_MS,
  needsFrequentReconciliation,
  wakeReconciliation,
  type ReconciliationBucket,
} from "./reconciliation.ts";

function memoryBucket() {
  let object: { etag: string; body: string } | null = null;
  let revision = 0;
  const bucket: ReconciliationBucket = {
    async get() {
      const snapshot = object;
      return snapshot ? { etag: snapshot.etag, text: async () => snapshot.body } : null;
    },
    async put(_key, body, options) {
      const condition = options?.onlyIf;
      if (condition?.etagMatches && object?.etag !== condition.etagMatches) return null;
      if (condition?.etagDoesNotMatch === "*" && object) return null;
      object = { etag: String(++revision), body };
      return object;
    },
  };
  return bucket;
}

describe("cloud idle reconciliation", () => {
  it("skips idle SQL work until the hourly recovery sweep", async () => {
    const bucket = memoryBucket();
    const gate = await beginReconciliation(bucket, "user", 1000);
    await gate!.complete(false);
    expect(await beginReconciliation(bucket, "user", 61000)).toBeNull();
    expect(await beginReconciliation(bucket, "user", 1000 + IDLE_RECONCILIATION_MS)).not.toBeNull();
    expect(await beginReconciliation(bucket, "user", 61000, true)).not.toBeNull();
  });
  it.each([false, true])(
    "does not overwrite a racing wake (existing marker: %s)",
    async (existing) => {
      const bucket = memoryBucket();
      if (existing) await wakeReconciliation(bucket, "user");
      const stale = await beginReconciliation(bucket, "user", 0);
      await wakeReconciliation(bucket, "user");
      await stale!.complete(false);
      expect(await beginReconciliation(bucket, "user", 60000)).not.toBeNull();
    },
  );
  it("a wake immediately reactivates an idle account", async () => {
    const bucket = memoryBucket();
    await (await beginReconciliation(bucket, "user", 0))!.complete(false);
    await wakeReconciliation(bucket, "user");
    expect(await beginReconciliation(bucket, "user", 60000)).not.toBeNull();
  });
  it("fails open on storage failures and corrupt markers", async () => {
    const bucket = memoryBucket();
    await bucket.put("", "broken");
    expect(await beginReconciliation(bucket, "user", 0)).not.toBeNull();
    bucket.get = async () => {
      throw new Error("unavailable");
    };
    const gate = await beginReconciliation(bucket, "user", 0);
    expect(gate).not.toBeNull();
    await gate!.complete(false);
  });
  it("monitors provider leases and pending cleanup every minute", () => {
    const state = initialState();
    expect(needsFrequentReconciliation(state)).toBe(false);
    state.accounts.codex.leasedBy = "task";
    expect(needsFrequentReconciliation(state)).toBe(true);
    state.accounts.codex.leasedBy = null;
    state.operations.cleanup = {
      id: "cleanup",
      taskId: "task",
      attemptId: null,
      kind: "delete",
      createdAt: "now",
      claimUntil: null,
      claimToken: null,
      failures: 0,
    };
    expect(needsFrequentReconciliation(state)).toBe(true);
  });
  it("keeps monitoring paused input and completed-turn grace periods, then idles stopped workers", () => {
    const state = initialState();
    state.accounts.codex.state = "connected";
    state.repositories.repo = {
      id: "repo",
      installationId: "1",
      owner: "example",
      name: "repo",
      defaultBranch: "main",
      setupCommand: "true",
      testCommand: "true",
      revision: 1,
    };
    applyCommand(
      state,
      {
        type: "task.create",
        idempotencyKey: "create",
        repositoryId: "repo",
        baseBranch: "main",
        provider: "codex",
        kind: "ask",
        prompt: "Explain the code",
        issueNumber: null,
      },
      "task",
      "fingerprint",
      0,
      true,
    );
    schedule(state, 0, true);
    state.operations = {};
    state.accounts.codex.leasedBy = null;
    const task = state.tasks.task!;
    task.state = "waiting_for_input";
    task.worker!.state = "paused";
    expect(needsFrequentReconciliation(state)).toBe(true);
    task.state = "completed";
    task.worker!.state = "ready";
    expect(needsFrequentReconciliation(state)).toBe(true);
    task.worker!.state = "stopped";
    expect(needsFrequentReconciliation(state)).toBe(false);
  });
});
