import { stableStringify } from "@t3tools/shared/relaySigning";
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Node-only transfer boundary; fetch forwards cancellation and request deadlines.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { cloudStarts, type StartReport } from "./startProgress.ts";
import {
  CloudRequestFailure,
  asDesktopCloudError,
  beforeConversationDispatch,
} from "./requestFailure.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CloudDesktopAuthError,
  CloudOverview,
  CloudRepository,
  CloudSnapshotRef,
  CloudStartConversationInput,
  CloudContinueConversationInput,
  CloudStartConversationResult,
  type CloudWorkspaceManifest,
  type CloudCommand,
} from "@t3tools/contracts/cloud";
import { uploadAttachments } from "../../../../scripts/vitre/cloud/attachments.mjs";
import { captureWorkspace } from "../../../../scripts/vitre/cloud/workspace.mjs";
import { desktopCloudSession } from "./DesktopCloudSession.ts";
import { ServerConfig } from "../config.ts";
import { durableJson, readJson } from "./handoffFiles.ts";
import { encodeWorkspaceChunkUpload } from "./workspaceChunkUpload.ts";
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeOverview = Schema.decodeUnknownSync(CloudOverview);
const decodeRepositories = Schema.decodeUnknownSync(Schema.Array(CloudRepository));
const decodePublicRepository = Schema.decodeUnknownSync(Schema.NullOr(CloudRepository));
const decodeSnapshot = Schema.decodeUnknownSync(CloudSnapshotRef);
const decodeResult = Schema.decodeUnknownSync(CloudStartConversationResult);

export function githubIdentity(remote: string): { owner: string; name: string } | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

export function cloudApi(
  session: { relayUrl: string; accessToken: string },
  request: (url: URL, options: RequestInit) => Promise<Response>,
) {
  const origin = new URL(session.relayUrl);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error("Cloud requires an HTTPS origin");
  return async (path: string, body?: unknown) => {
    const response = await request(new URL(`/v1/cloud${path}`, origin), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => null);
      const code =
        failure && typeof failure === "object" && "code" in failure ? failure.code : undefined;
      // Relay codes are stable; never display arbitrary proxy or provider bodies.
      const messages: Record<string, string> = {
        worker_busy: "The cloud environment is still stopping. Wait a moment, then send again.",
        task_busy:
          "The cloud task is still queued or running. Wait for it to finish before sending again.",
        switch_pending:
          "This conversation is still moving. Wait for the location switch to finish.",
        stale_owner: "This conversation moved to another environment. Reopen it before sending.",
        idempotency_conflict:
          "This request changed during a retry. Send it again as a new request.",
        revision_conflict: "Repository settings changed. Refresh and try again.",
        incomplete_workspace: "The workspace upload is incomplete. Try the transfer again.",
        incomplete_attachment: "An attachment upload is incomplete. Send it again.",
        incomplete_conversation:
          "Conversation history has not finished uploading. Try the transfer again.",
        task_limit: "Cloud task retention is full. Delete an old task before starting another.",
        checkpoint_required: "The cloud workspace has no saved checkpoint yet.",
      };
      const detail =
        failure && typeof failure === "object" ? (failure as Record<string, unknown>) : {};
      // An HTTP/proxy failure alone cannot establish whether a mutation committed.
      const rejected = detail.requestDisposition === "rejected";
      throw new CloudRequestFailure(
        typeof code === "string" && Object.hasOwn(messages, code)
          ? messages[code]!
          : `Cloud request failed (${response.status})`,
        rejected ? "rejected" : "unknown",
        typeof code === "string" ? code : undefined,
        typeof detail.retryable === "boolean" ? detail.retryable : undefined,
      );
    }
    return response.json();
  };
}
export async function captureCloudWorkspace(
  roots: typeof CloudStartConversationInput.Type.roots,
  api: ReturnType<typeof cloudApi>,
  options: { signal?: AbortSignal; report?: (progress: StartReport) => void } = {},
) {
  const pending = new Set<Promise<void>>();
  const seen = new Set<string>();
  let failure: unknown;
  let uploadedBytes = 0,
    reusedBytes = 0,
    files = 0;
  const report = () =>
    options.report?.({
      phase: "upload",
      completedBytes: uploadedBytes,
      message: `Uploading workspace · ${files.toLocaleString()} files · ${(uploadedBytes / 1048576).toFixed(1)} MB sent${reusedBytes ? ` · ${(reusedBytes / 1048576).toFixed(1)} MB reused` : ""}`,
    });
  try {
    const manifest = await captureWorkspace(
      roots,
      async (sha256, bytes) => {
        options.signal?.throwIfAborted();
        if (failure) throw failure;
        if (seen.has(sha256)) return;
        seen.add(sha256);
        while (pending.size >= 8) {
          await Promise.race(pending);
          if (failure) throw failure;
        }
        const upload = (async () => {
          const status = (await api(`/workspaces/chunks/${sha256}/status`)) as { present: boolean };
          if (status.present) {
            reusedBytes += bytes.length;
            report();
            return;
          }
          const payload = await encodeWorkspaceChunkUpload(bytes);
          const uploaded = (await api("/workspaces/chunks", payload)) as { sha256: string };
          if (uploaded.sha256 !== sha256)
            throw new Error("Workspace upload failed integrity verification");
          uploadedBytes += Buffer.byteLength(payload.base64, "base64");
          report();
        })().catch((error) => {
          failure ??= error;
        });
        pending.add(upload);
        void upload.then(() => pending.delete(upload));
      },
      {
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: (progress) => {
          files = progress.files;
          report();
        },
        beforeVerify: async () => {
          await Promise.all(pending);
          if (failure) throw failure;
        },
      },
    );
    await Promise.all(pending);
    if (failure) throw failure;
    return manifest;
  } finally {
    // Do not leave uploads running after capture or verification fails.
    await Promise.all(pending);
  }
}

async function uploadCloudAttachments(
  attachments: NonNullable<typeof CloudStartConversationInput.Type.attachments>,
  api: ReturnType<typeof cloudApi>,
) {
  return uploadAttachments(attachments, async (hash, bytes) => {
    const result = (await api("/workspaces/chunks", await encodeWorkspaceChunkUpload(bytes))) as {
      sha256: string;
    };
    if (result.sha256 !== hash) throw new Error("Attachment upload failed integrity verification");
  });
}
export async function continueCloudConversation(
  input: typeof CloudContinueConversationInput.Type,
  session: { relayUrl: string; accessToken: string },
  request: (url: URL, options: RequestInit) => Promise<Response> = fetch,
) {
  const api = cloudApi(session, request);
  const attachments = await uploadCloudAttachments(input.attachments, api).catch((error) => {
    throw beforeConversationDispatch(error);
  });
  return decodeResult(
    await api("/commands", {
      type: "task.continue",
      idempotencyKey: input.idempotencyKey,
      taskId: input.taskId,
      prompt: input.prompt,
      attachments,
    }),
  );
}

async function prepareAndStartCloudConversation(
  input: typeof CloudStartConversationInput.Type,
  session: { relayUrl: string; accessToken: string },
  request: (url: URL, options: RequestInit) => Promise<Response> = fetch,
  preparedWorkspace?: CloudWorkspaceManifest,
  onCapture?: (manifest: CloudWorkspaceManifest) => Promise<void>,
  options: {
    signal?: AbortSignal;
    report?: (progress: StartReport) => void;
    persistCommand?: (command: CloudCommand, workspace: CloudWorkspaceManifest) => Promise<void>;
  } = {},
): Promise<typeof CloudStartConversationResult.Type> {
  const api = cloudApi(session, request);
  const overview = decodeOverview(await api(""));
  if (!overview.enabled) throw new Error("Cloud execution is disabled");
  if (
    !overview.accounts.some(
      (account) => account.provider === input.provider && account.state === "connected",
    )
  )
    throw new Error("Connect your provider account in Cloud settings first");
  const root = input.roots[0];
  if (!root) throw new Error("Choose a project before starting a cloud conversation");
  let repositoryId = "local";
  let branch = "main";
  let revision = "";
  if (input.target === "cloud-github") {
    const git = async (...args: string[]) =>
      (
        await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
          cwd: root.path,
          timeout: 15_000,
        })
      ).stdout.trim();
    branch =
      preparedWorkspace?.roots[0]?.git?.branch ??
      (await git("symbolic-ref", "--short", "HEAD").catch(() => "HEAD"));
    const remoteName = await git("config", "--get", `branch.${branch}.remote`).catch(
      () => "origin",
    );
    const identity = githubIdentity(
      preparedWorkspace?.roots[0]?.git?.githubRemote ??
        (await git("remote", "get-url", remoteName === "." ? "origin" : remoteName)),
    );
    if (!identity) throw new Error("This workspace has no GitHub remote; choose Cloud: Local");
    revision =
      preparedWorkspace?.roots[0]?.git?.publishedRevision ??
      (await git("rev-parse", "@{upstream}")
        .catch(() =>
          git("rev-parse", `refs/remotes/${remoteName === "." ? "origin" : remoteName}/HEAD`),
        )
        // Complete uploads carry unpublished history too. An upstream is useful
        // metadata, but its absence must not force a remote read of that history.
        .catch(() => preparedWorkspace?.roots[0]?.git?.head ?? git("rev-parse", "HEAD"))
        .catch(async () => {
          const result = await git("ls-remote", remoteName === "." ? "origin" : remoteName, "HEAD");
          const head = result.split(/\s+/)[0];
          if (!head || !/^[a-f0-9]{40}$/.test(head))
            throw new Error("Cannot determine the GitHub base commit; choose Cloud: Local");
          return head;
        }));
    const configuredRepositories = overview.repositories.filter(
      (repo) => repo.id !== "local" && repo.installationId !== "local",
    );
    const matchesIdentity = (repo: CloudRepository) =>
      repo.owner.toLowerCase() === identity.owner.toLowerCase() &&
      repo.name.toLowerCase() === identity.name.toLowerCase();
    const configured = configuredRepositories.find(matchesIdentity);
    // This path always uploads the user's workspace. A previously configured
    // repository needs no new GitHub lookup just to identify that upload.
    if (configured) repositoryId = configured.id;
    else {
      const publicRepository = decodePublicRepository(
        await api(
          `/repositories/public/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.name)}`,
        ),
      );
      const available = publicRepository
        ? []
        : decodeRepositories(await api("/repositories/available")).filter(matchesIdentity);
      if (available.length > 1)
        throw new Error(
          "Choose a GitHub account for this repository in Settings → Cloud before starting it in the cloud.",
        );
      const repository = publicRepository ?? available[0];
      if (!repository)
        throw new Error(
          "This repository is private or unavailable; connect GitHub access or choose Cloud: Local",
        );
      repositoryId = repository.id;
      const existing = configuredRepositories.find((repo) => repo.id === repositoryId);
      if (!existing || (!publicRepository && existing.installationId !== repository.installationId))
        await api("/commands", {
          type: "repository.save",
          idempotencyKey: `${input.idempotencyKey}-repository`,
          repository: existing
            ? {
                ...existing,
                installationId: repository.installationId,
                owner: repository.owner,
                name: repository.name,
              }
            : repository,
        });
    }
  }
  const manifest = preparedWorkspace ?? (await captureCloudWorkspace(input.roots, api, options));
  options.signal?.throwIfAborted();
  options.report?.({ phase: "upload", message: "Verifying uploaded workspace…" });
  const snapshot = decodeSnapshot(await api("/workspaces", manifest));
  await onCapture?.(manifest);
  if (
    snapshot.sha256 !==
    NodeCrypto.createHash("sha256")
      .update(manifest.version === 2 ? stableStringify(manifest) : JSON.stringify(manifest))
      .digest("hex")
  )
    throw new Error("Workspace manifest failed integrity verification");
  const attachments = await uploadCloudAttachments(input.attachments ?? [], api);
  options.signal?.throwIfAborted();
  options.report?.({ phase: "creation", message: "Opening cloud conversation…" });
  const command: CloudCommand = {
    type: "task.create",
    ...(input.projectId ? { projectId: input.projectId } : {}),
    keepAliveSeconds: 900,
    ...(input.handoff ? { handoff: input.handoff } : {}),
    attachments,
    idempotencyKey: input.idempotencyKey,
    repositoryId,
    baseBranch: branch,
    provider: input.provider,
    model: input.model,
    ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
    kind: "build",
    prompt: input.prompt,
    issueNumber: null,
    source:
      input.target === "cloud-github"
        ? { kind: "github", revision, snapshot }
        : {
            kind: "local",
            snapshot,
            name:
              NodePath.basename(root.path)
                .replace(/[^a-zA-Z0-9_.-]/g, "-")
                .slice(0, 100) || "workspace",
          },
  };
  await options.persistCommand?.(command, manifest);
  options.signal?.throwIfAborted();
  return decodeResult(await api("/commands", command));
}

export async function startCloudConversation(
  input: typeof CloudStartConversationInput.Type,
  session: { relayUrl: string; accessToken: string },
  request: (url: URL, options: RequestInit) => Promise<Response> = fetch,
  preparedWorkspace?: CloudWorkspaceManifest,
  onCapture?: (manifest: CloudWorkspaceManifest) => Promise<void>,
  options: {
    signal?: AbortSignal;
    report?: (progress: StartReport) => void;
    persistCommand?: (command: CloudCommand, workspace: CloudWorkspaceManifest) => Promise<void>;
  } = {},
): Promise<typeof CloudStartConversationResult.Type> {
  let dispatched = false;
  try {
    return await prepareAndStartCloudConversation(
      input,
      session,
      (url, init) => {
        if (typeof init.body === "string" && JSON.parse(init.body).type === "task.create") {
          // Abort before this point is a definitive rejection; after dispatch the
          // relay receipt, not the transport result, determines delivery.
          options.signal?.throwIfAborted();
          dispatched = true;
        }
        return request(url, init);
      },
      preparedWorkspace,
      onCapture,
      options,
    );
  } catch (error) {
    if (!dispatched) throw beforeConversationDispatch(error);
    throw error;
  }
}

/** Persist the exact create command before dispatch, so restart recovery never recaptures changed files. */
export async function startRecordedCloudConversation(
  input: typeof CloudStartConversationInput.Type,
  session: { relayUrl: string; accessToken: string },
  stateDir: string,
  fetcher: (url: URL, options: RequestInit) => Promise<Response> = fetch,
  signal: AbortSignal = new AbortController().signal,
  report: (progress: StartReport) => void = () => {},
): Promise<typeof CloudStartConversationResult.Type> {
  let manifest: CloudWorkspaceManifest | undefined;
  const commandPath = NodePath.join(
    stateDir,
    "cloud-starts",
    `${NodeCrypto.createHash("sha256").update(input.idempotencyKey).digest("hex")}.json`,
  );
  const inputHash = NodeCrypto.createHash("sha256").update(stableStringify(input)).digest("hex");
  const saved = (await readJson(commandPath)) as {
    inputHash: string;
    command: CloudCommand;
    workspace: CloudWorkspaceManifest;
  } | null;
  if (saved && saved.inputHash !== inputHash)
    throw new CloudRequestFailure(
      "This request changed during a retry. Send it again as a new request.",
      "rejected",
      "idempotency_conflict",
    );
  const auth = session;
  const request = (url: URL, init: RequestInit) =>
    fetcher(url, {
      ...init,
      signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
    });
  if (saved) {
    manifest = saved.workspace;
    report({ phase: "creation", message: "Confirming cloud conversation…" });
  }
  const result = saved
    ? decodeResult(await cloudApi(auth, request)("/commands", saved.command))
    : await startCloudConversation(
        input,
        auth,
        request,
        undefined,
        async (captured) => {
          manifest = captured;
        },
        {
          signal,
          report,
          persistCommand: (command, workspace) =>
            durableJson(commandPath, { inputHash, command, workspace }),
        },
      );
  if (manifest && !input.handoff)
    await durableJson(
      NodePath.join(stateDir, "cloud-transfer", "bindings", `cloud-${result.entityId}.json`),
      {
        version: 1,
        workspace: manifest,
        roots: input.roots,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        history: {
          sha256: NodeCrypto.createHash("sha256").update("").digest("hex"),
          sizeBytes: 0,
          chunks: [],
        },
      },
    );
  return result;
}

export const startCloudConversationEffect = Effect.fn("cloud.start_conversation")(function* (
  input: typeof CloudStartConversationInput.Type,
) {
  const config = yield* ServerConfig;
  const session = yield* desktopCloudSession(false).pipe(
    Effect.mapError((error) =>
      asDesktopCloudError(beforeConversationDispatch(error), "Cloud sign-in failed"),
    ),
  );
  if (!session.enabled || !session.relayUrl || !session.accessToken)
    return yield* new CloudDesktopAuthError({
      message: "Sign in before starting a cloud conversation",
      code: "authentication_required",
      requestDisposition: "rejected",
    });
  return yield* Effect.tryPromise({
    try: () =>
      cloudStarts.run(
        input.idempotencyKey,
        async (signal, report) => {
          return startRecordedCloudConversation(
            input,
            {
              relayUrl: session.relayUrl!,
              accessToken: session.accessToken!,
            },
            config.stateDir,
            fetch,
            signal,
            report,
          );
        },
        NodeCrypto.createHash("sha256").update(stableStringify(input)).digest("hex"),
      ),
    catch: (error) => asDesktopCloudError(error, "Cloud workspace preparation failed"),
  });
});

export const continueCloudConversationEffect = Effect.fn("cloud.continue_conversation")(function* (
  input: typeof CloudContinueConversationInput.Type,
) {
  const session = yield* desktopCloudSession(false).pipe(
    Effect.mapError((error) =>
      asDesktopCloudError(beforeConversationDispatch(error), "Cloud sign-in failed"),
    ),
  );
  if (!session.enabled || !session.relayUrl || !session.accessToken)
    return yield* new CloudDesktopAuthError({
      message: "Sign in before continuing a cloud conversation",
      code: "authentication_required",
      requestDisposition: "rejected",
    });
  return yield* Effect.tryPromise({
    try: () =>
      continueCloudConversation(input, {
        relayUrl: session.relayUrl!,
        accessToken: session.accessToken!,
      }),
    catch: (error) => asDesktopCloudError(error, "Cloud attachment upload failed"),
  });
});
