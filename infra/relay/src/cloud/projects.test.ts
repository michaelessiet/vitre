import { describe, expect, it } from "vite-plus/test";
import { iso } from "./policy.ts";
import { applyCommand, initialState } from "./state.ts";
import {
  backfillProjects,
  projectSnapshot,
  projectSnapshots,
  recordProjectSnapshot,
  referencesTaskArtifacts,
} from "./projects.ts";

const now = Date.parse("2026-10-17T12:00:00Z");
function fixture() {
  const state = initialState();
  state.accounts.codex.state = "connected";
  applyCommand(
    state,
    {
      type: "task.create",
      idempotencyKey: "source",
      projectId: "stable-project",
      repositoryId: "upload",
      source: {
        kind: "local",
        name: "Uploaded project",
        snapshot: { id: "a".repeat(64), sha256: "a".repeat(64) },
      },
      baseBranch: "main",
      provider: "codex",
      prompt: "Work",
      kind: "build",
      issueNumber: null,
    },
    "source",
    "source",
    now,
    true,
  );
  state.tasks.source!.worker = {
    id: "source-worker",
    environmentId: "environment",
    state: "ready",
    sandboxId: null,
    cpu: 1,
    memoryGiB: 1,
    diskGiB: 1,
    stoppedAt: null,
  };
  backfillProjects(state);
  return state;
}
const create = {
  type: "task.createFromProject" as const,
  idempotencyKey: "copy",
  projectId: "stable-project",
  snapshotId: "a".repeat(64),
  prompt: "Continue independently",
  provider: "codex" as const,
  runtimeMode: "approval-required" as const,
};

describe("durable cloud projects", () => {
  it.each(["running", "cancelled", "completed"] as const)(
    "copies a %s source with a pinned workspace and a fresh task",
    (phase) => {
      const state = fixture();
      state.tasks.source!.state = phase;
      state.tasks.source!.archivedAt = phase === "completed" ? iso(now) : null;
      const source = structuredClone(state.tasks.source);
      applyCommand(state, create, "copy", "copy", now + 1, true);
      const copy = state.tasks.copy!;
      expect(copy.source).toEqual(source?.source);
      expect(copy.projectId).toBe("stable-project");
      expect(copy.branch).toBe("vitre/copy");
      expect(copy.checkpoint).toBeNull();
      expect(copy.handoff).toBeUndefined();
      expect(copy.attempt).toBeNull();
      expect(copy.runtimeMode).toBe("approval-required");
      expect(state.tasks.source).toEqual(source);
    },
  );
  it("pins the snapshot through a race and an ambiguous creation retry", () => {
    const state = fixture();
    applyCommand(state, create, "copy", "fingerprint", now, true);
    recordProjectSnapshot(state, state.tasks.source!, {
      id: "new",
      workspace: { id: "b".repeat(64), sha256: "b".repeat(64) },
      checkpoint: null,
      sourceKind: "local",
      baseBranch: "main",
      baseSha: null,
      roots: [{ id: "extra", name: "Assets" }],
      savedAt: iso(now + 10),
    });
    expect(applyCommand(state, create, "retry-id", "fingerprint", now + 20, true)).toBe("copy");
    expect(state.tasks.copy!.projectSnapshot!.id).toBe(create.snapshotId);
    expect(state.projects!["stable-project"]!.latestSnapshot?.id).toBe("new");
    expect(Object.keys(state.tasks)).toHaveLength(2);
  });
  it("retains projects independently of source deletion and does not merge uploaded names", () => {
    const state = fixture();
    const source = state.tasks.source!;
    state.tasks.unrelated = { ...structuredClone(source), id: "unrelated" };
    delete state.tasks.unrelated.projectId;
    backfillProjects(state);
    expect(Object.keys(state.projects!)).toHaveLength(2);
    state.deletedTasks.push("source");
    delete state.tasks.source;
    backfillProjects(state);
    expect(projectSnapshots(state, "stable-project")).toHaveLength(1);
    applyCommand(state, create, "copy", "copy", now, true);
    expect(state.tasks.copy!.source?.kind).toBe("local");
  });
  it("backfills older checkpoints idempotently, preserving the most recent saved time", () => {
    const state = fixture();
    state.tasks.source!.checkpoint = {
      id: "checkpoint",
      taskId: "source",
      attemptId: "attempt",
      sequence: 1,
      objectKey: "owned/key",
      sha256: "c".repeat(64),
      sizeBytes: 10,
      createdAt: iso(now + 10),
    };
    backfillProjects(state);
    backfillProjects(state);
    expect(projectSnapshots(state, "stable-project")).toHaveLength(2);
    expect(referencesTaskArtifacts(state, "source")).toBe(true);
    recordProjectSnapshot(state, state.tasks.source!, {
      id: "old",
      workspace: null,
      checkpoint: state.tasks.source!.checkpoint,
      sourceKind: "local",
      baseBranch: "main",
      baseSha: null,
      roots: [],
      savedAt: iso(now - 10),
    });
    expect(state.projects!["stable-project"]!.latestSnapshot?.id).toBe("checkpoint");
  });
  it("rejects snapshots absent from the account or belonging to another project", () => {
    const state = fixture();
    expect(() => projectSnapshot(initialState(), "stable-project", create.snapshotId)).toThrow(
      "unavailable",
    );
    expect(() =>
      applyCommand(state, { ...create, projectId: "another" }, "copy", "copy", now, true),
    ).toThrow("unavailable");
    expect(state.tasks.copy).toBeUndefined();
  });
});
