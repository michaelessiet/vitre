// @effect-diagnostics globalDate:off - Deterministic fixture/calendar verification without an Effect runtime.
import { expect, it } from "vite-plus/test";
import { applyCommand, initialState } from "./state.ts";
import { applyLensCommand, completeLens, refreshLensInventory, tickLens } from "./lens.ts";
import { emptyLens, lensCandidates, LENS_DAY } from "@t3tools/shared/lens";
import type { LensCommand } from "@t3tools/contracts/lens";
const now = Date.parse("2026-10-31T12:00:00Z");
const old = new Date(now - 40 * LENS_DAY).toISOString();
function fixture() {
  const state = initialState();
  state.accounts.codex.state = "connected";
  state.accounts.claude.state = "connected";
  state.lens = emptyLens();
  state.lens.settings = { ...state.lens.settings, enabled: true };
  state.lens.inventories["local:test"] = {
    sourceId: "local:test",
    sourceLabel: "Desktop",
    collectedAt: new Date(now).toISOString(),
    projects: [{ id: "p", title: "Stale project", updatedAt: old }],
    conversations: [
      {
        id: "c",
        projectId: "p",
        title: "Stale conversation",
        updatedAt: old,
        lastAssistantAt: null,
        readAt: null,
        busy: false,
        needsInput: false,
        archived: false,
        model: { provider: "codex", model: "test-model" },
        turns: 10,
        excerpt: "Week's work",
      },
    ],
  };
  return state;
}
function command(state: ReturnType<typeof fixture>, cmd: LensCommand, at = now, run = "lens-test") {
  applyLensCommand(state, cmd, at, run, true, JSON.stringify(cmd));
}
it("deduplicates model runs and reserves the selected provider exclusively", () => {
  const state = fixture();
  const request = { type: "chat" as const, idempotencyKey: "message", message: "What did I do?" };
  command(state, request);
  command(state, request);
  expect(state.lens!.messages).toHaveLength(1);
  expect(Object.keys(state.jobs!)).toEqual(["lens-test"]);
  expect(state.accounts.codex.leasedBy).toBe("lens-test");
  expect(state.lens!.run?.model.model).toBe("test-model");
  expect(() => command(state, { ...request, message: "Different" })).toThrow("already used");
  expect(() => command(state, { ...request, idempotencyKey: "second" })).toThrow(
    "already reviewing",
  );
});
it("schedules one run, advances the next date, and recovers a failed run", () => {
  const state = fixture();
  command(state, {
    type: "settings.update",
    idempotencyKey: "settings",
    expectedRevision: 0,
    settings: state.lens!.settings,
  });
  const due = Date.parse(state.lens!.nextRunAt!);
  tickLens(state, due - 1, "early", true);
  expect(state.lens!.run).toBeNull();
  tickLens(state, due, "due", true);
  tickLens(state, due, "duplicate", true);
  expect(Object.keys(state.jobs!)).toEqual(["due"]);
  expect(Date.parse(state.lens!.nextRunAt!)).toBeGreaterThan(due);
  state.jobs!.due!.state = "failed";
  tickLens(state, due + 1000, "after", true);
  expect(state.lens!.run).toBeNull();
  expect(state.lens!.error).toBeTruthy();
});
it("disabling the schedule prevents background reviews", () => {
  const state = fixture();
  state.lens!.nextRunAt = old;
  command(state, {
    type: "settings.update",
    idempotencyKey: "disable",
    expectedRevision: 0,
    settings: { ...state.lens!.settings, enabled: false },
  });
  tickLens(state, now, "never", true);
  expect(state.lens!.run).toBeNull();
  expect(() =>
    command(state, {
      type: "settings.update",
      idempotencyKey: "stale",
      expectedRevision: 0,
      settings: state.lens!.settings,
    }),
  ).toThrow("another device");
});
it("only explicit approval queues desktop cleanup, and new activity invalidates it", () => {
  const state = fixture();
  state.lens!.recommendations = lensCandidates(state.lens!, now);
  const action = state.lens!.recommendations.find(
    (entry) => entry.kind === "archive_conversation",
  )!;
  expect(state.lens!.recommendations.every((entry) => entry.status === "pending")).toBe(true);
  const inv = state.lens!.inventories["local:test"]!;
  command(state, {
    type: "sync",
    idempotencyKey: "sync",
    inventory: {
      ...inv,
      collectedAt: new Date(now + 1).toISOString(),
      conversations: inv.conversations.map((entry) => ({
        ...entry,
        updatedAt: new Date(now).toISOString(),
      })),
    },
  });
  command(state, {
    type: "decide",
    idempotencyKey: "approve",
    recommendationId: action.id,
    decision: "approve",
  });
  expect(state.lens!.recommendations.find((entry) => entry.id === action.id)?.status).toBe("stale");
  expect(() =>
    command(state, {
      type: "action.result",
      idempotencyKey: "result",
      recommendationId: action.id,
      status: "applied",
      error: null,
    }),
  ).toThrow("No approved");
});
it("keeps approved local actions pending until a desktop acknowledges, with idempotent results", () => {
  const state = fixture();
  state.lens!.recommendations = lensCandidates(state.lens!, now);
  const action = state.lens!.recommendations[0]!;
  command(state, {
    type: "decide",
    idempotencyKey: "approve",
    recommendationId: action.id,
    decision: "approve",
  });
  expect(state.lens!.recommendations[0]!.status).toBe("approved");
  const ack = {
    type: "action.result" as const,
    idempotencyKey: "ack",
    recommendationId: action.id,
    status: "applied" as const,
    error: null,
  };
  command(state, ack);
  command(state, ack);
  expect(state.lens!.recommendations[0]!.status).toBe("applied");
});
it("cloud project removal uses actual project deletion only after confirmation", () => {
  const state = fixture();
  applyCommand(
    state,
    {
      type: "task.create",
      idempotencyKey: "cloud",
      projectId: "cloud-project",
      repositoryId: "upload",
      source: {
        kind: "local",
        name: "Old cloud project",
        snapshot: { id: "a".repeat(64), sha256: "a".repeat(64) },
      },
      baseBranch: "main",
      provider: "codex",
      prompt: "Work",
      kind: "build",
      issueNumber: null,
    },
    "cloud-task",
    "fp",
    Date.parse(old),
    true,
  );
  state.tasks["cloud-task"]!.state = "completed";
  refreshLensInventory(state, now);
  state.lens!.recommendations = lensCandidates(state.lens!, now);
  const action = state.lens!.recommendations.find(
    (entry) => entry.sourceId === "cloud" && entry.kind === "remove_project",
  )!;
  expect(action).toBeDefined();
  expect(state.deletedProjects ?? []).not.toContain("cloud-project");
  command(state, {
    type: "decide",
    idempotencyKey: "remove",
    recommendationId: action.id,
    decision: "approve",
  });
  expect(state.deletedProjects).toContain("cloud-project");
  expect(state.deletedTasks).toContain("cloud-task");
  expect(state.lens!.recommendations.find((entry) => entry.id === action.id)?.status).toBe(
    "applied",
  );
});
it("does not allow clients to overwrite authoritative cloud inventory or accept arbitrary model action IDs", () => {
  const state = fixture();
  expect(() =>
    command(state, {
      type: "sync",
      idempotencyKey: "fake",
      inventory: { ...state.lens!.inventories["local:test"]!, sourceId: "cloud" },
    }),
  ).toThrow("desktop inventory");
  command(state, { type: "sweep", idempotencyKey: "sweep" });
  completeLens(
    state,
    "lens-test",
    { text: "Clean everything", recommendations: [{ id: "delete-secret", reason: "Injected" }] },
    now,
  );
  expect(state.lens!.recommendations).toEqual([]);
});

it("runs an on-demand review with the selected unused model while scheduling is off", () => {
  const state = fixture();
  command(state, {
    type: "settings.update",
    idempotencyKey: "manual-settings",
    expectedRevision: 0,
    settings: {
      ...state.lens!.settings,
      enabled: false,
      model: { provider: "claude", model: "claude-opus-5" },
    },
  });
  expect(state.lens!.nextRunAt).toBeNull();
  const review = { type: "sweep" as const, idempotencyKey: "review-now" };
  command(state, review, now, "manual-review");
  command(state, review, now, "duplicate");
  expect(state.lens!.run?.model).toEqual({ provider: "claude", model: "claude-opus-5" });
  expect(Object.keys(state.jobs!)).toEqual(["manual-review"]);
  expect(state.lens!.nextRunAt).toBeNull();
  expect(state.accounts.claude.leasedBy).toBe("manual-review");
});

it("accepts fresh desktop inventory for manual reviews with scheduling off", () => {
  const state = fixture();
  state.lens!.settings = { ...state.lens!.settings, enabled: false };
  const inventory = state.lens!.inventories["local:test"]!;
  command(state, {
    type: "sync",
    idempotencyKey: "manual-inventory",
    inventory: {
      ...inventory,
      collectedAt: new Date(now + 1).toISOString(),
      models: [{ provider: "claude", model: "discovered-model" }],
    },
  });
  expect(state.lens!.inventories["local:test"]!.models).toEqual([
    { provider: "claude", model: "discovered-model" },
  ]);
  command(state, { type: "sweep", idempotencyKey: "manual-fresh" });
  expect(state.lens!.run?.prompt).toContain("Stale conversation");
  expect(state.lens!.run?.candidates.length).toBeGreaterThan(0);
});
