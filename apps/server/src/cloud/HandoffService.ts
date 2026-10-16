import { cloudProviderForInstance } from "./providerValidation.ts";
import { hasOpenBlockingRequest, threadHasQueuedTurnStart } from "../orchestration/decider.ts";
// @effect-diagnostics nodeBuiltinImport:off - Managed workspace transfer boundary.
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import {
  CommandId,
  OrchestrationThread,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type ThreadExecutionState,
} from "@t3tools/contracts";
import {
  CloudSwitchResolveInput,
  CloudWorkspaceManifest,
  CloudTerminalState,
  CloudConversationSnapshot,
  CloudDesktopAuthError,
  CloudOverview,
  CloudSwitchInput,
  CloudTransferResult,
  type CloudSwitchStatus,
} from "@t3tools/contracts/cloud";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { desktopCloudSession } from "./DesktopCloudSession.ts";
import { ConversationChunkStore, transferConversationEffect } from "./conversationTransfer.ts";
import { readExecutionOwnership } from "./executionOwnership.ts";
import {
  advanceHandoffCoordinator,
  HandoffWait,
  HandoffFailure,
  HandoffCommitConfirmed,
  type HandoffJournal,
  type HandoffPorts,
} from "./handoffCoordinator.ts";
import { handoffRelay } from "./handoffTransport.ts";
import { createConflictWorkspace, mergeConflictChoice } from "./handoffConflicts.ts";
import { durableJson, readBlob, readJson, snapshotHashes } from "./handoffFiles.ts";
import { startCloudConversation } from "./StartCloudConversation.ts";
import { CloudRequestFailure, asDesktopCloudError } from "./requestFailure.ts";
import {
  captureWorkspace,
  digest,
  prepareWorkspaceReturn,
  restoreWorkspace,
} from "../../../../scripts/vitre/cloud/workspace.mjs";
import {
  restoreAttachmentFiles,
  type ArchivedAttachment,
} from "../../../../scripts/vitre/cloud/attachments.mjs";

export class CloudHandoffService extends Context.Service<
  CloudHandoffService,
  {
    readonly advancePending: Effect.Effect<void>;
    request(input: CloudSwitchInput): Effect.Effect<CloudSwitchStatus, CloudDesktopAuthError>;
    status(conversationId: string): Effect.Effect<CloudSwitchStatus, CloudDesktopAuthError>;
    resolve(
      input: typeof CloudSwitchResolveInput.Type,
    ): Effect.Effect<CloudSwitchStatus, CloudDesktopAuthError>;
    cancel(operationId: string): Effect.Effect<CloudSwitchStatus, CloudDesktopAuthError>;
  }
>()("t3/cloud/HandoffService/CloudHandoffService") {}

type SavedInput = CloudSwitchInput & { sourceTaskId: string | null };
type JournalRow = { id: string; input: string; journal: string };
const decodeTerminals = Schema.decodeUnknownSync(Schema.Array(CloudTerminalState));
const decodeOverview = Schema.decodeUnknownSync(CloudOverview);
const decodeWorkspace = Schema.decodeUnknownSync(CloudWorkspaceManifest);
const decodeSnapshot = Schema.decodeUnknownSync(CloudConversationSnapshot);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);
const decodeTransfer = Schema.decodeUnknownSync(CloudTransferResult);
const isInvariantError = Schema.is(OrchestrationCommandInvariantError);
const isPreviouslyRejected = Schema.is(OrchestrationCommandPreviouslyRejectedError);
const decodeStored = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeStored = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const layer = Layer.effect(
  CloudHandoffService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const advancing = yield* Semaphore.make(1);
    const config = yield* ServerConfig;
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    const context = yield* Effect.context<
      SqlClient.SqlClient | ServerConfig | OrchestrationEngineService | ProjectionSnapshotQuery
    >();
    const run = Effect.runPromiseWith(context);
    const root = NodePath.join(config.stateDir, "cloud-transfer");
    const chunks = new ConversationChunkStore(NodePath.join(root, "chunks"));
    const timestamp = () => run(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
    const recordPath = (id: string, name: string) =>
      NodePath.join(root, "operations", id, `${name}.json`);
    const bindingPath = (id: string) => NodePath.join(root, "bindings", `${id}.json`);
    const session = async () => {
      const value = await run(desktopCloudSession(false));
      if (!value.enabled || !value.relayUrl || !value.accessToken)
        throw new Error("Sign in to Cloud before moving this conversation");
      return { relayUrl: value.relayUrl, accessToken: value.accessToken };
    };
    const load = async (id: string) => {
      const rows = await run(
        sql<JournalRow>`SELECT id, input_json AS input, journal_json AS journal FROM cloud_handoff_journal WHERE id = ${id}`,
      );
      if (!rows[0]) throw new Error("Switch not found");
      return {
        row: rows[0],
        input: JSON.parse(rows[0].input) as SavedInput,
        operation: JSON.parse(rows[0].journal) as HandoffJournal,
      };
    };
    const localThread = async (id: string) => {
      const thread = await run(query.getThreadDetailById(ThreadId.make(id)));
      if (Option.isNone(thread)) throw new Error("Conversation not found");
      return thread.value;
    };
    const dispatch = (command: OrchestrationCommand) => run(engine.dispatch(command));
    const getSource = async (input: SavedInput, relay: ReturnType<typeof handoffRelay>) => {
      if (!input.sourceTaskId)
        return {
          threadId: input.localThreadId,
          thread: () => localThread(input.localThreadId),
          execution: () => run(readExecutionOwnership(input.localThreadId)),
          dispatch,
          transfer: (payload: Parameters<typeof transferConversationEffect>[0]) =>
            run(transferConversationEffect(payload)),
        };
      const task = (await relay.overview()).tasks.find((task) => task.id === input.sourceTaskId);
      if (!task) throw new Error("Cloud conversation no longer exists");
      if (task.worker?.state !== "ready") {
        if (!task.worker || ["stopped", "deleted"].includes(task.worker.state))
          await relay.api("/commands", {
            type: "task.wake",
            idempotencyKey: `${input.idempotencyKey}-wake-${task.attempt?.generation ?? 0}`,
            taskId: task.id,
          });
        throw new HandoffWait("cloud-preparation");
      }
      const request = await relay.environment(input.sourceTaskId);
      const threadId = ThreadId.make(`cloud-${input.sourceTaskId}`);
      return {
        threadId,
        thread: async () =>
          decodeThread(
            ((await request(`/api/orchestration/threads/${threadId}`)) as { thread: unknown })
              .thread,
          ),
        execution: async () => {
          const result = decodeTransfer(
            await request("/api/orchestration/transfer", { type: "ownership", threadId }),
          );
          if (result.type !== "ownership") throw new Error("Invalid ownership response");
          return result.execution;
        },
        dispatch: (command: OrchestrationCommand) =>
          request("/api/orchestration/dispatch", command),
        transfer: async (payload: Parameters<typeof transferConversationEffect>[0]) =>
          decodeTransfer(await request("/api/orchestration/transfer", payload)),
      };
    };
    const setExecution = async (
      source: Awaited<ReturnType<typeof getSource>>,
      op: HandoffJournal,
      current: ThreadExecutionState,
      status: ThreadExecutionState["status"],
      generation: number,
      suffix: string,
    ) => {
      const retryPath = recordPath(op.id, `${suffix}-retry`);
      const retry = ((await readJson(retryPath)) as number | null) ?? 0;
      try {
        await source.dispatch({
          type: "thread.execution.set",
          commandId: CommandId.make(`${op.id}-${suffix}${retry ? `-${retry}` : ""}`),
          threadId: source.threadId,
          expectedGeneration: current.generation,
          execution: { generation, operationId: op.id, status },
          createdAt: await timestamp(),
        });
      } catch (error) {
        // A known busy rejection is safe to retry with a new command receipt. Ambiguous
        // network failures keep the original key, so an accepted freeze cannot replay.
        if (
          status === "frozen" &&
          ((isInvariantError(error) && error.code === "execution_busy") ||
            isPreviouslyRejected(error) ||
            (error instanceof CloudRequestFailure &&
              error.requestDisposition === "rejected" &&
              ["execution_busy", "command_rejected"].includes(error.code ?? "")))
        ) {
          await durableJson(retryPath, retry + 1);
          throw new HandoffWait("active-turn");
        }
        throw error;
      }
    };
    const saveSnapshot = (id: string, snapshot: CloudConversationSnapshot) =>
      durableJson(recordPath(id, "snapshot"), snapshot);
    const snapshotFor = async (id: string) =>
      decodeSnapshot(await readJson(recordPath(id, "snapshot")));
    const historyFor = async (snapshot: CloudConversationSnapshot) => {
      const data = JSON.parse(
        Buffer.from(await readBlob(chunks, snapshot.history)).toString("utf8"),
      ) as { version: number; thread: unknown; attachments: ArchivedAttachment[] };
      if (data.version !== 1 || !Array.isArray(data.attachments))
        throw new Error("Invalid conversation history");
      return {
        thread: decodeThread(data.thread),
        attachments: data.attachments,
        terminals: decodeTerminals((data as { terminals?: unknown }).terminals ?? []),
      };
    };
    const relayPhase = async (
      relay: ReturnType<typeof handoffRelay>,
      op: HandoffJournal,
      target: HandoffJournal["phase"],
      checkpoint: CloudConversationSnapshot | null = null,
      destination?: string,
    ) => {
      const phases = [
        "waiting",
        "preparing",
        "checkpointing",
        "transferring",
        "verifying",
        "activating",
        "releasing",
        "completed",
      ] as const;
      let overview = await relay.overview();
      for (;;) {
        const current = overview.handoffs?.find((entry) => entry.id === op.id);
        if (!current) throw new Error("Authoritative switch not found");
        const index = phases.indexOf(current.phase as (typeof phases)[number]);
        const wanted = phases.indexOf(target as (typeof phases)[number]);
        if (index < 0) throw new Error("Switch was cancelled elsewhere");
        if (index >= wanted) return;
        const next = phases[index + 1]!;
        const hash = checkpoint ? digest(JSON.stringify(checkpoint.workspace)) : null;
        const original = (await readJson(
          bindingPath(op.conversationId),
        )) as CloudConversationSnapshot | null;
        const roots =
          next === "activating"
            ? checkpoint?.workspace.roots.map((root, index) => ({
                id: root.id,
                localPath:
                  op.to === "local"
                    ? NodePath.join(destination!, root.id)
                    : (original?.roots.find((entry) => entry.id === root.id)?.path ??
                      (op.from === "local"
                        ? checkpoint.roots.find((entry) => entry.id === root.id)?.path
                        : null) ??
                      null),
                cloudPath:
                  op.to === "local"
                    ? null
                    : index === 0
                      ? "/workspace/repository"
                      : `/workspace/roots/${root.id}`,
              }))
            : undefined;
        const result = (await relay.api("/commands", {
          type: "handoff.advance",
          idempotencyKey: `${op.id}-${next}`,
          operationId: op.id,
          expectedPhase: current.phase,
          nextPhase: next,
          checkpoint: hash ? { id: hash, sha256: hash } : current.checkpoint,
          ...(next === "activating"
            ? {
                destinationOwner:
                  op.to === "local" ? `desktop-${op.conversationId}` : `worker-${destination}`,
                roots,
                ...(op.to === "local" ? {} : { cloudTaskId: destination }),
              }
            : {}),
        })) as { overview: unknown };
        overview = decodeOverview(result.overview);
      }
    };
    const prepareLocalDestination = async (
      op: HandoffJournal,
      input: SavedInput,
      relay: ReturnType<typeof handoffRelay>,
      activate: boolean,
    ) => {
      const snapshot = await snapshotFor(op.id);
      const history = await historyFor(snapshot);
      const roots = snapshot.workspace.roots.map((entry) => ({
        id: entry.id,
        path: NodePath.join(op.destination!, entry.id),
      }));
      const primary = roots[0]!;
      for (const root of roots)
        await durableJson(
          NodePath.join(
            config.stateDir,
            "cloud-transfer",
            "root-identities",
            `${digest(root.path)}.json`,
          ),
          root,
        );
      const existing = await run(query.getThreadDetailById(input.localThreadId));
      const createdAt = await timestamp();
      if (Option.isNone(existing)) {
        const baseline = (await readJson(
          bindingPath(op.conversationId),
        )) as CloudConversationSnapshot | null;
        const projectId = ProjectId.make(baseline?.projectId ?? `returned-${op.conversationId}`);
        if (Option.isNone(await run(query.getProjectShellById(projectId))))
          await dispatch({
            type: "project.create",
            commandId: CommandId.make(`${op.id}-project`),
            projectId,
            title: history.thread.title,
            workspaceRoot: primary.path,
            defaultModelSelection: history.thread.modelSelection,
            createdAt,
          });
        await dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${op.id}-thread`),
          threadId: input.localThreadId,
          projectId,
          title: history.thread.title,
          modelSelection: history.thread.modelSelection,
          runtimeMode: history.thread.runtimeMode,
          interactionMode: history.thread.interactionMode,
          branch: history.thread.branch,
          worktreePath: primary.path,
          createdAt,
        });
      }
      let before = (await readJson(
        recordPath(op.id, "destination-execution"),
      )) as ThreadExecutionState | null;
      if (!before) {
        before = await run(readExecutionOwnership(input.localThreadId));
        await durableJson(recordPath(op.id, "destination-execution"), before);
      }
      const local = await getSource({ ...input, sourceTaskId: null }, relay);
      await setExecution(local, op, before, "frozen", before.generation, "destination-freeze");
      await restoreAttachmentFiles(history.attachments, config.attachmentsDir);
      await dispatch({
        type: "thread.execution.restore",
        commandId: CommandId.make(`${op.id}-restore`),
        threadId: input.localThreadId,
        operationId: op.id,
        expectedGeneration: before.generation,
        title: history.thread.title,
        modelSelection: history.thread.modelSelection,
        runtimeMode: history.thread.runtimeMode,
        interactionMode: history.thread.interactionMode,
        branch:
          (
            (await readJson(
              recordPath(op.id, "resolved-workspace"),
            )) as CloudWorkspaceManifest | null
          )?.roots[0]?.git?.branch ??
          snapshot.workspace.roots[0]?.git?.branch ??
          null,
        worktreePath: primary.path,
        additionalRoots: roots.slice(1).map((entry) => ({ kind: "path", path: entry.path })),
        messages: history.thread.messages,
        proposedPlans: history.thread.proposedPlans,
        activities: history.thread.activities,
        createdAt,
      });
      if (!(await readJson(recordPath(op.id, "terminals-restored")))) {
        await local.transfer({
          type: "restoreTerminals",
          threadId: local.threadId,
          operationId: op.id,
          generation: before.generation,
          terminals: history.terminals,
        });
        await durableJson(recordPath(op.id, "terminals-restored"), true);
      }
      if (activate)
        await setExecution(
          local,
          op,
          before,
          "active",
          before.generation + 1,
          "destination-activate",
        );
      if (activate) {
        await local.transfer({
          type: "restoreTerminals",
          resumeCommands: true,
          threadId: local.threadId,
          operationId: op.id,
          generation: before.generation + 1,
          terminals: history.terminals,
        });
        await durableJson(bindingPath(op.conversationId), { ...snapshot, roots });
      }
    };
    const makePorts = (
      input: SavedInput,
      relay: ReturnType<typeof handoffRelay>,
      auth: Awaited<ReturnType<typeof session>>,
    ): HandoffPorts => ({
      now: timestamp,
      read: async (id) => (await load(id)).operation,
      save: async (previous, next) => {
        const rows = await run(sql<{ id: string }>`UPDATE cloud_handoff_journal
        SET journal_json = ${JSON.stringify(next)}, terminal = ${["completed", "cancelled", "failed"].includes(next.phase) ? 1 : 0}
        WHERE id = ${previous.id} AND journal_json = ${JSON.stringify(previous)} RETURNING id`);
        if (!rows.length) throw new Error("Switch changed; reloading");
      },
      isSourceIdle: async (op) => {
        if (input.sourceTaskId) {
          const task = (await relay.overview()).tasks.find(
            (entry) => entry.id === input.sourceTaskId,
          );
          if (!task) throw new Error("Cloud conversation no longer exists");
          if (task.worker?.state !== "ready") {
            if (task.worker && !["stopped", "deleted"].includes(task.worker.state)) return false;
            await relay.api("/commands", {
              type: "task.wake",
              idempotencyKey: `${op.id}-wake`,
              taskId: task.id,
            });
            return false;
          }
          if (!task.idle) return false;
        }
        const source = await getSource(input, relay);
        const thread = await source.thread();
        return (
          !["running", "starting"].includes(thread.session?.status ?? "") &&
          thread.latestTurn?.state !== "running" &&
          !hasOpenBlockingRequest(thread) &&
          !threadHasQueuedTurnStart(thread, await timestamp())
        );
      },
      prepare: async (op) => {
        const source = await getSource(input, relay);
        const thread = await source.thread();
        if (op.to !== "local") {
          const provider = cloudProviderForInstance(thread.modelSelection.instanceId);
          if (!provider)
            throw new HandoffFailure("This provider configuration is not supported in Cloud");
          if (
            !(await relay.overview()).accounts.some(
              (account) => account.provider === provider && account.state === "connected",
            )
          )
            throw new HandoffFailure("Connect this provider in Cloud settings before moving");
        }
        await relay.api("/commands", {
          type: "handoff.request",
          idempotencyKey: op.id,
          conversationId: op.conversationId,
          localThreadId: input.localThreadId,
          cloudTaskId: input.sourceTaskId,
          target: op.to,
          expectedGeneration: op.generation,
        });
        await relayPhase(relay, op, "preparing");
      },
      freezeAndCapture: async (op) => {
        const cached = await readJson(recordPath(op.id, "snapshot"));
        if (cached) return digest(JSON.stringify(decodeSnapshot(cached)));
        const source = await getSource(input, relay);
        let execution = (await readJson(
          recordPath(op.id, "source-execution"),
        )) as ThreadExecutionState | null;
        if (!execution) {
          execution = await source.execution();
          await durableJson(recordPath(op.id, "source-execution"), execution);
        }
        await setExecution(source, op, execution, "frozen", execution.generation, "freeze");
        await relayPhase(relay, op, "checkpointing");
        const captured = await source.transfer({
          type: "capture",
          threadId: source.threadId,
          operationId: op.id,
          generation: execution.generation,
        });
        if (captured.type !== "snapshot") throw new Error("Invalid workspace snapshot");
        if (input.sourceTaskId) {
          const hashes = snapshotHashes(captured.snapshot);
          for (let offset = 0; offset < hashes.length; offset += 8) {
            const results = await Promise.allSettled(
              hashes.slice(offset, offset + 8).map(async (hash) => {
                // Reuse verified content captured locally before the outbound handoff.
                try {
                  await chunks.get(hash);
                  return;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
                const part = await source.transfer({ type: "read", sha256: hash });
                if (
                  part.type !== "chunk" ||
                  (await chunks.put(Buffer.from(part.base64, "base64"))) !== hash
                )
                  throw new Error("Workspace download failed verification");
              }),
            );
            for (const result of results) if (result.status === "rejected") throw result.reason;
          }
        }
        await saveSnapshot(op.id, captured.snapshot);
        return digest(JSON.stringify(captured.snapshot));
      },
      transfer: async (op) => {
        const snapshot = await snapshotFor(op.id);
        await relayPhase(relay, op, "transferring", snapshot);
        if (op.to !== "local") {
          const hashes = [...new Set(snapshotHashes(snapshot))];
          for (let offset = 0; offset < hashes.length; offset += 8) {
            const results = await Promise.allSettled(
              hashes.slice(offset, offset + 8).map(async (hash) => {
                const stored = (await relay.api("/workspaces/chunks", {
                  base64: Buffer.from(await chunks.get(hash)).toString("base64"),
                })) as { sha256: string };
                if (stored.sha256 !== hash) throw new Error("Workspace upload failed verification");
              }),
            );
            for (const result of results) if (result.status === "rejected") throw result.reason;
          }
          const history = await historyFor(snapshot);
          const model = history.thread.modelSelection;
          const original = (await readJson(
            bindingPath(op.conversationId),
          )) as CloudConversationSnapshot | null;
          const roots = input.sourceTaskId ? (original?.roots ?? []) : snapshot.roots;
          let workspace = snapshot.workspace;
          if (
            op.to === "cloud-github" &&
            input.sourceTaskId &&
            !workspace.roots[0]?.git?.githubRemote
          ) {
            const sourceTask = (await relay.overview()).tasks.find(
              (task) => task.id === input.sourceTaskId,
            );
            if (
              sourceTask?.repository.installationId !== "local" &&
              sourceTask?.baseSha &&
              workspace.roots[0]?.git
            ) {
              workspace = {
                ...workspace,
                roots: workspace.roots.map((root, index) =>
                  index === 0
                    ? {
                        ...root,
                        git: {
                          ...root.git!,
                          githubRemote: `https://github.com/${sourceTask.repository.owner}/${sourceTask.repository.name}.git`,
                          publishedRevision:
                            sourceTask.source?.kind === "github"
                              ? sourceTask.source.revision
                              : sourceTask.baseSha!,
                        },
                      }
                    : root,
                ),
              };
            }
          }
          if (!roots.length && op.to === "cloud-github" && !workspace.roots[0]?.git?.githubRemote)
            throw new HandoffFailure(
              "No unambiguous GitHub source is available; choose Cloud: Local",
            );
          const result = await startCloudConversation(
            {
              ...((original?.projectId ?? snapshot.projectId)
                ? { projectId: original?.projectId ?? snapshot.projectId }
                : {}),
              idempotencyKey: `${op.id}-destination`,
              target: op.to,
              roots: roots.length ? roots : [{ id: "primary", path: snapshot.roots[0]!.path }],
              provider: cloudProviderForInstance(model.instanceId)!,
              model: String(model.model),
              ...(model.options ? { modelOptions: model.options } : {}),
              interactionMode: history.thread.interactionMode,
              runtimeMode: history.thread.runtimeMode,
              prompt: history.thread.title,
              handoff: {
                operationId: op.id,
                conversationId: op.conversationId,
                generation: op.generation,
                history: snapshot.history,
              },
            },
            auth,
            fetch,
            workspace,
          );
          return result.entityId;
        }
        const destination = NodePath.join(config.stateDir, "cloud-workspaces", op.id);
        const receipt = (await readJson(recordPath(op.id, "destination"))) as {
          directory: string;
        } | null;
        if (receipt) return receipt.directory;
        // This marker is renamed with the prepared directory, closing the crash
        // window between installing the workspace and recording its receipt.
        if (await readJson(NodePath.join(destination, ".vitre-return.json"))) {
          await durableJson(recordPath(op.id, "destination"), { directory: destination });
          return destination;
        }
        const original = await readJson(bindingPath(op.conversationId));
        if (original) {
          const baseline = decodeSnapshot(original);
          const local = await captureWorkspace(baseline.roots, (_, bytes) => chunks.put(bytes));
          const resolved = await readJson(recordPath(op.id, "resolved-workspace"));
          const conflictLocal = await readJson(recordPath(op.id, "conflict-local"));
          if (resolved && JSON.stringify(local) !== JSON.stringify(conflictLocal))
            throw new HandoffFailure(
              "Local files changed while resolving; cancel and retry to include them",
            );
          const result = await prepareWorkspaceReturn({
            baseline: resolved ? local : baseline.workspace,
            local,
            remote: resolved ? decodeWorkspace(resolved) : snapshot.workspace,
            destination,
            getChunk: (hash) => chunks.get(hash),
          });
          await durableJson(recordPath(op.id, "conflicts"), result.conflicts);
          if (result.conflicts.length) {
            if (!(await readJson(recordPath(op.id, "conflict-roots")))) {
              await durableJson(recordPath(op.id, "conflict-local"), local);
              const conflictDirectory = NodePath.join(root, "operations", op.id, "resolution");
              // A failed preparation can leave only this private, unused directory.
              await NodeFSP.rm(conflictDirectory, { recursive: true, force: true });
              const roots = await createConflictWorkspace({
                baseline: baseline.workspace,
                local,
                remote: snapshot.workspace,
                conflicts: result.conflicts,
                destination: conflictDirectory,
                chunks,
              });
              await durableJson(recordPath(op.id, "conflict-roots"), roots);
            }
            throw new HandoffWait("conflict");
          }
        } else {
          const staging = `${destination}-staging`;
          await NodeFSP.rm(staging, { recursive: true, force: true });
          await restoreWorkspace(snapshot.workspace, staging, (hash) => chunks.get(hash));
          await durableJson(NodePath.join(staging, ".vitre-return.json"), { version: 1 });
          await NodeFSP.rename(staging, destination);
        }
        await durableJson(recordPath(op.id, "destination"), { directory: destination });
        return destination;
      },
      verify: async (op) => {
        const snapshot = await snapshotFor(op.id);
        const source = await getSource(input, relay);
        const execution = await source.execution();
        const current = await source.transfer({
          type: "capture",
          threadId: source.threadId,
          operationId: op.id,
          generation: execution.generation,
        });
        if (
          current.type !== "snapshot" ||
          digest(JSON.stringify(current.snapshot.workspace)) !==
            digest(JSON.stringify(snapshot.workspace))
        )
          throw new HandoffFailure(
            "Source files changed during transfer; cancel and retry to include those edits",
          );
        if (op.to !== "local") {
          const task = (await relay.overview()).tasks.find((entry) => entry.id === op.destination);
          if (
            task &&
            ["failed", "cancelled", "needs_auth", "usage_limited", "interrupted"].includes(
              task.state,
            )
          )
            throw new HandoffFailure(
              task.error ?? `Cloud workspace preparation stopped (${task.state})`,
            );
          if (task?.worker?.state !== "ready" || !task.idle)
            throw new HandoffWait("cloud-preparation");
          const request = await relay.environment(task.id);
          const validation = decodeTransfer(
            await request("/api/orchestration/transfer", {
              type: "validateProvider",
              threadId: `cloud-${task.id}`,
            }),
          );
          if (validation.type !== "providerValidation" || !validation.supported)
            throw new HandoffFailure(
              validation.type === "providerValidation"
                ? (validation.reason ?? "Cloud provider validation failed")
                : "Cloud provider validation failed",
              validation.type === "providerValidation" && validation.retryable
                ? "retryable"
                : "terminal",
            );
          const state = decodeTransfer(
            await request("/api/orchestration/transfer", {
              type: "ownership",
              threadId: `cloud-${task.id}`,
            }),
          );
          if (
            state.type !== "ownership" ||
            state.execution.status !== "frozen" ||
            state.execution.operationId !== op.id
          )
            throw new HandoffWait("cloud-activation");
        }
        if (op.to === "local") await prepareLocalDestination(op, input, relay, false);
        await relayPhase(relay, op, "verifying", snapshot);
      },
      commit: async (op) => {
        await relayPhase(
          relay,
          op,
          "activating",
          await snapshotFor(op.id),
          op.destination ?? undefined,
        );
      },
      activate: async (op) => {
        const snapshot = await snapshotFor(op.id);
        if (op.to !== "local") {
          if (!input.sourceTaskId) await durableJson(bindingPath(op.conversationId), snapshot);
          const request = await relay.environment(op.destination!);
          const state = decodeTransfer(
            await request("/api/orchestration/transfer", {
              type: "ownership",
              threadId: `cloud-${op.destination}`,
            }),
          );
          if (state.type !== "ownership" || state.execution.status !== "active")
            throw new HandoffWait("cloud-activation");
          return;
        }
        await prepareLocalDestination(op, input, relay, true);
      },
      release: async (op) => {
        const before = (await readJson(
          recordPath(op.id, "source-execution"),
        )) as ThreadExecutionState;
        const task = input.sourceTaskId
          ? (await relay.overview()).tasks.find((task) => task.id === input.sourceTaskId)
          : null;
        if (
          !input.sourceTaskId ||
          (task?.worker && !["stopped", "deleted"].includes(task.worker.state))
        ) {
          const source = await getSource(input, relay);
          await setExecution(source, op, before, "released", before.generation + 1, "release");
          await source.dispatch({
            type: "thread.session.stop",
            threadId: source.threadId,
            commandId: CommandId.make(`${op.id}-stop-session`),
            createdAt: await timestamp(),
          });
          await source.transfer({
            type: "closeTerminals",
            threadId: source.threadId,
            operationId: op.id,
            generation: before.generation + 1,
          });
        }
        await relayPhase(
          relay,
          op,
          "releasing",
          await snapshotFor(op.id),
          op.destination ?? undefined,
        );
        if (input.sourceTaskId && task)
          await relay.api("/commands", {
            type: "task.cancel",
            idempotencyKey: `${op.id}-stop-source`,
            taskId: input.sourceTaskId,
          });
        await relayPhase(
          relay,
          op,
          "completed",
          await snapshotFor(op.id),
          op.destination ?? undefined,
        );
      },
      rollback: async (op) => {
        const overview = await relay.overview();
        const binding = overview.bindings?.find(
          (entry) => entry.conversationId === op.conversationId,
        );
        const authoritative = overview.handoffs?.find((entry) => entry.id === op.id);
        if (binding && binding.generation !== op.generation) {
          if (
            binding.generation === op.generation + 1 &&
            authoritative &&
            ["activating", "releasing", "completed"].includes(authoritative.phase)
          ) {
            throw new HandoffCommitConfirmed();
          }
          throw new HandoffWait("ownership-confirmation");
        }
        if (authoritative)
          await relay.api("/commands", {
            type: "handoff.cancel",
            idempotencyKey: `${op.id}-cancel`,
            operationId: op.id,
          });
        const before = (await readJson(
          recordPath(op.id, "source-execution"),
        )) as ThreadExecutionState | null;
        if (before) {
          const source = await getSource(input, relay);
          const actual = await source.execution();
          if (actual.status !== "active" || actual.generation !== before.generation)
            await setExecution(source, op, before, "active", before.generation, "rollback");
        }
        const preparedLocal = (await readJson(
          recordPath(op.id, "destination-execution"),
        )) as ThreadExecutionState | null;
        if (preparedLocal && op.to === "local") {
          const local = await getSource({ ...input, sourceTaskId: null }, relay);
          await setExecution(
            local,
            op,
            preparedLocal,
            "released",
            preparedLocal.generation + 1,
            "discard-local",
          );
        }
        const destination =
          op.destination ?? overview.tasks.find((task) => task.handoff?.operationId === op.id)?.id;
        if (destination && op.to !== "local")
          await relay.api("/commands", {
            type: "task.delete",
            idempotencyKey: `${op.id}-discard`,
            taskId: destination,
          });
      },
    });

    const status = async (conversationId: string): Promise<CloudSwitchStatus> => {
      const rows =
        await run(sql<JournalRow>`SELECT id, input_json AS input, journal_json AS journal FROM cloud_handoff_journal
      WHERE conversation_id = ${conversationId} ORDER BY rowid DESC LIMIT 1`);
      const op = rows[0] ? (JSON.parse(rows[0].journal) as HandoffJournal) : null;
      const overview = await handoffRelay(await session()).overview();
      const binding =
        overview.bindings?.find((entry) => entry.conversationId === conversationId) ?? null;
      return {
        operation: op ? { ...op, checkpoint: null } : null,
        binding,
        ...(overview.revision !== undefined ? { accountRevision: overview.revision } : {}),
        ...(op && op.phase === "transferring"
          ? {
              conflictRoots:
                ((await readJson(recordPath(op.id, "conflict-roots"))) as
                  | { id: string; path: string }[]
                  | null) ?? [],
            }
          : {}),
        conflicts:
          op && op.phase === "transferring" && !op.cancelRequested
            ? (((await readJson(recordPath(op.id, "conflicts"))) as string[] | null) ?? [])
            : [],
      };
    };
    const wrap = <A>(body: () => Promise<A>) =>
      Effect.tryPromise({
        try: body,
        catch: (error) => asDesktopCloudError(error, "Conversation switch failed"),
      });
    const service = CloudHandoffService.of({
      advancePending: Effect.suspend(() => tick),
      request: (input) =>
        wrap(async () => {
          const auth = await session();
          const overview = await handoffRelay(auth).overview();
          const binding = overview.bindings?.find(
            (entry) => entry.conversationId === input.conversationId,
          );
          const taskId =
            binding?.target === "local" ? null : (binding?.cloudTaskId ?? input.cloudTaskId);
          const task = taskId ? overview.tasks.find((entry) => entry.id === taskId) : null;
          const from =
            binding?.target ??
            (task ? (task.source?.kind === "local" ? "cloud-local" : "cloud-github") : "local");
          if (from === input.target) return status(input.conversationId);
          const saved: SavedInput = { ...input, sourceTaskId: taskId };
          const createdAt = await timestamp();
          const journal: HandoffJournal = {
            revision: 0,
            startedAt: createdAt,
            updatedAt: createdAt,
            id: input.idempotencyKey,
            conversationId: input.conversationId,
            from,
            to: input.target,
            generation: binding?.generation ?? 0,
            phase: "waiting",
            checkpoint: null,
            destination: null,
            error: null,
            cancelRequested: false,
          };
          await run(
            sql.withTransaction(
              Effect.gen(function* () {
                const existing =
                  yield* sql<JournalRow>`SELECT id, input_json AS input, journal_json AS journal FROM cloud_handoff_journal WHERE id = ${journal.id}`;
                if (existing[0]) {
                  if (existing[0].input !== encodeStored(saved))
                    return yield* new CloudDesktopAuthError({
                      message: "Switch request was already used",
                    });
                  const prior = decodeStored(existing[0].journal) as HandoffJournal;
                  if (
                    prior.errorDisposition === "terminal" &&
                    !prior.cancelRequested &&
                    !["completed", "cancelled", "failed"].includes(prior.phase)
                  ) {
                    const { errorDisposition: _error, waitReason: _wait, ...retained } = prior;
                    yield* sql`UPDATE cloud_handoff_journal SET journal_json = ${encodeStored({
                      ...retained,
                      error: null,
                      revision: (prior.revision ?? 0) + 1,
                      updatedAt: createdAt,
                    })} WHERE id = ${prior.id}`;
                  }
                  return;
                }
                yield* sql`INSERT INTO cloud_handoff_journal(id, conversation_id, input_json, journal_json)
          VALUES (${journal.id}, ${journal.conversationId}, ${encodeStored(saved)}, ${encodeStored(journal)})`;
              }),
            ),
          );
          return status(input.conversationId);
        }),
      status: (id) => wrap(() => status(id)),
      resolve: (input) =>
        wrap(async () => {
          const { operation } = await load(input.operationId);
          if (
            operation.phase !== "transferring" ||
            operation.to !== "local" ||
            operation.cancelRequested
          )
            throw new Error("This switch has no pending conflicts");
          const snapshot = await snapshotFor(operation.id);
          const baseline = decodeSnapshot(await readJson(bindingPath(operation.conversationId)));
          const local = decodeWorkspace(await readJson(recordPath(operation.id, "conflict-local")));
          const conflicts = (await readJson(recordPath(operation.id, "conflicts"))) as string[];
          if (!conflicts?.length) throw new Error("No unresolved conflicts");
          let resolved;
          if (input.choice === "edited") {
            const roots = (await readJson(recordPath(operation.id, "conflict-roots"))) as {
              id: string;
              path: string;
            }[];
            resolved = await captureWorkspace(roots, (_, bytes) => chunks.put(bytes));
            for (const path of conflicts) {
              const entry = resolved.entries.find(
                (entry) => `${entry.rootId}/${entry.path}` === path,
              );
              if (entry?.kind === "file" && entry.sizeBytes <= 2 * 1024 * 1024) {
                const bytes = Buffer.concat(
                  await Promise.all(entry.chunks.map((hash) => chunks.get(hash))),
                );
                if (/^(<<<<<<< Local|=======|>>>>>>> Cloud)$/m.test(bytes.toString("utf8")))
                  throw new Error("Remove the conflict markers before continuing");
              }
            }
          } else
            resolved = mergeConflictChoice(
              baseline.workspace,
              local,
              snapshot.workspace,
              conflicts,
              input.choice,
            );
          await durableJson(recordPath(operation.id, "resolved-workspace"), resolved);
          await durableJson(recordPath(operation.id, "conflicts"), []);
          // Resolution changes presentation even before the next coordinator tick.
          // Increment the journal revision so a client can accept the cleared conflict.
          await run(sql`UPDATE cloud_handoff_journal SET journal_json = json_set(
            json_remove(journal_json, '$.waitReason', '$.errorDisposition'),
            '$.error', null, '$.revision', coalesce(json_extract(journal_json, '$.revision'), 0) + 1,
            '$.updatedAt', ${await timestamp()}) WHERE id = ${operation.id}
            AND json_extract(journal_json, '$.phase') = 'transferring'
            AND json_extract(journal_json, '$.cancelRequested') = 0`);
          return status(operation.conversationId);
        }).pipe(advancing.withPermit),
      cancel: (id) =>
        wrap(async () => {
          const { operation } = await load(id);
          if (!["activating", "releasing", "completed"].includes(operation.phase))
            await run(
              sql`UPDATE cloud_handoff_journal SET journal_json = json_set(journal_json,
                '$.cancelRequested', json('true'), '$.revision', coalesce(json_extract(journal_json, '$.revision'), 0) + 1,
                '$.updatedAt', ${await timestamp()}) WHERE id = ${id}
                AND json_extract(journal_json, '$.phase') NOT IN ('activating', 'releasing', 'completed', 'cancelled', 'failed')
                AND json_extract(journal_json, '$.cancelRequested') = 0`,
            );
          return status(operation.conversationId);
        }),
    });
    const tick = Effect.gen(function* () {
      const rows =
        yield* sql<JournalRow>`SELECT id, input_json AS input, journal_json AS journal FROM cloud_handoff_journal WHERE terminal = 0`;
      for (const row of rows)
        yield* wrap(async () => {
          const auth = await session();
          await advanceHandoffCoordinator(
            makePorts(JSON.parse(row.input) as SavedInput, handoffRelay(auth), auth),
            row.id,
          );
        }).pipe(Effect.ignore);
    }).pipe(Effect.ignore, advancing.withPermit);
    yield* Effect.forkScoped(Effect.forever(tick.pipe(Effect.andThen(Effect.sleep("2 seconds")))));
    return service;
  }),
);
