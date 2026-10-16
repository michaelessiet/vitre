// @effect-diagnostics preferSchemaOverJson:off - Encrypted endpoint envelopes are opaque JSON.
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ManagedEndpointProvider } from "../environments/ManagedEndpointProvider.ts";
import { CloudConfiguration, type CloudConfigurationValue } from "./config.ts";
import { CredentialVault, sha256 } from "./crypto.ts";
import { computeExecutor } from "./compute.ts";
import { CLOUD_POLICY, CloudError, iso } from "./policy.ts";
import { currentMillis, fromPromise } from "./service.ts";
import { confirmStopped, schedule, type CloudOperation } from "./state.ts";
import { CloudStore } from "./store.ts";
import { CloudAuxiliary } from "./auxiliary.ts";
import { CloudArtifacts } from "./artifacts.ts";

export class CloudScheduler extends Context.Service<
  CloudScheduler,
  {
    readonly tick: (userId: string) => Effect.Effect<void, CloudError>;
  }
>()("t3code-relay/cloud/scheduler/CloudScheduler") {}

/** Persistent machines survive a stop, so their worker endpoint is worth keeping. */
function isPersistentMachineWorker(
  config: CloudConfigurationValue,
  worker: { sandboxId?: string | null } | null | undefined,
) {
  return Boolean(config.machine) && Boolean(worker?.sandboxId?.startsWith("machine-"));
}

export const layer = Layer.effect(
  CloudScheduler,
  Effect.gen(function* () {
    const config = yield* CloudConfiguration;
    const cryptoService = yield* Crypto.Crypto;
    const store = yield* CloudStore;
    const auxiliary = yield* CloudAuxiliary;
    const artifacts = yield* CloudArtifacts;
    const tunnels = yield* ManagedEndpointProvider;
    const executor = computeExecutor(config);

    const processOperation = Effect.fn("cloud.process_operation")(function* (
      userId: string,
      operation: CloudOperation,
    ) {
      const current = yield* store.read(userId);
      const task = current.state.tasks[operation.taskId];
      if (!task) return true;
      if (operation.attemptId !== task.attempt?.id) return true;
      const now = yield* currentMillis;
      if (operation.kind === "provision") {
        if (task.state !== "preparing" || !task.attempt || !task.worker) return true;
        const vault = new CredentialVault(config.encryptionKey);
        let credential = current.private.workerTokens[task.id];
        if (!credential) {
          const token =
            (yield* cryptoService.randomUUIDv4.pipe(Effect.orDie)) +
            (yield* cryptoService.randomUUIDv4.pipe(Effect.orDie));
          const sealed = yield* fromPromise(() => vault.seal(token, `${userId}:worker:${task.id}`));
          const hash = yield* fromPromise(() => sha256(token));
          credential = yield* store.mutate(userId, (document) => {
            document.private.workerTokens[task.id] ??= { hash, sealed };
            return document.private.workerTokens[task.id]!;
          });
        }
        const token = yield* fromPromise(() =>
          vault.open(credential.sealed, `${userId}:worker:${task.id}`),
        );
        const backendPort = executor.prepare
          ? (yield* fromPromise(() => executor.prepare!(task.attempt!.id))).port
          : 3773;
        // Reserve endpoint capacity before starting paid compute. A persistent
        // machine keeps its endpoint across stops so a wake reconnects through the
        // same hostname (no DNS or tunnel churn); it only needs re-provisioning
        // when the machine allocated a different backend port this time.
        const retained = current.private.endpoints[task.id]
          ? (JSON.parse(
              yield* fromPromise(() =>
                vault.open(current.private.endpoints[task.id]!, `${userId}:endpoint:${task.id}`),
              ),
            ) as { backendPort?: number })
          : null;
        if (!retained || retained.backendPort !== backendPort) {
          const endpoint = yield* tunnels
            .provision({
              userId,
              environmentId: task.worker.environmentId,
              origin: { localHttpHost: "127.0.0.1", localHttpPort: backendPort },
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "ManagedTunnelLimitExceeded"
                  ? new CloudError(
                      "endpoint_capacity_exceeded",
                      `Cloud endpoint capacity reached: ${error.activeTunnels} of ${error.maxTunnels} endpoints in use. Increase your account capacity or delete an unused cloud conversation.`,
                      429,
                    )
                  : new CloudError(
                      "tunnel_unavailable",
                      "Could not provision the worker endpoint",
                      503,
                    ),
              ),
            );
          const sealed = yield* fromPromise(() =>
            vault.seal(
              JSON.stringify({ ...endpoint, backendPort }),
              `${userId}:endpoint:${task.id}`,
            ),
          );
          yield* store.mutate(userId, (document) => {
            document.private.endpoints[task.id] = sealed;
          });
        }
        if ((yield* store.read(userId)).state.tasks[task.id]?.state !== "preparing") return true;
        const sandbox = yield* fromPromise(() =>
          executor.ensure(task.id, {
            controlUrl: config.controlUrl,
            attemptId: task.attempt!.id,
            deadlineAt: task.attempt!.deadlineAt,
            token,
          }),
        );
        yield* store.mutate(userId, (document) => {
          const t = document.state.tasks[task.id];
          if (t?.worker && t.attempt?.id === task.attempt?.id) {
            t.worker.sandboxId = sandbox.id;
            if (t.state === "preparing") t.worker.state = "starting";
          }
        });
        return true;
      }
      if (operation.kind === "stop" || operation.kind === "delete") {
        // Stable-name lookup also catches an unrecorded successful create.
        const sandbox = yield* fromPromise(() =>
          executor.get(task.worker?.sandboxId ?? executor.name(operation.attemptId!)),
        );
        if (sandbox) {
          const savedSinceStop =
            task.checkpoint?.attemptId === task.attempt?.id &&
            Date.parse(task.checkpoint!.createdAt) >= Date.parse(operation.createdAt);
          if (
            operation.kind === "stop" &&
            // A confirmed exited process cannot produce another checkpoint.
            // Older agents omit this fact and retain the normal grace period.
            sandbox.running !== false &&
            !savedSinceStop &&
            task.state !== "completed" &&
            now - Date.parse(operation.createdAt) < CLOUD_POLICY.shutdownCheckpointMs
          )
            return false;
          if (operation.kind === "delete") {
            yield* fromPromise(() => executor.delete(sandbox.id));
            // Confirm absence before releasing the provider-account lease.
            if (yield* fromPromise(() => executor.get(sandbox.id))) return false;
          } else yield* fromPromise(() => executor.stop(sandbox.id));
        }
        // Stopping a persistent machine worker keeps its endpoint for the next
        // wake; deleting the task releases it.
        const retainEndpoint =
          operation.kind === "stop" && isPersistentMachineWorker(config, task.worker);
        if (task.worker && !retainEndpoint) {
          yield* tunnels
            .deprovision({ userId, environmentId: task.worker.environmentId })
            .pipe(
              Effect.mapError(
                () =>
                  new CloudError(
                    "tunnel_cleanup_failed",
                    "Worker endpoint cleanup will be retried",
                    503,
                  ),
              ),
            );
        }
        if (operation.kind === "delete" && current.state.deletedTasks.includes(task.id)) {
          if (!artifacts.deletePrefix)
            return yield* Effect.fail(
              new CloudError("cleanup_unavailable", "Artifact deletion is not configured", 503),
            );
          yield* fromPromise(() =>
            artifacts.deletePrefix!(`cloud/${encodeURIComponent(userId)}/${task.id}/`),
          );
          yield* store.mutate(userId, (doc) => {
            delete doc.state.projections?.[task.id];
            delete doc.state.events?.[task.id];
            const t = doc.state.tasks[task.id];
            if (t) {
              t.checkpoint = null;
              t.result = null;
            }
            for (const p of Object.values(doc.state.publications))
              if (p.taskId === task.id) delete doc.state.publicationInputs?.[p.id];
          });
        }
        yield* store.mutate(userId, (document) => {
          if (task.attempt)
            confirmStopped(
              document.state,
              task.id,
              task.attempt.id,
              now,
              operation.kind === "delete",
            );
          if (!retainEndpoint) delete document.private.endpoints[task.id];
          if (operation.kind === "delete") delete document.private.workerTokens[task.id];
        });
        // Continue queued work after confirmed lease release, without waiting for cron.
        yield* config.wake(userId).pipe(Effect.ignore);
        return true;
      }
      // Drain historical pause/resume operations without replaying provider requests.
      if (operation.kind === "pause" || operation.kind === "resume") return true;
      // Publication has a separate consumer; never execute it in an agent worker.
      return false;
    });

    return CloudScheduler.of({
      tick: Effect.fn("cloud.scheduler_tick")(function* (userId) {
        if (!config.allowedUserId || userId !== config.allowedUserId) return;
        const now = yield* currentMillis;
        const claimToken = yield* cryptoService.randomUUIDv4.pipe(Effect.orDie);
        const operations = yield* store.mutate(userId, (document) => {
          schedule(document.state, now, config.enabled && Boolean(config.machine), true);
          // Reconcile endpoints retained by older runtimes, using the same per-task
          // operation claim as provisioning so a concurrent wake cannot race cleanup.
          // Stopped persistent-machine workers keep theirs on purpose.
          for (const task of Object.values(document.state.tasks)) {
            if (
              task.attempt &&
              task.worker &&
              ["stopped", "deleted"].includes(task.worker.state) &&
              document.private.endpoints[task.id] &&
              !(
                task.worker.state === "stopped" && isPersistentMachineWorker(config, task.worker)
              ) &&
              !Object.values(document.state.operations).some((op) => op.taskId === task.id)
            ) {
              const id = `${task.attempt.id}-endpoint-cleanup`;
              document.state.operations[id] = {
                id,
                taskId: task.id,
                attemptId: task.attempt.id,
                kind: "stop",
                createdAt: iso(now - CLOUD_POLICY.shutdownCheckpointMs),
                claimUntil: null,
                claimToken: null,
                failures: 0,
              };
            }
          }
          const claimed: CloudOperation[] = [];
          const busy = new Set(
            Object.values(document.state.operations)
              .filter((o) => o.claimUntil && Date.parse(o.claimUntil) > now)
              .map((o) => o.taskId),
          );
          for (const op of Object.values(document.state.operations)) {
            if (busy.has(op.taskId) || op.kind === "publish") continue;
            op.claimUntil = iso(now + 300_000);
            op.claimToken = claimToken;
            claimed.push(structuredClone(op));
            busy.add(op.taskId);
            if (claimed.length >= 2) break;
          }
          return claimed;
        });
        yield* Effect.forEach(
          operations,
          (operation) =>
            processOperation(userId, operation).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  store.mutate(userId, (document) => {
                    const op = document.state.operations[operation.id];
                    if (op?.claimToken !== claimToken) return;
                    op.claimToken = null;
                    op.claimUntil = null;
                    op.failures++;
                    const task = document.state.tasks[operation.taskId];
                    if (task) task.error = error.message;
                  }),
                onSuccess: (done) =>
                  store.mutate(userId, (document) => {
                    const op = document.state.operations[operation.id];
                    if (op?.claimToken !== claimToken) return;
                    if (done) {
                      delete document.state.operations[operation.id];
                      const task = document.state.tasks[operation.taskId];
                      if (
                        operation.kind === "provision" &&
                        task?.attempt?.id === operation.attemptId &&
                        ["preparing", "running", "waiting_for_input"].includes(task.state)
                      )
                        task.error = null;
                    } else {
                      op.claimToken = null;
                      op.claimUntil = null;
                    }
                  }),
              }),
            ),
          { concurrency: 2, discard: true },
        );
        // Dispatch claimed task work before auxiliary jobs and orphan inventory.
        // Maintenance can involve slow external calls; it must not hold up a wake.
        // Auxiliary cleanup wakes scheduling again when it releases capacity.
        yield* auxiliary.tick(userId);
        // Only the reserved installation prefix and valid attempt names are eligible.
        const owned = config.machine
          ? yield* fromPromise(() => executor.owned()).pipe(Effect.orElseSucceed(() => []))
          : [];
        for (const sandbox of owned) {
          const latest = yield* store.read(userId);
          if (
            !Object.values(latest.state.tasks).some((t) => t.attempt?.id === sandbox.attemptId) &&
            !latest.state.jobs?.[sandbox.attemptId]
          )
            yield* fromPromise(() => executor.delete(sandbox.id)).pipe(
              Effect.catch(() => Effect.void),
            );
        }
      }),
    });
  }),
);
