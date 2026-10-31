import { stableStringify } from "@t3tools/shared/relaySigning";
// @effect-diagnostics nodeBuiltinImport:off - Fixtures exercise the Node filesystem transfer boundary.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeZlib from "node:zlib";
import {
  githubIdentity,
  cloudApi,
  captureCloudWorkspace,
  startCloudConversation,
  continueCloudConversation,
} from "./StartCloudConversation.ts";
const uploadedBytes = (payload: { base64: string; encoding?: "gzip" }) => {
  const bytes = Buffer.from(payload.base64, "base64");
  return payload.encoding === "gzip" ? NodeZlib.gunzipSync(bytes) : bytes;
};
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await NodeFSP.rm(root, { recursive: true, force: true, maxRetries: 3 });
});
const overview = {
  enabled: true,
  repositories: [],
  tasks: [],
  accounts: [{ provider: "codex", state: "connected", credentialVersion: 1, leasedBy: null }],
  publications: [],
  usage: {
    month: "2026-10",
    spentMicroDollars: 0,
    reservedMicroDollars: 0,
    limitMicroDollars: 25_000_000,
    warning: false,
  },
};
describe("cloud conversation preparation", () => {
  it("uploads chunks concurrently with bounded work and content deduplication", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-upload-"));
    roots.push(root);
    for (let index = 0; index < 20; index++)
      await NodeFSP.writeFile(
        NodePath.join(root, String(index)),
        Buffer.alloc(4 * 1024 * 1024, index % 10),
      );
    let active = 0,
      peak = 0,
      calls = 0;
    const api = cloudApi(
      { relayUrl: "https://cloud.test", accessToken: "test" },
      async (_url, options) => {
        if (_url.pathname.endsWith("/status")) return Response.json({ present: false });
        active++;
        calls++;
        peak = Math.max(peak, active);
        await NodeTimersPromises.setTimeout(15);
        active--;
        const body = JSON.parse(String(options.body));
        return Response.json({
          sha256: NodeCrypto.createHash("sha256").update(uploadedBytes(body)).digest("hex"),
        });
      },
    );
    await captureCloudWorkspace([{ id: "root", path: root }], api);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(calls).toBe(10);
    expect(active).toBe(0);
    let reused = 0;
    const retry = cloudApi({ relayUrl: "https://cloud.test", accessToken: "test" }, async (url) => {
      expect(url.pathname).toMatch(/\/status$/);
      reused++;
      return Response.json({ present: true });
    });
    await captureCloudWorkspace([{ id: "root", path: root }], retry);
    expect(reused).toBe(10);
    const failure = cloudApi({ relayUrl: "https://cloud.test", accessToken: "test" }, async () => {
      active++;
      await NodeTimersPromises.setTimeout(10);
      active--;
      return Response.json({ sha256: "wrong" });
    });
    await expect(captureCloudWorkspace([{ id: "root", path: root }], failure)).rejects.toThrow(
      "integrity",
    );
    expect(active).toBe(0);
  });

  it("explains relay conflicts without exposing raw error bodies", async () => {
    const session = { relayUrl: "https://cloud.test", accessToken: "test-token" };
    for (const [code, message] of [
      ["worker_busy", "still stopping"],
      ["task_busy", "still queued or running"],
      ["switch_pending", "still moving"],
      ["stale_owner", "moved to another environment"],
    ]) {
      const api = cloudApi(session, async () =>
        Response.json({ code, message: "private backend detail" }, { status: 409 }),
      );
      await expect(api("/commands", {})).rejects.toThrow(message);
    }
    const api = cloudApi(
      session,
      async () => new Response("private proxy detail", { status: 502 }),
    );
    await expect(api("/commands", {})).rejects.toThrow("Cloud request failed (502)");
  });
  it("uploads follow-up attachments before scheduling, preserving the retry key", async () => {
    const commands: unknown[] = [];
    const calls: string[] = [];
    const input = {
      idempotencyKey: "retry-key",
      taskId: "task",
      prompt: "Review this",
      attachments: [
        {
          type: "file" as const,
          name: "file.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
          dataUrl: "data:text/plain;base64,YWJj",
        },
      ],
    };
    const session = { relayUrl: "https://cloud.test", accessToken: "test-token" };
    const request: NonNullable<Parameters<typeof continueCloudConversation>[2]> = async (
      url,
      options,
    ) => {
      calls.push(url.pathname);
      const body = JSON.parse(String(options.body));
      if (url.pathname.endsWith("/status")) return Response.json({ present: false });
      if (url.pathname.endsWith("/chunks"))
        return Response.json({
          sha256: NodeCrypto.createHash("sha256").update(uploadedBytes(body)).digest("hex"),
        });
      commands.push(body);
      return Response.json({ entityId: "task", overview });
    };
    await continueCloudConversation(input, session, request);
    await continueCloudConversation(input, session, request);
    expect(commands[0]).toEqual(commands[1]);
    expect(commands[0]).toMatchObject({
      type: "task.continue",
      idempotencyKey: "retry-key",
      attachments: [{ name: "file.txt", sizeBytes: 3 }],
    });
    expect(calls).toContain("/v1/cloud/workspaces/chunks");
    await expect(
      continueCloudConversation(input, session, async () => Response.json({ sha256: "bad" })),
    ).rejects.toThrow("integrity");
  });
  it("infers GitHub identities without accepting arbitrary hosts or URL credentials", () => {
    expect(githubIdentity("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo",
    });
    expect(githubIdentity("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo",
    });
    expect(githubIdentity("https://token@github.com/owner/repo.git")).toBeNull();
    expect(githubIdentity("https://example.com/owner/repo")).toBeNull();
  });
  it("uploads a plain directory and creates a task without GitHub setup or model substitution", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-start-cloud-"));
    roots.push(root);
    await NodeFSP.writeFile(NodePath.join(root, "file"), "source");
    await NodeFSP.writeFile(NodePath.join(root, ".env"), "secret");
    const requests: { path: string; body: unknown }[] = [];
    const request: NonNullable<Parameters<typeof startCloudConversation>[2]> = async (
      url,
      options,
    ) => {
      const path = new URL(String(url)).pathname;
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ path, body });
      let response: unknown;
      if (path === "/v1/cloud") response = overview;
      else if (path.endsWith("/status")) return Response.json({ present: false });
      else if (path.endsWith("/chunks"))
        response = {
          sha256: NodeCrypto.createHash("sha256").update(uploadedBytes(body)).digest("hex"),
        };
      else if (path.endsWith("/workspaces")) {
        const hash = NodeCrypto.createHash("sha256")
          .update(body.version === 2 ? stableStringify(body) : JSON.stringify(body))
          .digest("hex");
        response = { id: hash, sha256: hash };
      } else response = { entityId: "task", overview };
      return Response.json(response);
    };
    const result = await startCloudConversation(
      {
        idempotencyKey: "request",
        roots: [{ id: "root", path: root }],
        target: "cloud-local",
        provider: "codex",
        model: "selected-model",
        modelOptions: [{ id: "reasoningEffort", value: "high" }],
        interactionMode: "plan",
        runtimeMode: "approval-required",
        prompt: "hello",
      },
      { relayUrl: "https://relay.example", accessToken: "token" },
      request,
    );
    expect(result.entityId).toBe("task");
    expect(requests.some((r) => r.path.includes("repositories"))).toBe(false);
    expect(JSON.stringify(requests)).not.toContain("secret");
    expect(requests.at(-1)?.body).toMatchObject({
      type: "task.create",
      provider: "codex",
      model: "selected-model",
      source: { kind: "local" },
      modelOptions: [{ id: "reasoningEffort", value: "high" }],
      interactionMode: "plan",
      runtimeMode: "approval-required",
    });
  });
});

it.each([
  { isPublic: false, configured: "new" },
  { isPublic: false, configured: "new", ambiguous: true },
  { isPublic: true, configured: "new" },
  { isPublic: false, configured: "github" },
  { isPublic: true, configured: "github" },
  { isPublic: true, configured: "local-id" },
  { isPublic: true, configured: "local-installation" },
  { isPublic: true, configured: "github", withUpstream: false },
])(
  "uses uploaded history (public=$isPublic, configured=$configured, upstream=$withUpstream)",
  async ({ isPublic, configured, withUpstream, ambiguous }) => {
    const NodeChildProcess = await import("node:child_process");
    const NodeUtil = await import("node:util");
    const exec = NodeUtil.promisify(NodeChildProcess.execFile);
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-start-github-"));
    roots.push(root);
    const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
    await git("init", "--initial-branch=feature");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.com");
    await NodeFSP.writeFile(NodePath.join(root, "file"), "published");
    await git("add", ".");
    await git("commit", "-m", "published");
    const published = await git("rev-parse", "HEAD");
    await git("remote", "add", "upstream", "git@github.com:owner/repo.git");
    if (withUpstream !== false) await git("update-ref", "refs/remotes/upstream/feature", published);
    await git("config", "branch.feature.remote", "upstream");
    await git("config", "branch.feature.merge", "refs/heads/feature");
    await NodeFSP.writeFile(NodePath.join(root, "file"), "unpublished");
    await git("commit", "-am", "unpublished");
    const unpublished = await git("rev-parse", "HEAD");
    // If preparation tries the remote fallback, SSH fails without any network
    // access. A complete local bundle must still start successfully.
    if (withUpstream === false) vi.stubEnv("GIT_SSH_COMMAND", "false");
    const repository = {
      id: "repo",
      owner: "owner",
      name: "repo",
      installationId: isPublic ? "public" : "1",
      revision: 0,
      defaultBranch: "main",
      setupCommand: "",
      testCommand: "",
    };
    const commands: unknown[] = [];
    const lookups: string[] = [];
    const configuredOverview = {
      ...overview,
      repositories:
        configured === "new"
          ? []
          : [
              {
                ...repository,
                id: configured === "local-id" ? "local" : repository.id,
                installationId:
                  configured === "local-installation" ? "local" : repository.installationId,
                owner: "OWNER",
                name: "RePo",
              },
            ],
    };
    let captured: unknown;
    const request: NonNullable<Parameters<typeof startCloudConversation>[2]> = async (
      url,
      options,
    ) => {
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      if (url.pathname === "/v1/cloud") return Response.json(configuredOverview);
      if (url.pathname.includes("/repositories/public/")) {
        lookups.push("public");
        expect(configured).not.toBe("github");
        return Response.json(isPublic ? repository : null);
      }
      if (url.pathname.endsWith("/available")) {
        lookups.push("private");
        expect(configured).not.toBe("github");
        expect(isPublic).toBe(false);
        return Response.json(
          ambiguous
            ? [
                { ...repository, githubAccountId: "personal" },
                { ...repository, githubAccountId: "work" },
              ]
            : [repository],
        );
      }
      if (url.pathname.endsWith("/status")) return Response.json({ present: false });
      if (url.pathname.endsWith("/chunks"))
        return Response.json({
          sha256: NodeCrypto.createHash("sha256").update(uploadedBytes(body)).digest("hex"),
        });
      if (url.pathname.endsWith("/workspaces")) {
        captured = body;
        const sha256 = NodeCrypto.createHash("sha256")
          .update(body.version === 2 ? stableStringify(body) : JSON.stringify(body))
          .digest("hex");
        return Response.json({ id: sha256, sha256 });
      }
      commands.push(body);
      return Response.json({ entityId: "task", overview });
    };
    const started = startCloudConversation(
      {
        idempotencyKey: "github",
        roots: [{ id: "root", path: root }],
        target: "cloud-github",
        provider: "codex",
        model: "model",
        prompt: "continue",
      },
      { relayUrl: "https://relay.example", accessToken: "token" },
      request,
    );
    if (ambiguous) {
      await expect(started).rejects.toThrow("Choose a GitHub account");
      expect(commands).toEqual([]);
      return;
    }
    await started;
    if (configured === "github") {
      expect(lookups).toEqual([]);
      expect(commands).toHaveLength(1);
    } else {
      expect(lookups).toEqual(isPublic ? ["public"] : ["public", "private"]);
      expect(commands[0]).toMatchObject({ type: "repository.save", repository });
    }
    expect(commands.at(-1)).toMatchObject({
      repositoryId: repository.id,
      source: { kind: "github", revision: withUpstream === false ? unpublished : published },
      baseBranch: "feature",
    });
    expect(captured).toMatchObject({ roots: [{ git: { head: unpublished } }] });
    if (withUpstream !== false)
      expect(await git("rev-parse", "refs/remotes/upstream/feature")).toBe(published);
  },
);

it("retains exact dispatched creation across a lost reply and a desktop restart", async () => {
  const { startRecordedCloudConversation } = await import("./StartCloudConversation.ts");
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-recorded-start-"));
  roots.push(directory);
  const workspace = NodePath.join(directory, "workspace");
  await NodeFSP.mkdir(workspace);
  await NodeFSP.writeFile(NodePath.join(workspace, "file.txt"), "original payload");
  const input = {
    idempotencyKey: "immutable-start",
    target: "cloud-local" as const,
    roots: [{ id: "root", path: workspace }],
    provider: "codex" as const,
    model: "selected",
    prompt: "create",
    runtimeMode: "approval-required" as const,
  };
  const commands: unknown[] = [];
  let callsAfterRestart: string[] | undefined;
  const request = async (url: URL, options: RequestInit) => {
    callsAfterRestart?.push(url.pathname);
    const body = typeof options.body === "string" ? JSON.parse(options.body) : undefined;
    if (url.pathname === "/v1/cloud") return Response.json(overview);
    if (url.pathname.endsWith("/status")) return Response.json({ present: false });
    if (url.pathname.endsWith("/chunks"))
      return Response.json({
        sha256: NodeCrypto.createHash("sha256").update(uploadedBytes(body)).digest("hex"),
      });
    if (url.pathname.endsWith("/workspaces")) {
      const sha256 = NodeCrypto.createHash("sha256").update(stableStringify(body)).digest("hex");
      return Response.json({ id: sha256, sha256 });
    }
    commands.push(body);
    if (commands.length === 1) throw new Error("Reply lost after acceptance");
    return Response.json({ entityId: "accepted-task", overview });
  };
  const session = { relayUrl: "https://cloud.test", accessToken: "test" };
  await expect(startRecordedCloudConversation(input, session, directory, request)).rejects.toThrow(
    "Reply lost",
  );
  await NodeFSP.writeFile(NodePath.join(workspace, "file.txt"), "edited after dispatch");
  callsAfterRestart = [];
  await expect(
    startRecordedCloudConversation(input, session, directory, request),
  ).resolves.toMatchObject({ entityId: "accepted-task" });
  expect(commands[1]).toEqual(commands[0]);
  expect(callsAfterRestart).toEqual(["/v1/cloud/commands"]);
  await expect(
    startRecordedCloudConversation({ ...input, prompt: "different" }, session, directory, request),
  ).rejects.toMatchObject({ code: "idempotency_conflict", requestDisposition: "rejected" });
  const binding = JSON.parse(
    await NodeFSP.readFile(
      NodePath.join(directory, "cloud-transfer", "bindings", "cloud-accepted-task.json"),
      "utf8",
    ),
  );
  expect(binding.roots).toEqual(input.roots);
  expect(
    binding.workspace.entries.find((entry: { path: string }) => entry.path === "file.txt")
      .sizeBytes,
  ).toBe(Buffer.byteLength("original payload"));
});

it("preserves explicit rejection and treats missing error disposition as ambiguous", async () => {
  const { asDesktopCloudError } = await import("./requestFailure.ts");
  for (const disposition of [undefined, "unknown", "rejected"] as const) {
    const api = cloudApi({ relayUrl: "https://cloud.test", accessToken: "test" }, async () =>
      Response.json(
        { code: "task_busy", requestDisposition: disposition, retryable: true },
        { status: 409 },
      ),
    );
    try {
      await api("/commands", {});
      throw new Error("Expected failure");
    } catch (error) {
      expect(asDesktopCloudError(error, "fallback")).toMatchObject({
        code: "task_busy",
        requestDisposition: disposition ?? "unknown",
        retryable: true,
      });
    }
  }
  expect(asDesktopCloudError(new Error("network interrupted"), "fallback").requestDisposition).toBe(
    "unknown",
  );
  await expect(
    startCloudConversation(
      {
        idempotencyKey: "not-dispatched",
        target: "cloud-local",
        roots: [{ id: "root", path: "/unused" }],
        provider: "codex",
        model: "test",
        prompt: "hello",
      },
      { relayUrl: "https://cloud.test", accessToken: "test" },
      async () => {
        throw new Error("Preflight network interrupted");
      },
    ),
  ).rejects.toMatchObject({ requestDisposition: "rejected" });
});
