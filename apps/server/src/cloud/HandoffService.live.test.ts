// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalConsole:off - Opt-in paid infrastructure harness: real wall-clock deadlines and external progress monitoring must run independently of the Effect coordinator under test.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";
import { expect, it } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
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
import { readExecutionOwnership } from "./executionOwnership.ts";
import { handoffRelay } from "./handoffTransport.ts";
import { DEFAULT_MODEL } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
// Opt-in: uses paid disposable cloud attempts and the connected Codex account.
for (const cloudTarget of ["cloud-local", "cloud-github"] as const) {
  it.skipIf(
    process.env.VITRE_LIVE_HANDOFF !== "1" ||
      (Boolean(process.env.VITRE_LIVE_SOURCE) && process.env.VITRE_LIVE_SOURCE !== cloudTarget),
  )(
    `round trips ${cloudTarget} through the deployed relay and a real provider`,
    async () => {
      const credentialPath = process.env.VITRE_LIVE_CREDENTIAL_FILE;
      if (!credentialPath) throw new Error("Set VITRE_LIVE_CREDENTIAL_FILE");
      const credential = JSON.parse(await NodeFSP.readFile(credentialPath, "utf8"));
      if (credential.expiresAtEpochMs < Date.now() + 600_000)
        throw new Error("Refresh the desktop cloud credential first");
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "vitre-live-handoff-"),
      );
      const workspace = NodePath.join(directory, "workspace");
      if (cloudTarget === "cloud-github") {
        const repository = process.env.VITRE_LIVE_GITHUB_REPOSITORY;
        if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
          throw new Error("Set VITRE_LIVE_GITHUB_REPOSITORY to a disposable-access repository");
        await exec("git", ["clone", `https://github.com/${repository}.git`, workspace]);
        await exec("git", ["config", "user.name", "Vitre verification"], { cwd: workspace });
        await exec("git", ["config", "user.email", "verification@example.invalid"], {
          cwd: workspace,
        });
      } else await NodeFSP.mkdir(workspace);
      await NodeFSP.writeFile(NodePath.join(workspace, "baseline.txt"), "local baseline\n");
      let unpublishedHead: string | undefined;
      if (cloudTarget === "cloud-github") {
        await exec("git", ["add", "baseline.txt"], { cwd: workspace });
        await exec("git", ["commit", "-m", "Unpublished round-trip fixture"], { cwd: workspace });
        unpublishedHead = (
          await exec("git", ["rev-parse", "HEAD"], { cwd: workspace })
        ).stdout.trim();
        await NodeFSP.writeFile(NodePath.join(workspace, "dirty.txt"), "staged fixture\n");
        await exec("git", ["add", "dirty.txt"], { cwd: workspace });
        await NodeFSP.writeFile(NodePath.join(workspace, "dirty.txt"), "unstaged fixture\n");
      }
      const binary = Buffer.from([0, 255, 128, 10, 42]);
      await NodeFSP.writeFile(NodePath.join(workspace, "binary-proof.bin"), binary);
      const relay = handoffRelay({
        relayUrl: "https://cloud.usevitre.app",
        accessToken: credential.accessToken,
      });
      const threadId = ThreadId.make(`proof-${NodeCrypto.randomUUID()}`);
      const projectId = ProjectId.make(`proof-${NodeCrypto.randomUUID()}`);
      let cloudTaskId: string | null = null;
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- This opt-in live harness owns a background coordinator across real network and filesystem operations.
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
                    accessToken: credential.accessToken,
                    refreshToken: credential.refreshToken,
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
                env: {
                  VITRE_CLOUD_DESKTOP_ENABLED: "true",
                  T3CODE_RELAY_URL: "https://cloud.usevitre.app",
                },
              }),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      );

      const tracePath = NodePath.join(directory, "progress.json");
      let tracing = false;
      const monitor = setInterval(async () => {
        if (tracing) return;
        tracing = true;
        try {
          const service = await runtime.runPromise(Effect.service(CloudHandoffService));
          const status = await runtime.runPromise(service.status(threadId));
          await NodeFSP.writeFile(
            tracePath,
            JSON.stringify({
              phase: status.operation?.phase,
              error: status.operation?.error,
              target: status.binding?.target,
            }),
          );
        } catch {
          /* The final assertion reports failures. */
        } finally {
          tracing = false;
        }
      }, 5000);
      try {
        const service = await runtime.runPromise(Effect.service(CloudHandoffService));
        const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
        const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
        const modelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        };
        const createdAt = new Date().toISOString();
        await runtime.runPromise(
          engine.dispatch({
            type: "project.create",
            commandId: CommandId.make(`${threadId}-project`),
            projectId,
            title: "Disposable cloud verification",
            workspaceRoot: workspace,
            defaultModelSelection: modelSelection,
            createdAt,
          }),
        );
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${threadId}-create`),
            threadId,
            projectId,
            title: "Disposable handoff verification",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        );
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.history.import",
            commandId: CommandId.make(`${threadId}-history`),
            threadId,
            messages: [
              {
                id: MessageId.make(`${threadId}-seed`),
                role: "user",
                text: "This is a disposable workspace for cloud handoff verification.",
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
        const move = async (target: "local" | "cloud-local" | "cloud-github") => {
          await runtime.runPromise(
            service.request({
              idempotencyKey: `${threadId}-${target}`,
              conversationId: threadId,
              localThreadId: threadId,
              cloudTaskId,
              target,
            }),
          );
          let lastPhase = "";
          const deadline = Date.now() + 600_000;
          while (Date.now() < deadline) {
            await runtime.runPromise(service.advancePending);
            const status = await runtime.runPromise(service.status(threadId));
            cloudTaskId = status.binding?.cloudTaskId ?? cloudTaskId;
            const label = `${status.operation?.phase}: ${status.operation?.error ?? ""}`;
            if (label !== lastPhase) {
              console.log(label);
              lastPhase = label;
            }
            const overview = await relay.overview();
            const destination = overview.tasks.find(
              (task) => task.handoff?.conversationId === threadId,
            );
            if (destination?.state === "failed")
              throw new Error(destination.error ?? "Cloud workspace preparation failed");
            if (status.operation?.phase === "completed") return status;
            if (status.operation?.phase === "cancelled") throw new Error("Handoff was cancelled");
            await NodeTimersPromises.setTimeout(3000);
          }
          throw new Error("Live handoff exceeded ten minutes");
        };
        const moved = await move(cloudTarget);
        expect(moved.binding?.target).toBe(cloudTarget);
        if (process.env.VITRE_LIVE_EXPECT_COMPUTE === "machine") {
          const task = (await relay.overview()).tasks.find(
            (t) => t.id === moved.binding?.cloudTaskId,
          );
          expect(task?.worker?.sandboxId).toMatch(/^machine-/);
        }
        cloudTaskId = moved.binding!.cloudTaskId;
        const request = await relay.environment(cloudTaskId!);
        const remoteId = `cloud-${cloudTaskId}`;
        const before = (await request(`/api/orchestration/threads/${remoteId}`)) as {
          thread: OrchestrationThread;
        };
        expect(before.thread.messages.some((m) => m.id === `${threadId}-seed`)).toBe(true);
        await relay.api("/commands", {
          type: "task.continue",
          idempotencyKey: `${threadId}-run`,
          taskId: cloudTaskId,
          prompt:
            "Create a file cloud-proof.txt containing exactly cloud round trip verified followed by a newline. Do not modify other files or run additional commands. Then reply done.",
          attachments: [],
        });
        const deadline = Date.now() + 180_000;
        let done = false;
        while (Date.now() < deadline) {
          const overview = await relay.overview();
          const task = overview.tasks.find((t) => t.id === cloudTaskId);
          if (task && ["failed", "needs_auth", "usage_limited"].includes(task.state)) {
            const saved = (await relay.api(`/tasks/${cloudTaskId}/events?after=0`)) as {
              conversation?: OrchestrationThread;
            };
            throw new Error(
              saved.conversation?.session?.lastError ??
                task.error ??
                "Disposable provider task failed",
            );
          }
          const snapshot = (await request(`/api/orchestration/threads/${remoteId}`)) as {
            thread: OrchestrationThread;
          };
          if (
            snapshot.thread.messages.some((m) => m.role === "assistant" && m.text.trim()) &&
            task?.idle
          ) {
            done = true;
            break;
          }
          await NodeTimersPromises.setTimeout(3000);
        }
        expect(done, "Provider turn did not finish within three minutes").toBe(true);
        await NodeFSP.writeFile(
          NodePath.join(workspace, "local-only.txt"),
          "independent local edit",
        );
        const returned = await move("local");
        expect(returned.binding?.target).toBe("local");
        const local = await runtime.runPromise(query.getThreadDetailById(threadId));
        if (Option.isNone(local)) throw new Error("Returned conversation missing");
        expect(
          await NodeFSP.readFile(
            NodePath.join(local.value.worktreePath!, "cloud-proof.txt"),
            "utf8",
          ),
        ).toBe("cloud round trip verified\n");
        expect(
          await NodeFSP.readFile(
            NodePath.join(local.value.worktreePath!, "local-only.txt"),
            "utf8",
          ),
        ).toBe("independent local edit");
        expect(local.value.messages.filter((m) => m.id === `${threadId}-seed`)).toHaveLength(1);
        expect((await runtime.runPromise(readExecutionOwnership(threadId))).status).toBe("active");
        expect(
          await NodeFSP.readFile(NodePath.join(local.value.worktreePath!, "binary-proof.bin")),
        ).toEqual(binary);
        expect(
          await NodeFSP.readFile(NodePath.join(local.value.worktreePath!, "baseline.txt"), "utf8"),
        ).toBe("local baseline\n");
        if (unpublishedHead) {
          const cwd = local.value.worktreePath!;
          expect((await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim()).toBe(
            unpublishedHead,
          );
          expect((await exec("git", ["show", ":dirty.txt"], { cwd })).stdout).toBe(
            "staged fixture\n",
          );
          expect(await NodeFSP.readFile(NodePath.join(cwd, "dirty.txt"), "utf8")).toBe(
            "unstaged fixture\n",
          );
        }
        console.log(`VITRE_LIVE_HANDOFF_PASS ${cloudTarget}`);
      } finally {
        clearInterval(monitor);
        await runtime.dispose();
        const overview = await relay.overview();
        for (const operation of overview.handoffs ?? []) {
          if (
            operation.conversationId === threadId &&
            !["completed", "cancelled", "failed", "activating", "releasing"].includes(
              operation.phase,
            )
          )
            await relay.api("/commands", {
              type: "handoff.cancel",
              idempotencyKey: `${operation.id}-cleanup`,
              operationId: operation.id,
            });
        }
        const tasks = overview.tasks.filter(
          (task) => task.id === cloudTaskId || task.handoff?.conversationId === threadId,
        );
        for (const task of tasks) {
          await relay.api("/commands", {
            type: "task.delete",
            idempotencyKey: `${threadId}-cleanup-${task.id}`,
            taskId: task.id,
          });
        }
        console.log(`Deleted ${tasks.length} disposable cloud tasks`);
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
    1_500_000,
  );
}
