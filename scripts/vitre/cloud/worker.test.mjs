import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { Schema } from "effect";
import { ClientOrchestrationCommand, DesktopBackendBootstrap } from "@t3tools/contracts";
import {
  childEnvironment,
  workerProgressUpdate,
  initialThreadRuntimeMode,
  retainIdleWorkspace,
  classifyWorkerTurn,
  createProviderLease,
  settleResidentTurn,
  preparePublicationSnapshot,
  cloudTurnContext,
  atomicJson,
  retryControlRequest,
  bootstrapWorker,
  providerEnvironment,
  workerModelSelection,
  workerTurnSettings,
  dispatchWorkerTurn,
  WorkerControlClient,
  makeLocalBackendClient,
  backendBootstrapEnvelope,
  providerFailurePhase,
  checkpointSettledRun,
  moveDirectory,
  copyWorkspace,
  installProviderCredential,
  sessionStopCommand,
  canRecoverWorker,
  canRecoverCredential,
  recoverActivatedHandoff,
  handoffRestoreCommand,
  prepareWorkspaceRepository,
} from "./worker.mjs";
import { captureWorkspace, restoreWorkspace, digest } from "./workspace.mjs";

const decodeCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const decodeBackendBootstrap = Schema.decodeUnknownSync(DesktopBackendBootstrap);
const exec = NodeUtil.promisify(NodeChildProcess.execFile);

describe("publication snapshot preparation", () => {
  const task = {
    turnRequestId: "turn",
    publicationPreparation: { id: "review", turnRequestId: "turn" },
  };
  it("claims the same settled turn before saving and does not publish anything", async () => {
    const events = [];
    expect(
      await preparePublicationSnapshot(
        task,
        "turn",
        async () => events.push("claim"),
        async () => events.push("snapshot"),
      ),
    ).toBe(true);
    expect(events).toEqual(["claim", "snapshot"]);
    expect(
      await preparePublicationSnapshot(
        {},
        "turn",
        async () => events.push("bad"),
        async () => events.push("bad"),
      ),
    ).toBe(false);
    expect(events).toEqual(["claim", "snapshot"]);
  });
  it("never stops or snapshots a replaced turn or failed claim", async () => {
    let saved = false;
    const save = async () => {
      saved = true;
    };
    await expect(
      preparePublicationSnapshot(task, "old-turn", async () => {}, save),
    ).rejects.toThrow("another turn");
    await expect(
      preparePublicationSnapshot(
        { ...task, turnRequestId: "new-turn" },
        "turn",
        async () => {},
        save,
      ),
    ).rejects.toThrow("another turn");
    await expect(
      preparePublicationSnapshot(
        task,
        "turn",
        async () => {
          throw new Error("cancelled");
        },
        save,
      ),
    ).rejects.toThrow("cancelled");
    expect(saved).toBe(false);
  });
  it("explains the supported PR flow instead of claiming cloud PRs are forbidden", () => {
    const context = cloudTurnContext("build");
    expect(context).toContain("Create PR");
    expect(context).toContain("draft PR");
    expect(context).toContain("credentials are read-only");
    expect(context).not.toContain("Do not publish branches, PRs, or comments");
  });
});

it("applies explicit follow-up settings without overwriting imported thread defaults", () => {
  const thread = {
    modelSelection: {
      instanceId: "codex",
      model: "existing",
      options: [{ id: "reasoning", value: "high" }],
    },
    runtimeMode: "approval-required",
    interactionMode: "plan",
  };
  expect(
    workerTurnSettings({ provider: "codex", model: "old", runtimeMode: "full-access" }, thread, {}),
  ).toEqual(thread);
  expect(
    workerTurnSettings(
      {
        provider: "codex",
        turnSettings: {
          model: "new",
          modelOptions: [],
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
        },
      },
      thread,
      {},
    ),
  ).toEqual({
    modelSelection: { instanceId: "codex", model: "new", options: [] },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
  });
});

describe("follow-up turn mode dispatch", () => {
  const thread = {
    modelSelection: { instanceId: "codex", model: "existing" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
  };
  const turn = {
    type: "thread.turn.start",
    commandId: "follow-up-turn",
    threadId: "cloud-task",
    message: { messageId: "follow-up-message", role: "user", text: "Continue", attachments: [] },
    createdAt: "2026-10-25T00:00:00.000Z",
  };

  it("commits Full access and interaction changes before the backend reads the turn modes", async () => {
    const storedThread = structuredClone(thread);
    const commands = [];
    const dispatch = async (input) => {
      const command = decodeCommand(input);
      commands.push(command);
      if (command.type === "thread.runtime-mode.set")
        storedThread.runtimeMode = command.runtimeMode;
      if (command.type === "thread.interaction-mode.set")
        storedThread.interactionMode = command.interactionMode;
      if (command.type === "thread.turn.start") {
        // The orchestration decider uses stored modes, not the fields on this command.
        expect(storedThread.runtimeMode).toBe("full-access");
        expect(storedThread.interactionMode).toBe("default");
      }
      return { sequence: commands.length };
    };
    await expect(
      dispatchWorkerTurn(
        { turnSettings: { runtimeMode: "full-access", interactionMode: "default" } },
        thread,
        {},
        turn,
        dispatch,
      ),
    ).resolves.toEqual({ sequence: 3 });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.runtime-mode.set",
      "thread.interaction-mode.set",
      "thread.turn.start",
    ]);
  });

  it.each([
    { runtimeMode: "full-access", interactionMode: "default" },
    { turnSettings: {} },
    { turnSettings: { runtimeMode: "approval-required", interactionMode: "plan" } },
  ])(
    "preserves existing modes when follow-up overrides are absent or unchanged: %j",
    async (task) => {
      const commands = [];
      await dispatchWorkerTurn(task, thread, {}, turn, async (command) => {
        commands.push(decodeCommand(command));
      });
      expect(commands).toEqual([{ ...turn, ...thread }]);
    },
  );

  it("uses stable, separate command IDs when a turn request is retried", async () => {
    const task = { turnSettings: { runtimeMode: "full-access", interactionMode: "default" } };
    const commands = [];
    const dispatch = async (command) => commands.push(decodeCommand(command));
    await dispatchWorkerTurn(task, thread, {}, turn, dispatch);
    await dispatchWorkerTurn(task, thread, {}, turn, dispatch);
    expect(commands.slice(0, 3)).toEqual(commands.slice(3));
    expect(commands.slice(0, 3).map((command) => command.commandId)).toEqual([
      "follow-up-turn-runtime-mode",
      "follow-up-turn-interaction-mode",
      "follow-up-turn",
    ]);
  });

  it("does not start a turn when a permission change fails", async () => {
    const commands = [];
    await expect(
      dispatchWorkerTurn(
        { turnSettings: { runtimeMode: "full-access" } },
        thread,
        {},
        turn,
        async (command) => {
          commands.push(decodeCommand(command));
          throw new Error("Permission update rejected");
        },
      ),
    ).rejects.toThrow("Permission update rejected");
    expect(commands.map((command) => command.type)).toEqual(["thread.runtime-mode.set"]);
  });
});

it("settles a finished turn despite stale thread-level approval flags", () => {
  const requestedAt = "2026-10-16T07:21:30.160Z";
  const shell = { hasPendingApprovals: true, hasPendingUserInput: false };
  expect(
    classifyWorkerTurn(
      { state: "completed", requestedAt, completedAt: "2026-10-16T07:28:58.099Z" },
      requestedAt,
      shell,
      true,
      false,
    ),
  ).toBe("settled");
  expect(
    classifyWorkerTurn({ state: "running", requestedAt }, requestedAt, shell, true, false),
  ).toBe("waiting_for_input");
  expect(
    classifyWorkerTurn({ state: "completed", requestedAt }, requestedAt, shell, true, true),
  ).toBe("settled");
  expect(
    classifyWorkerTurn(
      { state: "completed", requestedAt: "2026-10-16T07:00:00.000Z" },
      requestedAt,
      shell,
      true,
      false,
    ),
  ).toBe("waiting_for_input");
});

it.each([
  { state: "running", current: true, resident: true, expected: "working" },
  { state: "error", current: false, resident: true, expected: "working" },
  { state: "error", current: true, resident: true, expected: "failed" },
  { state: "interrupted", current: true, resident: false, expected: "failed" },
  { state: "interrupted", current: true, resident: true, expected: "settled" },
])("observes $state worker turns (current=$current, resident=$resident)", (test) => {
  const requestedAt = "2026-10-19T00:00:00Z";
  expect(
    classifyWorkerTurn(
      {
        state: test.state,
        requestedAt: test.current ? requestedAt : "2026-10-18T23:00:00Z",
      },
      requestedAt,
      {},
      test.resident,
      false,
      { status: "running" },
    ),
  ).toBe(test.expected);
});

it("observes provider failure before a turn exists without overriding pending input", () => {
  const requestedAt = "2026-10-19T00:00:00Z";
  expect(classifyWorkerTurn(null, requestedAt, {}, true, false, { status: "running" })).toBe(
    "working",
  );
  expect(classifyWorkerTurn(null, requestedAt, {}, true, false, { status: "error" })).toBe(
    "failed",
  );
  expect(
    classifyWorkerTurn(null, requestedAt, { hasPendingUserInput: true }, true, false, {
      status: "error",
    }),
  ).toBe("waiting_for_input");
});

it("restores exact historical activities and permissions without restoring a live session", () => {
  const createdAt = "2026-10-16T00:00:00.000Z";
  const activity = {
    id: "approval-1",
    kind: "approval.requested",
    tone: "approval",
    summary: "Read file",
    payload: { requestId: "request-1", command: "cat source.ts" },
    turnId: "previous-turn",
    createdAt,
    sequence: 19,
  };
  const thread = {
    title: "Transfer",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    messages: [],
    proposedPlans: [],
    activities: [activity],
    session: { status: "running" },
    latestTurn: { state: "running" },
  };
  const command = decodeCommand(
    handoffRestoreCommand({
      operationId: "move-1",
      threadId: "thread-1",
      thread,
      workspace: "/workspace",
      additionalRoots: [],
      createdAt,
    }),
  );
  expect(command.activities).toEqual([activity]);
  expect(command.runtimeMode).toBe("approval-required");
  expect(command).not.toHaveProperty("session");
  expect(command).not.toHaveProperty("latestTurn");
  expect(decodeCommand({ ...command, activities: undefined }).activities).toBeUndefined();
});

it("recovers an activated handoff after a new attempt without replaying imported history", async () => {
  const task = { handoff: { operationId: "move-1", generation: 1 } };
  const journal = { attemptId: "task-2", sequence: 0, submitted: false };
  let writes = 0;
  await recoverActivatedHandoff(
    task,
    journal,
    true,
    async () => ({ generation: 1, operationId: "move-1", status: "active" }),
    async () => writes++,
  );
  // Without reconciliation, the worker replays freeze/restore with generation
  // zero against this active generation-one database and receives HTTP 500.
  expect(task.handoff && !journal.imported).toBe(false);
  expect(journal.activated).toBe(true);
  expect(journal.submitted).toBe(false);
  expect(writes).toBe(1);
});

it("keeps genuine handoff initialization and interrupted import recoverable", async () => {
  const task = { handoff: { operationId: "move-1", generation: 7 } };
  for (const ownership of [
    { generation: 0, operationId: "initial", status: "active" },
    { generation: 0, operationId: "move-1", status: "frozen" },
  ]) {
    const journal = { submitted: false };
    await recoverActivatedHandoff(
      task,
      journal,
      true,
      async () => ownership,
      async () => {
        throw new Error("An unactivated handoff must not be marked imported");
      },
    );
    expect(journal).toEqual({ submitted: false });
  }
  await recoverActivatedHandoff(task, {}, false, async () => {
    throw new Error("A new destination has no retained ownership to recover");
  });
});

it("fences changed or ambiguous handoff ownership without marking history imported", async () => {
  const task = { handoff: { operationId: "move-1", generation: 1 } };
  for (const ownership of [
    undefined,
    { generation: 1, operationId: "another-move", status: "active" },
    { generation: 2, operationId: "move-1", status: "active" },
    { generation: 1, operationId: "move-1", status: "released" },
  ]) {
    const journal = { submitted: false };
    await expect(
      recoverActivatedHandoff(
        task,
        journal,
        true,
        async () => ownership,
        async () => {
          throw new Error("Changed ownership must not be persisted");
        },
      ),
    ).rejects.toThrow("Conversation ownership changed before handoff recovery");
    expect(journal).toEqual({ submitted: false });
  }
});

it("restores unpublished commits, dirty files and tracked dependency fixtures without cloning", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-source-test-"));
  const source = NodePath.join(directory, "source");
  const restored = NodePath.join(directory, "restored", "primary");
  const chunks = new Map();
  const git = async (cwd, ...args) => (await exec("git", args, { cwd })).stdout.trim();
  try {
    await NodeFSP.mkdir(source);
    await git(source, "init", "--initial-branch=main");
    await git(source, "config", "user.name", "Test");
    await git(source, "config", "user.email", "test@example.com");
    await git(source, "remote", "add", "origin", "https://github.com/example/repository.git");
    await NodeFSP.writeFile(NodePath.join(source, "file.txt"), "published");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "published");
    await git(source, "config", "vitre.publishedRevision", await git(source, "rev-parse", "HEAD"));
    const fixture = "tests/fixtures/node_modules/example/index.js";
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(source, fixture)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(source, fixture), "tracked fixture");
    await git(source, "add", "-f", fixture);
    await git(source, "commit", "-m", "unpublished fixture");
    const head = await git(source, "rev-parse", "HEAD");
    await NodeFSP.writeFile(NodePath.join(source, "file.txt"), "staged");
    await git(source, "add", "file.txt");
    await NodeFSP.writeFile(NodePath.join(source, "file.txt"), "unstaged");
    await NodeFSP.writeFile(NodePath.join(source, "untracked.txt"), "local only");
    const status = await git(source, "status", "--porcelain");
    const manifest = await captureWorkspace(
      [{ id: "primary", path: source }],
      async (hash, bytes) => {
        chunks.set(hash, bytes);
      },
    );
    await prepareWorkspaceRepository(manifest, async () => {
      throw new Error("Cloning a complete uploaded Git snapshot is unnecessary");
    });
    await restoreWorkspace(manifest, NodePath.dirname(restored), async (hash) => chunks.get(hash), {
      prefetch: true,
    });
    expect(await git(restored, "rev-parse", "HEAD")).toBe(head);
    expect(await git(restored, "show", ":file.txt")).toBe("staged");
    expect(await NodeFSP.readFile(NodePath.join(restored, "file.txt"), "utf8")).toBe("unstaged");
    expect(await NodeFSP.readFile(NodePath.join(restored, "untracked.txt"), "utf8")).toBe(
      "local only",
    );
    expect(await NodeFSP.readFile(NodePath.join(restored, fixture), "utf8")).toBe(
      "tracked fixture",
    );
    expect(await git(restored, "status", "--porcelain")).toBe(status);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("initializes legacy repositories and snapshots without primary Git metadata", async () => {
  const blob = { sha256: digest("bundle"), sizeBytes: 6, chunks: [digest("bundle")] };
  const git = {
    head: "a".repeat(40),
    branch: "main",
    bundle: blob,
    index: { sha256: digest(""), sizeBytes: 0, chunks: [] },
  };
  for (const manifest of [
    null,
    { version: 2, roots: [{ id: "primary", name: "folder" }], entries: [] },
    {
      version: 2,
      roots: [
        { id: "primary", name: "folder" },
        { id: "additional", name: "repo", git },
      ],
      entries: [],
    },
  ]) {
    let initialized = false;
    await prepareWorkspaceRepository(manifest, async () => {
      initialized = true;
    });
    expect(initialized).toBe(true);
  }
});

it("rejects invalid Git snapshot metadata before initializing a repository", async () => {
  const empty = { sha256: digest(""), sizeBytes: 0, chunks: [] };
  const git = { head: "a".repeat(40), branch: "main", bundle: empty, index: empty };
  for (const metadata of [git, { ...git, head: "invalid" }]) {
    let initialized = false;
    await expect(
      prepareWorkspaceRepository(
        {
          version: 2,
          roots: [{ id: "primary", name: "repo", git: metadata }],
          entries: [],
        },
        async () => {
          initialized = true;
        },
      ),
    ).rejects.toThrow(/Git/);
    expect(initialized).toBe(false);
  }
});

it("only retains reboot-time credentials under the last durable vault version fence", () => {
  const credential = { version: 7 };
  expect(canRecoverCredential({ credentialVersion: 7 }, credential)).toBe(true);
  expect(canRecoverCredential({ credentialVersion: 6 }, credential)).toBe(false);
  expect(canRecoverCredential({ credentialVersion: 8 }, credential)).toBe(false);
  expect(canRecoverCredential({}, credential)).toBe(false);
  expect(canRecoverCredential({ credentialVersion: "7" }, credential)).toBe(false);
});

it("recovers only current resident services with durable submission intent", () => {
  const bootstrap = {
    resident: true,
    attempt: { id: "attempt-1" },
    task: { state: "running" },
  };
  const journal = { attemptId: "attempt-1", setupComplete: true, submitted: true };
  expect(canRecoverWorker(bootstrap, journal, "attempt-1")).toBe(true);
  expect(canRecoverWorker(bootstrap, journal, "attempt-2")).toBe(false);
  expect(canRecoverWorker(bootstrap, null, "attempt-1")).toBe(false);
  expect(canRecoverWorker(bootstrap, { ...journal, submitted: false }, "attempt-1")).toBe(false);
  expect(canRecoverWorker(bootstrap, { ...journal, setupComplete: false }, "attempt-1")).toBe(
    false,
  );
  expect(canRecoverWorker({ ...bootstrap, stopRequested: true }, journal, "attempt-1")).toBe(false);
  expect(
    canRecoverWorker({ ...bootstrap, task: { state: "cancelled" } }, journal, "attempt-1"),
  ).toBe(false);
  expect(
    canRecoverWorker(
      { ...bootstrap, task: { state: "running", archivedAt: "now" } },
      journal,
      "attempt-1",
    ),
  ).toBe(false);
  expect(
    canRecoverWorker(
      { ...bootstrap, task: { state: "running", wakeOnly: true } },
      { ...journal, submitted: false },
      "attempt-1",
    ),
  ).toBe(true);
});

it("emits a session stop accepted by the backend's orchestration command schema", () => {
  const before = Date.now();
  const command = sessionStopCommand("attempt-lease-stop-1", "cloud-task");
  const decoded = decodeCommand(command);
  expect(decoded).toEqual(command);
  expect(Date.parse(decoded.createdAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(decoded.createdAt)).toBeLessThanOrEqual(Date.now());
  const { createdAt: _createdAt, ...missingTimestamp } = command;
  expect(() => decodeCommand(missingTimestamp)).toThrow();
});

it("hands a resident lease to a waiting conversation while its final mirror is blocked", async () => {
  const pendingHeartbeat = Promise.withResolvers();
  const mirrorStarted = Promise.withResolvers();
  const pendingMirror = Promise.withResolvers();
  let localIdle = false;
  let relayIdle = false;
  let owner = "first";
  const oldHeartbeat = pendingHeartbeat.promise.then(() => {
    relayIdle = false; // A busy callback was already in flight when the turn ended.
  });
  const firstLease = createProviderLease({
    owned: true,
    suspend: async () => {},
    persist: async () => {},
    release: async () => {
      owner = null;
      relayIdle = true;
    },
  });
  const settling = settleResidentTurn({
    markIdle: () => {
      localIdle = true;
    },
    drainCallbacks: () => oldHeartbeat,
    lease: firstLease,
    mirror: async () => {
      mirrorStarted.resolve();
      await pendingMirror.promise;
      relayIdle = localIdle;
    },
  });
  expect(localIdle).toBe(true);
  expect(owner).toBe("first");
  pendingHeartbeat.resolve();
  await mirrorStarted.promise;
  expect(relayIdle).toBe(true);
  const secondLease = createProviderLease({
    owned: false,
    acquire: async () => {
      if (owner !== null || !relayIdle) return { acquired: false };
      owner = "second";
      return { acquired: true, credential: "latest" };
    },
    install: async () => {},
  });
  expect(await secondLease.acquire("next-turn")).toBe(true);
  pendingMirror.resolve();
  await settling;
  expect(owner).toBe("second");
  expect(relayIdle).toBe(true);
});

it.each(["stop", "save"])(
  "does not publish a settled resident turn or release ownership when %s fails",
  async (failure) => {
    let released = false;
    let mirrored = false;
    const failAt = (step) => async () => {
      if (step === failure) throw new Error(failure);
    };
    const lease = createProviderLease({
      owned: true,
      suspend: failAt("stop"),
      persist: failAt("save"),
      release: async () => {
        released = true;
      },
    });
    await expect(
      settleResidentTurn({
        markIdle: () => {},
        drainCallbacks: async () => {},
        lease,
        mirror: async () => {
          mirrored = true;
        },
      }),
    ).rejects.toThrow(failure);
    expect(released).toBe(false);
    expect(mirrored).toBe(false);
  },
);

it("retries an ambiguous lease release without rerunning its credential boundary", async () => {
  const calls = [];
  let requests = 0;
  const control = new WorkerControlClient("https://relay.example", "worker-token", async () => {
    if (++requests === 1) throw new TypeError("Connection lost after commit");
    return Response.json({ acquired: false });
  });
  const lease = createProviderLease({
    owned: true,
    turnRequestId: "first",
    suspend: async () => calls.push("stop"),
    persist: async () => calls.push("save"),
    release: () =>
      retryControlRequest(
        () => control.request("worker/task/lease", { action: "release" }),
        async () => {},
      ),
    acquire: async () => ({ acquired: false }),
    install: async () => calls.push("install"),
  });
  await lease.release();
  expect(requests).toBe(2);
  expect(calls).toEqual(["stop", "save"]);
  expect(await lease.acquire("next")).toBe(false);
});

it.each([409, 503])(
  "bounds transient retries and never retries a lease fence (%s)",
  async (status) => {
    let calls = 0;
    const control = new WorkerControlClient("https://relay.example", "worker-token", async () => {
      calls++;
      return Response.json({ code: "unavailable" }, { status });
    });
    await expect(
      retryControlRequest(
        () => control.request("worker/task/lease", {}),
        async () => {},
      ),
    ).rejects.toThrow(`Control request failed (${status})`);
    expect(calls).toBe(status === 409 ? 1 : 3);
  },
);

it("backs off transient bootstrap failures and returns only the assigned attempt", async () => {
  const waits = [];
  const timeouts = [];
  let calls = 0;
  const bootstrap = { attempt: { id: "task-2" } };
  const result = await bootstrapWorker(
    {
      request: async (path, body, options) => {
        expect(path).toBe("worker/task/bootstrap");
        expect(body).toBeUndefined();
        timeouts.push(options.timeoutMs);
        if (++calls < 3) throw Object.assign(new Error("upstream secret"), { retryable: true });
        return bootstrap;
      },
    },
    "task",
    "task-2",
    null,
    { sleep: async (delay) => waits.push(delay), now: () => 0 },
  );
  expect(result).toBe(bootstrap);
  expect(waits).toEqual([500, 1000]);
  expect(timeouts).toEqual([5000, 5000, 5000]);
});

it("bounds repeated bootstrap failures and reports a sanitized attempt-fenced failure", async () => {
  const calls = [];
  const waits = [];
  const journal = { attemptId: "task-2", sequence: 41, setupComplete: true };
  await expect(
    bootstrapWorker(
      {
        request: async (path, body) => {
          calls.push({ path, body });
          throw Object.assign(new Error("private token and upstream body"), {
            code: "github_unavailable",
            retryable: true,
          });
        },
      },
      "task",
      "task-2",
      journal,
      { sleep: async (delay) => waits.push(delay), now: () => 0 },
    ),
  ).rejects.toThrow("Cloud preparation failed: GitHub is unavailable; retry preparation later.");
  expect(waits).toEqual([500, 1000, 2000]);
  expect(calls).toHaveLength(5);
  expect(calls.at(-1)).toEqual({
    path: "worker/callback",
    body: {
      taskId: "task",
      attemptId: "task-2",
      generation: 2,
      sequence: 42,
      phase: "failed",
      detail: "Cloud preparation failed: GitHub is unavailable; retry preparation later.",
    },
  });
  expect(journal).toEqual({ attemptId: "task-2", sequence: 41, setupComplete: true });
  expect(JSON.stringify(calls)).not.toContain("private token");
});

it("caps slow bootstrap requests at the remaining elapsed-time budget", async () => {
  let now = 0;
  const timeouts = [];
  await expect(
    bootstrapWorker(
      {
        request: async (path, _, { timeoutMs }) => {
          if (path === "worker/callback") return;
          timeouts.push(timeoutMs);
          now += timeoutMs;
          throw Object.assign(new Error("timed out"), { retryable: true });
        },
      },
      "task",
      "task-1",
      null,
      { sleep: async (delay) => (now += delay), now: () => now },
    ),
  ).rejects.toThrow("Cloud preparation failed");
  expect(timeouts).toEqual([5000, 5000, 3500]);
  expect(now).toBe(15_000);
});

it("reports a permanent provider auth rejection without retrying bootstrap", async () => {
  const calls = [];
  await expect(
    bootstrapWorker(
      {
        request: async (path, body) => {
          calls.push({ path, body });
          if (path === "worker/callback") return;
          throw Object.assign(new Error("private auth response"), { code: "needs_auth" });
        },
      },
      "task",
      "task-3",
      { attemptId: "task-2", sequence: 100 },
      {
        sleep: async () => {
          throw new Error("Must not retry");
        },
      },
    ),
  ).rejects.toThrow("Provider authorization is required; reconnect your account.");
  expect(calls).toHaveLength(2);
  expect(calls.at(-1).body).toMatchObject({ generation: 3, sequence: 1, phase: "needs_auth" });
});

it.each(["stale_worker", "task_settled", "unauthorized", "replacement"])(
  "never reports failure against a stale or unauthorized bootstrap (%s)",
  async (code) => {
    let calls = 0;
    await expect(
      bootstrapWorker(
        {
          request: async () => {
            calls++;
            if (code === "replacement") return { attempt: { id: "task-4" } };
            throw Object.assign(new Error("private rejection"), { code });
          },
        },
        "task",
        "task-3",
        null,
      ),
    ).rejects.toThrow("Cloud preparation failed");
    expect(calls).toBe(1);
  },
);

it.each(["other-1", "task-0", "task-1-extra", "task-9007199254740992"])(
  "does not invent a callback generation from an invalid attempt ID (%s)",
  async (attemptId) => {
    let calls = 0;
    await expect(
      bootstrapWorker(
        {
          request: async () => {
            calls++;
            throw new Error("private rejection");
          },
        },
        "task",
        attemptId,
        null,
      ),
    ).rejects.toThrow("Cloud preparation failed");
    expect(calls).toBe(1);
  },
);

it("serializes concurrent heartbeat and turn journal writes without losing the newest intent", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-journal-test-"));
  try {
    const path = NodePath.join(directory, "journal.json");
    await Promise.all(Array.from({ length: 30 }, (_, sequence) => atomicJson(path, { sequence })));
    expect(JSON.parse(await NodeFSP.readFile(path, "utf8"))).toEqual({ sequence: 29 });
    expect(await NodeFSP.readdir(directory)).toEqual(["journal.json"]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("hands over provider refresh ownership only after stopping and saving, then installs fresh auth", async () => {
  const calls = [];
  let available = false;
  const lease = createProviderLease({
    owned: true,
    turnRequestId: "first",
    suspend: async () => calls.push("stop"),
    persist: async () => calls.push("save"),
    release: async () => calls.push("release"),
    acquire: async (turn) => {
      calls.push(`acquire:${turn}`);
      return available
        ? { acquired: true, credential: "new-version", version: 2 }
        : { acquired: false };
    },
    install: async (auth) => calls.push(`install:${auth.credential}`),
  });
  expect(await lease.acquire("first")).toBe(true);
  await lease.release();
  await lease.release();
  expect(calls).toEqual(["stop", "save", "release"]);
  expect(await lease.acquire("second")).toBe(false);
  available = true;
  expect(await lease.acquire("second")).toBe(true);
  expect(calls.slice(3)).toEqual(["acquire:second", "acquire:second", "install:new-version"]);
});

it.each(["stop", "save"])("retains the provider lease when %s fails", async (failure) => {
  const calls = [];
  const step = (name) => async () => {
    calls.push(name);
    if (name === failure) throw new Error(failure);
  };
  const lease = createProviderLease({
    owned: true,
    suspend: step("stop"),
    persist: step("save"),
    release: step("release"),
    acquire: step("acquire"),
    install: step("install"),
  });
  await expect(lease.release()).rejects.toThrow(failure);
  expect(calls).not.toContain("release");
  expect(await lease.acquire()).toBe(true);
});

it("keeps a settled session warm, publishes idle before mirroring, and revalidates its next turn", async () => {
  const calls = [];
  const lease = createProviderLease({
    owned: true,
    turnRequestId: "first",
    acquire: async (turn) => {
      calls.push(`admit:${turn}`);
      return { acquired: true, credential: "older-vault-copy" };
    },
    suspend: async () => calls.push("stop"),
    persist: async () => calls.push("save"),
    release: async (turn) => calls.push(`release:${turn}`),
    install: async () => calls.push("install"),
  });
  await settleResidentTurn({
    markIdle: () => calls.push("idle"),
    drainCallbacks: async () => calls.push("drain"),
    lease,
    yieldIdle: false,
    publishIdle: async () => calls.push("ready"),
    mirror: async () => calls.push("mirror"),
  });
  expect(calls).toEqual(["idle", "drain", "ready", "mirror"]);
  expect(await lease.acquire("second")).toBe(true);
  expect(calls.at(-1)).toBe("admit:second");
  expect(calls).not.toContain("install");
  expect(calls).not.toContain("stop");
  await lease.release();
  expect(calls.slice(-3)).toEqual(["stop", "save", "release:second"]);
});

it("yields a retained session to an older waiter before admitting the next turn", async () => {
  const calls = [];
  let waiting = true;
  let providerRunning = true;
  const lease = createProviderLease({
    owned: true,
    turnRequestId: "first",
    acquire: async (turn) => {
      calls.push(`admit:${turn}`);
      return waiting ? { acquired: false } : { acquired: true, credential: "newest-token" };
    },
    suspend: async () => {
      providerRunning = false;
      calls.push("stop");
    },
    persist: async () => {
      expect(providerRunning).toBe(false);
      calls.push("save");
    },
    release: async (turn) => calls.push(`release:${turn}`),
    install: async (auth) => calls.push(`install:${auth.credential}`),
  });
  expect(await lease.acquire("second")).toBe(false);
  expect(calls).toEqual(["admit:second", "stop", "save", "release:first"]);
  expect(await lease.acquire("second")).toBe(false);
  expect(calls.filter((call) => call === "save")).toHaveLength(1);
  waiting = false;
  expect(await lease.acquire("second")).toBe(true);
  expect(calls.at(-1)).toBe("install:newest-token");
});

it("revalidates auth before dispatch even for the turn already owned at bootstrap", async () => {
  const calls = [];
  const lease = createProviderLease({
    owned: true,
    turnRequestId: "first",
    acquire: async () => {
      throw new Error("disconnected");
    },
    suspend: async () => calls.push("stop"),
    persist: async () => calls.push("save"),
    release: async () => calls.push("release"),
    install: async () => calls.push("install"),
  });
  await expect(lease.acquire("first", { revalidate: true })).rejects.toThrow("disconnected");
  expect(calls).toEqual([]);
});

it("installs private provider credentials on the destination mount without following a stale temporary symlink", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-auth-test-"));
  try {
    await NodeFSP.writeFile(NodePath.join(home, "untouched"), "original");
    await NodeFSP.symlink("untouched", NodePath.join(home, "auth.json.tmp"));
    await installProviderCredential(home, "opaque credential", 10001, {
      ...NodeFSP,
      chown: async () => {},
      rename: async (from, to) => {
        expect(NodePath.dirname(NodePath.dirname(from))).toBe(home);
        expect((await NodeFSP.stat(NodePath.dirname(from))).mode & 0o777).toBe(0o700);
        await NodeFSP.rename(from, to);
      },
    });
    expect(await NodeFSP.readFile(NodePath.join(home, "auth.json"), "utf8")).toBe(
      "opaque credential",
    );
    expect((await NodeFSP.stat(NodePath.join(home, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await NodeFSP.readFile(NodePath.join(home, "untouched"), "utf8")).toBe("original");
    expect((await NodeFSP.readdir(home)).filter((name) => name.startsWith(".auth-"))).toEqual([]);
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "moves Git state across mounts without publishing a failed copy (%s)",
  async (failCopy) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-move-test-"));
    const source = NodePath.join(directory, "source");
    const destination = NodePath.join(directory, "destination");
    try {
      await NodeFSP.mkdir(source);
      await NodeFSP.writeFile(NodePath.join(source, "config"), "portable git state");
      await NodeFSP.symlink("config", NodePath.join(source, "link"));
      const operation = moveDirectory(source, destination, {
        ...NodeFSP,
        rename: async (from, to) => {
          if (from === source)
            throw Object.assign(new Error("Different mounts"), { code: "EXDEV" });
          return NodeFSP.rename(from, to);
        },
        cp: async (...args) => {
          if (failCopy) throw new Error("Disk full");
          return NodeFSP.cp(...args);
        },
      });
      if (failCopy) {
        await expect(operation).rejects.toThrow("Disk full");
        expect(await NodeFSP.readFile(NodePath.join(source, "config"), "utf8")).toBe(
          "portable git state",
        );
        expect(await NodeFSP.readdir(directory)).toEqual(["source"]);
      } else {
        await operation;
        expect(await NodeFSP.readFile(NodePath.join(destination, "config"), "utf8")).toBe(
          "portable git state",
        );
        expect(await NodeFSP.readlink(NodePath.join(destination, "link"))).toBe("config");
        expect(await NodeFSP.readdir(directory)).toEqual(["destination"]);
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

describe("cloud worker isolation", () => {
  it("routes cloud Claude accounts to the canonical backend instance without changing selections", () => {
    const defaults = { codex: "codex-default", claudeAgent: "claude-default" };
    expect(workerModelSelection({ provider: "claude" }, defaults)).toEqual({
      instanceId: "claudeAgent",
      model: "claude-default",
    });
    const options = [{ id: "effort", value: "high" }];
    expect(
      workerModelSelection(
        { provider: "claude", model: "chosen-model", modelOptions: options },
        defaults,
      ),
    ).toEqual({ instanceId: "claudeAgent", model: "chosen-model", options });
    expect(workerModelSelection({ provider: "codex", model: "chosen-codex" }, defaults)).toEqual({
      instanceId: "codex",
      model: "chosen-codex",
    });
  });

  it("checkpoints a cancellation racing callbacks without saving a replacement attempt", async () => {
    const attempt = { id: "attempt", generation: 2 };
    const saved = [];
    const checkpoint = async (phase) => saved.push(phase);
    const settled = { code: "task_settled" };
    expect(
      await checkpointSettledRun(
        settled,
        attempt,
        async () => ({ stopRequested: true, attempt }),
        checkpoint,
      ),
    ).toBe(true);
    for (const status of [
      { stopRequested: false, attempt },
      { stopRequested: true, attempt: { ...attempt, generation: 3 } },
      { stopRequested: true, attempt: { ...attempt, id: "replacement" } },
    ])
      expect(await checkpointSettledRun(settled, attempt, async () => status, checkpoint)).toBe(
        false,
      );
    expect(saved).toEqual(["heartbeat"]);
    await expect(
      checkpointSettledRun(
        settled,
        attempt,
        async () => ({ stopRequested: true, attempt }),
        async () => {
          throw new Error("Upload failed");
        },
      ),
    ).rejects.toThrow("Upload failed");
  });
  it("maps provider subscription failures to actionable states without API fallback", () => {
    expect(providerFailurePhase("You've hit your usage limit")).toBe("usage_limited");
    expect(providerFailurePhase("OAuth token has expired. Please obtain a new token")).toBe(
      "needs_auth",
    );
    expect(providerFailurePhase("Not logged in · Please run /login")).toBe("needs_auth");
    expect(providerFailurePhase("The process exited unexpectedly")).toBe("failed");
  });
  it("renews expired backend authentication after VM pause without replaying ambiguous commands", async () => {
    const calls = [];
    let reject = true;
    const client = makeLocalBackendClient("bootstrap", async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: "fresh" });
      if (reject) {
        reject = false;
        return new Response(null, { status: 401 });
      }
      return Response.json({ ok: true });
    });
    await client.request("/api/orchestration/dispatch", { commandId: "same-command" });
    expect(calls).toHaveLength(3);
    expect(calls[0].init.body).toBe(calls[2].init.body);
    expect(calls[2].init.headers.authorization).toBe("Bearer fresh");
    let attempts = 0;
    const failing = makeLocalBackendClient("bootstrap", async () => {
      attempts++;
      throw new Error("Connection lost after dispatch");
    });
    await expect(
      failing.request("/api/orchestration/dispatch", { commandId: "ambiguous" }),
    ).rejects.toThrow("Connection lost");
    expect(attempts).toBe(1);
  });
  it("constructs child environments without inheriting infrastructure or API billing credentials", () => {
    const environment = childEnvironment();
    expect(Object.keys(environment).sort()).toEqual([
      "CI",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "LANG",
      "PATH",
      "USER",
    ]);
    const codex = providerEnvironment(
      "codex",
      JSON.stringify({ tokens: { refresh_token: "subscription" } }),
    );
    expect(codex.CODEX_HOME).toBe("/home/vitre/.codex");
    expect(codex.OPENAI_API_KEY).toBeUndefined();
    const claude = providerEnvironment("claude", "sk-ant-oat-subscription");
    expect(claude.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-subscription");
    expect(claude.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it("rejects API credentials without trying an alternate billing mode", () => {
    expect(() =>
      providerEnvironment("codex", JSON.stringify({ OPENAI_API_KEY: "api-key" })),
    ).toThrow("Subscription");
    expect(() => providerEnvironment("claude", "sk-ant-api-key")).toThrow("Subscription");
  });
  it("rejects insecure control URLs and does not follow credential-bearing redirects", async () => {
    expect(() => new WorkerControlClient("http://example.com", "secret")).toThrow("HTTPS");
    let options;
    const client = new WorkerControlClient(
      "https://cloud.example.com",
      "secret",
      async (_, init) => {
        options = init;
        return Response.json(
          { code: "needs_auth", message: "sensitive upstream body" },
          { status: 401 },
        );
      },
    );
    await expect(client.request("worker/task/bootstrap")).rejects.toMatchObject({
      code: "needs_auth",
      message: "Control request failed (401)",
    });
    expect(options.redirect).toBe("error");
  });
});

it.each([true, false, undefined, "true"])(
  "limits managed bootstrap lifetime to explicit resident workers (%s)",
  (resident) => {
    const envelope = decodeBackendBootstrap(
      backendBootstrapEnvelope({ resident, backendBootstrapToken: "backend-seed" }, 20042),
    );
    expect(envelope.residentCloudBootstrap).toBe(resident === true);
    expect(envelope.desktopBootstrapToken).toBe("backend-seed");
    expect(envelope.port).toBe(20042);
    expect(envelope.host).toBe("127.0.0.1");
  },
);

it("routes a persistent machine worker to its allocated backend port", async () => {
  const urls = [];
  const client = makeLocalBackendClient(
    "bootstrap",
    async (url) => {
      urls.push(url);
      return Response.json(
        url.endsWith("/oauth/token") ? { access_token: "local-test-token" } : { ok: true },
      );
    },
    20042,
  );
  await client.exchange();
  await client.request("/api/orchestration/snapshot");
  expect(urls).toEqual([
    "http://127.0.0.1:20042/oauth/token",
    "http://127.0.0.1:20042/api/orchestration/snapshot",
  ]);
});

it("preserves relative symlinks after removing workspace staging", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-copy-test-"));
  try {
    const source = NodePath.join(directory, "staging");
    const destination = NodePath.join(directory, "workspace");
    await NodeFSP.mkdir(source);
    await NodeFSP.writeFile(NodePath.join(source, "AGENTS.md"), "instructions");
    await NodeFSP.symlink("AGENTS.md", NodePath.join(source, "CLAUDE.md"));
    await copyWorkspace(source, destination);
    await NodeFSP.rm(source, { recursive: true });
    expect(await NodeFSP.readlink(NodePath.join(destination, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await NodeFSP.readFile(NodePath.join(destination, "CLAUDE.md"), "utf8")).toBe(
      "instructions",
    );
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("ends warm idle retention for queued work without waiting for the keep-alive timeout", () => {
  expect(retainIdleWorkspace(900, 1000, 2000, false)).toBe(true);
  expect(retainIdleWorkspace(900, 1000, 2000, true)).toBe(false);
  expect(retainIdleWorkspace(900, 1000, 901000, false)).toBe(false);
});

describe("precise worker presentation metadata", () => {
  it("keeps preparation timestamps stable per phase, fences new attempts, and retains failure through heartbeats", () => {
    const journal = {};
    const initial = workerProgressUpdate(journal, "attempt", 1, 0, {
      phase: "dependencies",
      outcome: "failed",
      detail: "Dependency setup failed",
    });
    const heartbeat = workerProgressUpdate(journal, "attempt", 2, 1000);
    expect(heartbeat.dependencySetup).toEqual({ ...initial.dependencySetup, sequence: 2 });
    expect(heartbeat.preparation.updatedAt).toBe(initial.preparation.updatedAt);
    expect(journal.dependencySetup.outcome).toBe("failed");
    const progress = workerProgressUpdate(journal, "attempt", 3, 2000, { phase: "dependencies" });
    expect(progress.preparation.startedAt).toBe(new Date(0).toISOString());
    expect(progress.preparation.updatedAt).toBe(new Date(2000).toISOString());
    workerProgressUpdate(journal, "attempt", 4, 3000, { phase: "ready" });
    expect(journal.dependencySetup.outcome).toBe("failed");
    const retry = workerProgressUpdate(journal, "retry", 1, 4000, {
      phase: "dependencies",
      outcome: "running",
    });
    expect(retry.preparation.startedAt).toBe(new Date(4000).toISOString());
    expect(retry.dependencySetup.attemptId).toBe("retry");
  });

  it("uses selected permissions for new threads and preserves restored permissions", () => {
    expect(initialThreadRuntimeMode({})).toBe("full-access");
    expect(initialThreadRuntimeMode({ runtimeMode: "approval-required" })).toBe(
      "approval-required",
    );
    expect(
      initialThreadRuntimeMode(
        { runtimeMode: "full-access" },
        { runtimeMode: "approval-required" },
      ),
    ).toBe("approval-required");
    expect(
      initialThreadRuntimeMode(
        { runtimeMode: "approval-required" },
        { runtimeMode: "full-access" },
      ),
    ).toBe("full-access");
  });
});
