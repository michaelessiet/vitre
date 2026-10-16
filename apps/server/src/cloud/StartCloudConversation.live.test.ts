// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Opt-in paid live verification owns disposable filesystem fixtures and real deadlines.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeTimersPromises from "node:timers/promises";
import { expect, it } from "vite-plus/test";
import { DEFAULT_MODEL } from "@t3tools/contracts";
import { startCloudConversation, continueCloudConversation } from "./StartCloudConversation.ts";
import { handoffRelay } from "./handoffTransport.ts";
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
it.skipIf(process.env.VITRE_LIVE_CLOUD_START !== "1")(
  "starts both workspace sources and accepts a follow-up through the deployed relay",
  async () => {
    const credential = JSON.parse(
      await NodeFSP.readFile(process.env.VITRE_LIVE_CREDENTIAL_FILE!, "utf8"),
    );
    if (credential.expiresAtEpochMs < Date.now() + 900_000)
      throw new Error("Refresh the cloud credential first");
    const session = { relayUrl: "https://cloud.usevitre.app", accessToken: credential.accessToken };
    const relay = handoffRelay(session);
    const overview = await relay.overview();
    const available = (await relay.api("/repositories/available")) as typeof overview.repositories;
    const repository = process.env.VITRE_LIVE_GITHUB_REPOSITORY
      ? available.find((r) => `${r.owner}/${r.name}` === process.env.VITRE_LIVE_GITHUB_REPOSITORY)
      : overview.repositories[0];
    if (!repository) throw new Error("Connect a disposable-access GitHub repository first");
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-live-start-"));
    const tasks: string[] = [];
    try {
      for (const target of ["cloud-local", "cloud-github"] as const) {
        const workspace = NodePath.join(root, target);
        await NodeFSP.mkdir(workspace);
        await NodeFSP.writeFile(NodePath.join(workspace, "baseline.txt"), "unchanged baseline\n");
        // The fixture uses an unpublished local history. GitHub supplies the exact
        // published base, then the uploaded bundle restores the local workspace.
        if (target === "cloud-github") {
          const git = (...args: string[]) => exec("git", args, { cwd: workspace });
          await git("init", "--initial-branch=fixture");
          await git("config", "user.name", "Vitre verification");
          await git("config", "user.email", "verification@example.invalid");
          await git("config", "credential.helper", "!gh auth git-credential");
          await git("add", ".");
          await git("commit", "-m", "Disposable local baseline");
          await git(
            "remote",
            "add",
            "origin",
            `https://github.com/${repository.owner}/${repository.name}.git`,
          );
          await NodeFSP.mkdir(NodePath.join(workspace, ".codex"));
          await NodeFSP.writeFile(
            NodePath.join(workspace, ".codex/config.toml"),
            '[mcp_servers.local]\ncommand = "node"\nargs = ["server.mjs"]\nenabled = false\n',
          );
        }
        const result = await startCloudConversation(
          {
            idempotencyKey: NodeCrypto.randomUUID(),
            roots: [{ id: "root", path: workspace }],
            target,
            provider: "codex",
            model: DEFAULT_MODEL,
            prompt:
              "Create proof.txt containing exactly verified followed by a newline. Do not modify other files. Then reply done.",
            attachments: [],
          },
          session,
        );
        tasks.push(result.entityId);
        const waitIdle = async () => {
          const deadline = Date.now() + 480_000;
          while (Date.now() < deadline) {
            const task = (await relay.overview()).tasks.find((t) => t.id === result.entityId);
            if (
              task &&
              ["failed", "needs_auth", "usage_limited", "interrupted"].includes(task.state)
            )
              throw new Error(task.error ?? `Cloud task ${task.state}`);
            if (task?.idle && task.worker?.state === "ready") return;
            await NodeTimersPromises.setTimeout(3000);
          }
          throw new Error(`${target} did not finish within eight minutes`);
        };
        await waitIdle();
        const environment = await relay.environment(result.entityId);
        const thread = (await environment(
          `/api/orchestration/threads/cloud-${result.entityId}`,
        )) as { thread: { messages: Array<{ role: string; text: string }> } };
        expect(thread.thread.messages.some((m) => m.role === "assistant" && m.text.trim())).toBe(
          true,
        );
        await continueCloudConversation(
          {
            idempotencyKey: NodeCrypto.randomUUID(),
            taskId: result.entityId,
            prompt:
              "Read proof.txt and baseline.txt. Confirm proof.txt says verified and baseline.txt says unchanged baseline. Do not change any files. Reply verified only if both match.",
            attachments: [],
          },
          session,
        );
        await waitIdle();
        const followed = (await environment(
          `/api/orchestration/threads/cloud-${result.entityId}`,
        )) as { thread: { messages: Array<{ role: string; text: string }> } };
        expect(
          followed.thread.messages.findLast((m) => m.role === "assistant")?.text.toLowerCase(),
        ).toContain("verified");
        await relay.api("/commands", {
          type: "task.delete",
          idempotencyKey: NodeCrypto.randomUUID(),
          taskId: result.entityId,
        });
        // Give cleanup time to release the provider lease before the next source.
        await NodeTimersPromises.setTimeout(5000);
      }
    } finally {
      for (const taskId of tasks)
        await relay
          .api("/commands", {
            type: "task.delete",
            idempotencyKey: NodeCrypto.randomUUID(),
            taskId,
          })
          .catch(() => {});
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
  1_200_000,
);
