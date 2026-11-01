import { rememberLensConversation } from "./lens.ts";
import { shouldYieldIdleWorker } from "./state.ts";
import {
  recordProjectSnapshot,
  workspaceRoots,
  projectSnapshot,
  validateProjectSnapshotWorkspace,
} from "./projects.ts";
import { enqueueCloudNotification, enqueueConversationNotifications } from "./notifications.ts";
// @effect-diagnostics preferSchemaOverJson:off - Provider/session payloads and encrypted endpoint envelopes are opaque JSON.
import {
  readWorkspace,
  putWorkspaceChunk,
  finalizeWorkspace,
  workspaceChunkStatus,
  uploadedGitHead,
} from "./workspaces.ts";
import type { CloudWorkspaceManifest } from "@t3tools/contracts/cloud";
import type { CloudWorkerCallback } from "@t3tools/contracts/cloud";
import type {
  RelayManagedEndpoint,
  RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CloudConfiguration } from "./config.ts";
import { CloudStore, type CloudAccountDocument } from "./store.ts";
import { CredentialVault, sha256 } from "./crypto.ts";
import { GitHubCloudClient, githubForRequest } from "./github.ts";
import { CloudError, iso } from "./policy.ts";
import { currentMillis, fromPromise } from "./service.ts";
import {
  acceptCallback,
  acceptCheckpoint,
  changeProviderLease,
  taskFor,
  isResidentWorker,
} from "./state.ts";
import { validateSubscriptionCredential } from "./subscription.ts";
import {
  CloudArtifacts,
  artifactPrefix,
  finalizeManifest,
  uploadChunk,
  type CheckpointManifest,
} from "./artifacts.ts";

export const make = Effect.gen(function* () {
  const config = yield* CloudConfiguration;
  const store = yield* CloudStore;
  const artifacts = yield* CloudArtifacts;
  const vault = () => new CredentialVault(config.encryptionKey);
  const github = githubForRequest(config.github).pipe(
    Effect.map(
      (configuration) => new GitHubCloudClient(configuration, fetch, config.allowedUserId),
    ),
  );
  const authenticateDocument = (document: CloudAccountDocument, taskId: string, hash: string) => {
    if (document.private.workerTokens[taskId]?.hash !== hash)
      throw new CloudError("unauthorized", "Invalid worker credential", 401);
    const task = document.state.tasks[taskId];
    if (!task?.attempt || !task.worker || ["stopped", "deleted"].includes(task.worker.state))
      throw new CloudError("stale_worker", "Worker is no longer active", 409);
    if (task.worker.sandboxId && !isResidentWorker(task))
      throw new CloudError("stale_worker", "Worker is outside the assigned machine", 409);
    return { document, task, attempt: task.attempt };
  };
  const authenticate = Effect.fn("cloud.worker_authenticate")(function* (
    taskId: string,
    token: string,
  ) {
    if (!config.allowedUserId || !token)
      return yield* Effect.fail(new CloudError("unauthorized", "Invalid worker credential", 401));
    const document = yield* store.read(config.allowedUserId);
    const hash = yield* fromPromise(() => sha256(token));
    return yield* Effect.try({
      try: () => authenticateDocument(document, taskId, hash),
      catch: (error) => error as CloudError,
    });
  });

  return {
    legacyRepository: Effect.fn("cloud.worker_legacy_repository")(function* (
      taskId: string,
      token: string,
    ) {
      const { task } = yield* authenticate(taskId, token);
      if (!task.projectSnapshot?.checkpoint || !task.baseSha)
        return yield* Effect.fail(
          new CloudError("invalid_snapshot", "No legacy project workspace is selected", 400),
        );
      const now = yield* currentMillis;
      const client = yield* github;
      return yield* fromPromise(() => client.resolve(task.repository, task.baseSha!, now));
    }),
    workspaceChunkStatus: (userId: string, hash: string) =>
      workspaceChunkStatus(userId, hash).pipe(Effect.provideService(CloudArtifacts, artifacts)),
    uploadWorkspace: (userId: string, bytes: Uint8Array<ArrayBuffer>) =>
      putWorkspaceChunk(userId, bytes).pipe(Effect.provideService(CloudArtifacts, artifacts)),
    finalizeWorkspace: (userId: string, manifest: CloudWorkspaceManifest) =>
      finalizeWorkspace(userId, manifest).pipe(Effect.provideService(CloudArtifacts, artifacts)),
    uploadWorkerWorkspace: Effect.fn("cloud.worker_workspace_upload")(function* (
      taskId: string,
      token: string,
      bytes: Uint8Array<ArrayBuffer>,
    ) {
      yield* authenticate(taskId, token);
      return yield* putWorkspaceChunk(config.allowedUserId, bytes).pipe(
        Effect.provideService(CloudArtifacts, artifacts),
      );
    }),
    saveWorkerWorkspace: Effect.fn("cloud.worker_workspace_save")(function* (
      taskId: string,
      token: string,
      manifest: CloudWorkspaceManifest,
      seed: boolean,
    ) {
      const { task, attempt } = yield* authenticate(taskId, token);
      if (seed && !task.projectSnapshot?.checkpoint)
        return yield* Effect.fail(
          new CloudError("invalid_snapshot", "This task has no project checkpoint", 400),
        );
      if (seed && task.projectSnapshot)
        yield* Effect.try({
          try: () => validateProjectSnapshotWorkspace(task.projectSnapshot!, manifest),
          catch: (error) => error as CloudError,
        });
      const workspace = yield* finalizeWorkspace(config.allowedUserId, manifest).pipe(
        Effect.provideService(CloudArtifacts, artifacts),
      );
      if (seed) {
        const tokenHash = yield* fromPromise(() => sha256(token));
        yield* store.mutate(config.allowedUserId, (doc) => {
          const { task: current } = authenticateDocument(doc, taskId, tokenHash);
          if (current.attempt?.id !== attempt.id || !current.projectSnapshot)
            throw new CloudError("stale_worker", "Snapshot preparation was replaced");
          const head = manifest.roots[0]?.git?.head;
          current.source =
            current.projectSnapshot.sourceKind === "github" && head
              ? { kind: "github", revision: head, snapshot: workspace }
              : {
                  kind: "local",
                  name:
                    doc.state.projects?.[current.projectSnapshot.projectId]?.title ??
                    task.repository.name,
                  snapshot: workspace,
                };
          current.baseSha = head ?? current.baseSha;
          const { project, snapshot } = projectSnapshot(
            doc.state,
            current.projectSnapshot.projectId,
            current.projectSnapshot.id,
          );
          // A conversion enriches the same immutable checkpoint, never selects newer work.
          const prepared = { ...snapshot, workspace, roots: workspaceRoots(manifest) };
          if (snapshot.workspace && snapshot.workspace.sha256 !== workspace.sha256)
            throw new CloudError(
              "snapshot_conflict",
              "Snapshot conversion produced different content",
            );
          doc.state.projectSnapshots![project.id]![snapshot.id] = prepared;
          if (project.latestSnapshot?.id === snapshot.id)
            doc.state.projects![project.id] = { ...project, latestSnapshot: prepared };
        });
      }
      return workspace;
    }),
    workspace: Effect.fn("cloud.worker_workspace")(function* (
      taskId: string,
      token: string,
      hash: string,
    ) {
      const { task } = yield* authenticate(taskId, token);
      let authorized =
        task.attachments?.some((attachment) => attachment.chunks.includes(hash)) ?? false;
      authorized ||= task.handoff?.history.chunks.includes(hash) ?? false;
      if (task.source) {
        const bytes = yield* readWorkspace(config.allowedUserId!, task.source.snapshot.sha256).pipe(
          Effect.provideService(CloudArtifacts, artifacts),
        );
        const manifest = JSON.parse(new TextDecoder().decode(bytes)) as CloudWorkspaceManifest;
        if (hash === task.source.snapshot.sha256) return { manifest };
        authorized ||=
          manifest.entries.some((entry) => entry.chunks.includes(hash)) ||
          manifest.roots.some(
            (root) =>
              root.git &&
              [root.git.bundle, root.git.index].some((blob) => blob.chunks.includes(hash)),
          );
      }
      if (!authorized)
        return yield* Effect.fail(
          new CloudError("forbidden", "Chunk is not attached to this task", 403),
        );
      const chunk = yield* readWorkspace(config.allowedUserId!, hash, true).pipe(
        Effect.provideService(CloudArtifacts, artifacts),
      );
      let binary = "";
      for (let offset = 0; offset < chunk.length; offset += 8192)
        binary += String.fromCharCode(...chunk.subarray(offset, offset + 8192));
      return { base64: btoa(binary) };
    }),
    artifact: Effect.fnUntraced(function* (userId: string, taskId: string, index?: number) {
      if (!userId || userId !== config.allowedUserId)
        return yield* Effect.fail(new CloudError("forbidden", "Account is not authorized", 403));
      const doc = yield* store.read(userId);
      const task = taskFor(doc.state, taskId);
      if (!task.checkpoint)
        return yield* Effect.fail(
          new CloudError("not_found", "No complete checkpoint is available", 404),
        );
      const bytes = yield* fromPromise(() => artifacts.get(task.checkpoint!.objectKey));
      if (!bytes || (yield* fromPromise(() => sha256(bytes))) !== task.checkpoint.sha256)
        return yield* Effect.fail(
          new CloudError(
            "not_found",
            "Checkpoint is unavailable or failed integrity verification",
            404,
          ),
        );
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as CheckpointManifest;
      if (index === undefined) return { checkpoint: task.checkpoint, chunks: manifest.chunks };
      const chunk = manifest.chunks[index];
      if (!chunk || chunk.index !== index)
        return yield* Effect.fail(new CloudError("not_found", "Chunk not found", 404));
      const prefix = artifactPrefix(userId, task.id, manifest.attemptId, manifest.checkpointId);
      const data = yield* fromPromise(() => artifacts.get(`${prefix}/${index}-${chunk.sha256}`));
      if (
        !data ||
        data.length !== chunk.sizeBytes ||
        (yield* fromPromise(() => sha256(data))) !== chunk.sha256
      )
        return yield* Effect.fail(
          new CloudError("invalid_checkpoint", "Checkpoint chunk failed integrity verification"),
        );
      let binary = "";
      for (const byte of data) binary += String.fromCharCode(byte);
      return { base64: btoa(binary), sha256: chunk.sha256 };
    }),
    mirror: Effect.fnUntraced(function* (
      token: string,
      callback: CloudWorkerCallback,
      conversation: unknown,
    ) {
      yield* authenticate(callback.taskId, token);
      if (callback.phase !== "heartbeat" || callback.checkpoint || callback.result)
        return yield* Effect.fail(
          new CloudError("invalid_projection", "Projection callback must be a heartbeat"),
        );
      const bytes = new TextEncoder().encode(JSON.stringify(conversation));
      if (bytes.length > 8 * 1024 * 1024)
        return yield* Effect.fail(
          new CloudError("projection_too_large", "Conversation exceeds export limit"),
        );
      const hash = yield* fromPromise(() => sha256(bytes));
      const key = `cloud/${encodeURIComponent(config.allowedUserId)}/${callback.taskId}/events/${callback.attemptId}/${callback.sequence}-${hash}.json`;
      yield* fromPromise(() => artifacts.put(key, bytes, { sha256: hash }));
      const now = yield* currentMillis;
      const notify = yield* store.mutate(config.allowedUserId, (doc) => {
        const before = Object.keys(doc.private.pushEvents ?? {}).length;
        if (acceptCallback(doc.state, callback, now)) {
          rememberLensConversation(doc.state, callback.taskId, conversation);
          (doc.state.projections ??= {})[callback.taskId] = { key, sha256: hash };
          enqueueConversationNotifications(
            doc,
            doc.state.tasks[callback.taskId]!,
            conversation,
            now,
          );
        }
        return Object.keys(doc.private.pushEvents ?? {}).length > before;
      });
      if (notify) yield* config.wake(config.allowedUserId).pipe(Effect.ignore);
    }),
    events: Effect.fnUntraced(function* (userId: string, taskId: string, after: number) {
      if (userId !== config.allowedUserId || !userId)
        return yield* Effect.fail(new CloudError("forbidden", "Account is not authorized", 403));
      const doc = yield* store.read(userId);
      taskFor(doc.state, taskId);
      const events = doc.state.events?.[taskId] ?? [];
      const projection = doc.state.projections?.[taskId];
      let conversation: unknown = null;
      if (projection) {
        const bytes = yield* fromPromise(() => artifacts.get(projection.key));
        if (bytes && (yield* fromPromise(() => sha256(bytes))) === projection.sha256)
          conversation = JSON.parse(new TextDecoder().decode(bytes));
      }
      return {
        cursor: events.at(-1)?.cursor ?? 0,
        reset: after > 0 && after < (events[0]?.cursor ?? 0) - 1,
        events: events.filter((event) => event.cursor > after),
        conversation,
      };
    }),
    bootstrap: Effect.fn("cloud.worker_bootstrap")(function* (taskId: string, token: string) {
      const { document, task, attempt } = yield* authenticate(taskId, token);
      const sealedEndpoint = document.private.endpoints[taskId];
      if (!sealedEndpoint || !task.worker)
        return yield* Effect.fail(
          new CloudError("preparing", "Endpoint is still being prepared", 503),
        );
      const endpoint = JSON.parse(
        yield* fromPromise(() =>
          vault().open(sealedEndpoint, `${config.allowedUserId}:endpoint:${taskId}`),
        ),
      ) as { endpoint: RelayManagedEndpoint; runtime: RelayManagedEndpointRuntimeConfig };
      const backendBootstrapToken = yield* fromPromise(() => sha256(`${token}:backend`));
      const binding = task.handoff
        ? (document.state.bindings?.[task.handoff.conversationId] ?? null)
        : null;
      // The process can bootstrap before ensure() records the machine receipt.
      const resident =
        Boolean(config.machine) && (!task.worker?.sandboxId || isResidentWorker(task));
      const leaseOwned = document.state.accounts[task.provider].leasedBy === attempt.id;
      const leaseTurnRequestId = leaseOwned
        ? (document.state.providerLeaseTurns?.[task.provider] ?? null)
        : null;
      if (task.state !== "preparing")
        return {
          task,
          binding,
          attempt,
          endpoint,
          backendBootstrapToken,
          resident,
          leaseOwned,
          leaseTurnRequestId,
          stopRequested: !["running", "waiting_for_input"].includes(task.state),
          yieldIdle: shouldYieldIdleWorker(document.state, task, yield* currentMillis),
        };
      const now = yield* currentMillis;
      const client = yield* github;
      const snapshotHead =
        task.source?.kind === "github"
          ? yield* readWorkspace(config.allowedUserId, task.source.snapshot.sha256).pipe(
              Effect.provideService(CloudArtifacts, artifacts),
              Effect.flatMap((bytes) =>
                Effect.try({
                  try: () => uploadedGitHead(bytes),
                  catch: (error) => error as CloudError,
                }),
              ),
            )
          : null;
      const resolved =
        task.projectSnapshot?.checkpoint && !task.source
          ? { sha: task.baseSha, token: "" }
          : task.source?.kind === "local" || task.projectSnapshot?.sourceKind === "local"
            ? { sha: null, token: "" }
            : snapshotHead
              ? { sha: snapshotHead, token: "" }
              : task.baseSha
                ? {
                    sha: task.baseSha,
                    token: yield* fromPromise(() => client.readAccess(task.repository, now)),
                  }
                : yield* fromPromise(() =>
                    client.resolve(
                      task.repository,
                      task.source?.kind === "github"
                        ? task.source.revision
                        : (task.baseSha ?? task.baseBranch),
                      now,
                    ),
                  );
      yield* store.mutate(config.allowedUserId, (doc) => {
        const t = taskFor(doc.state, taskId);
        if (t.attempt?.id !== attempt.id || t.state !== "preparing")
          throw new CloudError("stale_worker", "Task was cancelled or replaced");
        t.baseSha ??= resolved.sha;
      });
      const issue =
        task.issueNumber === null
          ? null
          : yield* fromPromise(async () =>
              client.issue(
                task.repository,
                task.issueNumber!,
                snapshotHead ? await client.readAccess(task.repository, now) : resolved.token,
              ),
            );
      return {
        task: { ...task, baseSha: task.baseSha ?? resolved.sha },
        binding,
        attempt,
        stopRequested: false,
        repositoryToken: resolved.token,
        issue,
        endpoint,
        backendBootstrapToken,
        resident,
        leaseOwned,
        leaseTurnRequestId,
      };
    }),
    lease: Effect.fn("cloud.worker_lease")(function* (
      taskId: string,
      token: string,
      attemptId: string,
      action: "acquire" | "release",
      turnRequestId?: string,
    ) {
      if (!config.allowedUserId || !token)
        return yield* Effect.fail(new CloudError("unauthorized", "Invalid worker credential", 401));
      if (!config.machine)
        return yield* Effect.fail(
          new CloudError("unsupported", "Worker does not support warm leases"),
        );
      const hash = yield* fromPromise(() => sha256(token));
      const credential = yield* store.mutate(config.allowedUserId, (document) => {
        // Validate against the same revision that grants the lease. This removes
        // an extra database round trip and fences token rotation during CAS retries.
        const { task, attempt } = authenticateDocument(document, taskId, hash);
        if (attempt.id === attemptId && task.worker!.sandboxId === null) {
          // The machine can start before ensure() returns its receipt. The
          // configured machine and authenticated current attempt already fix
          // this identity, including for later lease-free heartbeats. Reserve it
          // in the lease CAS so startup revalidation cannot reject its own run.
          task.worker!.sandboxId = `machine-${attemptId}`;
        }
        const acquired = changeProviderLease(
          document.state,
          taskId,
          attemptId,
          action,
          turnRequestId,
        );
        if (!acquired) return null;
        const saved = document.private.credentials[task.provider];
        if (!saved)
          throw new CloudError("needs_auth", "Connect the provider account before starting", 401);
        return { ...saved, provider: task.provider };
      });
      if (action === "release") yield* config.wake(config.allowedUserId).pipe(Effect.ignore);
      if (!credential) return { acquired: false as const };
      return {
        acquired: true as const,
        version: credential.version,
        credential: yield* fromPromise(() =>
          vault().open(
            credential.sealed,
            `${config.allowedUserId}:${credential.provider}:${credential.version}`,
          ),
        ),
      };
    }),
    credential: Effect.fn("cloud.worker_credential")(function* (
      taskId: string,
      token: string,
      attemptId: string,
    ) {
      const { document, task, attempt } = yield* authenticate(taskId, token);
      // Every provider process must acquire the shared credential lease first.
      if (
        attempt.id !== attemptId ||
        !["preparing", "running", "waiting_for_input"].includes(task.state) ||
        document.state.accounts[task.provider].leasedBy !== attemptId
      )
        return yield* Effect.fail(
          new CloudError("stale_worker", "Provider lease no longer belongs to this attempt"),
        );
      const credential = document.private.credentials[task.provider];
      if (!credential)
        return yield* Effect.fail(
          new CloudError("needs_auth", "Connect the provider account before starting", 401),
        );
      return {
        version: credential.version,
        credential: yield* fromPromise(() =>
          vault().open(
            credential.sealed,
            `${config.allowedUserId}:${task.provider}:${credential.version}`,
          ),
        ),
      };
    }),
    refreshCredential: Effect.fn("cloud.worker_refresh_credential")(function* (
      taskId: string,
      token: string,
      attemptId: string,
      expectedVersion: number,
      credential: string,
    ) {
      const { task, attempt } = yield* authenticate(taskId, token);
      if (attempt.id !== attemptId || task.provider !== "codex")
        return yield* Effect.fail(
          new CloudError("stale_worker", "Credential update belongs to a different attempt"),
        );
      yield* Effect.try({
        try: () => validateSubscriptionCredential("codex", credential),
        catch: () =>
          new CloudError("invalid_credential", "Refreshed subscription credential is invalid", 400),
      });
      const sealed = yield* fromPromise(() =>
        vault().seal(credential, `${config.allowedUserId}:codex:${expectedVersion + 1}`),
      );
      yield* store.mutate(config.allowedUserId, (document) => {
        const account = document.state.accounts.codex;
        if (
          account.leasedBy !== attemptId ||
          account.credentialVersion !== expectedVersion ||
          document.state.tasks[taskId]?.attempt?.id !== attemptId
        )
          throw new CloudError("credential_conflict", "Credential version or lease changed");
        account.credentialVersion++;
        document.private.credentials.codex = { version: account.credentialVersion, sealed };
      });
      return { version: expectedVersion + 1 };
    }),
    upload: Effect.fn("cloud.worker_upload")(function* (
      taskId: string,
      token: string,
      attemptId: string,
      checkpointId: string,
      index: number,
      bytes: Uint8Array<ArrayBuffer>,
    ) {
      const { attempt } = yield* authenticate(taskId, token);
      if (attempt.id !== attemptId)
        return yield* Effect.fail(
          new CloudError("stale_worker", "Upload belongs to a different attempt"),
        );
      return yield* uploadChunk(
        artifactPrefix(config.allowedUserId, taskId, attemptId, checkpointId),
        index,
        bytes,
      ).pipe(Effect.provideService(CloudArtifacts, artifacts));
    }),
    finalize: Effect.fn("cloud.worker_finalize")(function* (
      token: string,
      callback: CloudWorkerCallback,
      manifest: CheckpointManifest,
    ) {
      const { task, attempt } = yield* authenticate(callback.taskId, token);
      if (
        attempt.id !== callback.attemptId ||
        manifest.taskId !== task.id ||
        manifest.attemptId !== attempt.id ||
        callback.generation !== attempt.generation
      )
        return yield* Effect.fail(
          new CloudError("stale_worker", "Checkpoint belongs to a different attempt"),
        );
      if (task.result?.id === manifest.checkpointId) return;
      const workspaceBytes = manifest.workspace
        ? yield* readWorkspace(config.allowedUserId, manifest.workspace.sha256).pipe(
            Effect.provideService(CloudArtifacts, artifacts),
          )
        : null;
      const workspaceManifest = workspaceBytes
        ? (JSON.parse(new TextDecoder().decode(workspaceBytes)) as CloudWorkspaceManifest)
        : null;
      if (workspaceManifest)
        yield* finalizeWorkspace(config.allowedUserId, workspaceManifest).pipe(
          Effect.provideService(CloudArtifacts, artifacts),
        );
      const saved = yield* finalizeManifest(config.allowedUserId, manifest).pipe(
        Effect.provideService(CloudArtifacts, artifacts),
      );
      const now = yield* currentMillis;
      yield* store.mutate(config.allowedUserId, (document) => {
        const checkpoint = {
          id: manifest.checkpointId,
          taskId: task.id,
          attemptId: attempt.id,
          sequence: callback.sequence,
          ...saved,
          createdAt: iso(now),
        };
        const result = {
          id: manifest.checkpointId,
          taskId: task.id,
          checkpointId: checkpoint.id,
          sha256: saved.sha256,
          summary: manifest.result.summary,
          createdAt: iso(now),
        };
        const accepted = acceptCheckpoint(
          document.state,
          { ...callback, checkpoint, ...(callback.phase === "completed" ? { result } : {}) },
          now,
        );
        if (accepted)
          recordProjectSnapshot(document.state, task, {
            id: checkpoint.id,
            savedAt: checkpoint.createdAt,
            sourceKind: task.source?.kind ?? task.projectSnapshot?.sourceKind ?? "github",
            workspace: manifest.workspace ?? null,
            checkpoint: manifest.workspace ? null : checkpoint,
            baseBranch: task.baseBranch,
            branch: workspaceManifest?.roots[0]?.git?.branch ?? task.branch,
            baseSha: workspaceManifest?.roots[0]?.git?.head ?? task.baseSha,
            roots: workspaceManifest ? workspaceRoots(workspaceManifest) : [],
          });
        if (
          accepted &&
          callback.phase === "completed" &&
          document.state.tasks[task.id]?.state === "completed"
        )
          enqueueCloudNotification(
            document,
            task,
            "completed",
            task.turnRequestId ?? attempt.id,
            now,
          );
      });
      // A saved checkpoint can release a queued conversation immediately.
      yield* config.wake(config.allowedUserId).pipe(Effect.ignore);
    }),
    restore: Effect.fn("cloud.worker_restore")(function* (
      taskId: string,
      token: string,
      index?: number,
      seed = false,
    ) {
      const { task } = yield* authenticate(taskId, token);
      const checkpoint = seed ? task.projectSnapshot?.checkpoint : task.checkpoint;
      if (!checkpoint)
        return yield* Effect.fail(
          new CloudError("not_found", "No complete checkpoint exists", 404),
        );
      const bytes = yield* fromPromise(() => artifacts.get(checkpoint.objectKey));
      if (!bytes || (yield* fromPromise(() => sha256(bytes))) !== checkpoint.sha256) {
        return yield* Effect.fail(
          new CloudError("invalid_checkpoint", "Saved checkpoint is missing or corrupt", 409),
        );
      }
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as CheckpointManifest;
      if (index === undefined)
        return { checkpoint, manifest: seed ? { chunks: manifest.chunks } : manifest };
      const chunk = manifest.chunks[index];
      if (!Number.isSafeInteger(index) || index < 0 || !chunk || chunk.index !== index) {
        return yield* Effect.fail(
          new CloudError("not_found", "Checkpoint chunk does not exist", 404),
        );
      }
      const prefix = artifactPrefix(
        config.allowedUserId,
        checkpoint.taskId,
        checkpoint.attemptId,
        checkpoint.id,
      );
      const data = yield* fromPromise(() => artifacts.get(`${prefix}/${index}-${chunk.sha256}`));
      if (
        !data ||
        data.length !== chunk.sizeBytes ||
        (yield* fromPromise(() => sha256(data))) !== chunk.sha256
      ) {
        return yield* Effect.fail(
          new CloudError("invalid_checkpoint", "Checkpoint chunk is missing or corrupt", 409),
        );
      }
      // Build in small segments to avoid overflowing the JS argument stack.
      let binary = "";
      for (let offset = 0; offset < data.length; offset += 8192)
        binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
      return { base64: btoa(binary), sha256: chunk.sha256 };
    }),
    connection: Effect.fn("cloud.task_connection")(function* (userId: string, taskId: string) {
      if (!config.allowedUserId || config.allowedUserId !== userId)
        return yield* Effect.fail(new CloudError("forbidden", "Account is not authorized", 403));
      const document = yield* store.read(userId);
      const task = taskFor(document.state, taskId);
      const sealedEndpoint = document.private.endpoints[taskId];
      const storedToken = document.private.workerTokens[taskId];
      if (
        !sealedEndpoint ||
        !storedToken ||
        !task.worker ||
        !["ready", "starting"].includes(task.worker.state)
      )
        return yield* Effect.fail(new CloudError("not_ready", "The task environment is not ready"));
      const endpoint = JSON.parse(
        yield* fromPromise(() => vault().open(sealedEndpoint, `${userId}:endpoint:${taskId}`)),
      ) as { endpoint: RelayManagedEndpoint };
      const token = yield* fromPromise(() =>
        vault().open(storedToken.sealed, `${userId}:worker:${taskId}`),
      );
      return {
        environmentId: task.worker.environmentId,
        httpBaseUrl: endpoint.endpoint.httpBaseUrl,
        bootstrapToken: yield* fromPromise(() => sha256(`${token}:backend`)),
      };
    }),
    result: Effect.fn("cloud.task_result")(function* (userId: string, taskId: string) {
      if (!config.allowedUserId || config.allowedUserId !== userId)
        return yield* Effect.fail(new CloudError("forbidden", "Account is not authorized", 403));
      const document = yield* store.read(userId);
      const task = taskFor(document.state, taskId);
      if (!task.checkpoint)
        return yield* Effect.fail(new CloudError("not_found", "No saved result yet", 404));
      const bytes = yield* fromPromise(() => artifacts.get(task.checkpoint!.objectKey));
      if (!bytes)
        return yield* Effect.fail(new CloudError("not_found", "Saved result has expired", 404));
      if ((yield* fromPromise(() => sha256(bytes))) !== task.checkpoint.sha256) {
        return yield* Effect.fail(
          new CloudError("invalid_checkpoint", "Saved result integrity check failed", 409),
        );
      }
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as CheckpointManifest;
      return { revision: task.result, result: manifest.result };
    }),
  };
});

export class CloudWorkerControl extends Context.Service<
  CloudWorkerControl,
  Effect.Success<typeof make>
>()("t3code-relay/cloud/workerControl/CloudWorkerControl") {}
export const layer = Layer.effect(CloudWorkerControl, make);
