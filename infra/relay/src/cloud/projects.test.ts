import { describe, expect, it } from "vite-plus/test";
import { iso } from "./policy.ts";
import { applyCommand, initialState, publicOverview } from "./state.ts";
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

describe("cloud project deletion", () => {
  it("deletes only the selected project, cancels its work, and cannot be resurrected by backfill or late checkpoints", () => {
    const state = fixture();
    applyCommand(state, create, "copy", "copy", now, true);
    state.tasks.other = {
      ...structuredClone(state.tasks.source!),
      id: "other",
      projectId: "other-project",
    };
    backfillProjects(state);
    const other = structuredClone(state.tasks.other);
    const project = state.projects!["stable-project"]!;
    const command = {
      type: "project.delete" as const,
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: "delete-project",
    };
    expect(applyCommand(state, command, "delete-op", "delete-fingerprint", now, true)).toBe(
      project.id,
    );
    expect(state.deletedTasks).toEqual(expect.arrayContaining(["source", "copy"]));
    expect(state.tasks.source!.state).toBe("cancelled");
    expect(Object.values(state.operations).filter((op) => op.kind === "delete")).toHaveLength(2);
    expect(state.tasks.other).toEqual(other);
    backfillProjects(state);
    recordProjectSnapshot(state, state.tasks.source!, { ...project.latestSnapshot!, id: "late" });
    expect(state.projects![project.id]).toBeUndefined();
    expect(state.projectSnapshots![project.id]).toBeUndefined();
    expect(publicOverview(state, true, now).tasks.map((t) => t.id)).toEqual(["other"]);
    expect(() => projectSnapshots(state, project.id)).toThrow("not found");
    expect(() =>
      applyCommand(state, { ...create, idempotencyKey: "after-delete" }, "new", "new", now, true),
    ).toThrow("unavailable");
    const before = structuredClone(state);
    expect(applyCommand(state, command, "retry", "delete-fingerprint", now, true)).toBe(project.id);
    expect(state).toEqual(before);
  });
  it("rejects a stale confirmation or a project from another account without deleting work", () => {
    const state = fixture();
    const command = {
      type: "project.delete" as const,
      projectId: "stable-project",
      expectedRevision: 999,
      idempotencyKey: "delete",
    };
    const before = structuredClone(state);
    expect(() => applyCommand(state, command, "op", "fp", now, true)).toThrow("Project changed");
    expect(state).toEqual(before);
    expect(() => applyCommand(initialState(), command, "op", "fp", now, true)).toThrow("not found");
  });
  it("blocks deletion while a project conversation is moving", () => {
    const state = fixture();
    state.tasks.source!.handoff = {
      operationId: "moving",
      conversationId: "conversation",
      generation: 0,
      history: { sha256: "a".repeat(64), sizeBytes: 1, chunks: [] },
    };
    state.handoffs = {
      moving: {
        id: "moving",
        conversationId: "conversation",
        from: "local",
        to: "cloud-local",
        generation: 0,
        phase: "transferring",
        checkpoint: null,
        error: null,
      },
    };
    const project = state.projects!["stable-project"]!;
    expect(() =>
      applyCommand(
        state,
        {
          type: "project.delete",
          projectId: project.id,
          expectedRevision: project.revision,
          idempotencyKey: "delete",
        },
        "op",
        "fp",
        now,
        true,
      ),
    ).toThrow("finish moving");
    expect(state.deletedTasks).toEqual([]);
    expect(state.projects![project.id]).toBeDefined();
  });
  it("deletes legacy tasks by identity even before a handoff has populated projectId", () => {
    const state = fixture();
    const source = state.tasks.source!;
    delete source.projectId;
    state.projects!.source = { ...state.projects!["stable-project"]!, id: "source" };
    source.handoff = {
      operationId: "old",
      conversationId: "conversation",
      generation: 0,
      history: { sha256: "a".repeat(64), sizeBytes: 1, chunks: [] },
    };
    applyCommand(
      state,
      {
        type: "project.delete",
        projectId: "source",
        expectedRevision: state.projects!.source.revision,
        idempotencyKey: "delete",
      },
      "op",
      "fp",
      now,
      true,
    );
    expect(state.deletedTasks).toContain("source");
  });
  it("retains an archive pinned by an independent conversation after registry references are removed", () => {
    const state = fixture();
    applyCommand(state, create, "copy", "copy", now, true);
    state.tasks.copy!.projectSnapshot = {
      ...state.tasks.copy!.projectSnapshot!,
      checkpoint: {
        id: "saved",
        taskId: "source",
        attemptId: "source-1",
        sequence: 1,
        objectKey: "archive",
        sizeBytes: 100,
        sha256: "a".repeat(64),
        createdAt: iso(now),
      },
    };
    delete state.projectSnapshots;
    expect(referencesTaskArtifacts(state, "source")).toBe(true);
    state.deletedTasks.push("copy");
    expect(referencesTaskArtifacts(state, "source")).toBe(false);
  });
});
