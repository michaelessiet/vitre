import { describe, expect, it } from "vite-plus/test";
import type { CloudCommand, CloudWorkerCallback } from "@t3tools/contracts/cloud";
import {
  acceptCallback,
  acceptCheckpoint,
  applyCommand,
  changeProviderLease,
  confirmStopped,
  initialState,
  publicOverview,
  schedule,
  shouldYieldIdleWorker,
} from "./state.ts";
import { CLOUD_POLICY, iso, runReservation } from "./policy.ts";
import { reserveJob } from "./jobs.ts";

const now = Date.parse("2026-09-18T12:00:00Z");
const create = (
  key = "create",
  provider: "codex" | "claude" = "codex",
): Extract<CloudCommand, { type: "task.create" }> => ({
  type: "task.create",
  idempotencyKey: key,
  repositoryId: "repo",
  baseBranch: "main",
  provider,
  kind: "build",
  prompt: "Fix the failing test",
  issueNumber: null,
});
function fixture() {
  const state = initialState();
  state.repositories.repo = {
    id: "repo",
    installationId: "1",
    owner: "example",
    name: "repo",
    defaultBranch: "main",
    setupCommand: "npm ci",
    testCommand: "npm test",
    revision: 1,
  };
  state.accounts.codex.state = "connected";
  state.accounts.claude.state = "connected";
  return state;
}
function running() {
  const state = fixture();
  applyCommand(state, create(), "task", "fingerprint", now, true);
  schedule(state, now, true);
  const task = state.tasks.task!;
  task.worker!.sandboxId = "sandbox";
  task.worker!.state = "ready";
  task.state = "running";
  return state;
}
const heartbeat = (sequence: number): CloudWorkerCallback => ({
  taskId: "task",
  attemptId: "task-1",
  generation: 1,
  sequence,
  phase: "heartbeat",
  detail: "",
});

describe("cloud task lifecycle", () => {
  it("exposes the persisted account revision and keeps creation permissions", () => {
    const state = fixture();
    state.revision = 17;
    applyCommand(
      state,
      { ...create(), runtimeMode: "approval-required" },
      "supervised",
      "supervised",
      now,
      true,
    );
    applyCommand(state, create("legacy"), "legacy", "legacy", now, true);
    expect(publicOverview(state, true, now).revision).toBe(17);
    expect(state.tasks.supervised?.runtimeMode).toBe("approval-required");
    expect(state.tasks.legacy?.runtimeMode).toBe("full-access");
  });

  it("fences preparation by attempt and callback sequence and retains setup failures after ready/idle", () => {
    const state = running();
    const preparation = {
      attemptId: "task-1",
      sequence: 1,
      phase: "dependencies" as const,
      startedAt: iso(now),
      updatedAt: iso(now),
    };
    const dependencySetup = {
      attemptId: "task-1",
      sequence: 1,
      outcome: "failed" as const,
      updatedAt: iso(now),
      detail: "The lockfile is inconsistent",
    };
    expect(acceptCallback(state, { ...heartbeat(1), preparation, dependencySetup }, now)).toBe(
      true,
    );
    expect(
      acceptCallback(
        state,
        { ...heartbeat(1), dependencySetup: { ...dependencySetup, outcome: "succeeded" } },
        now,
      ),
    ).toBe(false);
    expect(() =>
      acceptCallback(
        state,
        { ...heartbeat(2), preparation: { ...preparation, attemptId: "old", sequence: 2 } },
        now,
      ),
    ).toThrow("different worker update");
    expect(() => acceptCallback(state, { ...heartbeat(2), dependencySetup }, now)).toThrow(
      "different worker update",
    );
    expect(state.tasks.task?.attempt?.lastSequence).toBe(1);
    acceptCallback(
      state,
      {
        ...heartbeat(2),
        phase: "running",
        idle: true,
        preparation: { ...preparation, phase: "ready", sequence: 2 },
      },
      now + 100,
    );
    acceptCallback(state, heartbeat(3), now + 200);
    expect(state.tasks.task?.preparation?.phase).toBe("ready");
    expect(state.tasks.task?.dependencySetup).toEqual(dependencySetup);
    expect(publicOverview(state, true, now).tasks[0]?.dependencySetup?.outcome).toBe("failed");
  });

  it("prepares and activates a cloud-method switch without moving the source provider lease", () => {
    const state = running();
    state.tasks.task!.idle = true;
    const command = (value: CloudCommand) =>
      applyCommand(state, value, `entity-${value.idempotencyKey}`, value.idempotencyKey, now, true);
    command({
      type: "handoff.request",
      idempotencyKey: "switch",
      conversationId: "conversation",
      localThreadId: "local",
      cloudTaskId: "task",
      target: "cloud-local",
      expectedGeneration: 0,
    });
    for (const [expectedPhase, nextPhase] of [
      ["waiting", "preparing"],
      ["preparing", "checkpointing"],
      ["checkpointing", "transferring"],
    ] as const)
      command({
        type: "handoff.advance",
        idempotencyKey: nextPhase,
        operationId: "switch",
        expectedPhase,
        nextPhase,
        checkpoint: { id: "checkpoint", sha256: "a".repeat(64) },
      });
    command({
      ...create("destination"),
      type: "task.create",
      source: {
        kind: "local",
        name: "folder",
        snapshot: { id: "snapshot", sha256: "b".repeat(64) },
      },
      handoff: {
        operationId: "switch",
        conversationId: "conversation",
        generation: 0,
        history: { sha256: "c".repeat(64), sizeBytes: 1, chunks: ["d".repeat(64)] },
      },
    });
    schedule(state, now, true);
    const destination = state.tasks["entity-destination"]!;
    destination.worker!.sandboxId = `machine-${destination.attempt!.id}`;
    expect(destination.attempt).not.toBeNull();
    expect(state.accounts.codex.leasedBy).toBe("task-1");
    acceptCallback(
      state,
      {
        taskId: destination.id,
        attemptId: destination.attempt!.id,
        generation: destination.attempt!.generation,
        sequence: 1,
        phase: "running",
        detail: "",
        idle: true,
      },
      now,
    );
    command({
      type: "handoff.advance",
      idempotencyKey: "verifying",
      operationId: "switch",
      expectedPhase: "transferring",
      nextPhase: "verifying",
      checkpoint: null,
    });
    command({
      type: "handoff.advance",
      idempotencyKey: "activating",
      operationId: "switch",
      expectedPhase: "verifying",
      nextPhase: "activating",
      checkpoint: null,
      destinationOwner: "destination-owner",
      cloudTaskId: destination.id,
    });
    expect(state.accounts.codex.leasedBy).toBe("task-1");
    expect(state.bindings?.conversation?.generation).toBe(1);
    confirmStopped(state, "task", "task-1", now);
    expect(state.accounts.codex.leasedBy).toBeNull();
    expect(changeProviderLease(state, destination.id, destination.attempt!.id, "acquire")).toBe(
      true,
    );
    expect(state.accounts.codex.leasedBy).toBe(destination.attempt!.id);
  });
  it("renames and archives a conversation without changing its execution prompt", () => {
    const state = running();
    const prompt = state.tasks.task!.prompt;
    applyCommand(
      state,
      {
        type: "task.update",
        idempotencyKey: "rename",
        taskId: "task",
        title: "My conversation",
        archived: true,
      },
      "update",
      "update",
      now,
      true,
    );
    expect(state.tasks.task).toMatchObject({
      title: "My conversation",
      archivedAt: iso(now),
      prompt,
    });
    applyCommand(
      state,
      { type: "task.update", idempotencyKey: "restore", taskId: "task", archived: false },
      "restore",
      "restore",
      now,
      true,
    );
    expect(state.tasks.task!.archivedAt).toBeNull();
  });
  it("a delayed Stop cannot cancel a newer request or enqueue worker shutdown", () => {
    const state = running();
    state.tasks.task!.idle = true;
    const staleStop = {
      type: "task.cancel",
      idempotencyKey: "old-stop",
      taskId: "task",
      expectedTurnRequestId: null,
    } as const;
    const nextTurn = {
      type: "task.continue",
      idempotencyKey: "new-turn",
      taskId: "task",
      prompt: "Keep working",
    } as const;
    applyCommand(state, nextTurn, "next", "next", now + 100, true);
    const task = structuredClone(state.tasks.task);
    const operations = structuredClone(state.operations);
    expect(applyCommand(state, staleStop, "stop", "stop", now + 200, true)).toBe("task");
    expect(state.tasks.task).toEqual(task);
    expect(state.operations).toEqual(operations);
    expect(state.receipts["old-stop"]?.entityId).toBe("task");
    // Even if the request later disappears, replay of the stale receipt is inert.
    delete state.tasks.task!.turnRequestId;
    applyCommand(state, staleStop, "retry", "stop", now + 300, true);
    expect(state.tasks.task!.state).toBe("running");
  });

  it("fenced Stops handle the initial turn and matching continued turn; legacy Stop still works", () => {
    for (const request of [null, "current"] as const) {
      const state = running();
      if (request !== null) state.tasks.task!.turnRequestId = request;
      applyCommand(
        state,
        {
          type: "task.cancel",
          idempotencyKey: "stop",
          taskId: "task",
          expectedTurnRequestId: request,
        },
        "stop",
        "stop",
        now + 1,
        true,
      );
      expect(state.tasks.task!.state).toBe("cancelled");
      expect(Object.values(state.operations).some((operation) => operation.kind === "stop")).toBe(
        true,
      );
    }
    const legacy = running();
    legacy.tasks.task!.turnRequestId = "current";
    applyCommand(
      legacy,
      { type: "task.cancel", idempotencyKey: "legacy-stop", taskId: "task" },
      "stop",
      "stop",
      now + 1,
      true,
    );
    expect(legacy.tasks.task!.state).toBe("cancelled");
  });

  it("continues an idle worker without provisioning another attempt", () => {
    const state = running();
    acceptCallback(state, { ...heartbeat(1), idle: true }, now);
    const attempt = state.tasks.task!.attempt;
    const command = {
      type: "task.continue",
      idempotencyKey: "next-turn",
      taskId: "task",
      prompt: "Keep going",
    } as const;
    applyCommand(state, command, "unused", "next-fingerprint", now, true);
    expect(state.tasks.task).toMatchObject({
      state: "running",
      idle: false,
      turnRequestId: "next-turn",
      prompt: "Keep going",
    });
    expect(state.tasks.task!.attempt).toBe(attempt);
    acceptCallback(state, { ...heartbeat(2), idle: true }, now);
    expect(state.tasks.task!.idle).toBe(false);
    expect(() =>
      acceptCallback(state, { ...heartbeat(3), idle: false, closeIdle: true }, now),
    ).toThrow("new turn");
    acceptCallback(state, { ...heartbeat(4), idle: true, turnRequestId: "next-turn" }, now);
    expect(state.tasks.task!.idle).toBe(true);
    acceptCallback(
      state,
      { ...heartbeat(5), idle: false, closeIdle: true, turnRequestId: "next-turn" },
      now,
    );
    expect(state.tasks.task!.idle).toBe(false);
    expect(() =>
      applyCommand(
        state,
        { ...command, idempotencyKey: "too-late" },
        "other",
        "other-fingerprint",
        now,
        true,
      ),
    ).toThrow("worker");
  });
  it("a lost continuation response can be retried with the same key without restarting work", () => {
    const state = running();
    state.tasks.task!.idle = true;
    const command = {
      type: "task.continue",
      idempotencyKey: "lost-response",
      taskId: "task",
      prompt: "Do this once",
    } as const;
    applyCommand(state, command, "first", "payload", now, true);
    const afterSend = structuredClone(state.tasks.task);
    expect(applyCommand(state, command, "retry", "payload", now + 100, true)).toBe("task");
    expect(state.tasks.task).toEqual(afterSend);
    state.tasks.task!.idle = true;
    expect(applyCommand(state, command, "late-retry", "payload", now + 200, true)).toBe("task");
    expect(state.tasks.task!.idle).toBe(true);
    expect(state.tasks.task!.turnRequestId).toBe("lost-response");
    expect(() =>
      applyCommand(
        state,
        { ...command, prompt: "Changed payload" },
        "bad-retry",
        "different",
        now + 300,
        true,
      ),
    ).toThrow("another request");
  });
  it("creates and resumes local-source tasks without a configured repository", () => {
    const state = fixture();
    state.repositories = {};
    const source = {
      kind: "local" as const,
      name: "folder",
      snapshot: { id: "a".repeat(64), sha256: "a".repeat(64) },
    };
    applyCommand(
      state,
      { ...create(), source, model: "selected-model" } as CloudCommand,
      "task",
      "fingerprint",
      now,
      true,
    );
    expect(state.tasks.task).toMatchObject({
      source,
      model: "selected-model",
      repository: { installationId: "local" },
    });
    schedule(state, now, true);
    const callback = { ...heartbeat(1), baseSha: "b".repeat(40) };
    acceptCallback(state, callback, now);
    expect(state.tasks.task!.baseSha).toBe("b".repeat(40));
    expect(() =>
      applyCommand(
        state,
        {
          type: "publication.create",
          idempotencyKey: "publish",
          taskId: "task",
          resultId: "result",
          resultSha256: "c".repeat(64),
          kind: "pull_request",
          title: "title",
          body: "body",
        } as CloudCommand,
        "publication",
        "publish-fingerprint",
        now,
        true,
      ),
    ).toThrow("not connected to GitHub");
  });
  it("keeps input waits live and billable, bounded by the input deadline", () => {
    const state = running();
    acceptCallback(state, { ...heartbeat(1), phase: "waiting_for_input" }, now);
    expect(state.tasks.task!.worker!.state).toBe("ready");
    expect(Object.values(state.operations).some((op) => op.kind === "pause")).toBe(false);
    acceptCallback(state, heartbeat(2), now + 60_000);
    expect(state.usage["2026-09"]).toBe(60 * CLOUD_POLICY.computeMicroDollarsPerSecond);
    acceptCallback(state, heartbeat(3), now + CLOUD_POLICY.waitingTimeoutMs + 1);
    schedule(state, now + CLOUD_POLICY.waitingTimeoutMs + 1, false);
    expect(state.tasks.task!.state).toBe("interrupted");
    expect(state.accounts.codex.leasedBy).toBe("task-1");
  });

  it("accounts for auxiliary execution before scheduling without double charging a repeated tick", () => {
    const state = fixture();
    reserveJob(state, "login", "login", now);
    schedule(state, now + 60_000, false);
    expect(state.usage["2026-09"]).toBe(60 * CLOUD_POLICY.computeMicroDollarsPerSecond);
    schedule(state, now + 60_000, false);
    expect(state.usage["2026-09"]).toBe(60 * CLOUD_POLICY.computeMicroDollarsPerSecond);
  });
  it("deduplicates creation and rejects reusing a key for different content", () => {
    const state = fixture();
    expect(applyCommand(state, create(), "task", "same", now, true)).toBe("task");
    expect(applyCommand(state, create(), "other", "same", now, true)).toBe("task");
    expect(Object.keys(state.tasks)).toEqual(["task"]);
    expect(() => applyCommand(state, create(), "other", "different", now, true)).toThrow(
      "another request",
    );
    schedule(state, now, true);
    schedule(state, now, true);
    expect(Object.values(state.operations)).toHaveLength(1);
  });
  it("serializes each provider while allowing two distinct providers", () => {
    const state = fixture();
    for (const [id, provider] of [
      ["a", "codex"],
      ["b", "codex"],
      ["c", "claude"],
    ] as const)
      applyCommand(state, create(id, provider), id, id, now, true);
    schedule(state, now, true);
    expect(state.tasks.a!.state).toBe("preparing");
    expect(state.tasks.b!.state).toBe("queued");
    expect(state.tasks.c!.state).toBe("preparing");
    expect(publicOverview(state, true, now).usage.reservedMicroDollars).toBe(2 * runReservation);
    expect(state.tasks.a!.worker!.diskGiB).toBe(CLOUD_POLICY.diskGiB);
  });
  it("reserves budget before provisioning and does not overbook it", () => {
    const state = fixture();
    state.monthlyLimit = runReservation;
    applyCommand(state, create("a"), "a", "a", now, true);
    applyCommand(state, create("b", "claude"), "b", "b", now, true);
    schedule(state, now, true);
    expect(state.tasks.a!.state).toBe("preparing");
    expect(state.tasks.b!.state).toBe("queued");
    expect(state.tasks.b!.error).toContain("allowance");
  });
  it("cancellation during provisioning retains the account lease until confirmed shutdown", () => {
    const state = fixture();
    applyCommand(state, create(), "task", "f", now, true);
    schedule(state, now, true);
    applyCommand(
      state,
      { type: "task.cancel", idempotencyKey: "cancel", taskId: "task" },
      "op",
      "c",
      now + 1000,
      true,
    );
    expect(state.accounts.codex.leasedBy).toBe("task-1");
    expect(Object.values(state.operations).map((o) => o.kind)).toEqual(["provision", "stop"]);
    confirmStopped(state, "task", "old-attempt", now + 2000);
    expect(state.accounts.codex.leasedBy).toBe("task-1");
    confirmStopped(state, "task", "task-1", now + 3000);
    expect(state.accounts.codex.leasedBy).toBeNull();
    expect(state.tasks.task!.attempt!.reservedMicroDollars).toBe(0);
  });
  it("ignores duplicate events and fences replaced workers", () => {
    const state = running();
    expect(acceptCallback(state, heartbeat(1), now + 1000)).toBe(true);
    expect(acceptCallback(state, heartbeat(1), now + 5000)).toBe(false);
    expect(state.tasks.task!.attempt!.heartbeatAt).toBe(iso(now + 1000));
    expect(() => acceptCallback(state, { ...heartbeat(2), generation: 0 }, now + 6000)).toThrow(
      "no longer current",
    );
  });
  it("keeps work running without clients but interrupts a lost worker", () => {
    const state = running();
    acceptCallback(state, heartbeat(1), now + 90_000);
    schedule(state, now + 120_000, true);
    expect(state.tasks.task!.state).toBe("running");
    schedule(state, now + 300_000, true);
    expect(state.tasks.task!.state).toBe("interrupted");
    expect(Object.values(state.operations).some((o) => o.kind === "stop")).toBe(true);
  });
  it("does not mark results complete without a durable checkpoint", () => {
    const state = running();
    expect(() => acceptCallback(state, { ...heartbeat(1), phase: "completed" }, now)).toThrow(
      "checkpoint",
    );
    expect(state.tasks.task!.state).toBe("running");
  });
  it("retains a checkpoint that races cancellation without completing or reviving the task", () => {
    const state = running();
    applyCommand(
      state,
      { type: "task.cancel", taskId: "task", idempotencyKey: "cancel" },
      "op",
      "cancel",
      now,
      true,
    );
    const checkpoint = {
      id: "cp",
      taskId: "task",
      attemptId: "task-1",
      sequence: 1,
      objectKey: "manifest",
      sha256: "0".repeat(64),
      sizeBytes: 1,
      createdAt: iso(now + 1000),
    };
    expect(acceptCheckpoint(state, { ...heartbeat(1), checkpoint }, now + 1000)).toBe(true);
    expect(state.tasks.task!.state).toBe("cancelled");
    expect(state.tasks.task!.checkpoint?.id).toBe("cp");
    expect(state.tasks.task!.result).toBeNull();
    confirmStopped(state, "task", "task-1", now + 2000);
    expect(() => acceptCheckpoint(state, { ...heartbeat(2), checkpoint }, now + 3000)).toThrow(
      "no longer current",
    );
  });
  it("does not fall back to API billing when subscription auth or usage fails", () => {
    for (const phase of ["needs_auth", "usage_limited"] as const) {
      const state = running();
      acceptCallback(state, { ...heartbeat(1), phase, detail: "Login or limit" }, now);
      expect(state.tasks.task!.state).toBe(phase);
      expect(state.accounts.codex.state).toBe(phase);
    }
  });
  it("cannot publish stale or unreviewed results", () => {
    const state = running();
    expect(() =>
      applyCommand(
        state,
        {
          type: "publication.create",
          idempotencyKey: "pub",
          taskId: "task",
          resultId: "r",
          resultSha256: "0".repeat(64),
          kind: "pull_request",
          title: "Fix",
          body: "Reviewed",
        },
        "pub",
        "p",
        now,
        true,
      ),
    ).toThrow("Review");
  });
  it("freezes the reviewed checkpoint independently of later continuation and rejects changed publication text", () => {
    const state = running();
    const task = state.tasks.task!;
    task.state = "completed";
    task.checkpoint = {
      id: "r",
      taskId: "task",
      attemptId: "task-1",
      sequence: 1,
      objectKey: "immutable-manifest",
      sha256: "a".repeat(64),
      sizeBytes: 42,
      createdAt: iso(now),
    };
    task.result = {
      id: "r",
      taskId: "task",
      checkpointId: "r",
      sha256: "a".repeat(64),
      summary: "Reviewed",
      createdAt: iso(now),
    };
    const command: CloudCommand = {
      type: "publication.create",
      idempotencyKey: "publish",
      taskId: "task",
      resultId: "r",
      resultSha256: "a".repeat(64),
      kind: "pull_request",
      title: "Approved",
      body: "Exact approved body",
    };
    applyCommand(state, command, "publication", "review", now, true);
    expect(() =>
      applyCommand(
        state,
        { ...command, idempotencyKey: "changed", body: "Different body" },
        "other",
        "changed",
        now,
        true,
      ),
    ).toThrow("different approved publication");
    confirmStopped(state, "task", "task-1", now);
    applyCommand(
      state,
      {
        type: "task.continue",
        idempotencyKey: "continue",
        taskId: "task",
        prompt: "Another change",
      },
      "next",
      "next",
      now,
      true,
    );
    expect(task.result).toBeNull();
    expect(state.publicationInputs?.publication?.result?.summary).toBe("Reviewed");
    expect(state.publicationInputs?.publication?.checkpoint?.objectKey).toBe("immutable-manifest");
  });
  it("keeps cancellation available when cloud execution is disabled", () => {
    const state = running();
    expect(() => applyCommand(state, create("new"), "new", "n", now, false)).toThrow("disabled");
    applyCommand(
      state,
      { type: "task.cancel", idempotencyKey: "cancel", taskId: "task" },
      "op",
      "c",
      now,
      false,
    );
    expect(state.tasks.task!.state).toBe("cancelled");
  });
  it("does not relabel a completed result when shutdown crosses a deadline or budget threshold", () => {
    const state = running();
    state.tasks.task!.state = "completed";
    state.monthlyLimit = 1;
    schedule(state, now + CLOUD_POLICY.runTimeoutMs + 1, false);
    expect(state.tasks.task!.state).toBe("completed");
    expect(Object.values(state.operations).some((operation) => operation.kind === "stop")).toBe(
      true,
    );
  });
  it("splits charges at month boundaries and limits execution time", () => {
    const state = running();
    state.tasks.task!.attempt!.billedThrough = "2026-09-30T23:59:59Z";
    schedule(state, Date.parse("2026-10-01T00:00:01Z"), false);
    expect(state.usage["2026-09"]).toBe(CLOUD_POLICY.computeMicroDollarsPerSecond);
    expect(state.usage["2026-10"]).toBe(CLOUD_POLICY.computeMicroDollarsPerSecond);
    expect(state.tasks.task!.state).toBe("interrupted");
  });
});

it("releases a settled worker promptly for queued work without stealing its provider lease", () => {
  const state = running();
  state.tasks.task!.state = "completed";
  applyCommand(state, create("next"), "next", "next-fingerprint", now, true);
  schedule(state, now + 1, true);
  expect(
    Object.values(state.operations).some((op) => op.kind === "stop" && op.taskId === "task"),
  ).toBe(true);
  expect(state.tasks.task!.state).toBe("completed");
  expect(state.tasks.next!.state).toBe("queued");
  expect(state.accounts.codex.leasedBy).toBe("task-1");
});

it("does not stop active work just because another task is queued", () => {
  const state = running();
  applyCommand(state, create("next"), "next", "next-fingerprint", now, true);
  schedule(state, now + 1, true);
  expect(Object.values(state.operations).some((op) => op.kind === "stop")).toBe(false);
  expect(state.tasks.next!.state).toBe("queued");
});

it("yields only idle workers to queued conversations using the same provider", () => {
  const state = running();
  applyCommand(state, create("next"), "next", "next-fingerprint", now, true);
  expect(shouldYieldIdleWorker(state, state.tasks.task!)).toBe(false);
  state.tasks.task!.idle = true;
  expect(shouldYieldIdleWorker(state, state.tasks.task!)).toBe(true);
  state.tasks.task!.state = "waiting_for_input";
  expect(shouldYieldIdleWorker(state, state.tasks.task!)).toBe(false);
  state.tasks.task!.state = "running";
  state.tasks.next!.provider = "claude";
  expect(shouldYieldIdleWorker(state, state.tasks.task!)).toBe(false);
});

describe("resident conversation provider leases", () => {
  const resident = () => {
    const state = running();
    state.tasks.task!.worker!.sandboxId = "machine-task-1";
    return state;
  };
  const handoff = (residentDestination: boolean) => {
    const state = resident();
    const source = state.tasks.task!;
    source.idle = true;
    state.tasks.destination = {
      ...structuredClone(source),
      id: "destination",
      attempt: { ...source.attempt!, id: "destination-1" },
      worker: {
        ...source.worker!,
        id: "destination-1",
        sandboxId: residentDestination ? "machine-destination-1" : "retired-destination",
      },
      handoff: {
        operationId: "switch",
        conversationId: "conversation",
        generation: 0,
        history: { sha256: "a".repeat(64), sizeBytes: 1, chunks: ["b".repeat(64)] },
      },
    };
    state.bindings = {
      conversation: {
        conversationId: "conversation",
        localThreadId: "local",
        cloudTaskId: "task",
        target: "cloud-github",
        generation: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    };
    state.handoffs = {
      switch: {
        id: "switch",
        conversationId: "conversation",
        from: "cloud-github",
        to: "cloud-local",
        generation: 0,
        phase: "verifying",
        checkpoint: { id: "saved", sha256: "c".repeat(64) },
        error: null,
      },
    };
    return state;
  };
  const activate = {
    type: "handoff.advance",
    idempotencyKey: "activate",
    operationId: "switch",
    expectedPhase: "verifying",
    nextPhase: "activating",
    checkpoint: null,
    destinationOwner: "destination-owner",
    cloudTaskId: "destination",
  } as const;

  it("retains an uncontested session and advances its turn fence without stopping the worker", () => {
    const state = resident();
    const task = state.tasks.task!;
    acceptCallback(state, { ...heartbeat(1), idle: true }, now);
    expect(shouldYieldIdleWorker(state, task)).toBe(false);
    applyCommand(
      state,
      {
        type: "task.continue",
        taskId: "task",
        idempotencyKey: "retained-next",
        prompt: "Next",
      },
      "unused",
      "retained-next",
      now + 1,
      true,
    );
    expect(changeProviderLease(state, "task", "task-1", "acquire", "retained-next")).toBe(true);
    expect(state.providerLeaseTurns!.codex).toBe("retained-next");
    changeProviderLease(state, "task", "task-1", "release");
    expect(state.accounts.codex.leasedBy).toBe("task-1");
    expect(task.idle).toBe(false);
    expect(task.worker!.state).toBe("ready");
    state.accounts.codex.state = "disconnected";
    expect(() => changeProviderLease(state, "task", "task-1", "acquire", "retained-next")).toThrow(
      "Connect",
    );
    task.state = "cancelled";
    expect(() => changeProviderLease(state, "task", "task-1", "acquire", "retained-next")).toThrow(
      "runnable",
    );
  });

  it("makes a retained session yield to an older queued conversation before a new turn", () => {
    const state = resident();
    const task = state.tasks.task!;
    acceptCallback(state, { ...heartbeat(1), idle: true }, now);
    applyCommand(state, create("older"), "older", "older", now + 1, true);
    expect(shouldYieldIdleWorker(state, task)).toBe(true);
    applyCommand(
      state,
      {
        type: "task.continue",
        taskId: "task",
        idempotencyKey: "retained-next",
        prompt: "Next",
      },
      "unused",
      "retained-next",
      now + 2,
      true,
    );
    expect(changeProviderLease(state, "task", "task-1", "acquire", "retained-next")).toBe(false);
    expect(state.accounts.codex.leasedBy).toBe("task-1");
    changeProviderLease(state, "task", "task-1", "release");
    expect(task.idle).toBe(false);
    schedule(state, now + 3, true, true);
    expect(state.tasks.older!.state).toBe("preparing");
    expect(changeProviderLease(state, "task", "task-1", "acquire", "retained-next")).toBe(false);
  });

  it("yields retained refresh ownership to pending warm turns and ready handoff validation", () => {
    const state = handoff(true);
    const task = state.tasks.task!;
    const destination = state.tasks.destination!;
    destination.state = "preparing";
    destination.idle = false;
    state.handoffs!.switch = { ...state.handoffs!.switch!, phase: "checkpointing" };
    expect(shouldYieldIdleWorker(state, task)).toBe(false);
    state.handoffs!.switch = { ...state.handoffs!.switch!, phase: "transferring" };
    expect(shouldYieldIdleWorker(state, task)).toBe(true);
    destination.state = "running";
    destination.idle = true;
    expect(shouldYieldIdleWorker(state, task)).toBe(false);
    destination.idle = false;
    expect(shouldYieldIdleWorker(state, task)).toBe(true);
    destination.provider = "claude";
    expect(shouldYieldIdleWorker(state, task)).toBe(false);
  });

  it("activates resident destinations without granting or replacing a provider lease", () => {
    for (const owner of [null, "task-1", "unrelated-1"]) {
      const state = handoff(true);
      state.accounts.codex.leasedBy = owner;
      applyCommand(state, activate, "unused", "activate", now, true);
      expect(state.accounts.codex.leasedBy).toBe(owner);
      expect(state.bindings!.conversation!.cloudTaskId).toBe("destination");
      expect(changeProviderLease(state, "destination", "destination-1", "acquire")).toBe(
        owner === null,
      );
    }
  });

  it("rejects a handoff to an unsupported executor before committing ownership", () => {
    const state = handoff(false);
    state.accounts.codex.leasedBy = "unrelated-1";
    expect(() => applyCommand(state, activate, "unused", "activate", now, true)).toThrow(
      "assigned machine",
    );
    expect(state.accounts.codex.leasedBy).toBe("unrelated-1");
    expect(state.bindings!.conversation!.cloudTaskId).toBe("task");
    expect(state.handoffs!.switch!.phase).toBe("verifying");
  });

  it("leases initial handoff validation only after source capture and without taking an active owner's lease", () => {
    const state = handoff(true);
    const destination = state.tasks.destination!;
    destination.state = "preparing";
    destination.idle = false;
    expect(changeProviderLease(state, "destination", "destination-1", "acquire")).toBe(false);
    changeProviderLease(state, "task", "task-1", "release");
    state.handoffs!.switch = { ...state.handoffs!.switch!, phase: "checkpointing" };
    expect(() => changeProviderLease(state, "destination", "destination-1", "acquire")).toThrow(
      "runnable",
    );
    state.handoffs!.switch = { ...state.handoffs!.switch!, phase: "cancelled" };
    expect(() => changeProviderLease(state, "destination", "destination-1", "acquire")).toThrow(
      "runnable",
    );
    state.handoffs!.switch = { ...state.handoffs!.switch!, phase: "transferring" };
    expect(changeProviderLease(state, "destination", "destination-1", "acquire")).toBe(true);
    expect(state.accounts.codex.leasedBy).toBe("destination-1");
  });

  it("releases the provider while keeping the backend ready and accepts lease-free heartbeats", () => {
    const state = resident();
    expect(changeProviderLease(state, "task", "task-1", "release")).toBe(false);
    expect(state.accounts.codex.leasedBy).toBeNull();
    expect(state.tasks.task).toMatchObject({
      state: "running",
      idle: true,
      worker: { state: "ready" },
    });
    acceptCallback(state, { ...heartbeat(1), idle: true }, now);
    applyCommand(state, create("second"), "second", "second", now + 1, true);
    expect(shouldYieldIdleWorker(state, state.tasks.task!)).toBe(false);
    schedule(state, now + 1, true, true);
    expect(state.tasks.second!.state).toBe("preparing");
    expect(state.tasks.task!.worker!.state).toBe("ready");
    acceptCallback(state, { ...heartbeat(2), idle: true }, now + 2);
  });

  it("serializes warm turns and rejects stale releases after a newer turn acquires the lease", () => {
    const state = resident();
    const task = state.tasks.task!;
    changeProviderLease(state, "task", "task-1", "release");
    applyCommand(
      state,
      {
        type: "task.continue",
        taskId: "task",
        idempotencyKey: "next",
        prompt: "Next",
      },
      "unused",
      "next",
      now + 1,
      true,
    );
    state.accounts.codex.leasedBy = "other-1";
    expect(changeProviderLease(state, "task", "task-1", "acquire", "next")).toBe(false);
    state.accounts.codex.leasedBy = null;
    expect(changeProviderLease(state, "task", "task-1", "acquire", "next")).toBe(true);
    changeProviderLease(state, "task", "task-1", "release");
    expect(state.accounts.codex.leasedBy).toBe("task-1");
    expect(task.idle).toBe(false);
    expect(() => changeProviderLease(state, "task", "task-1", "acquire", "old")).toThrow("current");
    task.turnRequestId = "later";
    changeProviderLease(state, "task", "task-1", "release", "next");
    expect(task.idle).toBe(false);
    expect(state.accounts.codex.leasedBy).toBeNull();
    expect(changeProviderLease(state, "task", "task-1", "acquire", "later")).toBe(true);
  });

  it("prioritizes older pending warm turns over a newly queued cold task", () => {
    const state = resident();
    changeProviderLease(state, "task", "task-1", "release");
    applyCommand(
      state,
      {
        type: "task.continue",
        taskId: "task",
        idempotencyKey: "next",
        prompt: "Next",
      },
      "unused",
      "next",
      now + 1,
      true,
    );
    applyCommand(state, create("second"), "second", "second", now + 2, true);
    schedule(state, now + 2, true, true);
    expect(state.tasks.second!.state).toBe("queued");
    expect(changeProviderLease(state, "task", "task-1", "acquire", "next")).toBe(true);
  });

  it("keeps dedicated backends past execution budgets and allows more than two warm tasks", () => {
    const state = resident();
    state.monthlyLimit = 0;
    changeProviderLease(state, "task", "task-1", "release");
    for (let index = 0; index < 3; index++) {
      const id = `more-${index}`;
      applyCommand(state, create(id), id, id, now + index + 1, true);
      schedule(state, now + index + 1, true, true);
      const task = state.tasks[id]!;
      expect(task.state).toBe("preparing");
      task.worker!.sandboxId = `machine-${id}-1`;
      task.worker!.state = "ready";
      task.state = "running";
      changeProviderLease(state, id, `${id}-1`, "release");
    }
    const later = now + CLOUD_POLICY.runTimeoutMs + 1;
    for (const task of Object.values(state.tasks)) task.attempt!.heartbeatAt = iso(later);
    schedule(state, later, true, true);
    expect(Object.values(state.tasks).every((task) => task.state === "running")).toBe(true);
    expect(Object.values(state.operations).some((operation) => operation.kind === "stop")).toBe(
      false,
    );
    expect(state.usage).toEqual({});
  });

  it("does not let legacy workers drop their lease or send updates without it", () => {
    const state = running();
    expect(() => changeProviderLease(state, "task", "task-1", "release")).toThrow("current");
    state.accounts.codex.leasedBy = null;
    expect(() => acceptCallback(state, heartbeat(1), now)).toThrow("current");
  });

  it("fences stopped resident workers and leaves another lease owner's account status unchanged", () => {
    const state = resident();
    changeProviderLease(state, "task", "task-1", "release");
    state.accounts.codex.leasedBy = "another-task-1";
    acceptCallback(state, { ...heartbeat(1), phase: "needs_auth" }, now);
    expect(state.accounts.codex.state).toBe("connected");
    state.tasks.task!.state = "running";
    confirmStopped(state, "task", "task-1", now);
    expect(() => acceptCallback(state, { ...heartbeat(2), phase: "running" }, now)).toThrow(
      "current",
    );
  });

  it("keeps deadlines enforced for unsupported workers retained in historical state", () => {
    const state = running();
    schedule(state, now + CLOUD_POLICY.runTimeoutMs + 1, true, true);
    expect(state.tasks.task!.state).toBe("interrupted");
    expect(state.tasks.task!.error).toBe("Run deadline reached");
  });
});

it("clears recovered preparation errors on readiness while retaining dependency warning events", () => {
  const state = running();
  state.tasks.task!.error = "Machine request failed (503)";
  acceptCallback(
    state,
    { ...heartbeat(1), detail: "Dependency setup needs attention: installer failed" },
    now,
  );
  expect(state.tasks.task!.error).toBe("Machine request failed (503)");
  acceptCallback(state, { ...heartbeat(2), phase: "running" }, now + 1);
  expect(state.tasks.task!.error).toBeNull();
  expect(state.events!.task![0]!.detail).toBe("Dependency setup needs attention: installer failed");
  acceptCallback(
    state,
    { ...heartbeat(3), phase: "failed", detail: "Preparation failed" },
    now + 2,
  );
  expect(state.tasks.task!.error).toBe("Preparation failed");
});
