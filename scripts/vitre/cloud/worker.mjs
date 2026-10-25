import { downloadAttachments, restoreAttachmentFiles } from "./attachments.mjs";
import {
  SETUP_LOG_PATH,
  dependencyFailure,
  dependencySetup,
  dependencySetupFingerprint,
} from "./dependencies.mjs";
import { createWorkspaceBranch, restoreWorkspace, validateManifest } from "./workspace.mjs";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTimersPromises from "node:timers/promises";
import {
  createCheckpoint,
  restoreCheckpoint,
  projectWorkspaceFromCheckpoint,
  IncompleteProjectSnapshotError,
} from "./checkpoint.mjs";

const BACKEND_PORT = Number(process.env.VITRE_CLOUD_BACKEND_PORT ?? 3773);
if (!Number.isInteger(BACKEND_PORT) || BACKEND_PORT < 1024 || BACKEND_PORT > 65535)
  throw new Error("Invalid backend port");
const ROOT = "/var/lib/vitre-worker";
const WORKSPACE = "/workspace/repository";
const APP_HOME = "/home/vitre/.t3";
const CODEX_HOME = "/home/vitre/.codex";
const providerHomes = { codex: CODEX_HOME, claude: "/home/vitre/.claude" };
const UID = 10001;
const SETUP_UID = 10002;
const CHUNK_SIZE = 8 * 1024 * 1024;
const digest = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Only actual work emits progress; heartbeats cannot reset dependency outcomes. */
export function workerProgressUpdate(journal, attemptId, sequence, now, update = {}) {
  const updatedAt = new Date(now).toISOString();
  const progress = {};
  // Resend known facts under each callback's sequence fence: a lost failure
  // response followed by readiness must not make the warning disappear.
  for (const key of ["preparation", "dependencySetup"]) {
    if (journal[key]?.attemptId === attemptId) {
      progress[key] = { ...journal[key], sequence };
      journal[key] = progress[key];
    }
  }
  if (update.phase) {
    const previous = journal.preparation;
    progress.preparation = {
      attemptId,
      sequence,
      phase: update.phase,
      startedAt:
        previous?.attemptId === attemptId && previous.phase === update.phase
          ? previous.startedAt
          : updatedAt,
      updatedAt,
    };
    journal.preparation = progress.preparation;
  }
  if (update.outcome) {
    progress.dependencySetup = {
      attemptId,
      sequence,
      outcome: update.outcome,
      updatedAt,
      ...(update.detail ? { detail: update.detail } : {}),
    };
    journal.dependencySetup = progress.dependencySetup;
  }
  return progress;
}

/** Existing/restored thread settings are never overwritten by task creation defaults. */
export function initialThreadRuntimeMode(task, existingThread) {
  return existingThread?.runtimeMode ?? task.runtimeMode ?? "full-access";
}

/** A complete snapshot restores its own Git repository; cloning first would
 * download a second copy that restoration immediately discards. */
export async function prepareWorkspaceRepository(manifest, initialize) {
  if (manifest) {
    validateManifest(manifest);
    const git = manifest.roots[0].git;
    if (git) {
      if (!git.bundle.sizeBytes) throw new Error("Workspace Git bundle is empty");
      return;
    }
  }
  await initialize();
}

export async function checkpointSettledRun(error, attempt, readStatus, checkpoint) {
  if (error?.code !== "task_settled") return false;
  const status = await readStatus();
  if (
    !status.stopRequested ||
    status.attempt?.id !== attempt.id ||
    status.attempt?.generation !== attempt.generation
  )
    return false;
  await checkpoint("heartbeat");
  return true;
}

/** Queued conversations can reclaim a warm slot after the current turn finishes. */
export function retainIdleWorkspace(keepAliveSeconds, idleSince, now, yieldIdle) {
  return !yieldIdle && !!keepAliveSeconds && now - idleSince < keepAliveSeconds * 1000;
}

/** A completed current turn wins over stale thread-level pending-input flags. */
export function classifyWorkerTurn(latestTurn, requestedAt, shell, resident, idleWake, session) {
  const currentTurn = latestTurn && Date.parse(latestTurn.requestedAt) >= Date.parse(requestedAt);
  if (
    (currentTurn &&
      (latestTurn.state === "completed" || (resident && latestTurn.state === "interrupted"))) ||
    idleWake
  )
    return "settled";
  if (shell?.hasPendingApprovals || shell?.hasPendingUserInput) return "waiting_for_input";
  if (
    (currentTurn && ["error", "interrupted"].includes(latestTurn.state)) ||
    session?.status === "error"
  )
    return "failed";
  return "working";
}

/** Recover services only; an ambiguous first submission must never be replayed. */
export function canRecoverWorker(bootstrap, journal, attemptId) {
  return (
    bootstrap.resident === true &&
    !bootstrap.stopRequested &&
    bootstrap.attempt?.id === attemptId &&
    journal?.attemptId === attemptId &&
    journal.setupComplete === true &&
    !bootstrap.task?.archivedAt &&
    ["running", "waiting_for_input"].includes(bootstrap.task?.state) &&
    (journal.submitted === true || bootstrap.task.wakeOnly === true || journal.activated === true)
  );
}

/** A reboot must not upload an older account token over a newer vault version. */
export function canRecoverCredential(journal, credential) {
  return (
    Number.isSafeInteger(journal.credentialVersion) &&
    journal.credentialVersion >= 0 &&
    journal.credentialVersion === credential.version
  );
}

/** Reconcile retained backend ownership before replaying a handoff on a new attempt. */
export async function recoverActivatedHandoff(task, journal, threadExists, readOwnership, persist) {
  if (!task.handoff || !threadExists || journal.activated) return;
  const ownership = await readOwnership();
  if (
    ownership?.generation === 1 &&
    ownership.operationId === task.handoff.operationId &&
    ownership.status === "active"
  ) {
    // The database outlives attempt-scoped journals. Its activated ownership
    // proves history was imported already; importing the original handoff again
    // would discard every message added since the transfer.
    journal.imported = true;
    journal.activated = true;
    await persist();
    return;
  }
  if (
    ownership?.generation === 0 &&
    ((ownership.operationId === "initial" && ownership.status === "active") ||
      (ownership.operationId === task.handoff.operationId && ownership.status === "frozen"))
  )
    return;
  throw new WorkerFailure("Conversation ownership changed before handoff recovery");
}

export function sessionStopCommand(commandId, threadId) {
  return {
    type: "thread.session.stop",
    commandId,
    threadId,
    createdAt: new Date().toISOString(),
  };
}

export function handoffRestoreCommand({
  operationId,
  threadId,
  thread,
  workspace,
  additionalRoots,
  createdAt,
}) {
  return {
    type: "thread.execution.restore",
    threadId,
    commandId: `${operationId}-history`,
    operationId,
    expectedGeneration: 0,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    worktreePath: workspace,
    branch: thread.branch,
    additionalRoots: additionalRoots.map((root) => ({ kind: "path", path: root.path })),
    messages: thread.messages,
    proposedPlans: thread.proposedPlans,
    activities: thread.activities ?? [],
    createdAt,
  };
}

/** A warm backend may outlive its provider lease. Never release refresh ownership
 * until the provider process is gone and its last credential has been saved. */
export function createProviderLease({
  owned,
  turnRequestId: ownedTurnRequestId,
  acquire,
  suspend,
  persist,
  release,
  install,
}) {
  const relinquish = async () => {
    if (!owned) return;
    await suspend();
    await persist();
    await release(ownedTurnRequestId);
    owned = false;
  };
  return {
    async acquire(turnRequestId, { revalidate = false } = {}) {
      if (owned && !revalidate && turnRequestId === ownedTurnRequestId) return true;
      // Each new turn must validate current ownership/auth and join the relay's
      // FIFO queue, even when this process retained the previous turn's lease.
      const result = await acquire(turnRequestId);
      if (!result.acquired) {
        await relinquish();
        return false;
      }
      const retained = owned;
      // Keep ownership even when installation fails; teardown must fence it.
      owned = true;
      ownedTurnRequestId = turnRequestId;
      // A live session may already have rotated its on-disk credential. Never
      // overwrite that newer token with the last periodically persisted copy.
      if (!retained) await install(result);
      return true;
    },
    release: relinquish,
  };
}

/** Publish readiness, and free contested refresh ownership, before transcript I/O. */
export async function settleResidentTurn({
  markIdle,
  drainCallbacks,
  lease,
  yieldIdle = true,
  publishIdle = async () => {},
  mirror,
}) {
  // Future heartbeats must say idle, and earlier busy heartbeats must finish
  // before release marks this task idle in the relay's FIFO lease queue.
  markIdle();
  await drainCallbacks();
  if (yieldIdle) await lease.release();
  await publishIdle();
  await mirror();
}

export function cloudTurnContext(kind) {
  return `This is a cloud ${kind} task. Pull requests are supported through Vitre's Create PR action, which saves the workspace for review and publishes a draft PR with the connected GitHub account. When asked to open a PR, finish the changes and validation, suggest a title and description, and direct the user to Create PR. Do not push branches or publish PRs/comments from shell tools; execution credentials are read-only. Report changes and validation accurately.`;
}

/** Claim the reviewed turn before stopping any process or reading its files. */
export async function preparePublicationSnapshot(task, turnRequestId, claim, save) {
  const preparation = task.publicationPreparation;
  if (!preparation) return false;
  if (
    preparation.turnRequestId !== (turnRequestId ?? null) ||
    preparation.turnRequestId !== (task.turnRequestId ?? null)
  )
    throw new WorkerFailure("Publication preparation belongs to another turn");
  await claim();
  await save();
  return true;
}

/** Retry only explicitly transient failures on reads or idempotent operations.
 * Credential rotation and turn submission must reconcile ambiguous responses. */
export async function retryControlRequest(operation, sleep = NodeTimersPromises.setTimeout) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!error.retryable || attempt >= 2) throw error;
      await sleep(250 * 2 ** attempt);
    }
  }
}

/** Bootstrap cannot report progress until it succeeds. Bound both requests and
 * elapsed time so a rejected dependency cannot silently hold preparation open. */
export async function bootstrapWorker(
  control,
  taskId,
  attemptId,
  journal,
  { sleep = NodeTimersPromises.setTimeout, now = Date.now } = {},
) {
  const deadline = now() + 15_000;
  let failure;
  for (let retry = 0; retry < 4 && now() < deadline; retry++) {
    try {
      const bootstrap = await control.request(`worker/${taskId}/bootstrap`, undefined, {
        timeoutMs: Math.min(5000, deadline - now()),
      });
      if (bootstrap.attempt?.id !== attemptId)
        throw Object.assign(new WorkerFailure("Stale worker attempt"), { code: "stale_worker" });
      return bootstrap;
    } catch (error) {
      failure = error;
      if (!error.retryable || retry === 3) break;
      const delay = 500 * 2 ** retry;
      if (now() + delay >= deadline) break;
      await sleep(delay);
    }
  }
  // Error codes select fixed text; upstream messages and response bodies can
  // contain credentials and must never reach logs or the conversation.
  const reason =
    failure?.code === "github_unavailable"
      ? "GitHub is unavailable; retry preparation later."
      : failure?.code === "needs_auth"
        ? "Provider authorization is required; reconnect your account."
        : failure?.code === "preparing"
          ? "The cloud endpoint was not ready before preparation timed out."
          : "Cloud preparation could not connect to its control service.";
  const suffix = attemptId?.startsWith(`${taskId}-`) ? attemptId.slice(taskId.length + 1) : "";
  const generation = /^[1-9][0-9]*$/.test(suffix) ? Number(suffix) : NaN;
  const sequence = journal?.attemptId === attemptId ? journal.sequence + 1 : 1;
  if (
    !["stale_worker", "task_settled", "unauthorized"].includes(failure?.code) &&
    Number.isSafeInteger(generation) &&
    Number.isSafeInteger(sequence) &&
    sequence > 0
  ) {
    // The scheduler encodes generation in the attempt ID. The relay still
    // authenticates and checks the full task/attempt/generation fence. Do not
    // replace an older journal or acquire credentials just to report failure.
    await control
      .request(
        "worker/callback",
        {
          taskId,
          attemptId,
          generation,
          sequence,
          phase: failure?.code === "needs_auth" ? "needs_auth" : "failed",
          detail: `Cloud preparation failed: ${reason}`,
        },
        { timeoutMs: 5000 },
      )
      .catch(() => {});
  }
  throw new WorkerBootstrapFailure(`Cloud preparation failed: ${reason}`);
}

/** Never inherit the supervisor's control, GitHub, or infrastructure credentials. */
export function childEnvironment(home = "/home/vitre") {
  return {
    HOME: home,
    USER: home.endsWith("vitre-setup") ? "vitre-setup" : "vitre",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...(home.endsWith("vitre-setup")
      ? {
          npm_config_cache: `${home}/.cache/npm`,
          npm_config_store_dir: `${home}/.cache/pnpm`,
          COREPACK_HOME: `${home}/.cache/corepack`,
          YARN_CACHE_FOLDER: `${home}/.cache/yarn`,
        }
      : {}),
  };
}

export function providerEnvironment(provider, credential) {
  const env = childEnvironment();
  if (provider === "codex") {
    const auth = JSON.parse(credential);
    if (!auth.tokens?.refresh_token || auth.OPENAI_API_KEY)
      throw new WorkerFailure("Subscription credentials required");
    env.CODEX_HOME = CODEX_HOME;
  } else if (provider === "claude" && credential.startsWith("sk-ant-oat")) {
    env.CLAUDE_CODE_OAUTH_TOKEN = credential;
    env.CLAUDE_CONFIG_DIR = "/home/vitre/.claude";
  } else throw new WorkerFailure("Subscription credentials required");
  return env;
}

export function workerModelSelection(task, models) {
  const instanceId = task.provider === "claude" ? "claudeAgent" : task.provider;
  return {
    instanceId,
    model: task.model ?? models[instanceId],
    ...(task.modelOptions ? { options: task.modelOptions } : {}),
  };
}

export function workerTurnSettings(task, thread, models) {
  const settings = task.turnSettings;
  return {
    modelSelection:
      settings?.model || settings?.modelOptions
        ? workerModelSelection(
            {
              ...task,
              model: settings.model ?? thread.modelSelection.model,
              modelOptions: settings.modelOptions ?? thread.modelSelection.options,
            },
            models,
          )
        : thread.modelSelection,
    runtimeMode: settings?.runtimeMode ?? thread.runtimeMode,
    interactionMode: settings?.interactionMode ?? thread.interactionMode,
  };
}

export async function dispatchWorkerTurn(task, thread, models, turnCommand, dispatch) {
  const settings = workerTurnSettings(task, thread, models);
  // Turn start reads the stored thread modes. Its compatibility fields do not
  // update them, so persist explicit follow-up changes before starting work.
  for (const [field, type, suffix] of [
    ["runtimeMode", "thread.runtime-mode.set", "runtime-mode"],
    ["interactionMode", "thread.interaction-mode.set", "interaction-mode"],
  ]) {
    if (settings[field] !== thread[field]) {
      await dispatch({
        type,
        commandId: `${turnCommand.commandId}-${suffix}`,
        threadId: turnCommand.threadId,
        [field]: settings[field],
        createdAt: turnCommand.createdAt,
      });
    }
  }
  return dispatch({ ...turnCommand, ...settings });
}

export function providerFailurePhase(message = "") {
  if (
    /rate[ _-]?limit|usage[ _-]?limit|quota.{0,40}(exceeded|exhausted)|out of.{0,20}usage|\b429\b/i.test(
      message,
    )
  )
    return "usage_limited";
  if (
    /not logged in|unauthori[sz]ed|authentication (failed|required)|token.{0,80}(expired|revoked)|login required|please run \/login|\b401\b/i.test(
      message,
    )
  )
    return "needs_auth";
  return "failed";
}

function launch(
  binary,
  args,
  { cwd = WORKSPACE, env = childEnvironment(), uid = UID, stdin } = {},
) {
  const child = NodeChildProcess.spawn(binary, args, {
    cwd,
    env,
    uid,
    gid: uid,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (stdin !== undefined) child.stdin.end(stdin);
  else child.stdin.end();
  // Raw tool output may contain credentials. Only capture bounded output in memory.
  let output = "";
  const collect = (bytes) => {
    output = (output + bytes.toString()).slice(-256 * 1024);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal, output }));
  });
  return { child, done };
}

async function stop(process) {
  if (!process) return;
  try {
    globalThis.process.kill(-process.child.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([process.done.catch(() => {}), NodeTimersPromises.setTimeout(5000)]);
  // Also remove descendants that outlived the group leader.
  try {
    globalThis.process.kill(-process.child.pid, "SIGKILL");
  } catch {}
}

/** A failure the worker described itself. Only these messages (never raw
 * provider or tool output, which can carry credentials) reach the task. */
class WorkerFailure extends Error {}
class WorkerBootstrapFailure extends WorkerFailure {}

function describeFailure(error) {
  if (error instanceof IncompleteProjectSnapshotError)
    return new IncompleteProjectSnapshotError().message;
  if (error instanceof WorkerFailure) return error.message;
  if (typeof error?.code === "string" && /^E[A-Z0-9]+$/.test(error.code)) {
    const where =
      typeof error.path === "string" && error.path.startsWith("/") ? ` on ${error.path}` : "";
    return `${error.syscall ?? "system call"} failed with ${error.code}${where}`;
  }
  return null;
}

async function command(binary, args, options, timeout = 900_000) {
  const process = launch(binary, args, options);
  const timer = setTimeout(() => {
    void stop(process);
  }, timeout);
  try {
    const result = await process.done;
    if (result.code !== 0)
      throw new WorkerFailure(
        `${NodePath.basename(binary)} exited with code ${result.code}${result.signal ? ` (${result.signal})` : ""}`,
      );
    return result.output;
  } finally {
    clearTimeout(timer);
  }
}

const jsonWrites = new Map();
export async function atomicJson(path, value) {
  const encoded = JSON.stringify(value);
  const pending = (jsonWrites.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
      try {
        await NodeFSP.writeFile(temporary, encoded, { mode: 0o600, flag: "wx" });
        await NodeFSP.rename(temporary, path);
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    });
  jsonWrites.set(path, pending);
  try {
    await pending;
  } finally {
    if (jsonWrites.get(path) === pending) jsonWrites.delete(path);
  }
}

export async function copyWorkspace(source, destination) {
  await NodeFSP.cp(source, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
}

/** Workspace and private worker state can be separate bind mounts. */
export async function moveDirectory(source, destination, filesystem = NodeFSP) {
  try {
    await filesystem.rename(source, destination);
    return;
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
  }
  const staging = await filesystem.mkdtemp(NodePath.join(NodePath.dirname(destination), ".move-"));
  try {
    const copied = NodePath.join(staging, "data");
    await filesystem.cp(source, copied, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    // Publish only a complete copy, on the destination filesystem.
    await filesystem.rename(copied, destination);
    await filesystem.rm(source, { recursive: true });
  } finally {
    await filesystem.rm(staging, { recursive: true, force: true });
  }
}

export async function installProviderCredential(directory, credential, uid, filesystem = NodeFSP) {
  // Same filesystem as auth.json; the private random directory prevents a
  // previous provider process from pre-creating a symlink at the temporary path.
  const staging = await filesystem.mkdtemp(NodePath.join(directory, ".auth-"));
  try {
    await filesystem.chmod(staging, 0o700);
    const temporary = NodePath.join(staging, "auth.json");
    await filesystem.writeFile(temporary, credential, { mode: 0o600, flag: "wx" });
    await filesystem.chown(temporary, uid, uid);
    await filesystem.rename(temporary, NodePath.join(directory, "auth.json"));
  } finally {
    await filesystem.rm(staging, { recursive: true, force: true });
  }
}

export class WorkerControlClient {
  constructor(baseUrl, token, fetcher = fetch) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new WorkerFailure("Cloud control URL must use HTTPS");
    this.baseUrl = url.href.replace(/\/$/, "");
    this.token = token;
    this.fetcher = fetcher;
  }
  async request(path, body, { timeoutMs = 30_000 } = {}) {
    const response = await this.fetcher(`${this.baseUrl}/v1/cloud/${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => {
      throw Object.assign(new WorkerFailure("Cloud control connection unavailable"), {
        retryable: true,
      });
    });
    if (!response.ok) {
      const error = new Error(`Control request failed (${response.status})`);
      // Only the documented code is used; never log upstream bodies or tokens.
      const data = await response.json().catch(() => ({}));
      error.code = data.code;
      error.retryable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      throw error;
    }
    return response.json().catch(() => {
      throw Object.assign(new WorkerFailure("Cloud control response was incomplete"), {
        retryable: true,
      });
    });
  }
}

export function backendBootstrapEnvelope(bootstrap, port = BACKEND_PORT) {
  return {
    mode: "desktop",
    noBrowser: true,
    port,
    t3Home: APP_HOME,
    host: "127.0.0.1",
    desktopBootstrapToken: bootstrap.backendBootstrapToken,
    residentCloudBootstrap: bootstrap.resident === true,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  };
}

export function makeLocalBackendClient(bootstrapToken, fetcher = fetch, port = BACKEND_PORT) {
  let accessToken;
  const exchange = async () => {
    const response = await fetcher(`http://127.0.0.1:${port}/oauth/token`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: bootstrapToken,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        client_label: "Vitre Cloud Supervisor",
        client_device_type: "desktop",
      }),
    });
    if (!response.ok) throw new WorkerFailure("Backend authentication failed");
    accessToken = (await response.json()).access_token;
  };
  return {
    exchange,
    request: async (path, body) => {
      const send = () =>
        fetcher(`http://127.0.0.1:${port}${path}`, {
          method: body === undefined ? "GET" : "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      let response = await send();
      // The VM may resume after its HTTP token expires. Retry only an explicit
      // authentication rejection, never an ambiguous command/network failure.
      if (response.status === 401) {
        await exchange();
        response = await send();
      }
      if (!response.ok) throw new WorkerFailure(`Backend request failed (${response.status})`);
      return response.json();
    },
  };
}

export async function prepareBackendHome(appHome, roots) {
  const identities = NodePath.join(appHome, "userdata/cloud-transfer/root-identities");
  await NodeFSP.mkdir(identities, { recursive: true, mode: 0o700 });
  for (const root of roots)
    await atomicJson(NodePath.join(identities, `${digest(root.path)}.json`), root);
  // Recursive mkdir also creates the private home and userdata parents as root.
  // Give the backend access to the entire tree, not only its deepest directory.
  await command("chown", ["-h", "-R", `${UID}:${UID}`, appHome], { uid: 0, cwd: appHome });
}

export async function runWorker() {
  let additionalRoots = [];
  let primaryIsNonGit = false;
  let primaryRootId = "primary";
  if (process.getuid?.() !== 0)
    throw new WorkerFailure("Worker supervisor must run as root with unprivileged child accounts");
  const control = new WorkerControlClient(
    process.env.VITRE_CLOUD_CONTROL_URL,
    process.env.VITRE_CLOUD_WORKER_TOKEN,
  );
  const taskId = process.env.VITRE_CLOUD_TASK_ID;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId ?? ""))
    throw new WorkerFailure("Invalid worker task ID");
  await NodeFSP.mkdir(ROOT, { recursive: true, mode: 0o700 });
  const journalPath = NodePath.join(ROOT, "journal.json");
  const recovering = process.env.VITRE_CLOUD_RECOVER_ATTEMPT === "1";
  let journal = await NodeFSP.readFile(journalPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const bootstrap = await bootstrapWorker(
    control,
    taskId,
    process.env.VITRE_CLOUD_ATTEMPT_ID,
    journal,
  );
  const { task, attempt } = bootstrap;
  const resident = bootstrap.resident === true;
  const previousJournal = journal;
  if (recovering && !canRecoverWorker(bootstrap, previousJournal, attempt.id))
    throw new WorkerFailure("Worker recovery is no longer authorized");
  const sameAttempt = journal?.attemptId === attempt.id;
  journal = sameAttempt
    ? journal
    : { attemptId: attempt.id, sequence: attempt.lastSequence, submitted: false };
  journal.sequence = Math.max(journal.sequence, attempt.lastSequence);
  let backend, tunnel, setup, heartbeatTimer;
  let auth;
  const secrets = new Set(
    [
      process.env.VITRE_CLOUD_WORKER_TOKEN,
      bootstrap.backendBootstrapToken,
      bootstrap.repositoryToken,
      bootstrap.endpoint?.runtime.connectorToken,
    ].filter(Boolean),
  );
  const rememberCredential = (credential) => {
    if (task.provider === "claude") secrets.add(credential);
    else
      for (const token of Object.values(JSON.parse(credential).tokens ?? {}))
        if (typeof token === "string") secrets.add(token);
  };
  let lastCredentialCheck = 0;
  const persistCredential = async () => {
    if (!auth || task.provider !== "codex") return;
    if (recovering && !backendAuthenticated && !canRecoverCredential(journal, auth)) return;
    // Read at the provider's privilege level: a tool can replace paths in its
    // own home, but must never trick the root supervisor into reading root files.
    const updated = await command(
      "node",
      [
        "-e",
        "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
        NodePath.join(CODEX_HOME, "auth.json"),
      ],
      { uid: UID, cwd: "/tmp" },
      5000,
    );
    rememberCredential(updated);
    if (updated !== auth.credential) {
      const refreshed = await control.request(`worker/${taskId}/credential/refresh`, {
        attemptId: attempt.id,
        expectedVersion: auth.version,
        credential: updated,
      });
      auth.credential = updated;
      auth.version = refreshed.version;
      journal.credentialVersion = auth.version;
      await atomicJson(journalPath, journal);
    }
    lastCredentialCheck = Date.now();
  };
  let currentPhase = task.state;
  // Serialize heartbeats and finalization so callbacks cannot overtake a checkpoint.
  let tail = Promise.resolve();
  let idle = false;
  const callback = (phase, detail = "", manifest, conversation, closeIdle = false, progress) => {
    const next = tail
      .catch(() => {})
      .then(async () => {
        const event = {
          taskId,
          attemptId: attempt.id,
          generation: attempt.generation,
          ...(task.baseSha ? { baseSha: task.baseSha } : {}),
          sequence: ++journal.sequence,
          phase,
          detail,
          idle,
          ...(journal.turnRequestId ? { turnRequestId: journal.turnRequestId } : {}),
          ...(closeIdle ? { closeIdle: true } : {}),
        };
        Object.assign(
          event,
          workerProgressUpdate(journal, attempt.id, journal.sequence, Date.now(), progress),
        );
        await atomicJson(journalPath, journal);
        await control.request(
          manifest ? "worker/finalize" : conversation ? "worker/mirror" : "worker/callback",
          manifest
            ? { callback: event, manifest }
            : conversation
              ? { callback: event, conversation }
              : event,
        );
        currentPhase = phase === "heartbeat" ? currentPhase : phase;
      });
    tail = next;
    return next;
  };
  const reportPreparation = (phase) =>
    callback("heartbeat", "", undefined, undefined, false, { phase });
  const reportSetup = (outcome, detail, phase) =>
    callback("heartbeat", detail ?? "", undefined, undefined, false, { outcome, detail, phase });
  const checkDisk = async () => {
    const disk = await NodeFSP.statfs("/workspace");
    if (disk.bavail * disk.bsize < 512 * 1024 * 1024)
      throw new WorkerFailure("Worker disk allowance exhausted");
  };
  let backendAuthenticated = false;
  const localApi = makeLocalBackendClient(bootstrap.backendBootstrapToken);
  const backendRequest = localApi.request;
  const dispatch = (command) => backendRequest("/api/orchestration/dispatch", command);
  const threadId = `cloud-${taskId}`;
  const lease = createProviderLease({
    owned: bootstrap.leaseOwned ?? true,
    turnRequestId: bootstrap.leaseTurnRequestId ?? undefined,
    acquire: (turnRequestId) =>
      control.request(`worker/${taskId}/lease`, {
        attemptId: attempt.id,
        action: "acquire",
        ...(turnRequestId ? { turnRequestId } : {}),
      }),
    suspend: async () => {
      if (!backendAuthenticated) return;
      const { thread } = await backendRequest(`/api/orchestration/threads/${threadId}`);
      if (!thread.session || thread.session.status === "stopped") return;
      journal.leaseStopSequence = (journal.leaseStopSequence ?? 0) + 1;
      await atomicJson(journalPath, journal);
      await dispatch(
        sessionStopCommand(`${attempt.id}-lease-stop-${journal.leaseStopSequence}`, threadId),
      );
      for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
        const { thread: current } = await backendRequest(`/api/orchestration/threads/${threadId}`);
        if (!current.session || current.session.status === "stopped") return;
        await NodeTimersPromises.setTimeout(50);
      }
      throw new WorkerFailure("Provider session did not stop; retaining credential ownership");
    },
    persist: async () => {
      // A restarted worker may need to yield its previous turn before starting
      // the backend. Load the version fence before saving any retained auth file.
      auth ??= await control.request(`worker/${taskId}/credential`, { attemptId: attempt.id });
      await persistCredential();
    },
    release: async (turnRequestId) => {
      if (task.provider === "codex") {
        await command(
          "node",
          [
            "-e",
            "require('node:fs').rmSync(process.argv[1], {force: true})",
            NodePath.join(CODEX_HOME, "auth.json"),
          ],
          { uid: UID, cwd: "/tmp" },
          5000,
        );
      }
      // Persist has completed and no process can refresh this credential now.
      // Clearing locally also makes an ambiguous release safe to checkpoint.
      auth = undefined;
      await retryControlRequest(() =>
        control.request(`worker/${taskId}/lease`, {
          attemptId: attempt.id,
          action: "release",
          ...(turnRequestId ? { turnRequestId } : {}),
        }),
      );
    },
    install: async (credential) => {
      rememberCredential(credential.credential);
      if (task.provider === "codex") {
        await installProviderCredential(CODEX_HOME, credential.credential, UID);
      } else if (initialCredential !== undefined && credential.credential !== initialCredential) {
        // Claude's token is inherited by the backend. Do not run with an older
        // token after the account has been reconnected.
        throw new WorkerFailure("Provider account changed; restart this workspace");
      }
      auth = credential;
      journal.credentialVersion = auth.version;
      await atomicJson(journalPath, journal);
    },
  });
  let initialCredential;
  const uploadPortableWorkspace = async (saved, seed = false) => {
    validateManifest(saved.workspace);
    const hashes = new Set(saved.workspace.entries.flatMap((entry) => entry.chunks));
    for (const root of saved.workspace.roots)
      for (const blob of root.git ? [root.git.bundle, root.git.index] : [])
        for (const hash of blob.chunks) hashes.add(hash);
    for (const hash of hashes) {
      const bytes = await saved.readWorkspaceChunk(hash);
      if (digest(bytes) !== hash)
        throw new WorkerFailure("Saved workspace failed integrity verification");
      const uploaded = await retryControlRequest(() =>
        control.request(`worker/${taskId}/workspace-chunks`, {
          base64: Buffer.from(bytes).toString("base64"),
        }),
      );
      if (uploaded.sha256 !== hash) throw new WorkerFailure("Uploaded workspace digest mismatch");
    }
    return retryControlRequest(() =>
      control.request(`worker/${taskId}/workspace`, { manifest: saved.workspace, seed }),
    );
  };
  const checkpoint = async (phase, thread = null, test = { output: "", code: null }) => {
    // Stop the provider process tree before taking the database/worktree boundary.
    if (backend && backendAuthenticated) {
      await dispatch(sessionStopCommand(`${attempt.id}-stop`, threadId)).catch(() => {});
      for (let i = 0; i < 10; i++) {
        const snapshot = await backendRequest(`/api/orchestration/threads/${threadId}`).catch(
          () => null,
        );
        if (!snapshot?.thread?.session || snapshot.thread.session.status === "stopped") break;
        await NodeTimersPromises.setTimeout(250);
      }
    }
    await stop(backend);
    backend = undefined;
    // A tool may daemonize out of its original process group. This VM belongs to
    // one task, so terminate both task UIDs before reading a consistent boundary.
    for (const uid of [UID, SETUP_UID])
      await command("pkill", ["-KILL", "-u", String(uid)], { uid: 0 }, 5000).catch(() => {});
    await persistCredential();
    await checkDisk();
    const saved = await createCheckpoint({
      repository: WORKSPACE,
      database: NodePath.join(APP_HOME, "userdata/state.sqlite"),
      attachmentsDirectory: NodePath.join(APP_HOME, "userdata/attachments"),
      directory: ROOT,
      baseSha: task.baseSha,
      secrets: [...secrets],
      providerHomes,
      additionalRoots,
      primaryIsNonGit,
      ...(primaryIsNonGit ? { objectDirectory: NodePath.join(ROOT, "non-git", "objects") } : {}),
    });
    try {
      const id = NodeCrypto.randomUUID();
      const workspace = await uploadPortableWorkspace(saved);
      const file = await NodeFSP.open(saved.path, "r");
      const chunks = [];
      try {
        let index = 0;
        for (;;) {
          const buffer = Buffer.alloc(CHUNK_SIZE);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          const chunk = buffer.subarray(0, bytesRead);
          const uploaded = await control.request(`worker/${taskId}/chunks`, {
            attemptId: attempt.id,
            checkpointId: id,
            index,
            base64: chunk.toString("base64"),
          });
          if (uploaded.sha256 !== digest(chunk))
            throw new WorkerFailure("Uploaded checkpoint digest mismatch");
          chunks.push(uploaded);
          index++;
        }
      } finally {
        await file.close();
      }
      const lastAssistant = thread?.messages?.findLast((message) => message.role === "assistant");
      const manifest = {
        version: 1,
        taskId,
        attemptId: attempt.id,
        checkpointId: id,
        chunks,
        workspace,
        result: {
          summary: lastAssistant?.text ?? "Workspace checkpoint saved",
          diff: saved.diff,
          conversation: thread,
          testOutput: test.output,
          testExitCode: test.code,
        },
      };
      let encoded = JSON.stringify(manifest);
      for (const secret of secrets) encoded = encoded.replaceAll(secret, "[redacted]");
      await callback(phase, "", JSON.parse(encoded));
    } finally {
      await saved.dispose();
    }
  };
  try {
    if (bootstrap.stopRequested) return;
    heartbeatTimer = setInterval(() => {
      void callback("heartbeat").catch(() => {});
    }, 30_000);
    await checkDisk();
    const workspaceInfo = await NodeFSP.readFile(NodePath.join(ROOT, "workspace-info.json"), "utf8")
      .then(JSON.parse)
      .catch(() => ({}));
    primaryIsNonGit = workspaceInfo.primaryIsNonGit === true;
    primaryRootId = workspaceInfo.primaryRootId ?? "primary";
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(primaryRootId))
      throw new WorkerFailure("Invalid primary root identity");
    additionalRoots = await NodeFSP.readFile(NodePath.join(ROOT, "workspace-roots.json"), "utf8")
      .then(JSON.parse)
      .catch(() => []);
    if (
      !Array.isArray(additionalRoots) ||
      additionalRoots.some(
        (root) =>
          !/^[a-zA-Z0-9_-]{1,128}$/.test(root.id) ||
          root.path !== NodePath.join("/workspace/roots", root.id),
      )
    )
      throw new WorkerFailure("Invalid workspace root mapping");
    const exists =
      (!task.projectSnapshot || previousJournal?.workspaceRestored || task.checkpoint) &&
      (await NodeFSP.stat(
        primaryIsNonGit ? NodePath.join(ROOT, "non-git") : NodePath.join(WORKSPACE, ".git"),
      )
        .then(() => true)
        .catch(() => false));
    if (!exists && task.projectSnapshot) {
      await NodeFSP.rm(WORKSPACE, { recursive: true, force: true });
      await NodeFSP.rm(NodePath.join(ROOT, "non-git"), { recursive: true, force: true });
    }
    const setupFingerprint = async () =>
      Promise.all(
        [WORKSPACE, ...additionalRoots.map((root) => root.path)].map(async (cwd) => [
          cwd,
          await dependencySetupFingerprint(
            cwd,
            cwd === WORKSPACE ? task.repository.setupCommand : "",
          ),
        ]),
      );
    const reuseSetup =
      exists &&
      previousJournal?.setupComplete &&
      !previousJournal.setupWarning &&
      JSON.stringify(previousJournal.setupFingerprint) === JSON.stringify(await setupFingerprint());
    journal.setupComplete = !!reuseSetup;
    delete journal.setupWarning;
    // A warm workspace already belongs to the agent user; only files written by
    // root or the setup user this run need their ownership fixed afterwards.
    let ownershipChanged = !exists;
    if (!exists) {
      await reportPreparation(
        task.source || task.checkpoint || task.projectSnapshot ? "restoring" : "cloning",
      );
      if (task.projectSnapshot?.checkpoint && !task.source) {
        await callback("heartbeat", "Preparing saved project workspace from an older checkpoint");
        const { manifest: seedManifest } = await control.request(`worker/${taskId}/seed`);
        const archive = NodePath.join(ROOT, "project-seed.tar.gz");
        const file = await NodeFSP.open(archive, "w", 0o600);
        try {
          for (const chunk of seedManifest.chunks) {
            const fetched = await control.request(`worker/${taskId}/seed/${chunk.index}`);
            const bytes = Buffer.from(fetched.base64, "base64");
            if (bytes.length !== chunk.sizeBytes || digest(bytes) !== chunk.sha256)
              throw new WorkerFailure("Project snapshot failed integrity verification");
            await file.write(bytes);
          }
        } finally {
          await file.close();
        }
        const saved = await projectWorkspaceFromCheckpoint({
          archive,
          directory: ROOT,
          baseSha: task.baseSha,
          legacyLocal: task.projectSnapshot.sourceKind === "local",
          prepareLegacyRepository: async (destination) => {
            const access = await control.request(`worker/${taskId}/legacy-repository`);
            const env = {
              ...childEnvironment("/home/vitre-setup"),
              ...(access.token
                ? {
                    GIT_CONFIG_COUNT: "1",
                    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
                    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${access.token}`).toString("base64")}`,
                  }
                : {}),
            };
            rememberCredential(access.token);
            await command(
              "git",
              [
                "clone",
                "--no-checkout",
                `https://github.com/${task.repository.owner}/${task.repository.name}.git`,
                destination,
              ],
              { uid: 0, cwd: ROOT, env },
            );
            return destination;
          },
        });
        try {
          const snapshot = await uploadPortableWorkspace(saved, true);
          const head = saved.workspace.roots[0]?.git?.head;
          task.source =
            task.projectSnapshot.sourceKind === "github" && head
              ? { kind: "github", revision: head, snapshot }
              : { kind: "local", name: task.repository.name, snapshot };
          task.baseSha = head ?? task.baseSha;
        } finally {
          await saved.dispose();
          await NodeFSP.rm(archive, { force: true });
        }
        await callback(
          "heartbeat",
          "Saved project workspace is ready; creating an independent conversation",
        );
      }
      if (task.source?.kind !== "local" && !task.baseSha)
        throw new WorkerFailure("A pinned repository revision is required");
      const manifest = task.source
        ? (await control.request(`worker/${taskId}/workspace/${task.source.snapshot.sha256}`))
            .manifest
        : null;
      if (task.source && !manifest) throw new WorkerFailure("Workspace manifest is missing");
      await NodeFSP.mkdir(WORKSPACE, { recursive: true });
      // The parent may have been created under a restrictive umask.
      await NodeFSP.chmod(NodePath.dirname(WORKSPACE), 0o755);
      await NodeFSP.chown(WORKSPACE, SETUP_UID, SETUP_UID);
      const setupEnv = childEnvironment("/home/vitre-setup");
      // Token is in the clone process environment, never the remote URL or Git config.
      const cloneEnv = bootstrap.repositoryToken
        ? {
            ...setupEnv,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${bootstrap.repositoryToken}`).toString("base64")}`,
          }
        : setupEnv;
      await prepareWorkspaceRepository(manifest, async () => {
        await callback(
          "heartbeat",
          task.source?.kind === "local"
            ? "Preparing the uploaded workspace"
            : "Cloning the repository",
        );
        if (task.source?.kind !== "local") {
          await command(
            "git",
            [
              "clone",
              "--no-checkout",
              `https://github.com/${task.repository.owner}/${task.repository.name}.git`,
              ".",
            ],
            { uid: SETUP_UID, env: cloneEnv },
          );
          await command(
            "git",
            [
              "checkout",
              "-B",
              task.branch,
              task.source?.kind === "github" ? task.source.revision : task.baseSha,
            ],
            {
              uid: SETUP_UID,
              env: setupEnv,
            },
          );
        } else {
          await command("git", ["init", "--initial-branch", task.branch], {
            uid: SETUP_UID,
            env: setupEnv,
          });
          await command(
            "git",
            [
              "-c",
              "user.name=Vitre",
              "-c",
              "user.email=vitre@localhost",
              "commit",
              "--allow-empty",
              "-m",
              "Local workspace baseline",
            ],
            {
              uid: SETUP_UID,
              env: {
                ...setupEnv,
                GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
                GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
              },
            },
          );
          const head = await command("git", ["rev-parse", "HEAD"], {
            uid: SETUP_UID,
            env: setupEnv,
          });
          task.baseSha = String(head).trim();
        }
      });
      if (manifest) {
        await callback("heartbeat", "Restoring the uploaded workspace");
        primaryIsNonGit = !manifest.roots[0].git;
        primaryRootId = manifest.roots[0].id;
        await atomicJson(NodePath.join(ROOT, "workspace-info.json"), {
          primaryIsNonGit,
          primaryRootId,
        });
        const staging = NodePath.join(ROOT, "workspace-restore");
        await NodeFSP.rm(staging, { recursive: true, force: true });
        await restoreWorkspace(
          manifest,
          staging,
          async (hash) => {
            const chunk = await control.request(`worker/${taskId}/workspace/${hash}`);
            return Buffer.from(chunk.base64, "base64");
          },
          { prefetch: true },
        );
        for (const name of await NodeFSP.readdir(WORKSPACE))
          if (name !== ".git")
            await NodeFSP.rm(NodePath.join(WORKSPACE, name), { recursive: true, force: true });
        if (manifest.roots[0].git)
          await NodeFSP.rm(NodePath.join(WORKSPACE, ".git"), { recursive: true, force: true });
        await copyWorkspace(NodePath.join(staging, manifest.roots[0].id), WORKSPACE);
        if (manifest.roots[0].git) {
          task.baseSha = manifest.roots[0].git.head;
          if (task.projectSnapshot) await createWorkspaceBranch(WORKSPACE, task.branch);
        }
        if (primaryIsNonGit) {
          await NodeFSP.rm(NodePath.join(ROOT, "non-git"), { recursive: true, force: true });
          await moveDirectory(NodePath.join(WORKSPACE, ".git"), NodePath.join(ROOT, "non-git"));
        }
        additionalRoots = manifest.roots
          .slice(1)
          .map((root) => ({ id: root.id, path: NodePath.join("/workspace/roots", root.id) }));
        await NodeFSP.mkdir("/workspace/roots", { recursive: true });
        for (const root of additionalRoots)
          await copyWorkspace(NodePath.join(staging, root.id), root.path);
        await atomicJson(NodePath.join(ROOT, "workspace-roots.json"), additionalRoots);
        await NodeFSP.rm(staging, { recursive: true, force: true });
      }
      if (task.checkpoint) {
        const { manifest } = await control.request(`worker/${taskId}/checkpoint`);
        const archive = NodePath.join(ROOT, "restore.tar.gz");
        const file = await NodeFSP.open(archive, "w", 0o600);
        try {
          for (const chunk of manifest.chunks) {
            const fetched = await control.request(`worker/${taskId}/checkpoint/${chunk.index}`);
            const bytes = Buffer.from(fetched.base64, "base64");
            if (bytes.length !== chunk.sizeBytes || digest(bytes) !== chunk.sha256)
              throw new WorkerFailure("Checkpoint digest mismatch");
            await file.write(bytes);
          }
        } finally {
          await file.close();
        }
        await NodeFSP.mkdir(NodePath.join(APP_HOME, "userdata"), { recursive: true });
        await restoreCheckpoint({
          archive,
          repository: WORKSPACE,
          database: NodePath.join(APP_HOME, "userdata/state.sqlite"),
          attachmentsDirectory: NodePath.join(APP_HOME, "userdata/attachments"),
          directory: ROOT,
          baseSha: task.baseSha,
          providerHomes,
          additionalRoots,
        });
        await NodeFSP.rm(archive);
      }
    }
    journal.workspaceRestored = true;
    await atomicJson(journalPath, journal);
    if (reuseSetup) await reportSetup("reused");
    if (!journal.setupComplete) {
      let installed = false;
      ownershipChanged = true;
      await NodeFSP.mkdir(NodePath.dirname(SETUP_LOG_PATH), { recursive: true });
      await NodeFSP.writeFile(SETUP_LOG_PATH, "", { mode: 0o644 });
      await command("chown", ["-h", "-R", `${SETUP_UID}:${SETUP_UID}`, WORKSPACE], { uid: 0 });
      const setupRoots = [WORKSPACE, ...additionalRoots.map((root) => root.path)];
      for (const cwd of setupRoots) {
        await command("chown", ["-h", "-R", `${SETUP_UID}:${SETUP_UID}`, cwd], { uid: 0 });
        const installation =
          cwd === WORKSPACE && task.repository.setupCommand.trim()
            ? {
                binary: "/bin/sh",
                args: ["-c", task.repository.setupCommand],
                label: "Running the repository setup command",
              }
            : await dependencySetup(cwd);
        if (!installation) continue;
        installed = true;
        await reportSetup(
          journal.setupWarning ? "failed" : "running",
          journal.setupWarning ?? installation.label,
          "dependencies",
        );
        setup = launch(installation.binary, installation.args, {
          cwd,
          uid: SETUP_UID,
          env: childEnvironment("/home/vitre-setup"),
        });
        const timeout = setTimeout(
          () => {
            void stop(setup);
          },
          Math.max(1, Date.parse(attempt.startedAt) + 900_000 - Date.now()),
        );
        try {
          const finished = await setup.done;
          // The agent and the user can inspect the real installer output; the
          // task itself only ever receives the classified notice below.
          await NodeFSP.appendFile(
            SETUP_LOG_PATH,
            `# ${installation.label} in ${cwd}\n# ${installation.binary} ${installation.args.join(" ")}\n# exit code ${finished.code}${finished.signal ? ` (${finished.signal})` : ""}\n${finished.output}\n`,
          );
          if (finished.code !== 0) {
            journal.setupWarning = dependencyFailure(finished.output, finished);
            await reportSetup("failed", journal.setupWarning);
            if (cwd === WORKSPACE && task.repository.setupCommand.trim())
              throw new WorkerFailure(`Repository setup command exited with code ${finished.code}`);
          }
        } finally {
          clearTimeout(timeout);
          await stop(setup);
          setup = undefined;
        }
      }
      await reportSetup(
        journal.setupWarning ? "failed" : installed ? "succeeded" : "unnecessary",
        journal.setupWarning,
      );
      journal.setupComplete = true;
      journal.setupCommand = task.repository.setupCommand;
      journal.setupFingerprint = await setupFingerprint();
      await atomicJson(journalPath, journal);
    }
    if (ownershipChanged)
      await command(
        "chown",
        ["-h", "-R", `${UID}:${UID}`, WORKSPACE, ...additionalRoots.map((root) => root.path)],
        { uid: 0 },
      );
    await command("chown", ["-h", "-R", `${UID}:${UID}`, "/home/vitre"], { uid: 0 });
    if (task.provider === "codex") {
      await NodeFSP.mkdir(CODEX_HOME, { recursive: true, mode: 0o700 });
      if (!(await NodeFSP.lstat(CODEX_HOME)).isDirectory())
        throw new WorkerFailure("Unsafe credential directory");
      await NodeFSP.chown(CODEX_HOME, UID, UID);
    }
    await reportPreparation("provider");
    if (resident) {
      while (!(await lease.acquire(task.turnRequestId, { revalidate: recovering }))) {
        const status = await control.request(`worker/${taskId}/bootstrap`);
        if (status.stopRequested)
          throw Object.assign(new WorkerFailure("Preparation was cancelled"), {
            code: "task_settled",
          });
        await NodeTimersPromises.setTimeout(200);
      }
    }
    auth ??= await control.request(`worker/${taskId}/credential`, { attemptId: attempt.id });
    // The retained on-disk token may have rotated just before the host rebooted.
    // Save it under the freshly validated version fence before reinstalling auth.
    if (recovering && bootstrap.leaseOwned) await persistCredential();
    initialCredential = auth.credential;
    rememberCredential(auth.credential);
    const env = {
      ...providerEnvironment(task.provider, auth.credential),
      ...(resident ? { VITRE_CLOUD_RESIDENT_PROVIDER: task.provider } : {}),
    };
    if (task.provider === "codex") {
      await installProviderCredential(CODEX_HOME, auth.credential, UID);
    }
    journal.credentialVersion = auth.version;
    await atomicJson(journalPath, journal);
    await prepareBackendHome(APP_HOME, [
      { id: primaryRootId, path: WORKSPACE },
      ...additionalRoots,
    ]);
    await reportPreparation("backend");
    backend = launch("node", ["/opt/vitre/server/dist/bin.mjs", "--bootstrap-fd", "0"], {
      env,
      stdin: JSON.stringify(backendBootstrapEnvelope(bootstrap)) + "\n",
    });
    // Poll quickly: the backend usually listens within a couple of seconds and
    // every idle interval here is added to the user's reconnection time.
    for (const deadline = Date.now() + 120_000; Date.now() < deadline; ) {
      try {
        await localApi.exchange();
        backendAuthenticated = true;
        break;
      } catch {}
      await NodeTimersPromises.setTimeout(250);
    }
    if (!backendAuthenticated) throw new WorkerFailure("Backend startup failed");
    tunnel = launch("cloudflared", ["tunnel", "--no-autoupdate", "run"], {
      cwd: ROOT,
      uid: 0,
      env: { ...childEnvironment(), TUNNEL_TOKEN: bootstrap.endpoint.runtime.connectorToken },
    });
    const snapshot = await backendRequest("/api/orchestration/snapshot");
    const projectId = `cloud-${taskId}`;
    const models = JSON.parse(await NodeFSP.readFile("/opt/vitre/cloud/models.json", "utf8"));
    const modelSelection = workerModelSelection(task, models);
    const createdAt = new Date().toISOString();
    if (!snapshot.projects.some((project) => project.id === projectId))
      await dispatch({
        type: "project.create",
        commandId: `${taskId}-project`,
        projectId,
        title: task.repository.name,
        workspaceRoot: WORKSPACE,
        defaultModelSelection: modelSelection,
        createdAt,
      });
    if (!snapshot.threads.some((thread) => thread.id === threadId))
      await dispatch({
        type: "thread.create",
        commandId: `${taskId}-thread`,
        threadId,
        projectId,
        title: task.prompt
          .replace(/^<vitre_ask_mode>[\s\S]*?<\/vitre_ask_mode>\s*/, "")
          .slice(0, 120),
        modelSelection,
        runtimeMode: initialThreadRuntimeMode(task),
        interactionMode: task.interactionMode ?? "default",
        branch: primaryIsNonGit ? null : task.branch,
        worktreePath: null,
        additionalRoots: additionalRoots.map((root) => ({ kind: "path", path: root.path })),
        createdAt,
      });
    // The backend probes the provider CLI on demand. Right after startup that
    // probe can still be pending or time out, which is not a signed-out account.
    await reportPreparation("provider");
    for (let probe = 1; ; probe++) {
      const validation = await backendRequest("/api/orchestration/transfer", {
        type: "validateProvider",
        threadId,
      });
      if (validation.type === "providerValidation" && validation.supported) break;
      if (validation.type !== "providerValidation" || !validation.retryable || probe >= 6)
        throw new WorkerFailure(validation.reason ?? "Cloud provider validation failed");
      await NodeTimersPromises.setTimeout(3000);
    }
    await recoverActivatedHandoff(
      task,
      journal,
      snapshot.threads.some((thread) => thread.id === threadId),
      async () =>
        (await backendRequest("/api/orchestration/transfer", { type: "ownership", threadId }))
          .execution,
      () => atomicJson(journalPath, journal),
    );
    if (task.handoff && !journal.imported) {
      const blob = task.handoff.history;
      if (
        blob.sizeBytes > 360 * 1024 * 1024 ||
        blob.chunks.length !== Math.ceil(blob.sizeBytes / (4 * 1024 * 1024))
      )
        throw new WorkerFailure("Invalid conversation transfer");
      const parts = [];
      for (const hash of blob.chunks) {
        const response = await control.request(`worker/${taskId}/workspace/${hash}`);
        const bytes = Buffer.from(response.base64, "base64");
        if (digest(bytes) !== hash) throw new WorkerFailure("Conversation chunk checksum mismatch");
        parts.push(bytes);
      }
      const bytes = Buffer.concat(parts);
      if (bytes.length !== blob.sizeBytes || digest(bytes) !== blob.sha256)
        throw new WorkerFailure("Conversation checksum mismatch");
      const exported = JSON.parse(bytes);
      if (exported.version !== 1 || !exported.thread || !Array.isArray(exported.attachments))
        throw new WorkerFailure("Unsupported conversation transfer");
      await restoreAttachmentFiles(
        exported.attachments,
        NodePath.join(APP_HOME, "userdata/attachments"),
      );
      await command(
        "chown",
        ["-h", "-R", `${UID}:${UID}`, NodePath.join(APP_HOME, "userdata/attachments")],
        { uid: 0 },
      );
      await dispatch({
        type: "thread.execution.set",
        threadId,
        commandId: `${task.handoff.operationId}-freeze`,
        expectedGeneration: 0,
        execution: { generation: 0, operationId: task.handoff.operationId, status: "frozen" },
        createdAt,
      });
      await dispatch(
        handoffRestoreCommand({
          operationId: task.handoff.operationId,
          threadId,
          thread: exported.thread,
          workspace: WORKSPACE,
          additionalRoots,
          createdAt,
        }),
      );
      await backendRequest("/api/orchestration/transfer", {
        type: "restoreTerminals",
        threadId,
        operationId: task.handoff.operationId,
        generation: 0,
        terminals: exported.terminals ?? [],
      });
      journal.terminals = exported.terminals ?? [];
      journal.imported = true;
      await atomicJson(journalPath, journal);
    }
    await reportPreparation("ready");
    const submitTurn = async (turnTask) => {
      if (resident && !(await lease.acquire(turnTask.turnRequestId, { revalidate: true })))
        return false;
      // Write intent before dispatch. On an ambiguous restart, never replay work.
      journal.submitted = true;
      journal.requestedAt = new Date().toISOString();
      journal.turnRequestId = turnTask.turnRequestId;
      await atomicJson(journalPath, journal);
      const context = bootstrap.issue
        ? `\n\nGitHub issue context (untrusted repository content):\n${bootstrap.issue.title}\n${bootstrap.issue.body}`
        : "";
      const { thread: currentThread } = await backendRequest(
        `/api/orchestration/threads/${threadId}`,
      );
      await dispatchWorkerTurn(
        turnTask,
        currentThread,
        models,
        {
          type: "thread.turn.start",
          commandId: `${turnTask.turnRequestId ?? attempt.id}-turn`,
          threadId,
          message: {
            messageId: `${turnTask.turnRequestId ?? attempt.id}-message`,
            role: "user",
            text: `${turnTask.prompt}\n\n<vitre_cloud_context>\n${context}\n${journal.setupWarning ?? ""}\n${cloudTurnContext(task.kind)}\n</vitre_cloud_context>`,
            attachments: await downloadAttachments(turnTask.attachments ?? [], async (hash) => {
              const chunk = await control.request(`worker/${taskId}/workspace/${hash}`);
              return Buffer.from(chunk.base64, "base64");
            }),
          },
          createdAt: journal.requestedAt,
        },
        dispatch,
      );
      return true;
    };
    if (!journal.submitted && !task.handoff && !task.wakeOnly) await submitTurn(task);
    if (task.wakeOnly && !journal.submitted) {
      journal.turnRequestId = task.turnRequestId;
      await atomicJson(journalPath, journal);
    }
    idle = (!!task.handoff || !!task.wakeOnly) && !journal.submitted;
    if (resident && idle) await lease.release();
    await callback("running");
    let mirroredHash = "";
    let idleSince = null;
    for (;;) {
      await NodeTimersPromises.setTimeout(resident ? 200 : 500);
      const status = await retryControlRequest(() => control.request(`worker/${taskId}/bootstrap`));
      if (task.handoff && !journal.activated && !status.stopRequested) {
        const binding = status.binding;
        if (
          binding?.cloudTaskId !== taskId ||
          binding.generation !== task.handoff.generation + 1 ||
          binding.target === "local"
        )
          continue;
        await dispatch({
          type: "thread.execution.set",
          threadId,
          commandId: `${task.handoff.operationId}-activate`,
          expectedGeneration: 0,
          execution: { generation: 1, operationId: task.handoff.operationId, status: "active" },
          createdAt: new Date().toISOString(),
        });
        await backendRequest("/api/orchestration/transfer", {
          type: "restoreTerminals",
          resumeCommands: true,
          threadId,
          operationId: task.handoff.operationId,
          generation: 1,
          terminals: journal.terminals ?? [],
        });
        journal.activated = true;
        await atomicJson(journalPath, journal);
      }
      if (
        !status.stopRequested &&
        status.task.turnRequestId &&
        status.task.turnRequestId !== journal.turnRequestId
      ) {
        idle = false;
        idleSince = null;
        if (!(await submitTurn(status.task))) continue;
        await callback("running");
      }
      const { thread } = await backendRequest(`/api/orchestration/threads/${threadId}`);
      if (
        status.task.title &&
        status.task.title !== thread.title &&
        (await backendRequest("/api/orchestration/transfer", { type: "ownership", threadId }))
          .execution.status === "active"
      ) {
        await dispatch({
          type: "thread.meta.update",
          threadId,
          commandId: `title-${digest(status.task.title)}`,
          title: status.task.title,
        });
        thread.title = status.task.title;
      }
      const mirror = async () => {
        const serialized = JSON.stringify(thread, (_key, value) => {
          if (typeof value !== "string") return value;
          for (const secret of secrets)
            if (secret.length >= 8) value = value.split(secret).join("[redacted]");
          return value;
        });
        const hash = digest(serialized);
        if (hash !== mirroredHash && !status.stopRequested) {
          await callback("heartbeat", "Conversation updated", undefined, JSON.parse(serialized));
          mirroredHash = hash;
        }
      };
      if (
        status.stopRequested ||
        (!resident && Date.now() >= Date.parse(status.attempt.deadlineAt))
      ) {
        await checkpoint("heartbeat", thread);
        return;
      }
      const shell = await backendRequest("/api/orchestration/shell");
      const threadShell = shell.threads.find((item) => item.id === threadId);
      const turnObservation = classifyWorkerTurn(
        thread.latestTurn,
        journal.requestedAt ?? attempt.startedAt,
        threadShell,
        resident,
        idle && (task.wakeOnly || journal.activated),
        thread.session,
      );
      if (turnObservation === "waiting_for_input") {
        await mirror();
        if (currentPhase !== "waiting_for_input") await callback("waiting_for_input");
        continue;
      }
      if (currentPhase === "waiting_for_input") await callback("running");
      await checkDisk();
      if (Date.now() - lastCredentialCheck >= 30_000) await persistCredential();
      if (turnObservation === "settled") {
        idleSince ??= Date.now();
        if (
          await preparePublicationSnapshot(
            status.task,
            journal.turnRequestId,
            () =>
              callback(
                "heartbeat",
                "Saving changes for pull request review",
                undefined,
                undefined,
                true,
              ),
            () =>
              checkpoint("completed", thread, {
                output:
                  "Tests were not rerun while saving this snapshot. Review the conversation for validation results.",
                code: null,
              }),
          )
        )
          return;
        if (resident) {
          const wasIdle = idle;
          await settleResidentTurn({
            markIdle: () => {
              idle = true;
            },
            drainCallbacks: () => tail.catch(() => {}),
            lease,
            yieldIdle: status.yieldIdle,
            publishIdle: () =>
              wasIdle ? Promise.resolve() : callback("heartbeat", "Workspace ready"),
            mirror,
          });
          continue;
        }
        await mirror();
        if (retainIdleWorkspace(task.keepAliveSeconds, idleSince, Date.now(), status.yieldIdle)) {
          if (!idle) {
            idle = true;
            await callback("heartbeat", "Workspace ready");
          }
          continue;
        }
        if (task.keepAliveSeconds) {
          // Claim shutdown atomically against follow-up requests before stopping the backend.
          idle = false;
          const claimed = await callback(
            "heartbeat",
            "Saving workspace",
            undefined,
            undefined,
            true,
          )
            .then(() => true)
            .catch(() => false);
          if (!claimed) continue;
        }
        await stop(backend);
        backend = undefined;
        await persistCredential();
        await command("pkill", ["-KILL", "-u", String(UID)], { uid: 0 }, 5000).catch(() => {});
        // Test commands do not inherit subscription or cloud credentials.
        let test = { code: null, output: "No test command configured" };
        if (task.repository.testCommand.trim()) {
          await command("chown", ["-h", "-R", `${SETUP_UID}:${SETUP_UID}`, WORKSPACE], { uid: 0 });
          const process = launch("/bin/sh", ["-c", task.repository.testCommand], {
            uid: SETUP_UID,
            env: childEnvironment("/home/vitre-setup"),
          });
          const timer = setTimeout(
            () => {
              void stop(process);
            },
            Math.max(1, Date.parse(status.attempt.deadlineAt) - Date.now()),
          );
          try {
            test = await process.done;
          } finally {
            clearTimeout(timer);
            await stop(process);
          }
        }
        await checkpoint("completed", thread, test);
        return;
      }
      await mirror();
      if (turnObservation === "failed") {
        await callback(
          providerFailurePhase(thread.session?.lastError ?? ""),
          "Provider execution stopped; review the saved checkpoint before continuing",
        );
        await checkpoint("heartbeat", thread);
        return;
      }
    }
  } catch (error) {
    // Cancellation can race any callback after the last bootstrap read. Save the
    // current attempt before exiting, but never checkpoint a replacement's run.
    const saved = await checkpointSettledRun(
      error,
      attempt,
      () => control.request(`worker/${taskId}/bootstrap`),
      checkpoint,
    ).catch(() => false);
    if (saved) return;
    // Never forward raw exception/tool output, which can contain provider credentials.
    const phase = error.code === "needs_auth" ? "needs_auth" : "failed";
    const reason = describeFailure(error);
    await callback(
      phase,
      reason
        ? `Worker could not complete this run: ${reason}. Its disk is retained for recovery.`
        : "Worker could not complete this run. Its disk is retained for recovery.",
      undefined,
      undefined,
      false,
      {
        phase: "failed",
        ...(journal.dependencySetup?.outcome === "running"
          ? {
              outcome: "failed",
              detail: "Dependency setup was interrupted before completion.",
            }
          : {}),
      },
    ).catch(() => {});
    // Raw provider failures may contain credentials; return a sanitized error.
    throw new WorkerFailure("Worker run failed; sandbox disk retained");
  } finally {
    clearInterval(heartbeatTimer);
    await stop(setup);
    await stop(backend);
    await stop(tunnel);
    await NodeFSP.rm(NodePath.join(CODEX_HOME, "auth.json"), { force: true });
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const run =
    process.env.VITRE_CLOUD_WORKER_MODE && process.env.VITRE_CLOUD_WORKER_MODE !== "task"
      ? import("./auxiliary.mjs").then((module) => module.runAuxiliary())
      : runWorker();
  run.catch((error) => {
    console.error(
      `[vitre-cloud] ${error instanceof WorkerBootstrapFailure ? error.message : "Worker run failed; inspect task status."}`,
    );
    process.exitCode = 1;
  });
}
