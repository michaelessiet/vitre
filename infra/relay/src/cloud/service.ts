// @effect-diagnostics preferSchemaOverJson:off - Validate the provider-owned opaque authentication cache without re-encoding or losing provider fields.
import type {
  CloudCommand,
  CloudOverview,
  CloudProvider,
  CloudWorkerCallback,
} from "@t3tools/contracts/cloud";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CloudArtifacts } from "./artifacts.ts";
import {
  readWorkspace,
  uploadedGitHead,
  verifyAttachments,
  verifyConversationBlob,
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
export const currentMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

export class CloudService extends Context.Service<
  CloudService,
  {
    readonly overview: (userId: string) => Effect.Effect<CloudOverview, CloudError>;
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
      overview: Effect.fn("cloud.overview")(function* (userId) {
        yield* allowed(userId);
        const document = yield* store.read(userId);
        return publicOverview(document.state, config.enabled, yield* currentMillis);
      }),
      command: Effect.fn("cloud.command")(function* (userId, command) {
        yield* allowed(userId);
        const now = yield* currentMillis;
        const id = yield* cryptoService.randomUUIDv4.pipe(Effect.orDie);
        const fingerprint = yield* fromPromise(() => sha256(JSON.stringify(command)));
        let resolved: { sha: string; repositoryRevision: number } | undefined;
        let snapshotHead: string | null = null;
        if (command.type === "task.create" && command.handoff) {
          yield* verifyConversationBlob(userId, command.handoff.history).pipe(
            Effect.provideService(CloudArtifacts, artifacts),
          );
        }
        if (
          (command.type === "task.create" || command.type === "task.continue") &&
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
          acceptCallback(document.state, callback, now);
        });
        yield* wake(userId);
      }),
    });
  }),
);
