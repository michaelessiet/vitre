import { stableStringify } from "@t3tools/shared/relaySigning";
// @effect-diagnostics nodeBuiltinImport:off - Disposable filesystem integration fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type ThreadExecutionState,
} from "@t3tools/contracts";
import type { CloudCommand, CloudConversationSnapshot } from "@t3tools/contracts/cloud";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { CloudCliTokenManager } from "./CliTokenManager.ts";
import { CloudHandoffService, layer as HandoffLayer } from "./HandoffService.ts";
import { ConversationChunkStore, captureConversation } from "./conversationTransfer.ts";
import { isolatedWorkspaceRoots, readExecutionOwnership } from "./executionOwnership.ts";
import { digest, restoreWorkspace } from "../../../../scripts/vitre/cloud/workspace.mjs";
import {
  applyCommand,
  initialState,
  publicOverview,
  schedule,
} from "../../../../infra/relay/src/cloud/state.ts";

it.each([false, true])(
  "moves a real conversation round trip with conflict resolution: %s",
  async (withConflict) => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "vitre-handoff-service-"),
    );
    const workspace = NodePath.join(directory, "workspace");
    await NodeFSP.mkdir(workspace);
    const additional = NodePath.join(directory, "additional");
    await NodeFSP.mkdir(additional);
    await NodeFSP.writeFile(NodePath.join(additional, "extra.txt"), "extra workspace");
    await NodeFSP.writeFile(NodePath.join(workspace, "base.txt"), "original");
    await NodeFSP.writeFile(NodePath.join(workspace, "local.txt"), "base");
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- This integration owns the background coordinator lifetime while its Promise-based cloud transport runs real filesystem transfers.
    const runtime = ManagedRuntime.make(
      HandoffLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            OrchestrationEngineLive.pipe(
              Layer.provide(OrchestrationProjectionSnapshotQueryLive),
              Layer.provide(OrchestrationProjectionPipelineLive),
            ),
            OrchestrationProjectionSnapshotQueryLive,
          ),
        ),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "handoff-" })),
        Layer.provide(
          Layer.succeed(
            CloudCliTokenManager,
            CloudCliTokenManager.of({
              get: Effect.die("No login prompt"),
              getExisting: Effect.succeed(
                Option.some({
                  accessToken: "test-access",
                  refreshToken: "test-refresh",
                  expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
                }),
              ),
              hasCredential: Effect.succeed(true),
              store: () => Effect.void,
              clear: Effect.void,
            }),
          ),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { VITRE_CLOUD_DESKTOP_ENABLED: "true", T3CODE_RELAY_URL: "https://relay.test" },
            }),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    let rejectedModel = false;
    const relayState = initialState();
    relayState.accounts.codex.state = "connected";
    const chunks = new Map<string, Buffer>();
    let remote:
      | {
          thread: OrchestrationThread;
          snapshot: CloudConversationSnapshot;
          execution: ThreadExecutionState;
        }
      | undefined;
    let serial = 0;
    const remoteChunks = new ConversationChunkStore(NodePath.join(directory, "remote-chunks"));
    const json = (value: unknown) => Response.json(value);
    const now = Date.parse("2026-10-14T00:00:00Z");
    const request = async (
      input: string | URL | Request,
      options?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      const body = typeof options?.body === "string" ? JSON.parse(options.body) : null;
      if (url.host === "relay.test") {
        if (url.pathname === "/v1/cloud") return json(publicOverview(relayState, true, now));
        if (url.pathname === "/v1/cloud/workspaces/chunks") {
          const bytes = Buffer.from(body.base64, "base64");
          const sha256 = digest(bytes);
          chunks.set(sha256, bytes);
          return json({ sha256 });
        }
        if (url.pathname === "/v1/cloud/workspaces") {
          const encoded = body.version === 2 ? stableStringify(body) : JSON.stringify(body);
          const sha256 = digest(encoded);
          chunks.set(sha256, Buffer.from(encoded));
          return json({ id: sha256, sha256 });
        }
        if (url.pathname.endsWith("/connection"))
          return json({
            environmentId: "remote",
            httpBaseUrl: "https://worker.test",
            bootstrapToken: "bootstrap",
          });
        if (url.pathname === "/v1/cloud/commands") {
          const command = body as CloudCommand;
          const entityId = applyCommand(
            relayState,
            command,
            `task-${++serial}`,
            digest(JSON.stringify(command)),
            now,
            true,
          );
          if (command.type === "task.create" && command.handoff) {
            expect(command.runtimeMode).toBe("approval-required");
            schedule(relayState, now, true);
            const task = relayState.tasks[entityId]!;
            expect(task.attempt).not.toBeNull();
            const history = JSON.parse(
              Buffer.concat(
                command.handoff.history.chunks.map((hash) => chunks.get(hash)!),
              ).toString(),
            );
            const manifest = JSON.parse(chunks.get(command.source!.snapshot.sha256)!.toString());
            const destination = NodePath.join(directory, "remote");
            await restoreWorkspace(manifest, destination, async (hash) => chunks.get(hash)!);
            remote = {
              thread: { ...history.thread, id: ThreadId.make(`cloud-${entityId}`), session: null },
              snapshot: {
                version: 1,
                workspace: manifest,
                history: command.handoff.history,
                roots: manifest.roots.map((root: { id: string }) => ({
                  id: root.id,
                  path: NodePath.join(destination, root.id),
                })),
              },
              execution: {
                generation: 0,
                operationId: command.handoff.operationId,
                status: "frozen",
              },
            };
            task.state = "failed";
            task.error = "Worker could not complete this run: Backend startup failed";
            task.worker!.state = "ready";
            task.worker!.sandboxId = "machine-test";
            task.idle = false;
          }
          if (
            command.type === "handoff.advance" &&
            command.nextPhase === "activating" &&
            command.cloudTaskId &&
            remote
          )
            remote.execution = { ...remote.execution, generation: 1, status: "active" };
          return json({ entityId, overview: publicOverview(relayState, true, now) });
        }
      } else if (url.host === "worker.test" && remote) {
        if (url.pathname === "/oauth/token") return json({ access_token: "worker-access" });
        if (url.pathname.startsWith("/api/orchestration/threads/"))
          return json({ thread: remote.thread });
        if (url.pathname === "/api/orchestration/dispatch") {
          if (body.type === "thread.execution.set") remote.execution = body.execution;
          return json({ sequence: 1 });
        }
        if (url.pathname === "/api/orchestration/transfer") {
          if (body.type === "validateProvider") {
            const supported = rejectedModel;
            rejectedModel = true;
            return json({
              type: "providerValidation",
              supported,
              reason: supported
                ? null
                : "The selected model is not available for this cloud account",
            });
          }
          if (body.type === "closeTerminals") return json({ type: "terminalsRestored" });
          if (body.type === "ownership")
            return json({ type: "ownership", execution: remote.execution });
          if (body.type === "capture") {
            expect(remote.execution.status).toBe("frozen");
            remote.snapshot = await captureConversation(
              remote.thread,
              remote.snapshot.roots,
              NodePath.join(directory, "no-attachments"),
              remoteChunks,
            );
            return json({ type: "snapshot", snapshot: remote.snapshot });
          }
          if (body.type === "read")
            return json({
              type: "chunk",
              sha256: body.sha256,
              base64: Buffer.from(await remoteChunks.get(body.sha256)).toString("base64"),
            });
        }
      }
      throw new Error(`Unexpected test request: ${url.pathname}`);
    };
    vi.stubGlobal("fetch", request);
    try {
      const service = await runtime.runPromise(Effect.service(CloudHandoffService));
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      let busyRejection = withConflict;
      const freezeKeys: string[] = [];
      const originalDispatch = engine.dispatch;
      const dispatchSpy = vi.spyOn(engine, "dispatch").mockImplementation((command) => {
        if (command.type === "thread.execution.set" && command.execution.status === "frozen") {
          freezeKeys.push(command.commandId);
          if (busyRejection) {
            busyRejection = false;
            return Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Wait for the active turn and pending requests before moving.",
                code: "execution_busy",
              }),
            );
          }
        }
        return originalDispatch(command);
      });
      const threadId = ThreadId.make("conversation");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
      const createdAt = await runtime.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
      await runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project"),
          projectId: ProjectId.make("project"),
          title: "Project",
          workspaceRoot: workspace,
          additionalRoots: [{ kind: "path", path: additional }],
          defaultModelSelection: modelSelection,
          createdAt,
        }),
      );
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("thread"),
          threadId,
          projectId: ProjectId.make("project"),
          title: "Keep my conversation",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.make("history"),
          threadId,
          messages: [
            {
              id: MessageId.make("original-message"),
              role: "user",
              text: "Existing history",
              streaming: false,
              turnId: null,
              createdAt,
              updatedAt: createdAt,
            },
          ],
          proposedPlans: [],
          createdAt,
        }),
      );
      const move = async (
        id: string,
        target: "local" | "cloud-local",
        cloudTaskId: string | null,
      ) => {
        await runtime.runPromise(
          service.request({
            idempotencyKey: id,
            conversationId: threadId,
            localThreadId: threadId,
            target,
            cloudTaskId,
          }),
        );
        for (let step = 0; step < 16; step++) {
          await runtime.runPromise(service.advancePending);
          const status = await runtime.runPromise(service.status(threadId));
          if (status.conflicts.length) {
            expect(withConflict).toBe(true);
            expect(status.operation?.waitReason).toBe("conflict");
            expect(status.operation?.error).toBeNull();
            expect(status.binding?.target).toBe("cloud-local");
            const resolution = NodePath.join(status.conflictRoots![0]!.path, "base.txt");
            expect(await NodeFSP.readFile(resolution, "utf8")).toContain("<<<<<<< Local");
            await expect(
              runtime.runPromise(service.resolve({ operationId: id, choice: "edited" })),
            ).rejects.toThrow("conflict markers");
            await NodeFSP.writeFile(resolution, "local and cloud combined");
            const resolved = await runtime.runPromise(
              service.resolve({ operationId: id, choice: "edited" }),
            );
            expect(resolved.conflicts).toEqual([]);
            expect(resolved.operation?.revision).toBeGreaterThan(status.operation?.revision ?? 0);
            expect(resolved.operation?.updatedAt).toBeDefined();
            expect(resolved.operation?.waitReason).toBeUndefined();
            continue;
          }
          if (status.operation?.error?.includes("Backend startup failed")) {
            expect(target).toBe("cloud-local");
            expect(status.operation.phase).toBe("verifying");
            expect(status.binding?.target).not.toBe("cloud-local");
            expect((await runtime.runPromise(readExecutionOwnership(threadId))).status).toBe(
              "frozen",
            );
            const task = Object.values(relayState.tasks).find((task) => task.state === "failed")!;
            task.state = "running";
            task.error = null;
            task.idle = true;
            expect(status.operation.errorDisposition).toBe("terminal");
            await runtime.runPromise(
              service.request({
                idempotencyKey: id,
                conversationId: threadId,
                localThreadId: threadId,
                target,
                cloudTaskId,
              }),
            );
            continue;
          }
          if (status.operation?.error?.includes("selected model is not available")) {
            expect(status.operation.errorDisposition).toBe("terminal");
            await runtime.runPromise(
              service.request({
                idempotencyKey: id,
                conversationId: threadId,
                localThreadId: threadId,
                target,
                cloudTaskId,
              }),
            );
            expect(status.operation.phase).toBe("verifying");
            expect(status.binding?.target).not.toBe("cloud-local");
            expect(remote!.execution.status).toBe("frozen");
            expect((await runtime.runPromise(readExecutionOwnership(threadId))).status).toBe(
              "frozen",
            );
            continue;
          }
          if (status.operation?.error?.includes("Wait for the active turn")) continue;
          expect(status.operation?.error, `phase ${status.operation?.phase}`).toBeNull();
          if (status.operation?.phase === "completed") return status;
        }
        throw new Error("Switch did not complete");
      };
      const moved = await move("outbound", "cloud-local", null);
      expect(moved.binding?.target).toBe("cloud-local");
      if (withConflict) expect(new Set(freezeKeys).size).toBeGreaterThan(1);
      dispatchSpy.mockRestore();
      expect((await runtime.runPromise(readExecutionOwnership(threadId))).status).toBe("released");
      expect(remote!.thread.messages[0]?.text).toBe("Existing history");
      // These records exist only on the cloud destination. Returning must import
      // their exact history, without reviving provider actions from the old host.
      const historicalActivities: OrchestrationThread["activities"] = [
        {
          id: EventId.make("cloud-tool"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Read source",
          payload: { command: "cat source.ts", output: "source" },
          turnId: null,
          createdAt,
        },
        {
          id: EventId.make("cloud-approval"),
          kind: "approval.requested",
          tone: "approval",
          summary: "Approve read",
          payload: { requestId: "cloud-request" },
          turnId: null,
          createdAt,
        },
        {
          id: EventId.make("cloud-input"),
          kind: "user-input.requested",
          tone: "info",
          summary: "Choose option",
          payload: { requestId: "cloud-question" },
          turnId: null,
          createdAt,
        },
      ];
      remote!.thread = {
        ...remote!.thread,
        activities: [
          ...remote!.thread.activities,
          ...historicalActivities,
          {
            id: EventId.make("previous-hop-history"),
            kind: "thread.history.imported",
            tone: "info",
            summary: "Conversation moved",
            turnId: null,
            createdAt,
            payload: {
              lastMessageId: "original-message",
              historicalActivityIds: historicalActivities.map((activity) => activity.id),
            },
          },
        ],
      };
      await NodeFSP.writeFile(
        NodePath.join(remote!.snapshot.roots[0]!.path, "base.txt"),
        "cloud change",
      );
      await NodeFSP.writeFile(NodePath.join(workspace, "local.txt"), "independent local edit");
      if (withConflict)
        await NodeFSP.writeFile(NodePath.join(workspace, "base.txt"), "local conflicting edit");
      const returned = await move("return", "local", moved.binding!.cloudTaskId);
      expect(returned.binding?.target).toBe("local");
      const local = await runtime.runPromise(query.getThreadDetailById(threadId));
      expect(Option.isSome(local)).toBe(true);
      if (Option.isNone(local)) throw new Error("Missing returned conversation");
      expect(local.value.worktreePath).not.toBe(workspace);
      expect(
        await NodeFSP.readFile(NodePath.join(local.value.worktreePath!, "base.txt"), "utf8"),
      ).toBe(withConflict ? "local and cloud combined" : "cloud change");
      expect(
        await NodeFSP.readFile(NodePath.join(local.value.worktreePath!, "local.txt"), "utf8"),
      ).toBe("independent local edit");
      expect(await NodeFSP.readFile(NodePath.join(workspace, "base.txt"), "utf8")).toBe(
        withConflict ? "local conflicting edit" : "original",
      );
      expect(
        local.value.messages.filter((message) => message.id === "original-message"),
      ).toHaveLength(1);
      for (const activity of historicalActivities) {
        expect(local.value.activities.filter((entry) => entry.id === activity.id)).toEqual([
          activity,
        ]);
      }
      expect(local.value.latestTurn).toBeNull();
      expect(local.value.session).toBeNull();
      expect(local.value.runtimeMode).toBe("approval-required");
      const shell = await runtime.runPromise(query.getThreadShellById(threadId));
      expect(Option.isSome(shell) && shell.value.hasPendingApprovals).toBe(false);
      expect(Option.isSome(shell) && shell.value.hasPendingUserInput).toBe(false);
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.make("history-repeat"),
          threadId,
          messages: [],
          proposedPlans: [],
          activities: historicalActivities,
          createdAt,
        }),
      );
      const repeated = await runtime.runPromise(query.getThreadDetailById(threadId));
      if (Option.isNone(repeated)) throw new Error("Missing repeated history");
      for (const activity of historicalActivities) {
        expect(repeated.value.activities.filter((entry) => entry.id === activity.id)).toEqual([
          activity,
        ]);
      }
      const returnedAdditional = local.value.additionalRoots[0];
      expect(returnedAdditional?.kind).toBe("path");
      if (returnedAdditional?.kind !== "path") throw new Error("Missing returned additional root");
      expect(returnedAdditional.path).not.toBe(additional);
      expect(
        await NodeFSP.readFile(NodePath.join(returnedAdditional.path, "extra.txt"), "utf8"),
      ).toBe("extra workspace");
      const isolated = await runtime.runPromise(
        isolatedWorkspaceRoots(threadId, {
          primary: local.value.worktreePath!,
          additional: [additional, returnedAdditional.path],
        }),
      );
      expect(isolated.additional).toEqual([returnedAdditional.path]);
      expect((await runtime.runPromise(readExecutionOwnership(threadId))).status).toBe("active");
      for (const activity of historicalActivities.filter((activity) =>
        activity.kind.endsWith(".requested"),
      )) {
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`new-${activity.id}`),
            threadId,
            activity: { ...activity, id: EventId.make(`new-${activity.id}`) },
            createdAt,
          }),
        );
      }
      const currentShell = await runtime.runPromise(query.getThreadShellById(threadId));
      expect(Option.isSome(currentShell) && currentShell.value.hasPendingApprovals).toBe(true);
      expect(Option.isSome(currentShell) && currentShell.value.hasPendingUserInput).toBe(true);
    } finally {
      await runtime.dispose();
      vi.unstubAllGlobals();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
