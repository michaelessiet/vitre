// @effect-diagnostics preferSchemaOverJson:off - Validate the provider-owned opaque authentication cache without re-encoding or losing provider fields.
import type {
  CloudCommand,
  CloudOverview,
  CloudProvider,
  CloudWorkerCallback,
  CloudProjectSnapshot,
  CloudMobileDeviceRegistration,
} from "@t3tools/contracts/cloud";
import { backfillProjects, projectSnapshot, projectSnapshots } from "./projects.ts";
import { CloudWorkspaceManifest } from "@t3tools/contracts/cloud";
import * as Schema from "effect/Schema";
import { enqueueCloudNotification } from "./notifications.ts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CloudArtifacts, finalizeManifest, type CheckpointManifest } from "./artifacts.ts";
import {
  readWorkspace,
  uploadedGitHead,
  verifyAttachments,
  verifyConversationBlob,
  finalizeWorkspace,
} from "./workspaces.ts";
import { CloudConfiguration } from "./config.ts";
import { CredentialVault, sha256 } from "./crypto.ts";
import { CloudError, iso } from "./policy.ts";
import { CloudStore } from "./store.ts";
import { GitHubCloudClient } from "./github.ts";
import { validateSubscriptionCredential } from "./subscription.ts";
import {
  acceptCallback,
  applyCommand,
  isResidentWorker,
  publicOverview,
  schedule,
} from "./state.ts";

export const fromPromise = <A>(body: () => Promise<A>): Effect.Effect<A, CloudError> =>
  Effect.tryPromise({
    try: body,
    catch: (error) =>
      error instanceof CloudError
        ? error
        : new CloudError(
            "cloud_unavailable",
            "Cloud operation failed; retry or inspect server diagnostics",
            503,
          ),
  });
const decodeWorkspaceManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CloudWorkspaceManifest),
);
export const currentMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

export class CloudService extends Context.Service<
  CloudService,
  {
    readonly overview: (userId: string) => Effect.Effect<CloudOverview, CloudError>;
    readonly registerMobileDevice: (
      userId: string,
      registration: CloudMobileDeviceRegistration,
    ) => Effect.Effect<void, CloudError>;
    readonly projectSnapshots: (
      userId: string,
      projectId: string,
    ) => Effect.Effect<CloudProjectSnapshot[], CloudError>;
    readonly command: (
      userId: string,
      command: CloudCommand,
    ) => Effect.Effect<{ entityId: string; overview: CloudOverview }, CloudError>;
    readonly saveCredential: (
      userId: string,
      provider: CloudProvider,
      credential: string,
      expectedVersion: number,
      idempotencyKey: string,
    ) => Effect.Effect<void, CloudError>;
    readonly callback: (
      token: string,
      callback: CloudWorkerCallback,
    ) => Effect.Effect<void, CloudError>;
  }
>()("t3code-relay/cloud/service/CloudService") {}

export const layer = Layer.effect(
  CloudService,
  Effect.gen(function* () {
    const config = yield* CloudConfiguration;
    const artifacts = yield* CloudArtifacts;
    const cryptoService = yield* Crypto.Crypto;
    const store = yield* CloudStore;
    const allowed = (userId: string) =>
      config.allowedUserId && userId === config.allowedUserId
        ? Effect.void
        : Effect.fail(
            new CloudError(
              "forbidden",
              "This account cannot access this personal cloud deployment",
              403,
            ),
          );
    const wake = (userId: string) => config.wake(userId).pipe(Effect.ignore); // durable outbox + cron cover a lost wakeup
    return CloudService.of({
      registerMobileDevice: Effect.fn("cloud.mobile_register")(function* (userId, registration) {
        yield* allowed(userId);
        const now = yield* currentMillis;
        const device =
          registration.token === null
            ? null
            : {
                platform: registration.platform,
                updatedAt: now,
                token: yield* fromPromise(() =>
                  new CredentialVault(config.encryptionKey).seal(
                    registration.token!,
                    `${userId}:mobile:${registration.deviceId}`,
                  ),
                ),
                tokenHash: yield* fromPromise(() => sha256(registration.token!)),
              };
        yield* store.mutate(userId, (doc) => {
          const devices = (doc.private.mobileDevices ??= {});
          if (device) {
            if (!devices[registration.deviceId] && Object.keys(devices).length >= 20)
              throw new CloudError(
                "device_limit",
                "Remove an old mobile device before registering another",
                400,
              );
            devices[registration.deviceId] = device;
          } else delete devices[registration.deviceId];
        });
      }),
      overview: Effect.fn("cloud.overview")(function* (userId) {
        yield* allowed(userId);
        let document = yield* store.read(userId);
        if (
          !document.state.projects ||
          Object.values(document.state.tasks).some(
            (task) => !task.projectId && !document.state.deletedTasks.includes(task.id),
          )
        ) {
          yield* store.mutate(userId, (doc) => backfillProjects(doc.state));
          document = yield* store.read(userId);
        }
        return publicOverview(document.state, config.enabled, yield* currentMillis);
      }),
      projectSnapshots: Effect.fn("cloud.project_snapshots")(function* (userId, projectId) {
        yield* allowed(userId);
        const snapshots = yield* store.mutate(userId, (doc) => {
          backfillProjects(doc.state);
          return projectSnapshots(doc.state, projectId);
        });
        // Backfilled uploads predate registry root metadata. Hydrate from the
        // immutable owned manifest, without contacting the original worker.
        for (const snapshot of snapshots) {
          if (!snapshot.workspace || snapshot.roots.length) continue;
          const manifest = yield* readWorkspace(userId, snapshot.workspace.sha256).pipe(
            Effect.provideService(CloudArtifacts, artifacts),
            Effect.flatMap((bytes) => decodeWorkspaceManifest(new TextDecoder().decode(bytes))),
            Effect.option,
          );
          if (manifest._tag === "None") continue;
          yield* store.mutate(userId, (doc) => {
            const saved = doc.state.projectSnapshots?.[projectId]?.[snapshot.id];
            if (!saved || saved.workspace?.sha256 !== snapshot.workspace?.sha256) return;
            const enriched = {
              ...saved,
              roots: manifest.value.roots.map(({ id, name }) => ({ id, name })),
              branch: manifest.value.roots[0]?.git?.branch ?? saved.branch ?? saved.baseBranch,
            };
            doc.state.projectSnapshots![projectId]![snapshot.id] = enriched;
            const project = doc.state.projects?.[projectId];
            if (project?.latestSnapshot?.id === snapshot.id)
              doc.state.projects![projectId] = { ...project, latestSnapshot: enriched };
          });
        }
        return projectSnapshots((yield* store.read(userId)).state, projectId);
      }),
      command: Effect.fn("cloud.command")(function* (userId, command) {
        yield* allowed(userId);
        const now = yield* currentMillis;
        const id = yield* cryptoService.randomUUIDv4.pipe(Effect.orDie);
        const fingerprint = yield* fromPromise(() => sha256(JSON.stringify(command)));
        const current = yield* store.read(userId);
        const receipt = current.state.receipts[command.idempotencyKey];
        if (receipt) {
          if (receipt.fingerprint !== fingerprint)
            return yield* Effect.fail(
              new CloudError(
                "idempotency_conflict",
                "Idempotency key was used for another request",
              ),
            );
          return {
            entityId: receipt.entityId,
            overview: publicOverview(current.state, config.enabled, now),
          };
        }
        if (command.type === "repository.save")
          command = {
            ...command,
            repository: yield* fromPromise(() =>
              new GitHubCloudClient(config.github).verifyRepository(
                (command as Extract<CloudCommand, { type: "repository.save" }>).repository,
                now,
              ),
            ),
          };
        if (command.type === "task.createFromProject") {
          backfillProjects(current.state);
          const { snapshot } = yield* Effect.try({
            try: () => projectSnapshot(current.state, command.projectId, command.snapshotId),
            catch: (error) => error as CloudError,
          });
          if (snapshot.workspace) {
            const bytes = yield* readWorkspace(userId, snapshot.workspace.sha256).pipe(
              Effect.provideService(CloudArtifacts, artifacts),
            );
            yield* finalizeWorkspace(userId, JSON.parse(new TextDecoder().decode(bytes))).pipe(
              Effect.provideService(CloudArtifacts, artifacts),
            );
          } else if (snapshot.checkpoint) {
            const bytes = yield* fromPromise(() => artifacts.get(snapshot.checkpoint!.objectKey));
            if (!bytes || (yield* fromPromise(() => sha256(bytes))) !== snapshot.checkpoint.sha256)
              return yield* Effect.fail(
                new CloudError(
                  "snapshot_unavailable",
                  "Saved workspace is missing or corrupt. Choose another snapshot.",
                  409,
                ),
              );
            const manifest = yield* Effect.try({
              try: () => JSON.parse(new TextDecoder().decode(bytes)) as CheckpointManifest,
              catch: () =>
                new CloudError("snapshot_unavailable", "Saved checkpoint metadata is corrupt", 409),
            });
            if (
              manifest.taskId !== snapshot.checkpoint.taskId ||
              manifest.attemptId !== snapshot.checkpoint.attemptId ||
              manifest.checkpointId !== snapshot.checkpoint.id
            )
              return yield* Effect.fail(
                new CloudError(
                  "snapshot_unavailable",
                  "Saved checkpoint identity does not match this project",
                  409,
                ),
              );
            yield* finalizeManifest(userId, manifest).pipe(
              Effect.provideService(CloudArtifacts, artifacts),
            );
          } else
            return yield* Effect.fail(
              new CloudError("snapshot_unavailable", "This project has no saved workspace", 409),
            );
        }
        let resolved: { sha: string; repositoryRevision: number } | undefined;
        let snapshotHead: string | null = null;
        if (command.type === "task.create" && command.handoff) {
          yield* verifyConversationBlob(userId, command.handoff.history).pipe(
            Effect.provideService(CloudArtifacts, artifacts),
          );
        }
        if (
          (command.type === "task.create" ||
            command.type === "task.createFromProject" ||
            command.type === "task.continue") &&
          command.attachments
        ) {
          yield* verifyAttachments(userId, command.attachments).pipe(
            Effect.provideService(CloudArtifacts, artifacts),
          );
        }
        if (command.type === "task.create" && command.source) {
          if (command.source.snapshot.id !== command.source.snapshot.sha256)
            return yield* Effect.fail(
              new CloudError("invalid_workspace", "Invalid workspace reference", 400),
            );
          const bytes = yield* readWorkspace(userId, command.source.snapshot.sha256).pipe(
            Effect.provideService(CloudArtifacts, artifacts),
          );
          if (command.source.kind === "github")
            snapshotHead = yield* Effect.try({
              try: () => uploadedGitHead(bytes),
              catch: (error) => error as CloudError,
            });
        }
        if (command.type === "task.create" && command.source?.kind !== "local" && config.enabled) {
          const document = yield* store.read(userId);
          if (!document.state.receipts[command.idempotencyKey]) {
            const repository = document.state.repositories[command.repositoryId];
            if (!repository)
              return yield* Effect.fail(
                new CloudError("not_found", "Repository not configured", 404),
              );
            const revision = snapshotHead
              ? { sha: snapshotHead }
              : yield* fromPromise(() =>
                  new GitHubCloudClient(config.github).resolve(
                    repository,
                    command.source?.kind === "github"
                      ? command.source.revision
                      : command.baseBranch,
                    now,
                  ),
                );
            resolved = { sha: revision.sha, repositoryRevision: repository.revision };
          }
        }
        const result = yield* store.mutate(userId, (document) => {
          if (
            command.type === "task.create" &&
            command.source?.kind !== "local" &&
            !document.state.receipts[command.idempotencyKey] &&
            document.state.repositories[command.repositoryId]?.revision !==
              resolved?.repositoryRevision &&
            config.enabled
          ) {
            throw new CloudError(
              "revision_conflict",
              "Repository settings changed while resolving the branch; retry",
            );
          }
          const entityId = applyCommand(
            document.state,
            command,
            id,
            fingerprint,
            now,
            config.enabled,
          );
          if (command.type === "task.create" && entityId === id && resolved)
            document.state.tasks[id]!.baseSha = resolved.sha;
          backfillProjects(document.state);
          if (command.type === "provider.disconnect")
            delete document.private.credentials[command.provider];
          schedule(document.state, now, config.enabled, Boolean(config.machine));
          const task = document.state.tasks[entityId];
          const warmContinuation =
            command.type === "task.continue" &&
            Boolean(config.machine) &&
            task?.state === "running" &&
            task.worker?.state === "ready" &&
            isResidentWorker(task);
          return {
            response: { entityId, overview: publicOverview(document.state, config.enabled, now) },
            // A ready resident already polls for its next turn. Avoid making the
            // caller wait for an R2 marker and queue send when no scheduler work
            // exists. Cold starts, stops and unrelated outbox work still wake it.
            needsWake: !warmContinuation || Object.keys(document.state.operations).length > 0,
          };
        });
        if (result.needsWake) yield* wake(userId);
        return result.response;
      }),
      saveCredential: Effect.fn("cloud.save_credential")(
        function* (userId, provider, credential, expectedVersion, idempotencyKey) {
          yield* allowed(userId);
          if (!config.enabled)
            return yield* Effect.fail(
              new CloudError("disabled", "Cloud execution is disabled", 503),
            );
          yield* Effect.try({
            try: () => validateSubscriptionCredential(provider, credential),
            catch: () =>
              new CloudError("invalid_credential", "Use valid subscription credentials", 400),
          });
          const version = expectedVersion + 1;
          const fingerprint = yield* fromPromise(() =>
            sha256(
              JSON.stringify({
                type: "provider.credential",
                provider,
                credential,
                expectedVersion,
              }),
            ),
          );
          const sealed = yield* fromPromise(() =>
            new CredentialVault(config.encryptionKey).seal(
              credential,
              `${userId}:${provider}:${version}`,
            ),
          );
          const now = yield* currentMillis;
          yield* store.mutate(userId, (document) => {
            const receipt = document.state.receipts[idempotencyKey];
            if (receipt) {
              if (receipt.fingerprint !== fingerprint)
                throw new CloudError(
                  "idempotency_conflict",
                  "Idempotency key was used for another request",
                );
              return;
            }
            const account = document.state.accounts[provider];
            if (account.credentialVersion !== expectedVersion || account.leasedBy)
              throw new CloudError(
                "credential_conflict",
                "Stop current provider work and reload account status before replacing credentials",
              );
            document.private.credentials[provider] = { version, sealed };
            account.credentialVersion = version;
            account.state = "connected";
            document.state.receipts[idempotencyKey] = { fingerprint, entityId: provider };
            for (const task of Object.values(document.state.tasks))
              if (task.provider === provider && task.state === "needs_auth" && !task.attempt) {
                task.state = "queued";
                task.updatedAt = iso(now);
              }
            schedule(document.state, now, config.enabled, Boolean(config.machine));
          });
          yield* wake(userId);
        },
      ),
      callback: Effect.fn("cloud.worker_callback")(function* (token, callback) {
        const userId = config.allowedUserId;
        if (!userId || !token)
          return yield* Effect.fail(
            new CloudError("unauthorized", "Invalid worker credential", 401),
          );
        const hash = yield* fromPromise(() => sha256(token));
        const now = yield* currentMillis;
        yield* store.mutate(userId, (document) => {
          const credential = document.private.workerTokens[callback.taskId];
          if (!credential || credential.hash !== hash)
            throw new CloudError("unauthorized", "Invalid worker credential", 401);
          // Completion is accepted only by the artifact finalizer after upload verification.
          if (callback.checkpoint || callback.result || callback.phase === "completed")
            throw new CloudError(
              "artifact_required",
              "Use the artifact finalization endpoint to complete a task",
              400,
            );
          if (
            acceptCallback(document.state, callback, now) &&
            ["failed", "needs_auth", "usage_limited"].includes(callback.phase)
          ) {
            const task = document.state.tasks[callback.taskId]!;
            enqueueCloudNotification(
              document,
              task,
              "failed",
              task.turnRequestId ?? callback.attemptId,
              now,
            );
          }
          backfillProjects(document.state);
        });
        yield* wake(userId);
      }),
    });
  }),
);
