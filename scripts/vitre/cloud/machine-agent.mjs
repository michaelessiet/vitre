/** Resident, provider-independent supervisor. This API never creates/deletes VMs. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const attemptPattern = /^(?:[a-f0-9-]{36}-[1-9][0-9]*|(?:login|publish|lens)-[a-f0-9-]{36})$/;
const idPattern = /^(?:[a-f0-9-]{36}|(?:login|publish|lens)-[a-f0-9-]{36})$/;
export function validateAttempt(id) {
  if (!attemptPattern.test(id)) throw Object.assign(new Error("Invalid attempt"), { status: 400 });
  return id;
}
function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
function equalSecret(a, b) {
  const hash = (value) => NodeCrypto.createHash("sha256").update(value).digest();
  return NodeCrypto.timingSafeEqual(hash(a), hash(b));
}
export function sandboxArguments(rootfs, directory) {
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--ro-bind",
    rootfs,
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--perms",
    "1777",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--ro-bind",
    "/etc/resolv.conf",
    "/etc/resolv.conf",
    "--bind",
    NodePath.join(directory, "workspace"),
    "/workspace",
    "--bind",
    NodePath.join(directory, "home"),
    "/home",
    "--bind",
    NodePath.join(NodePath.dirname(NodePath.dirname(directory)), "package-cache"),
    "/home/vitre-setup/.cache",
    "--bind",
    NodePath.join(directory, "worker"),
    "/var/lib/vitre-worker",
    "--cap-drop",
    "ALL",
    ...[
      "CAP_SETUID",
      "CAP_SETGID",
      "CAP_CHOWN",
      "CAP_DAC_OVERRIDE",
      "CAP_FOWNER",
      "CAP_KILL",
    ].flatMap((cap) => ["--cap-add", cap]),
    "--chdir",
    "/workspace",
    "/usr/local/bin/node",
    "/opt/vitre/cloud/worker.mjs",
  ];
}
export function systemdDriver(rootfs, execute = exec) {
  const unit = (id) => `vitre-attempt-${validateAttempt(id)}.service`;
  return {
    async running(id) {
      const { stdout } = await execute(
        "systemctl",
        ["show", "--property=LoadState,ActiveState", unit(id)],
        { timeout: 5000 },
      ).catch((error) => {
        if (error.stdout?.split("\n").includes("LoadState=not-found"))
          return { stdout: error.stdout };
        throw error;
      });
      if (stdout.split("\n").includes("LoadState=not-found")) return false;
      const state = stdout
        .split("\n")
        .find((line) => line.startsWith("ActiveState="))
        ?.slice(12);
      if (["active", "activating", "reloading", "deactivating"].includes(state)) return true;
      if (["inactive", "failed"].includes(state)) return false;
      throw new Error("Worker process state is unknown");
    },
    async start(id, directory, deadlineAt, { recover = false } = {}) {
      const remaining = Math.max(1, Math.ceil((Date.parse(deadlineAt) - Date.now()) / 1000) + 90);
      if (recover)
        await execute("systemctl", ["reset-failed", unit(id)], { timeout: 5000 }).catch(() => {});
      await execute(
        "systemd-run",
        [
          "--quiet",
          "--collect",
          `--unit=${unit(id)}`,
          "--service-type=exec",
          "--property=Restart=no",
          "--property=KillMode=control-group",
          "--property=TimeoutStopSec=15",
          // Task backends remain resident. Auxiliary login/publication jobs
          // still have a strict deadline; the relay fences unhealthy tasks.
          `--property=RuntimeMaxSec=${id.startsWith("login-") || id.startsWith("publish-") || id.startsWith("lens-") ? remaining : "infinity"}`,
          "--property=IPAddressDeny=169.254.0.0/16",
          "--property=IPAddressDeny=fd00:ec2::254/128",
          "--property=TasksMax=2048",
          process.execPath,
          NodeURL.fileURLToPath(import.meta.url),
          "run",
          directory,
          rootfs,
          ...(recover ? ["recover"] : []),
        ],
        { timeout: 20_000 },
      );
    },
    async stop(id) {
      await exec("systemctl", ["stop", unit(id)], { timeout: 25_000 }).catch(async (error) => {
        const { stdout } = await exec("systemctl", [
          "show",
          "--property=LoadState",
          "--value",
          unit(id),
        ]);
        if (stdout.trim() !== "not-found") throw error;
      });
      const { stdout } = await exec("systemctl", [
        "show",
        "--property=ActiveState",
        "--value",
        unit(id),
      ]);
      if (!["inactive", "failed", ""].includes(stdout.trim()))
        throw new Error("Worker stop unconfirmed");
    },
  };
}
export async function createMachineAgent({
  directory,
  ownerId,
  token,
  controlUrl,
  driver,
  fetcher = fetch,
  recoveryIntervalMs = 5000,
}) {
  if (!ownerId || token.length < 32 || new URL(controlUrl).protocol !== "https:")
    throw new Error("Invalid machine configuration");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(directory, 0o700);
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const folder = (id) => NodePath.join(directory, validateAttempt(id));
  const read = async (id) => {
    try {
      return JSON.parse(await NodeFSP.readFile(NodePath.join(folder(id), "receipt.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const save = async (id, value) => {
    const target = NodePath.join(folder(id), "receipt.json");
    const file = await NodeFSP.open(`${target}.tmp`, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFSP.rename(`${target}.tmp`, target);
    const parent = await NodeFSP.open(folder(id), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  };
  const all = async () =>
    (
      await Promise.all(
        (await NodeFSP.readdir(directory)).filter((id) => attemptPattern.test(id)).map(read),
      )
    ).filter(Boolean);
  const taskForAttempt = (id) =>
    id.startsWith("login-") || id.startsWith("publish-") || id.startsWith("lens-")
      ? id
      : id.slice(0, 36);
  const prepare = async (id) => {
    const current = await read(id);
    if (current?.state === "deleted") fail(409, "Attempt retired");
    if (current) return current;
    const taskId = taskForAttempt(id);
    const retained = (await all()).filter((r) => r.state !== "deleted");
    const belongsToTask = (r) => (r.taskId ?? taskForAttempt(r.attemptId)) === taskId;
    // Older supervisors lent stopped ports to other conversations. Those receipts
    // cannot establish exclusive ownership when migrating to resident backends.
    const foreignPorts = new Set(retained.filter((r) => !belongsToTask(r)).map((r) => r.port));
    const priority = (r) => (r.state === "started" ? 2 : r.state === "prepared" ? 1 : 0);
    const previous = retained
      .filter(
        (r) =>
          belongsToTask(r) &&
          Number.isInteger(r.port) &&
          r.port >= 20000 &&
          r.port <= 59999 &&
          !foreignPorts.has(r.port),
      )
      .sort(
        (a, b) =>
          priority(b) - priority(a) ||
          Number(b.attemptId.slice(37)) - Number(a.attemptId.slice(37)),
      )[0];
    const used = new Set(retained.map((r) => r.port));
    let port = previous?.port ?? 20000;
    if (!previous) while (used.has(port) && port <= 59999) port++;
    if (port > 59999) fail(503, "Machine at capacity");
    await NodeFSP.mkdir(folder(id), { mode: 0o700 });
    const receipt = { attemptId: id, taskId, port, state: "prepared" };
    await save(id, receipt);
    return receipt;
  };
  const server = NodeHttp.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (
        !equalSecret(req.headers.authorization ?? "", `Bearer ${token}`) ||
        req.headers["x-vitre-owner"] !== ownerId
      )
        return reply(401, { error: "Unauthorized" });
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/v1/health" && req.method === "GET")
        return reply(200, { ready: true, protocol: 1 });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 16 * 1024) fail(413, "Request too large");
      }
      const result = await exclusive(async () => {
        if (url.pathname === "/v1/attempts" && req.method === "GET")
          return (await all())
            .filter((r) => r.state !== "deleted")
            .map((r) => ({ id: `machine-${r.attemptId}`, attemptId: r.attemptId }));
        const match = /^\/v1\/attempts\/([^/]+)(?:\/(prepare|stop))?$/.exec(url.pathname);
        if (!match) fail(404, "Not found");
        const id = validateAttempt(match[1]);
        const action = match[2];
        if (action === "prepare" && req.method === "POST")
          return { port: (await prepare(id)).port };
        let receipt = await read(id);
        if (req.method === "PUT" && !action) {
          const input = JSON.parse(body);
          if (
            input.attemptId !== id ||
            !(id === input.taskId || id.startsWith(`${input.taskId}-`)) ||
            !idPattern.test(input.taskId) ||
            input.controlUrl !== controlUrl ||
            typeof input.token !== "string" ||
            input.token.length < 32 ||
            input.token.length > 4096 ||
            ![undefined, "login", "publication", "lens"].includes(input.mode)
          )
            fail(400, "Invalid bootstrap");
          const fingerprint = NodeCrypto.createHash("sha256")
            .update(
              JSON.stringify([
                input.taskId,
                input.attemptId,
                input.controlUrl,
                input.token,
                input.deadlineAt,
                input.mode ?? "task",
              ]),
            )
            .digest("hex");
          if (receipt?.fingerprint && receipt.fingerprint !== fingerprint)
            fail(409, "Attempt identity conflict");
          if (receipt && receipt.state !== "prepared") {
            if (receipt.state === "deleted") fail(409, "Attempt retired");
            return { id: `machine-${id}` }; // Never replay after a crash, stop, or lost response.
          }
          const remaining = Date.parse(input.deadlineAt) - Date.now();
          if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 3 * 3600_000)
            fail(400, "Invalid deadline");
          const other = (await all()).find(
            (r) => r.taskId === input.taskId && r.attemptId !== id && r.state === "started",
          );
          if (other) fail(409, "Previous conversation worker must stop first");
          receipt = await prepare(id);
          const workspaceDirectory = NodePath.join(directory, "workspaces", input.taskId);
          for (const dir of ["workspace", "home/vitre", "home/vitre-setup", "worker"])
            await NodeFSP.mkdir(NodePath.join(workspaceDirectory, dir), {
              recursive: true,
              mode: dir === "worker" ? 0o700 : 0o755,
            });
          for (const dir of ["workspace", "home"])
            await NodeFSP.chmod(NodePath.join(workspaceDirectory, dir), 0o755);
          await NodeFSP.writeFile(
            NodePath.join(folder(id), "bootstrap.json"),
            JSON.stringify({ ...input, port: receipt.port, workspaceDirectory }),
            { mode: 0o600 },
          );
          receipt = { ...receipt, fingerprint, taskId: input.taskId, state: "started" };
          await save(id, receipt); // Durable receipt BEFORE launch: ambiguous failures cannot replay prompts.
          await driver.start(id, folder(id), input.deadlineAt);
          return { id: `machine-${id}` };
        }
        if (!receipt || receipt.state === "deleted") {
          if (req.method === "DELETE" || action === "stop") return { stopped: true };
          fail(404, "Attempt not found");
        }
        if (req.method === "GET" && !action)
          return {
            id: `machine-${id}`,
            ...(driver.running ? { running: await driver.running(id) } : {}),
          };
        if ((req.method === "POST" && action === "stop") || (req.method === "DELETE" && !action)) {
          await driver.stop(id);
          receipt.state = req.method === "DELETE" ? "deleted" : "stopped";
          await save(id, receipt);
          await NodeFSP.rm(NodePath.join(folder(id), "bootstrap.json"), { force: true });
          // Keep conversation disks across attempt cleanup; deleting workspaces is a separate administrative operation.
          return { stopped: true };
        }
        fail(405, "Unsupported operation");
      });
      reply(200, result);
    } catch (error) {
      reply(error.status ?? 503, {
        error: error.status ? error.message : "Machine operation failed",
      });
    }
  });
  const shutdown = new AbortController();
  let recovery;
  // Receipts survive a reboot; transient systemd units do not. Recover only a
  // previously running resident attempt that the relay still authorizes. Never
  // turn old stopped conversations or unfinished first submissions into work.
  server.recover = () => {
    if (!driver.running || shutdown.signal.aborted) return Promise.resolve();
    recovery ??= (async () => {
      const receipts = await all();
      await Promise.allSettled(
        receipts.map(async (receipt) => {
          const id = receipt.attemptId;
          if (
            receipt.state !== "started" ||
            !/^[a-f0-9-]{36}-[1-9][0-9]*$/.test(id) ||
            receipts.some(
              (other) =>
                other.attemptId !== id &&
                other.state === "started" &&
                (taskForAttempt(other.attemptId) === taskForAttempt(id) ||
                  other.port === receipt.port),
            ) ||
            (await driver.running(id))
          )
            return;
          const input = JSON.parse(
            await NodeFSP.readFile(NodePath.join(folder(id), "bootstrap.json"), "utf8"),
          );
          const workspace = NodePath.join(directory, "workspaces", taskForAttempt(id));
          if (
            input.attemptId !== id ||
            input.taskId !== taskForAttempt(id) ||
            input.controlUrl !== controlUrl ||
            input.workspaceDirectory !== workspace ||
            input.port !== receipt.port ||
            input.mode !== undefined ||
            typeof input.token !== "string" ||
            input.token.length < 32
          )
            return;
          const journal = JSON.parse(
            await NodeFSP.readFile(NodePath.join(workspace, "worker/journal.json"), "utf8"),
          );
          if (journal.attemptId !== id || !journal.setupComplete) return;
          const response = await fetcher(
            new URL(`/v1/cloud/worker/${input.taskId}/bootstrap`, controlUrl),
            {
              redirect: "error",
              headers: { authorization: `Bearer ${input.token}` },
              signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(5000)]),
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            return;
          }
          const status = await response.json();
          if (
            !status.resident ||
            status.stopRequested ||
            status.attempt?.id !== id ||
            status.task?.id !== input.taskId ||
            status.task.archivedAt ||
            !["running", "waiting_for_input"].includes(status.task.state) ||
            !["ready", "starting"].includes(status.task.worker?.state) ||
            !(journal.submitted || status.task.wakeOnly || journal.activated)
          )
            return;
          await exclusive(async () => {
            const current = await read(id);
            if (
              shutdown.signal.aborted ||
              current?.state !== "started" ||
              current.fingerprint !== receipt.fingerprint ||
              (await driver.running(id))
            )
              return;
            await driver.start(id, folder(id), input.deadlineAt, { recover: true });
          });
        }),
      );
    })().finally(() => {
      recovery = undefined;
    });
    return recovery;
  };
  let recoveryTimer;
  server.once("listening", () => {
    if (recoveryIntervalMs <= 0) return;
    const recover = () => {
      void server.recover().catch(() => {});
    };
    recover();
    recoveryTimer = setInterval(recover, recoveryIntervalMs);
    recoveryTimer.unref();
  });
  server.once("close", () => {
    shutdown.abort();
    clearInterval(recoveryTimer);
  });
  return server;
}
async function runAttempt(directory, rootfs, recover = false) {
  const input = JSON.parse(
    await NodeFSP.readFile(NodePath.join(directory, "bootstrap.json"), "utf8"),
  );
  for (const [user, uid] of [
    ["vitre", 10001],
    ["vitre-setup", 10002],
  ])
    await NodeFSP.chown(NodePath.join(input.workspaceDirectory, "home", user), uid, uid);
  const cache = NodePath.join(
    NodePath.dirname(NodePath.dirname(input.workspaceDirectory)),
    "package-cache",
  );
  await NodeFSP.mkdir(cache, { recursive: true, mode: 0o755 });
  await NodeFSP.chown(cache, 10002, 10002);
  await NodeFSP.mkdir(NodePath.join(input.workspaceDirectory, "home/vitre-setup/.cache"), {
    recursive: true,
  });
  const child = NodeChildProcess.spawn(
    "/usr/bin/bwrap",
    sandboxArguments(rootfs, input.workspaceDirectory),
    {
      stdio: "inherit",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        VITRE_CLOUD_CONTROL_URL: input.controlUrl,
        VITRE_CLOUD_TASK_ID: input.taskId,
        VITRE_CLOUD_ATTEMPT_ID: input.attemptId,
        VITRE_CLOUD_WORKER_TOKEN: input.token,
        VITRE_CLOUD_WORKER_MODE: input.mode ?? "task",
        VITRE_CLOUD_BACKEND_PORT: String(input.port),
        ...(recover ? { VITRE_CLOUD_RECOVER_ATTEMPT: "1" } : {}),
      },
    },
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("Worker exited"))));
  });
}
if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const main = async () => {
    if (process.getuid?.() !== 0) throw new Error("Machine agent requires root");
    process.umask(0o077);
    if (process.argv[2] === "run")
      return runAttempt(process.argv[3], process.argv[4], process.argv[5] === "recover");
    const rootfs = process.env.VITRE_MACHINE_ROOTFS ?? "/opt/vitre-machine/rootfs";
    const server = await createMachineAgent({
      directory: "/var/lib/vitre-machine/attempts",
      ownerId: process.env.VITRE_MACHINE_OWNER,
      token: process.env.VITRE_MACHINE_TOKEN ?? "",
      controlUrl: process.env.VITRE_MACHINE_CONTROL_URL,
      driver: systemdDriver(rootfs),
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.listen(9077, "127.0.0.1");
  };
  main().catch(() => {
    console.error("[vitre-machine] Operation failed; inspect the machine service");
    process.exitCode = 1;
  });
}
