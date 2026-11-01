import type { LensModelReply } from "@t3tools/contracts/lens";
import { completeLens, tickLens } from "./lens.ts";
// @effect-diagnostics preferSchemaOverJson:off - Immutable checkpoint manifests and encrypted credential envelopes.
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CloudConfiguration } from "./config.ts";
import { CloudStore } from "./store.ts";
import { CloudArtifacts, artifactPrefix, type CheckpointManifest } from "./artifacts.ts";
import { CredentialVault, sha256 } from "./crypto.ts";
import { computeExecutor } from "./compute.ts";
import { GitHubCloudClient, githubForRequest } from "./github.ts";
import { accrueJobs, reserveJob } from "./jobs.ts";
import { CloudError, iso } from "./policy.ts";
import { currentMillis, fromPromise } from "./service.ts";
import { validateSubscriptionCredential } from "./subscription.ts";

export const make = Effect.gen(function* () {
  const config = yield* CloudConfiguration;
  const store = yield* CloudStore;
  const artifacts = yield* CloudArtifacts;
  const crypto = yield* Crypto.Crypto;
  const executor = computeExecutor(config);
  const github = githubForRequest(config.github).pipe(
    Effect.map(
      (configuration) => new GitHubCloudClient(configuration, fetch, config.allowedUserId),
    ),
  );
  const vault = () => new CredentialVault(config.encryptionKey);
  const own = (userId: string) =>
    userId === config.allowedUserId && !!userId
      ? Effect.void
      : Effect.fail(new CloudError("forbidden", "Account cannot access this deployment", 403));
  const authenticate = Effect.fnUntraced(function* (id: string, token: string) {
    const doc = yield* store.read(config.allowedUserId);
    if (!token || doc.private.workerTokens[id]?.hash !== (yield* fromPromise(() => sha256(token))))
      return yield* Effect.fail(
        new CloudError("unauthorized", "Invalid auxiliary worker credential", 401),
      );
    const job = doc.state.jobs?.[id];
    if (!job || job.deleted || job.state === "failed")
      return yield* Effect.fail(new CloudError("stale_worker", "Auxiliary worker stopped"));
    return { doc, job };
  });
  const manifestFor = Effect.fnUntraced(function* (id: string) {
    const doc = yield* store.read(config.allowedUserId);
    const job = doc.state.jobs?.[id];
    const task = job?.publicationId ? doc.state.publicationInputs?.[job.publicationId] : null;
    if (!task?.checkpoint || !task.result)
      return yield* Effect.fail(
        new CloudError("not_found", "Reviewed checkpoint is unavailable", 404),
      );
    const bytes = yield* fromPromise(() => artifacts.get(task.checkpoint!.objectKey));
    if (!bytes || (yield* fromPromise(() => sha256(bytes))) !== task.result.sha256)
      return yield* Effect.fail(
        new CloudError("artifact_changed", "Reviewed checkpoint failed integrity verification"),
      );
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as CheckpointManifest;
    return { task, manifest };
  });

  return {
    publicRepository: Effect.fn("cloud.public_repository")(function* (
      userId: string,
      owner: string,
      name: string,
    ) {
      yield* own(userId);
      const client = yield* github;
      return yield* fromPromise(() => client.publicRepository(owner, name));
    }),
    repositories: Effect.fn("cloud.available_repositories")(function* (userId: string) {
      yield* own(userId);
      const now = yield* currentMillis;
      const client = yield* github;
      return yield* fromPromise(() => client.repositories(now));
    }),
    login: Effect.fnUntraced(function* (userId: string, key: string) {
      yield* own(userId);
      if (!config.enabled)
        return yield* Effect.fail(new CloudError("disabled", "Cloud execution is disabled", 503));
      const now = yield* currentMillis;
      const id = `login-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
      const result = yield* store.mutate(userId, (doc) => {
        const prior = doc.state.receipts[key];
        if (prior) {
          if (prior.fingerprint !== "codex.login")
            throw new CloudError("idempotency_conflict", "Idempotency key was already used");
          return prior.entityId;
        }
        const pending = Object.values(doc.state.jobs ?? {}).find(
          (job) =>
            job.kind === "login" && !job.deleted && ["starting", "running"].includes(job.state),
        );
        if (pending) {
          doc.state.receipts[key] = { fingerprint: "codex.login", entityId: pending.id };
          return pending.id;
        }
        reserveJob(doc.state, id, "login", now);
        doc.state.receipts[key] = { fingerprint: "codex.login", entityId: id };
        return id;
      });
      yield* config.wake(userId);
      return { id: result };
    }),
    status: Effect.fnUntraced(function* (userId: string, id: string) {
      yield* own(userId);
      const doc = yield* store.read(userId);
      const job = doc.state.jobs?.[id];
      if (!job || job.kind !== "login")
        return yield* Effect.fail(new CloudError("not_found", "Login not found", 404));
      return {
        id,
        state: job.state,
        verificationUrl: job.verificationUrl,
        userCode: job.userCode,
        error: job.error,
      };
    }),
    bootstrap: Effect.fnUntraced(function* (id: string, token: string) {
      const { doc, job } = yield* authenticate(id, token);
      if (job.state === "completed") return { kind: job.kind, done: true };
      if (job.kind === "login")
        return { kind: "login", done: false, deadlineAt: job.deadlineAt, sequence: job.sequence };
      if (job.kind === "lens") {
        const provider = job.provider ?? "codex";
        const account = doc.state.accounts[provider];
        const credential = doc.private.credentials[provider];
        const run = doc.state.lens?.run;
        if (
          !run ||
          run.id !== id ||
          !credential ||
          account.leasedBy !== id ||
          account.credentialVersion !== job.credentialVersion
        )
          return yield* Effect.fail(new CloudError("stale_worker", "Lens model access changed."));
        return {
          kind: "lens",
          done: false,
          deadlineAt: job.deadlineAt,
          sequence: job.sequence,
          prompt: run.prompt,
          model: run.model,
          credential: yield* fromPromise(() =>
            vault().open(
              credential.sealed,
              `${config.allowedUserId}:${provider}:${credential.version}`,
            ),
          ),
        };
      }
      const { task, manifest } = yield* manifestFor(id);
      const publication = doc.state.publications[job.publicationId!]!;
      const now = yield* currentMillis;
      const client = yield* github;
      return {
        kind: "publication",
        done: false,
        task,
        publication,
        manifest,
        deadlineAt: job.deadlineAt,
        sequence: job.sequence,
        repositoryToken: yield* fromPromise(() =>
          client.repositoryToken(task.repository, now, "write"),
        ),
      };
    }),
    chunk: Effect.fnUntraced(function* (id: string, token: string, index: number) {
      yield* authenticate(id, token);
      const { task, manifest } = yield* manifestFor(id);
      const chunk = manifest.chunks[index];
      if (!chunk || chunk.index !== index)
        return yield* Effect.fail(new CloudError("not_found", "Chunk not found", 404));
      const prefix = artifactPrefix(
        config.allowedUserId,
        task.id,
        manifest.attemptId,
        manifest.checkpointId,
      );
      const bytes = yield* fromPromise(() => artifacts.get(`${prefix}/${index}-${chunk.sha256}`));
      if (
        !bytes ||
        bytes.length !== chunk.sizeBytes ||
        (yield* fromPromise(() => sha256(bytes))) !== chunk.sha256
      )
        return yield* Effect.fail(
          new CloudError("artifact_changed", "Publication artifact integrity failure"),
        );
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { base64: btoa(binary) };
    }),
    callback: Effect.fnUntraced(function* (
      id: string,
      token: string,
      input: {
        reply?: LensModelReply;
        sequence: number;
        phase: "code" | "completed" | "failed";
        verificationUrl?: string;
        userCode?: string;
        credential?: string;
        commit?: string | null;
      },
    ) {
      const { job } = yield* authenticate(id, token);
      if (input.sequence <= job.sequence) return;
      if (job.kind === "lens" && input.phase === "code")
        return yield* Effect.fail(
          new CloudError("invalid_reply", "Lens jobs cannot request device login.", 400),
        );
      const callbackTime = yield* currentMillis;
      let sealed: import("./crypto.ts").SealedCredential | undefined;
      if (
        (job.kind === "login" || job.kind === "lens") &&
        input.phase === "completed" &&
        (job.kind === "login" || input.credential)
      ) {
        yield* Effect.try({
          try: () =>
            validateSubscriptionCredential(job.provider ?? "codex", input.credential ?? ""),
          catch: () =>
            new CloudError(
              "invalid_credential",
              "Subscription login did not return valid credentials",
            ),
        });
        sealed = yield* fromPromise(() =>
          vault().seal(
            input.credential!,
            `${config.allowedUserId}:${job.provider ?? "codex"}:${job.credentialVersion + 1}`,
          ),
        );
      }
      yield* store.mutate(config.allowedUserId, (doc) => {
        const current = doc.state.jobs?.[id];
        if (
          !current ||
          current.deleted ||
          !["starting", "running"].includes(current.state) ||
          current.sequence >= input.sequence
        )
          throw new CloudError("stale_worker", "Login or publication callback is stale");
        if (job.kind === "login" || job.kind === "lens") {
          const provider = job.provider ?? "codex";
          const account = doc.state.accounts[provider];
          if (account.leasedBy !== id || account.credentialVersion !== job.credentialVersion)
            throw new CloudError("stale_worker", "Provider account was replaced");
          if (input.phase === "code" && job.kind === "login") {
            const url = new URL(input.verificationUrl ?? "");
            if (
              url.origin !== "https://auth.openai.com" ||
              !/^[A-Z0-9-]{4,32}$/.test(input.userCode ?? "")
            )
              throw new CloudError("invalid_login", "Invalid device authorization response");
            current.verificationUrl = url.href;
            current.userCode = input.userCode!;
            current.state = "running";
            current.error = null;
          } else if (sealed) {
            account.credentialVersion++;
            account.state = "connected";
            doc.private.credentials[provider] = { version: account.credentialVersion, sealed };
          }
        }
        if (job.kind === "lens" && input.phase !== "code") {
          if (input.phase === "completed" && !input.reply)
            throw new CloudError("invalid_reply", "Lens returned no review.", 400);
          completeLens(
            doc.state,
            id,
            input.phase === "completed" ? (input.reply ?? null) : null,
            callbackTime,
          );
        }
        current.sequence = input.sequence;
        if (input.phase === "completed") {
          current.state = "completed";
          current.commit = input.commit ?? null;
        }
        if (input.phase === "failed") {
          current.state = "failed";
          current.error = "Isolated operation failed; reconnect or review publication status";
        }
        if (input.phase !== "code") {
          current.userCode = null;
          current.verificationUrl = null;
        }
      });
      yield* config.wake(config.allowedUserId);
    }),
    tick: Effect.fn("cloud.auxiliary_tick")(function* (userId: string) {
      yield* own(userId);
      const now = yield* currentMillis;
      const claim = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const lensId = `lens-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
      const jobs = yield* store.mutate(userId, (doc) => {
        accrueJobs(doc.state, now);
        tickLens(doc.state, now, lensId, config.enabled && !!config.machine);
        if (config.enabled)
          for (const publication of Object.values(doc.state.publications)) {
            const id = `publish-${publication.id}`;
            if (publication.state !== "queued" || doc.state.jobs?.[id]) continue;
            try {
              reserveJob(doc.state, id, "publication", now, publication.id);
              publication.state = "publishing";
            } catch (error) {
              if (!(error instanceof CloudError)) throw error;
            }
          }
        const claimed = Object.values(doc.state.jobs ?? {})
          .filter((job) => !job.deleted && (!job.claimUntil || Date.parse(job.claimUntil) <= now))
          .slice(0, 2);
        for (const job of claimed) {
          job.claimToken = claim;
          job.claimUntil = iso(now + 300_000);
        }
        return structuredClone(claimed);
      });
      for (const job of jobs)
        yield* Effect.gen(function* () {
          if (job.state === "completed" || job.state === "failed") {
            if (job.kind === "publication" && job.state === "completed") {
              const doc = yield* store.read(userId);
              const publication = doc.state.publications[job.publicationId!]!;
              if (publication.state !== "published") {
                const task = doc.state.publicationInputs?.[publication.id];
                if (!task)
                  return yield* Effect.fail(
                    new CloudError("not_found", "Reviewed result is unavailable"),
                  );
                const allowCreate = yield* store.mutate(userId, (next) => {
                  const current = next.state.jobs![job.id]!;
                  const attempts = (next.state.publicationAttempts ??= {});
                  const allow = !attempts[publication.id];
                  attempts[publication.id] = true;
                  current.publicationAttempted = true;
                  return allow;
                });
                const client = yield* github;
                const outcome = yield* fromPromise(() =>
                  client.publish(task, publication, job.commit ?? null, now, allowCreate),
                ).pipe(Effect.result);
                yield* store.mutate(userId, (next) => {
                  const p = next.state.publications[publication.id]!;
                  if (outcome._tag === "Success") {
                    p.state = "published";
                    p.url = outcome.success;
                  } else {
                    next.state.jobs![job.id]!.error = outcome.failure.message;
                  }
                });
                if (outcome._tag === "Failure" && !job.publicationAttempted) return;
                if (outcome._tag === "Failure")
                  yield* store.mutate(userId, (next) => {
                    next.state.publications[publication.id]!.state = "failed";
                  });
              }
            }
            const sandbox = yield* fromPromise(() => executor.get(executor.name(job.id)));
            if (sandbox) {
              yield* fromPromise(() => executor.delete(sandbox.id));
              return;
            }
            yield* store.mutate(userId, (doc) => {
              const current = doc.state.jobs![job.id]!;
              current.deleted = true;
              current.reservedMicroDollars = 0;
              delete doc.private.workerTokens[job.id];
              for (const account of Object.values(doc.state.accounts))
                if (account.leasedBy === job.id) account.leasedBy = null;
              if (job.publicationId) {
                const publication = doc.state.publications[job.publicationId]!;
                if (publication.state !== "published") publication.state = "failed";
                for (const op of Object.values(doc.state.operations))
                  if (op.publicationId === job.publicationId) delete doc.state.operations[op.id];
              }
            });
            // Task scheduling runs before maintenance. Revisit queued work only
            // after confirmed absence has released this job's capacity/lease.
            yield* config.wake(userId);
            return;
          }
          let credential = (yield* store.read(userId)).private.workerTokens[job.id];
          if (!credential) {
            const token = `${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
            const sealed = yield* fromPromise(() => vault().seal(token, `${userId}:job:${job.id}`));
            const hash = yield* fromPromise(() => sha256(token));
            credential = yield* store.mutate(
              userId,
              (doc) => (doc.private.workerTokens[job.id] ??= { hash, sealed }),
            );
          }
          const token = yield* fromPromise(() =>
            vault().open(credential.sealed, `${userId}:job:${job.id}`),
          );
          yield* fromPromise(() =>
            executor.ensure(job.id, {
              controlUrl: config.controlUrl,
              attemptId: job.id,
              deadlineAt: job.deadlineAt,
              token,
              mode: job.kind,
            }),
          );
        }).pipe(
          Effect.catch((error) =>
            store
              .mutate(userId, (doc) => {
                const current = doc.state.jobs?.[job.id];
                if (current?.claimToken === claim) current.error = error.message;
              })
              .pipe(Effect.catch(() => Effect.void)),
          ),
          Effect.ensuring(
            store
              .mutate(userId, (doc) => {
                const current = doc.state.jobs?.[job.id];
                if (current?.claimToken === claim) {
                  current.claimUntil = null;
                  current.claimToken = null;
                }
              })
              .pipe(Effect.catch(() => Effect.void)),
          ),
        );
    }),
  };
});
export class CloudAuxiliary extends Context.Service<CloudAuxiliary, Effect.Success<typeof make>>()(
  "t3code-relay/cloud/auxiliary/CloudAuxiliary",
) {}
export const layer = Layer.effect(CloudAuxiliary, make);
