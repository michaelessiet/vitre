import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { WorkerControlClient, childEnvironment } from "./worker.mjs";
const exec = NodeUtil.promisify(NodeChildProcess.execFile);

export function devicePrompt(text) {
  // oxlint-disable-next-line no-control-regex -- Remove ANSI escapes emitted by the pinned CLI.
  const plain = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const verificationUrl = plain.match(/https:\/\/auth\.openai\.com\/[a-zA-Z0-9/_-]+/)?.[0];
  const userCode = plain.match(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/)?.[0];
  return verificationUrl && userCode ? { verificationUrl, userCode } : null;
}

export async function createLoginHome(base = "/home/vitre", uid = 10001, gid = 10001) {
  const home = await NodeFSP.mkdtemp(NodePath.join(base, ".cloud-login-"));
  try {
    await NodeFSP.chmod(home, 0o700);
    await NodeFSP.chown(home, uid, gid);
    return home;
  } catch (error) {
    await NodeFSP.rm(home, { recursive: true, force: true });
    throw error;
  }
}

export async function runAuxiliary() {
  if (process.getuid?.() !== 0) throw new Error("Auxiliary supervisor must run as root");
  const id = process.env.VITRE_CLOUD_TASK_ID;
  if (!/^(login|publish|lens)-[a-zA-Z0-9-]+$/.test(id ?? "")) throw new Error("Invalid job id");
  const control = new WorkerControlClient(
    process.env.VITRE_CLOUD_CONTROL_URL,
    process.env.VITRE_CLOUD_WORKER_TOKEN,
  );
  const bootstrap = await control.request(`jobs/${id}/bootstrap`);
  if (bootstrap.done) return;
  let sequence = bootstrap.sequence ?? 0;
  const callback = (body) =>
    control.request(`jobs/${id}/callback`, { ...body, sequence: ++sequence });
  const timeout = Math.min(900_000, Math.max(1, Date.parse(bootstrap.deadlineAt) - Date.now()));
  const root = await NodeFSP.mkdtemp("/var/lib/vitre-worker/aux-");
  let loginHome;
  try {
    if (bootstrap.kind === "login") {
      const home = await createLoginHome();
      loginHome = home;
      const child = NodeChildProcess.spawn(
        "codex",
        ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"],
        {
          uid: 10001,
          gid: 10001,
          cwd: home,
          env: { ...childEnvironment(), CODEX_HOME: home },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      let sent = false;
      let pending = Promise.resolve();
      const capture = (bytes) => {
        output = (output + bytes.toString()).slice(-16384);
        const prompt = devicePrompt(output);
        if (prompt && !sent) {
          sent = true;
          pending = callback({ phase: "code", ...prompt });
          pending.catch(() => child.kill("SIGKILL"));
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });
        await pending;
        if (code !== 0) throw new Error("Device login did not complete");
        const credential = await NodeFSP.readFile(NodePath.join(home, "auth.json"), "utf8");
        const parsed = JSON.parse(credential);
        if (parsed.OPENAI_API_KEY || !parsed.tokens?.refresh_token)
          throw new Error("Subscription login required");
        await callback({ phase: "completed", credential });
      } finally {
        clearTimeout(timer);
        child.kill("SIGKILL");
      }
    } else if (bootstrap.kind === "lens") {
      const { runLensModel } = await import("./lens.mjs");
      const result = await runLensModel(bootstrap, timeout);
      await callback({ phase: "completed", ...result });
    } else if (bootstrap.kind === "publication") {
      let commit = null;
      if (bootstrap.publication.kind === "pull_request") {
        const archive = NodePath.join(root, "checkpoint.tar.gz");
        const file = await NodeFSP.open(archive, "wx", 0o600);
        try {
          for (const chunk of bootstrap.manifest.chunks) {
            const response = await control.request(`jobs/${id}/chunks/${chunk.index}`);
            const bytes = Buffer.from(response.base64, "base64");
            if (
              bytes.length !== chunk.sizeBytes ||
              NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== chunk.sha256
            )
              throw new Error("Publication artifact mismatch");
            await file.write(bytes);
          }
        } finally {
          await file.close();
        }
        const metadata = JSON.parse(
          (await exec("tar", ["-xOzf", archive, "metadata.json"], { maxBuffer: 65536 })).stdout,
        );
        if (
          metadata.baseSha !== bootstrap.task.baseSha ||
          !/^[a-f0-9]{40}$/.test(metadata.commit) ||
          !/^refs\/vitre-checkpoints\/[a-f0-9-]{36}$/.test(metadata.ref)
        )
          throw new Error("Invalid publication checkpoint");
        const bundle = NodePath.join(root, "repository.bundle");
        const output = await NodeFSP.open(bundle, "wx", 0o600);
        try {
          await new Promise((resolve, reject) => {
            const child = NodeChildProcess.spawn("tar", ["-xOzf", archive, "repository.bundle"], {
              stdio: ["ignore", output.fd, "ignore"],
            });
            child.once("error", reject);
            child.once("exit", (code) =>
              code === 0 ? resolve() : reject(new Error("Invalid publication bundle")),
            );
          });
        } finally {
          await output.close();
        }
        const repository = NodePath.join(root, "repository.git");
        const token = Buffer.from(`x-access-token:${bootstrap.repositoryToken}`).toString("base64");
        const env = {
          ...childEnvironment(),
          HOME: root,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${token}`,
          GIT_CONFIG_KEY_1: "core.hooksPath",
          GIT_CONFIG_VALUE_1: "/dev/null",
        };
        const git = async (args) =>
          (
            await exec("git", args, { env, cwd: root, timeout, maxBuffer: 16 * 1024 * 1024 })
          ).stdout.trim();
        await git(["init", "--bare", repository]);
        const run = (args) => git(["--git-dir", repository, ...args]);
        const remote = `https://github.com/${bootstrap.task.repository.owner}/${bootstrap.task.repository.name}.git`;
        await run(["fetch", remote, bootstrap.task.baseSha]);
        await run(["bundle", "verify", bundle]);
        await run(["fetch", bundle, metadata.ref]);
        commit = await run(["rev-parse", "FETCH_HEAD"]);
        if (
          commit !== metadata.commit ||
          (await run(["rev-parse", `${commit}^`])) !== bootstrap.task.baseSha
        )
          throw new Error("Publication commit mismatch");
        if (
          (await run([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--binary",
            bootstrap.task.baseSha,
            commit,
          ])) !== bootstrap.manifest.result.diff.trim()
        )
          throw new Error("Publication differs from approved review");
        const ref = `refs/heads/${bootstrap.task.branch}`;
        const existing = await run(["ls-remote", "--refs", remote, ref]);
        if (existing && existing.split(/\s/)[0] !== commit)
          throw new Error("Task branch already points to another commit");
        if (!existing) await run(["push", remote, `${commit}:${ref}`]);
      }
      await callback({ phase: "completed", commit });
    } else throw new Error("Invalid auxiliary mode");
  } catch {
    await callback({ phase: "failed" }).catch(() => {});
    throw new Error("Isolated cloud operation failed");
  } finally {
    if (loginHome) await NodeFSP.rm(loginHome, { recursive: true, force: true });
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}
