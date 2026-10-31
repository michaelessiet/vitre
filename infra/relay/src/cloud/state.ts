// @effect-diagnostics globalDate:off - Pure UTC billing calculations with an explicit injected clock.
import type {
  CloudCommand,
  CloudOverview,
  CloudProvider,
  CloudProviderAccount,
  CloudPublication,
  CloudRepository,
  CloudTask,
  CloudWorkerCallback,
  CloudProject,
  CloudProjectSnapshot,
  CloudGitHubAccount,
} from "@t3tools/contracts/cloud";
import { backfillProjects, projectSnapshot, projectIdentity } from "./projects.ts";
import { requestHandoff, advanceHandoff, stopHandoff, type HandoffState } from "./handoff.ts";
import { CLOUD_POLICY, CloudError, iso, month, runReservation } from "./policy.ts";
import { accrueJobs, activeJobs, type CloudJob, type PublicationInput } from "./jobs.ts";

export interface CloudOperation {
  id: string;
  taskId: string;
  attemptId: string | null;
  kind: "provision" | "stop" | "pause" | "resume" | "delete" | "publish";
  publicationId?: string;
  createdAt: string;
  claimUntil: string | null;
  claimToken: string | null;
  failures: number;
}

/** One small, revision-guarded aggregate per personal account. No external I/O in reducers. */
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
export type MutableCloudTask = Mutable<CloudTask>;

export interface CloudState {
  githubAccounts?: Record<string, CloudGitHubAccount>;
  projects?: Record<string, CloudProject>;
  deletedProjects?: string[];
  projectSnapshots?: Record<string, Record<string, CloudProjectSnapshot>>;
  /** Supplied from the SQL account row on load/CAS; never an independent counter. */
  revision?: number;
  providerLeaseTurns?: Partial<Record<CloudProvider, string | null>>;
  bindings?: HandoffState["bindings"];
  handoffs?: HandoffState["handoffs"];
  events?: Record<
    string,
    {
      cursor: number;
      attemptId: string;
      sequence: number;
      phase: string;
      detail: string;
      createdAt: string;
    }[]
  >;
  projections?: Record<string, { key: string; sha256: string }>;
  jobs?: Record<string, CloudJob>;
  publicationInputs?: Record<string, PublicationInput>;
  publicationAttempts?: Record<string, boolean>;
  version: 1;
  repositories: Record<string, CloudRepository>;
  tasks: Record<string, MutableCloudTask>;
  accounts: Record<CloudProvider, Mutable<CloudProviderAccount>>;
  publications: Record<string, Mutable<CloudPublication>>;
  operations: Record<string, CloudOperation>;
  receipts: Record<string, { fingerprint: string; entityId: string }>;
  usage: Record<string, number>;
  monthlyLimit: number;
  deletedTasks: string[];
}

export function initialState(): CloudState {
  const account = (provider: CloudProvider): CloudProviderAccount => ({
    provider,
    state: "disconnected",
    credentialVersion: 0,
    leasedBy: null,
  });
  return {
    version: 1,
    repositories: {},
    tasks: {},
    publications: {},
    operations: {},
    receipts: {},
    usage: {},
    accounts: { codex: account("codex"), claude: account("claude") },
    monthlyLimit: CLOUD_POLICY.monthlyComputeMicroDollars,
    deletedTasks: [],
  };
}

export function taskFor(state: CloudState, id: string): MutableCloudTask {
  const task = state.tasks[id];
  if (!task || state.deletedTasks.includes(id))
    throw new CloudError("not_found", "Task not found", 404);
  return task;
}

/** Dedicated-machine workers retain their backend while provider sessions come and go. */
export function isResidentWorker(task: CloudTask): boolean {
  return task.worker?.sandboxId?.startsWith("machine-") === true;
}

function canValidateHandoff(state: CloudState, task: CloudTask): boolean {
  const operation = task.handoff ? state.handoffs?.[task.handoff.operationId] : undefined;
  return (
    task.state === "preparing" &&
    isPreparingHandoff(state, task) &&
    !!operation?.checkpoint &&
    ["transferring", "verifying"].includes(operation.phase)
  );
}

function needsProviderLease(state: CloudState, task: CloudTask): boolean {
  return (
    task.state === "queued" ||
    (isResidentWorker(task) &&
      ((task.state === "running" && task.idle === false) ||
        (task.state === "preparing" && (!task.handoff || canValidateHandoff(state, task)))))
  );
}

function nextProviderTask(
  state: CloudState,
  provider: CloudProvider,
): MutableCloudTask | undefined {
  return Object.values(state.tasks)
    .filter((candidate) => candidate.provider === provider && needsProviderLease(state, candidate))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))[0];
}

export function changeProviderLease(
  state: CloudState,
  taskId: string,
  attemptId: string,
  action: "acquire" | "release",
  turnRequestId?: string,
): boolean {
  const task = taskFor(state, taskId);
  if (
    task.attempt?.id !== attemptId ||
    !isResidentWorker(task) ||
    !task.worker ||
    ["stopped", "deleted"].includes(task.worker.state)
  )
    throw new CloudError("stale_worker", "Worker attempt is no longer current");
  const account = state.accounts[task.provider];
  if (action === "release") {
    // The caller has stopped its provider process and persisted rotated tokens.
    // A newer user request may already exist; leave it pending for reacquisition.
    const leasedTurn = state.providerLeaseTurns?.[task.provider];
    if (account.leasedBy === attemptId) {
      if (leasedTurn !== undefined && leasedTurn !== (turnRequestId ?? null)) return false;
      account.leasedBy = null;
      if (state.providerLeaseTurns) delete state.providerLeaseTurns[task.provider];
    }
    if (task.turnRequestId === turnRequestId && task.state === "running") task.idle = true;
    return false;
  }
  const binding = task.handoff ? state.bindings?.[task.handoff.conversationId] : undefined;
  const activatedHandoff =
    !task.handoff ||
    (binding?.cloudTaskId === task.id &&
      binding.target !== "local" &&
      binding.generation === task.handoff.generation + 1);
  if (
    !["preparing", "running", "waiting_for_input"].includes(task.state) ||
    task.turnRequestId !== turnRequestId ||
    (!activatedHandoff && !canValidateHandoff(state, task))
  )
    throw new CloudError("stale_worker", "Turn is no longer current or runnable");
  if (account.state !== "connected")
    throw new CloudError("needs_auth", "Connect the provider account before starting", 401);
  const retained = account.leasedBy === attemptId;
  if (account.leasedBy && !retained) return false;
  // Retrying an already admitted turn is idempotent. A retained session's next
  // turn must join the same FIFO queue as every other conversation.
  if (retained && state.providerLeaseTurns?.[task.provider] === (turnRequestId ?? null))
    return true;
  const firstWaiting = nextProviderTask(state, task.provider);
  if (firstWaiting && firstWaiting.id !== task.id) return false;
  account.leasedBy = attemptId;
  (state.providerLeaseTurns ??= {})[task.provider] = turnRequestId ?? null;
  return true;
}

function enqueue(
  state: CloudState,
  task: CloudTask,
  kind: CloudOperation["kind"],
  now: number,
  publicationId?: string,
): void {
  const id = `${task.id}:${task.attempt?.id ?? "none"}:${kind}:${publicationId ?? ""}`;
  state.operations[id] ??= {
    id,
    taskId: task.id,
    attemptId: task.attempt?.id ?? null,
    kind,
    ...(publicationId ? { publicationId } : {}),
    createdAt: iso(now),
    claimUntil: null,
    claimToken: null,
    failures: 0,
  };
}

export function publicOverview(state: CloudState, enabled: boolean, now: number): CloudOverview {
  const reserved =
    activeJobs(state).reduce((n, job) => n + job.reservedMicroDollars, 0) +
    Object.values(state.tasks).reduce((n, t) => n + (t.attempt?.reservedMicroDollars ?? 0), 0);
  const spent = state.usage[month(now)] ?? 0;
  return {
    projects: Object.values(state.projects ?? {}),
    githubAccounts: Object.values(state.githubAccounts ?? {}),
    capabilities: {
      projectDeletion: true,
      projectCreation: true,
      followUpSettings: true,
      publicationPreparation: true,
      mobileNotifications: true,
    },
    ...(state.revision !== undefined ? { revision: state.revision } : {}),
    bindings: Object.values(state.bindings ?? {}),
    handoffs: Object.values(state.handoffs ?? {}),
    enabled,
    repositories: Object.values(state.repositories),
    tasks: Object.values(state.tasks)
      .filter((t) => !state.deletedTasks.includes(t.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    accounts: Object.values(state.accounts),
    publications: Object.values(state.publications).filter(
      (publication) => !state.deletedTasks.includes(publication.taskId),
    ),
    usage: {
      month: month(now),
      spentMicroDollars: spent,
      reservedMicroDollars: reserved,
      limitMicroDollars: state.monthlyLimit,
      warning: spent + reserved >= state.monthlyLimit * 0.8,
    },
  };
}

export function applyCommand(
  state: CloudState,
  command: CloudCommand,
  id: string,
  fingerprint: string,
  now: number,
  enabled: boolean,
): string {
  const receipt = state.receipts[command.idempotencyKey];
  if (receipt) {
    if (receipt.fingerprint !== fingerprint)
      throw new CloudError("idempotency_conflict", "Idempotency key was used for another request");
    return receipt.entityId;
  }
  if (
    !enabled &&
    ![
      "github.refresh",
      "task.cancel",
      "task.delete",
      "project.delete",
      "provider.disconnect",
    ].includes(command.type)
  ) {
    throw new CloudError("disabled", "Cloud execution is disabled", 503);
  }
  let entityId = id;
  backfillProjects(state);
  switch (command.type) {
    case "github.refresh":
      break;
    case "project.delete": {
      const project = state.projects?.[command.projectId];
      if (!project) throw new CloudError("not_found", "Cloud project not found", 404);
      if (project.revision !== command.expectedRevision)
        throw new CloudError(
          "revision_conflict",
          "Project changed. Refresh and review before deleting.",
          409,
        );
      const tasks = Object.values(state.tasks).filter(
        (task) => projectIdentity(task) === project.id && !state.deletedTasks.includes(task.id),
      );
      if (
        tasks.some((task) =>
          Object.values(state.handoffs ?? {}).some(
            (operation) =>
              !["completed", "cancelled", "failed"].includes(operation.phase) &&
              (operation.conversationId === task.handoff?.conversationId ||
                state.bindings?.[operation.conversationId]?.cloudTaskId === task.id),
          ),
        )
      )
        throw new CloudError(
          "switch_pending",
          "Wait for conversations to finish moving before deleting this project.",
          409,
        );
      for (const task of tasks) {
        applyCommand(
          state,
          { type: "task.delete", taskId: task.id, idempotencyKey: `${id}-${task.id}` },
          id,
          fingerprint,
          now,
          enabled,
        );
      }
      (state.deletedProjects ??= []).push(project.id);
      delete state.projects![project.id];
      delete state.projectSnapshots?.[project.id];
      entityId = project.id;
      break;
    }
    case "task.createFromProject": {
      const { project, snapshot } = projectSnapshot(state, command.projectId, command.snapshotId);
      const repositoryId = project.repository?.id ?? project.id;
      const source = snapshot.workspace
        ? snapshot.sourceKind === "github" && snapshot.baseSha
          ? { kind: "github" as const, revision: snapshot.baseSha, snapshot: snapshot.workspace }
          : { kind: "local" as const, name: project.title, snapshot: snapshot.workspace }
        : undefined;
      // Reuse the normal creation policy, receipt, scheduler and provider leases.
      // A checkpoint seed is restored by the new worker without importing history.
      if (!state.repositories[repositoryId] && project.repository)
        state.repositories[repositoryId] = structuredClone(project.repository);
      if (!source && !project.repository)
        state.repositories[repositoryId] = {
          id: repositoryId,
          installationId: "local",
          owner: "local",
          name: project.title,
          defaultBranch: snapshot.baseBranch,
          setupCommand: "",
          testCommand: "",
          revision: 0,
        };
      entityId = applyCommand(
        state,
        {
          ...command,
          type: "task.create",
          repositoryId,
          baseBranch: snapshot.baseBranch,
          kind: "build",
          issueNumber: null,
          ...(source ? { source } : {}),
        },
        id,
        fingerprint,
        now,
        enabled,
      );
      const task = state.tasks[entityId]!;
      task.projectSnapshot = { ...snapshot, roots: snapshot.roots.map((root) => ({ ...root })) };
      task.baseSha = snapshot.baseSha;
      break;
    }
    case "publication.retry": {
      const publication = state.publications[command.publicationId];
      if (!publication || publication.state !== "failed")
        throw new CloudError("not_found", "Failed publication not found", 404);
      taskFor(state, publication.taskId);
      const job = state.jobs?.[`publish-${publication.id}`];
      if (job && !job.deleted)
        throw new CloudError("worker_busy", "Wait for publication worker cleanup");
      if (state.jobs) delete state.jobs[`publish-${publication.id}`];
      publication.state = "queued";
      entityId = publication.id;
      break;
    }
    case "repository.save": {
      const existing = state.repositories[command.repository.id];
      if (existing && existing.revision !== command.repository.revision)
        throw new CloudError(
          "revision_conflict",
          "Repository settings changed; reload before saving",
        );
      state.repositories[command.repository.id] = {
        ...command.repository,
        revision: (existing?.revision ?? 0) + 1,
      };
      entityId = command.repository.id;
      break;
    }
    case "handoff.request": {
      const bindings = (state.bindings ??= {});
      const handoffs = (state.handoffs ??= {});
      const sourceId = bindings[command.conversationId]?.cloudTaskId ?? command.cloudTaskId;
      if (sourceId && state.tasks[sourceId]?.publicationPreparation)
        throw new CloudError(
          "publication_preparing",
          "Wait for the workspace to finish saving for review",
        );
      if (!bindings[command.conversationId]) {
        if (command.expectedGeneration !== 0)
          throw new CloudError("stale_owner", "Unknown conversation generation");
        const task = command.cloudTaskId ? taskFor(state, command.cloudTaskId) : null;
        bindings[command.conversationId] = {
          conversationId: command.conversationId,
          localThreadId: command.localThreadId,
          cloudTaskId: command.cloudTaskId,
          target: task ? (task.source?.kind === "local" ? "cloud-local" : "cloud-github") : "local",
          generation: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
        };
      }
      entityId = requestHandoff(
        { bindings, handoffs },
        {
          id: command.idempotencyKey,
          conversationId: command.conversationId,
          target: command.target,
          expectedGeneration: command.expectedGeneration,
          now,
        },
      ).id;
      break;
    }
    case "handoff.advance": {
      const bindings = (state.bindings ??= {});
      const handoffs = (state.handoffs ??= {});
      if (command.cloudTaskId) {
        const destination = taskFor(state, command.cloudTaskId);
        if (
          command.nextPhase === "activating" &&
          (!destination.attempt || destination.worker?.state !== "ready" || !destination.idle)
        )
          throw new CloudError("destination_not_ready", "Destination workspace is not ready");
        if (command.nextPhase === "activating" && !isResidentWorker(destination))
          throw new CloudError(
            "destination_not_ready",
            "Destination must use the assigned machine",
          );
      }
      entityId = advanceHandoff(
        { bindings, handoffs },
        {
          id: command.operationId,
          expectedPhase: command.expectedPhase,
          nextPhase: command.nextPhase,
          checkpoint: command.checkpoint,
          now,
          ...(command.destinationOwner ? { destinationOwner: command.destinationOwner } : {}),
          ...(command.cloudTaskId ? { cloudTaskId: command.cloudTaskId } : {}),
          ...(command.roots ? { roots: command.roots } : {}),
        },
      ).id;

      break;
    }
    case "handoff.cancel": {
      entityId = stopHandoff(
        { bindings: (state.bindings ??= {}), handoffs: (state.handoffs ??= {}) },
        command.operationId,
        undefined,
        now,
      ).id;
      break;
    }
    case "task.create": {
      if (command.handoff) {
        const operation = state.handoffs?.[command.handoff.operationId];
        if (
          !operation ||
          operation.conversationId !== command.handoff.conversationId ||
          operation.generation !== command.handoff.generation ||
          !["checkpointing", "transferring"].includes(operation.phase) ||
          operation.to !== (command.source?.kind === "local" ? "cloud-local" : "cloud-github")
        )
          throw new CloudError("stale_switch", "The destination does not match the pending switch");
      }
      if (Object.keys(state.tasks).length >= 1000)
        throw new CloudError("task_limit", "Task retention limit reached");
      const repository =
        command.source?.kind === "local"
          ? {
              id: command.repositoryId,
              installationId: "local",
              owner: "local",
              name: command.source.name,
              defaultBranch: command.baseBranch,
              setupCommand: "",
              testCommand: "",
              revision: 0,
            }
          : state.repositories[command.repositoryId];
      if (!repository) throw new CloudError("not_found", "Repository not configured", 404);
      if (command.kind === "investigate" && command.issueNumber === null)
        throw new CloudError("issue_required", "Choose an issue to investigate", 400);
      const projectId =
        command.projectId ?? (command.source?.kind === "local" ? id : `github-${repository.id}`);
      // An explicit new conversation/hoist can start a fresh registry after deletion.
      // Deleted tasks remain tombstoned and cannot repopulate its old snapshots.
      if (state.deletedProjects?.includes(projectId))
        state.deletedProjects = state.deletedProjects.filter((deleted) => deleted !== projectId);
      state.tasks[id] = {
        id,
        ...(command.projectId ? { projectId: command.projectId } : {}),
        ...(command.handoff
          ? {
              handoff: {
                ...command.handoff,
                history: {
                  ...command.handoff.history,
                  chunks: [...command.handoff.history.chunks],
                },
              },
            }
          : {}),
        ...(command.keepAliveSeconds !== undefined
          ? { keepAliveSeconds: command.keepAliveSeconds }
          : {}),
        repository: structuredClone(repository),
        ...(command.source ? { source: command.source } : {}),
        ...(command.attachments
          ? {
              attachments: command.attachments.map((attachment) => ({
                ...attachment,
                chunks: [...attachment.chunks],
              })),
            }
          : {}),
        ...(command.model ? { model: command.model } : {}),
        ...(command.modelOptions
          ? { modelOptions: command.modelOptions.map((option) => ({ ...option })) }
          : {}),
        ...(command.interactionMode ? { interactionMode: command.interactionMode } : {}),
        runtimeMode: command.runtimeMode ?? "full-access",
        baseBranch: command.baseBranch,
        baseSha: null,
        provider: command.provider,
        kind: command.kind,
        prompt: command.prompt,
        issueNumber: command.issueNumber,
        state: "queued",
        branch: `vitre/${id}`,
        createdAt: iso(now),
        updatedAt: iso(now),
        attempt: null,
        worker: null,
        checkpoint: null,
        result: null,
        error: null,
      };
      break;
    }
    case "task.cancel": {
      const task = taskFor(state, command.taskId);
      entityId = task.id;
      // A delayed Stop acknowledges the captured request only. Consume its
      // idempotency key even when stale so replay cannot later cancel work.
      if (
        command.expectedTurnRequestId !== undefined &&
        command.expectedTurnRequestId !== (task.turnRequestId ?? null)
      )
        break;
      task.state = "cancelled";
      delete task.publicationPreparation;
      task.updatedAt = iso(now);
      if (task.worker && task.worker.state !== "deleted") enqueue(state, task, "stop", now);
      // Keep the provider lease until shutdown is confirmed, even during provisioning.
      break;
    }
    case "task.update": {
      const task = taskFor(state, command.taskId);
      if (command.title !== undefined) task.title = command.title;
      if (command.archived !== undefined) task.archivedAt = command.archived ? iso(now) : null;
      task.updatedAt = iso(now);
      entityId = task.id;
      break;
    }
    case "task.wake": {
      const task = taskFor(state, command.taskId);
      entityId = task.id;
      if (["queued", "preparing", "running", "waiting_for_input"].includes(task.state)) break;
      if (task.worker && !["stopped", "deleted"].includes(task.worker.state))
        throw new CloudError("worker_busy", "The previous environment is still saving");
      if (!task.checkpoint)
        throw new CloudError("checkpoint_required", "No saved workspace is available");
      const binding = Object.values(state.bindings ?? {}).find(
        (entry) => entry.cloudTaskId === task.id || entry.aliases?.includes(task.id),
      );
      if (binding && (binding.target === "local" || binding.cloudTaskId !== task.id))
        throw new CloudError("stale_owner", "Conversation moved to another environment");
      task.wakeOnly = true;
      task.keepAliveSeconds = 900;
      task.state = "queued";
      task.error = null;
      task.updatedAt = iso(now);
      break;
    }
    case "task.continue": {
      const task = taskFor(state, command.taskId);
      if (task.publicationPreparation)
        throw new CloudError(
          "publication_preparing",
          "Wait for the workspace to finish saving for review",
        );
      const binding = Object.values(state.bindings ?? {}).find(
        (entry) =>
          entry.cloudTaskId === task.id ||
          entry.aliases?.includes(task.id) ||
          entry.conversationId === task.handoff?.conversationId,
      );
      if (binding && (binding.target === "local" || binding.cloudTaskId !== task.id))
        throw new CloudError("stale_owner", "This environment no longer owns the conversation");
      if (task.handoff && (!binding || binding.generation <= task.handoff.generation))
        throw new CloudError("switch_pending", "The destination has not been activated");
      if (
        binding &&
        Object.values(state.handoffs ?? {}).some(
          (operation) =>
            operation.conversationId === binding.conversationId &&
            ["checkpointing", "transferring", "verifying", "activating"].includes(operation.phase),
        )
      )
        throw new CloudError("switch_pending", "Wait for the conversation to finish moving");
      entityId = task.id;
      const liveIdle =
        task.state === "running" && task.idle === true && task.worker?.state === "ready";
      if (!liveIdle && task.worker && !["stopped", "deleted"].includes(task.worker.state))
        throw new CloudError("worker_busy", "Wait for the previous worker to stop");
      if (
        !liveIdle &&
        ![
          "completed",
          "failed",
          "cancelled",
          "interrupted",
          "needs_auth",
          "usage_limited",
        ].includes(task.state)
      )
        throw new CloudError("task_busy", "Task cannot be continued in this state");
      task.prompt = command.prompt;
      task.turnSettings = {
        ...(command.model !== undefined ? { model: command.model } : {}),
        ...(command.modelOptions !== undefined
          ? { modelOptions: command.modelOptions.map((option) => ({ ...option })) }
          : {}),
        ...(command.runtimeMode !== undefined ? { runtimeMode: command.runtimeMode } : {}),
        ...(command.interactionMode !== undefined
          ? { interactionMode: command.interactionMode }
          : {}),
      };
      if (command.model !== undefined) task.model = command.model;
      if (command.modelOptions !== undefined)
        task.modelOptions = command.modelOptions.map((option) => ({ ...option }));
      if (command.runtimeMode !== undefined) task.runtimeMode = command.runtimeMode;
      if (command.interactionMode !== undefined) task.interactionMode = command.interactionMode;
      task.attachments = command.attachments
        ? command.attachments.map((attachment) => ({
            ...attachment,
            chunks: [...attachment.chunks],
          }))
        : [];
      task.state = liveIdle ? "running" : "queued";
      task.wakeOnly = false;
      task.idle = false;
      task.turnRequestId = command.idempotencyKey;
      task.error = null;
      task.result = null;
      task.updatedAt = iso(now);
      break;
    }
    case "task.resume": {
      const task = taskFor(state, command.taskId);
      entityId = task.id;
      if (task.state !== "waiting_for_input" || task.worker?.state !== "ready")
        throw new CloudError("not_waiting", "Worker is not waiting for input");
      // The persistent worker stays ready while input is pending.
      break;
    }
    case "task.delete": {
      const task = taskFor(state, command.taskId);
      entityId = task.id;
      task.state = "cancelled";
      delete task.publicationPreparation;
      task.updatedAt = iso(now);
      state.deletedTasks.push(task.id);
      for (const publication of Object.values(state.publications)) {
        if (
          publication.taskId === task.id &&
          ["queued", "publishing"].includes(publication.state)
        ) {
          publication.state = "failed";
          const job = state.jobs?.[`publish-${publication.id}`];
          if (job) job.state = "failed";
        }
      }
      enqueue(state, task, "delete", now);
      break;
    }
    case "provider.disconnect": {
      const account = state.accounts[command.provider];
      entityId = command.provider;
      account.state = "disconnected";
      account.credentialVersion++;
      for (const task of Object.values(state.tasks)) {
        if (task.provider !== command.provider) continue;
        if (task.state === "queued") task.state = "needs_auth";
        if (task.worker && !["deleted", "stopped"].includes(task.worker.state)) {
          task.state = "cancelled";
          delete task.publicationPreparation;
          enqueue(state, task, "stop", now);
        }
      }
      break;
    }
    case "publication.prepare": {
      const task = taskFor(state, command.taskId);
      entityId = task.id;
      if (task.source?.kind === "local" || task.repository.installationId === "local")
        throw new CloudError("no_repository", "This workspace is not connected to GitHub");
      if (task.repository.installationId === "public")
        throw new CloudError(
          "github_connection_required",
          "Connect this repository to your personal GitHub account in Vitre before creating a pull request",
        );
      if ((task.turnRequestId ?? null) !== command.expectedTurnRequestId)
        throw new CloudError(
          "turn_replaced",
          "The conversation changed. Review the latest turn before preparing a pull request",
        );
      const binding = Object.values(state.bindings ?? {}).find(
        (entry) => entry.cloudTaskId === task.id || entry.aliases?.includes(task.id),
      );
      if (binding && (binding.target === "local" || binding.cloudTaskId !== task.id))
        throw new CloudError("stale_owner", "This environment no longer owns the conversation");
      if (
        binding &&
        Object.values(state.handoffs ?? {}).some(
          (operation) =>
            operation.conversationId === binding.conversationId &&
            !["completed", "cancelled", "failed"].includes(operation.phase),
        )
      )
        throw new CloudError("switch_pending", "Wait for the conversation to finish moving");
      if (task.state === "completed" && task.result) break;
      if (task.publicationPreparation) break;
      if (task.state !== "running" || task.idle !== true || task.worker?.state !== "ready")
        throw new CloudError(
          "task_busy",
          "Wait for the current work to finish before preparing a pull request",
        );
      task.publicationPreparation = {
        id: command.idempotencyKey,
        turnRequestId: command.expectedTurnRequestId,
        requestedAt: iso(now),
      };
      task.result = null;
      task.updatedAt = iso(now);
      break;
    }
    case "publication.create": {
      if (taskFor(state, command.taskId).source?.kind === "local")
        throw new CloudError("no_repository", "This workspace is not connected to GitHub");
      const task = taskFor(state, command.taskId);
      if (
        task.state !== "completed" ||
        !task.result ||
        task.result.id !== command.resultId ||
        task.result.sha256 !== command.resultSha256
      )
        throw new CloudError(
          "result_changed",
          "Review the latest completed result before publishing",
        );
      if (command.kind === "issue_comment" && task.issueNumber === null)
        throw new CloudError("issue_required", "Task has no issue", 400);
      const existing = Object.values(state.publications).find(
        (p) => p.taskId === task.id && p.resultId === command.resultId && p.kind === command.kind,
      );
      if (existing) {
        if (existing.title !== command.title || existing.body !== command.body)
          throw new CloudError(
            "publication_conflict",
            "This result already has a different approved publication",
          );
        entityId = existing.id;
        break;
      }
      state.publications[id] = {
        id,
        taskId: task.id,
        resultId: command.resultId,
        resultSha256: command.resultSha256,
        kind: command.kind,
        title: command.title,
        body: command.body,
        state: "queued",
        url: null,
      };
      (state.publicationInputs ??= {})[id] = structuredClone(task);
      enqueue(state, task, "publish", now, id);
      break;
    }
    case "limits.update":
      state.monthlyLimit = command.monthlyComputeMicroDollars;
      entityId = "limits";
      break;
  }
  state.receipts[command.idempotencyKey] = { fingerprint, entityId };
  return entityId;
}

/** Charge actual allocated wall time, including transitions, split at UTC month boundaries. */
export function accrue(state: CloudState, task: MutableCloudTask, now: number): void {
  const attempt = task.attempt;
  if (attempt && isResidentWorker(task)) {
    // Dedicated machine billing is independent of its number of warm conversations.
    attempt.billedThrough = iso(now);
    attempt.reservedMicroDollars = 0;
    return;
  }
  if (!attempt || !task.worker || ["stopped", "deleted", "paused"].includes(task.worker.state))
    return;
  let from = Date.parse(attempt.billedThrough);
  const end = Math.max(from, now);
  while (from < end) {
    const d = new Date(from);
    const until = Math.min(end, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const charge = Math.ceil((until - from) / 1000) * CLOUD_POLICY.computeMicroDollarsPerSecond;
    const key = month(from);
    state.usage[key] = (state.usage[key] ?? 0) + charge;
    attempt.reservedMicroDollars = Math.max(0, attempt.reservedMicroDollars - charge);
    from = until;
  }
  attempt.billedThrough = iso(end);
}

export function isPreparingHandoff(state: CloudState, task: CloudTask): boolean {
  if (!task.handoff) return false;
  const binding = state.bindings?.[task.handoff.conversationId];
  const operation = state.handoffs?.[task.handoff.operationId];
  return (
    !!operation &&
    ["checkpointing", "transferring", "verifying"].includes(operation.phase) &&
    binding?.generation === task.handoff.generation &&
    binding.cloudTaskId !== task.id
  );
}

/** Ask a warm, idle worker to checkpoint before releasing its provider lease. */
export function shouldYieldIdleWorker(state: CloudState, task: CloudTask): boolean {
  if (isResidentWorker(task)) {
    // This is a cooperative hint: resident workers honor it only after their
    // active turn has settled. Include pending warm turns and handoff validation
    // so retaining an idle provider process cannot starve either path.
    return (
      task.state === "running" &&
      state.accounts[task.provider].leasedBy === task.attempt?.id &&
      Object.values(state.tasks).some(
        (waiting) =>
          waiting.id !== task.id &&
          waiting.provider === task.provider &&
          needsProviderLease(state, waiting),
      )
    );
  }
  return (
    task.state === "running" &&
    task.idle === true &&
    !Object.values(state.handoffs ?? {}).some(
      (operation) =>
        !["completed", "cancelled"].includes(operation.phase) &&
        state.bindings?.[operation.conversationId]?.cloudTaskId === task.id,
    ) &&
    Object.values(state.tasks).some(
      (waiting) =>
        waiting.id !== task.id && waiting.state === "queued" && waiting.provider === task.provider,
    )
  );
}

export function schedule(
  state: CloudState,
  now: number,
  enabled: boolean,
  persistentMachine = false,
): void {
  accrueJobs(state, now);
  for (const task of Object.values(state.tasks)) {
    accrue(state, task, now);
    if (!task.worker || !task.attempt) continue;
    const resident = persistentMachine && (!task.worker.sandboxId || isResidentWorker(task));
    const stopped = ["stopped", "deleted"].includes(task.worker.state);
    const executing = ["preparing", "running", "waiting_for_input"].includes(task.state);
    const elapsed = now - Date.parse(task.updatedAt);
    if (
      executing &&
      !resident &&
      !stopped &&
      task.worker.state !== "paused" &&
      Date.parse(task.attempt.deadlineAt) <= now
    ) {
      task.state = "interrupted";
      task.error = "Run deadline reached";
      enqueue(state, task, "stop", now);
    } else if (
      !stopped &&
      task.worker.state !== "paused" &&
      ["running", "waiting_for_input"].includes(task.state) &&
      now - Date.parse(task.attempt.heartbeatAt) > CLOUD_POLICY.staleMs
    ) {
      task.state = "interrupted";
      task.error = "Worker heartbeat lost; review before continuing";
      enqueue(state, task, "stop", now);
    } else if (
      task.state === "preparing" &&
      now - Date.parse(task.attempt.startedAt) > CLOUD_POLICY.setupTimeoutMs
    ) {
      task.state = "failed";
      task.error = "Workspace setup timed out";
      enqueue(state, task, "stop", now);
    } else if (task.state === "waiting_for_input" && elapsed > CLOUD_POLICY.waitingTimeoutMs) {
      task.state = "interrupted";
      task.error = "Input request expired; continue to request fresh input";
      enqueue(state, task, "stop", now);
    } else if (
      !stopped &&
      ["completed", "failed", "needs_auth", "usage_limited", "cancelled", "interrupted"].includes(
        task.state,
      ) &&
      (elapsed >= CLOUD_POLICY.settledGraceMs ||
        Object.values(state.tasks).some(
          (waiting) => waiting.state === "queued" && waiting.provider === task.provider,
        ))
    ) {
      enqueue(state, task, "stop", now);
    }
    if (!resident && !stopped && (state.usage[month(now)] ?? 0) >= state.monthlyLimit) {
      if (executing) {
        task.state = "interrupted";
        task.error = "Monthly compute allowance reached";
      }
      enqueue(state, task, "stop", now);
    }
    if (
      task.worker.state === "stopped" &&
      task.worker.stoppedAt &&
      now - Date.parse(task.worker.stoppedAt) >= CLOUD_POLICY.sandboxRetentionMs &&
      task.checkpoint?.attemptId === task.attempt.id
    )
      enqueue(state, task, "delete", now);
    if (!["running", "waiting_for_input"].includes(task.state)) delete task.publicationPreparation;
  }
  if (!enabled) return;
  for (const task of Object.values(state.tasks).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )) {
    if (task.state !== "queued") continue;
    const account = state.accounts[task.provider];
    if (account.state !== "connected") {
      task.state = "needs_auth";
      continue;
    }
    if (account.leasedBy && !isPreparingHandoff(state, task)) continue;
    if (
      persistentMachine &&
      !isPreparingHandoff(state, task) &&
      nextProviderTask(state, task.provider)?.id !== task.id
    )
      continue;
    const leases =
      Object.values(state.tasks).filter(
        (t) => t.worker && !["stopped", "deleted"].includes(t.worker.state),
      ).length + activeJobs(state).length;
    if (!persistentMachine && leases >= CLOUD_POLICY.maxExecuting) break;
    const overview = publicOverview(state, enabled, now);
    if (
      !persistentMachine &&
      overview.usage.spentMicroDollars + overview.usage.reservedMicroDollars + runReservation >
        state.monthlyLimit
    ) {
      task.error = "Insufficient remaining compute allowance for a run";
      continue;
    }
    const generation = (task.attempt?.generation ?? 0) + 1;
    task.attempt = {
      id: `${task.id}-${generation}`,
      generation,
      startedAt: iso(now),
      deadlineAt: iso(now + CLOUD_POLICY.runTimeoutMs),
      heartbeatAt: iso(now),
      lastSequence: 0,
      reservedMicroDollars: persistentMachine ? 0 : runReservation,
      billedThrough: iso(now),
    };
    const previous = task.worker;
    task.worker = {
      id: task.attempt.id,
      sandboxId: null,
      environmentId: previous?.environmentId ?? `cloud-${task.id}`,
      state: "provisioning",
      cpu: CLOUD_POLICY.cpu,
      memoryGiB: CLOUD_POLICY.memoryGiB,
      diskGiB: CLOUD_POLICY.diskGiB,
      stoppedAt: null,
    };
    task.state = "preparing";
    task.updatedAt = iso(now);
    task.error = null;
    if (!isPreparingHandoff(state, task)) {
      account.leasedBy = task.attempt.id;
      (state.providerLeaseTurns ??= {})[task.provider] = task.turnRequestId ?? null;
    }
    enqueue(state, task, "provision", now);
  }
}

export function acceptCallback(
  state: CloudState,
  callback: CloudWorkerCallback,
  now: number,
): boolean {
  const task = taskFor(state, callback.taskId);
  const attempt = task.attempt;
  if (
    !attempt ||
    !task.worker ||
    ["stopped", "deleted"].includes(task.worker.state) ||
    attempt.id !== callback.attemptId ||
    attempt.generation !== callback.generation ||
    (state.accounts[task.provider].leasedBy !== attempt.id &&
      !isPreparingHandoff(state, task) &&
      !isResidentWorker(task))
  )
    throw new CloudError("stale_worker", "Worker attempt is no longer current");
  if (callback.sequence <= attempt.lastSequence) return false;
  if (callback.closeIdle && callback.turnRequestId !== task.turnRequestId)
    throw new CloudError("turn_replaced", "A new turn arrived before idle shutdown");
  if (
    callback.phase === "completed" &&
    task.publicationPreparation &&
    (callback.turnRequestId ?? null) !== task.publicationPreparation.turnRequestId
  )
    throw new CloudError("turn_replaced", "Publication checkpoint belongs to another turn");
  if (!["preparing", "running", "waiting_for_input"].includes(task.state))
    throw new CloudError("task_settled", "Task no longer accepts worker updates");
  if (
    callback.checkpoint &&
    (callback.checkpoint.taskId !== task.id || callback.checkpoint.attemptId !== attempt.id)
  )
    throw new CloudError("invalid_checkpoint", "Checkpoint belongs to a different attempt", 400);
  if (
    callback.phase === "completed" &&
    (!callback.checkpoint ||
      !callback.result ||
      callback.result.taskId !== task.id ||
      callback.result.checkpointId !== callback.checkpoint.id)
  )
    throw new CloudError(
      "checkpoint_required",
      "A verified checkpoint and result are required before completion",
    );
  for (const progress of [callback.preparation, callback.dependencySetup]) {
    if (progress && (progress.attemptId !== attempt.id || progress.sequence !== callback.sequence))
      throw new CloudError(
        "stale_progress",
        "Preparation belongs to a different worker update",
        409,
      );
  }
  accrue(state, task, now);
  attempt.lastSequence = callback.sequence;
  if (callback.preparation) task.preparation = { ...callback.preparation };
  // Dependency warnings are independent of connection/turn state. Ordinary
  // heartbeats and readiness must never erase a failed setup outcome.
  if (callback.dependencySetup) task.dependencySetup = { ...callback.dependencySetup };
  if (callback.baseSha && task.source) task.baseSha = callback.baseSha;
  const events = ((state.events ??= {})[task.id] ??= []);
  events.push({
    cursor: (events.at(-1)?.cursor ?? 0) + 1,
    attemptId: attempt.id,
    sequence: callback.sequence,
    phase: callback.phase,
    detail: callback.detail,
    createdAt: iso(now),
  });
  if (events.length > 1000) events.splice(0, events.length - 1000);
  attempt.heartbeatAt = iso(now);
  // A delayed idle heartbeat cannot consume a newer user request.
  if (callback.idle !== undefined && callback.turnRequestId === task.turnRequestId)
    task.idle = callback.idle;
  if (callback.checkpoint) task.checkpoint = callback.checkpoint;
  if (callback.phase !== "heartbeat") {
    task.state = callback.phase;
    task.updatedAt = iso(now);
    if (task.worker) task.worker.state = "ready";
    if (callback.phase === "completed") task.result = callback.result ?? null;
    if (["completed", "failed", "needs_auth", "usage_limited"].includes(callback.phase))
      delete task.publicationPreparation;
    if (callback.phase === "running" || callback.phase === "waiting_for_input") task.error = null;
    if (["failed", "needs_auth", "usage_limited"].includes(callback.phase))
      task.error = callback.detail;
    if (
      (callback.phase === "needs_auth" || callback.phase === "usage_limited") &&
      state.accounts[task.provider].leasedBy === attempt.id
    )
      state.accounts[task.provider].state = callback.phase;
  }
  return true;
}

export function confirmStopped(
  state: CloudState,
  taskId: string,
  attemptId: string,
  now: number,
  deleted = false,
): void {
  const task = state.tasks[taskId];
  if (!task?.attempt || task.attempt.id !== attemptId || !task.worker) return;
  accrue(state, task, now);
  task.worker.state = deleted ? "deleted" : "stopped";
  task.worker.stoppedAt = iso(now);
  if (task.publicationPreparation) {
    delete task.publicationPreparation;
    if (task.state === "running") {
      task.state = "interrupted";
      task.error =
        "The workspace stopped before its pull request snapshot was saved. Resume it and try again.";
    }
  }
  task.attempt.reservedMicroDollars = 0;
  const account = state.accounts[task.provider];
  if (account.leasedBy === attemptId) {
    account.leasedBy = null;
    if (state.providerLeaseTurns) delete state.providerLeaseTurns[task.provider];
  }
}

/** Finalization can race cancellation. Save the checkpoint without reviving cancelled work. */
export function acceptCheckpoint(
  state: CloudState,
  callback: CloudWorkerCallback,
  now: number,
): boolean {
  const task = taskFor(state, callback.taskId);
  const attempt = task.attempt;
  if (
    !attempt ||
    !task.worker ||
    ["stopped", "deleted"].includes(task.worker.state) ||
    attempt.id !== callback.attemptId ||
    attempt.generation !== callback.generation ||
    (state.accounts[task.provider].leasedBy !== attempt.id && !isResidentWorker(task))
  )
    throw new CloudError("stale_worker", "Worker attempt is no longer current");
  if (callback.sequence <= attempt.lastSequence) return false;
  if (
    !callback.checkpoint ||
    callback.checkpoint.taskId !== task.id ||
    callback.checkpoint.attemptId !== attempt.id
  ) {
    throw new CloudError("invalid_checkpoint", "Checkpoint belongs to a different attempt", 400);
  }
  if (["preparing", "running", "waiting_for_input"].includes(task.state))
    return acceptCallback(state, callback, now);
  if (!["cancelled", "interrupted", "failed", "needs_auth", "usage_limited"].includes(task.state)) {
    throw new CloudError("task_settled", "Task no longer accepts checkpoints");
  }
  attempt.lastSequence = callback.sequence;
  attempt.heartbeatAt = iso(now);
  task.checkpoint = callback.checkpoint;
  return true;
}
