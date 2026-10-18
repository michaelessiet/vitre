import type {
  CloudProject,
  CloudProjectSnapshot,
  CloudTask,
  CloudWorkspaceManifest,
} from "@t3tools/contracts/cloud";
import type { CloudState } from "./state.ts";
import { CloudError } from "./policy.ts";

// Legacy checkpoints use this deterministic empty commit for non-Git workspaces.
const NON_GIT_BASELINE = "8742d9f52a52b29e1195b85b4cb31ed599afb990";

export function validateProjectSnapshotWorkspace(
  snapshot: CloudProjectSnapshot,
  manifest: CloudWorkspaceManifest,
): void {
  if (
    !manifest.roots[0]?.git &&
    ((snapshot.baseSha !== null && snapshot.baseSha !== NON_GIT_BASELINE) ||
      (snapshot.checkpoint && snapshot.baseSha === null))
  )
    throw new CloudError(
      "snapshot_unavailable",
      "This saved snapshot omitted Git metadata. Choose another saved snapshot for this project.",
      409,
    );
}

export function projectIdentity(task: CloudTask): string {
  return (
    task.projectId ??
    (task.source?.kind === "local" || task.repository.installationId === "local"
      ? task.id
      : `github-${task.repository.id}`)
  );
}

export function registerProject(state: CloudState, task: CloudTask): CloudProject {
  const id = projectIdentity(task);
  const projects = (state.projects ??= {});
  return (projects[id] ??= {
    id,
    title: task.source?.kind === "local" ? task.source.name : task.repository.name,
    repository:
      task.source?.kind === "local" || task.repository.installationId === "local"
        ? null
        : structuredClone(task.repository),
    revision: 0,
    latestSnapshot: null,
  });
}

export function recordProjectSnapshot(
  state: CloudState,
  task: CloudTask,
  input: Omit<CloudProjectSnapshot, "projectId" | "revision" | "sourceTaskId" | "sourceTitle">,
): CloudProjectSnapshot {
  const project = registerProject(state, task);
  const snapshots = ((state.projectSnapshots ??= {})[project.id] ??= {});
  const existing = snapshots[input.id];
  if (existing) return existing;
  const snapshot: CloudProjectSnapshot = {
    ...input,
    projectId: project.id,
    revision: project.revision + 1,
    sourceTaskId: task.id,
    sourceTitle: task.title ?? task.prompt.slice(0, 120),
  };
  snapshots[snapshot.id] = snapshot;
  state.projects![project.id] = {
    ...project,
    revision: snapshot.revision,
    latestSnapshot:
      !project.latestSnapshot || snapshot.savedAt >= project.latestSnapshot.savedAt
        ? snapshot
        : project.latestSnapshot,
  };
  return snapshot;
}

/** Idempotent migration of retained tasks; names never determine project identity. */
export function backfillProjects(state: CloudState): void {
  const tasks = Object.values(state.tasks).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const task of tasks) {
    if (state.deletedTasks.includes(task.id)) continue;
    if (task.handoff) {
      const binding = state.bindings?.[task.handoff.conversationId];
      if (!binding || binding.generation <= task.handoff.generation) continue;
    }
    const project = registerProject(state, task);
    task.projectId ??= project.id;
    if (
      task.source &&
      !task.projectSnapshot &&
      (task.handoff || task.checkpoint || task.result || task.worker?.state === "ready")
    ) {
      recordProjectSnapshot(state, task, {
        id: task.source.snapshot.sha256,
        savedAt: task.createdAt,
        sourceKind: task.source.kind,
        workspace: task.source.snapshot,
        checkpoint: null,
        baseBranch: task.baseBranch,
        branch: task.baseBranch,
        baseSha: task.baseSha,
        roots: [],
      });
    }
    if (task.checkpoint) {
      recordProjectSnapshot(state, task, {
        id: task.checkpoint.id,
        savedAt: task.checkpoint.createdAt,
        sourceKind: task.source?.kind ?? task.projectSnapshot?.sourceKind ?? "github",
        workspace: null,
        checkpoint: structuredClone(task.checkpoint),
        baseBranch: task.baseBranch,
        branch: task.branch,
        baseSha: task.baseSha,
        roots: [],
      });
    }
  }
}

export function projectSnapshot(state: CloudState, projectId: string, snapshotId: string) {
  const project = state.projects?.[projectId];
  const snapshot = state.projectSnapshots?.[projectId]?.[snapshotId];
  if (!project || !snapshot || snapshot.projectId !== projectId)
    throw new CloudError(
      "snapshot_unavailable",
      "This project's saved workspace is unavailable. Refresh and choose another snapshot.",
      404,
    );
  return { project, snapshot };
}

export function projectSnapshots(state: CloudState, projectId: string): CloudProjectSnapshot[] {
  if (!state.projects?.[projectId])
    throw new CloudError("not_found", "Cloud project not found", 404);
  return Object.values(state.projectSnapshots?.[projectId] ?? {}).sort(
    (a, b) => b.savedAt.localeCompare(a.savedAt) || b.revision - a.revision,
  );
}

export function referencesTaskArtifacts(state: CloudState, taskId: string): boolean {
  return Object.values(state.projectSnapshots ?? {}).some((snapshots) =>
    Object.values(snapshots).some((snapshot) => snapshot.checkpoint?.taskId === taskId),
  );
}

export function workspaceRoots(manifest: CloudWorkspaceManifest) {
  return manifest.roots.map(({ id, name }) => ({ id, name }));
}
