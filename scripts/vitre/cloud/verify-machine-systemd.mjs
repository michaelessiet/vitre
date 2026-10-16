/** Destructive fixture in dedicated proof directories; run only on a disposable installed Linux host. */
import * as NodeFSP from "node:fs/promises";
const fs = NodeFSP;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeChildProcess from "node:child_process";
const { execFile } = NodeChildProcess;
import * as NodeUtil from "node:util";
const { promisify } = NodeUtil;
import * as NodeOS from "node:os";
import {
  createMachineAgent,
  systemdDriver,
} from "/opt/vitre-machine/rootfs/opt/vitre/cloud/machine-agent.mjs";
if (
  process.env.VITRE_VERIFY_MACHINE_SYSTEMD !== "1" ||
  // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone host verifier, outside the Effect application
  NodeOS.platform() !== "linux" ||
  process.getuid?.() !== 0
)
  throw new Error("Run as root on a disposable Linux host with VITRE_VERIFY_MACHINE_SYSTEMD=1");
const exec = promisify(execFile),
  root = "/opt/vitre-machine/proof-rootfs",
  directory = "/var/lib/vitre-machine/proof";
await exec("cp", ["-al", "/opt/vitre-machine/rootfs", root]);
await fs.unlink(root + "/opt/vitre/cloud/worker.mjs");
await fs.writeFile("/host-only-vitre-proof", "secret");
await fs.writeFile(
  root + "/opt/vitre/cloud/worker.mjs",
  `
import fs from 'node:fs/promises'; import {execFileSync} from 'node:child_process';
if(await fs.stat('/host-only-vitre-proof').then(()=>true,()=>false)) throw Error('Host file leaked');
if(process.env.VITRE_MACHINE_TOKEN) throw Error('Host credential leaked');
await fs.mkdir('/workspace/repository',{recursive:true});await fs.chown('/workspace/repository',10001,10001);
execFileSync('/usr/local/bin/node',['-e',"const fs=require('fs');fs.appendFileSync('/workspace/repository/runs','x');fs.writeFileSync('/home/vitre/proof','ok');fs.writeFileSync('/tmp/provider-temp','ok');if((fs.statSync('/tmp').mode & 0o7777)!==0o1777)throw Error('Unsafe temporary directory permissions')"],{uid:10001,gid:10001});
const denied=await fetch('http://169.254.169.254/latest/meta-data/',{signal:AbortSignal.timeout(1500)}).then(()=>false,()=>true);
if(!denied)throw Error('Metadata reachable');
await fs.writeFile('/workspace/ready','ok');setInterval(()=>{},1000);
`,
);
const driver = systemdDriver(root),
  token = "proof-credential-".repeat(4),
  ownerId = "proof-owner",
  controlUrl = "https://relay.invalid";
const taskId = "00000000-0000-4000-8000-000000000042";
const ids = [taskId + "-1", taskId + "-2"];
let server;
async function listen() {
  server = await createMachineAgent({ directory, ownerId, token, controlUrl, driver });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
}
async function close() {
  await new Promise((r, j) => server.close((e) => (e ? j(e) : r())));
}
async function request(path, method = "GET", body, auth = true) {
  return fetch("http://127.0.0.1:" + server.address().port + "/v1" + path, {
    method,
    headers: auth ? { authorization: "Bearer " + token, "x-vitre-owner": ownerId } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const bootstrap = (id) => ({
  taskId,
  attemptId: id,
  controlUrl,
  token: "dummy-worker-token-".repeat(3),
  deadlineAt: new Date(Date.now() + 180000).toISOString(),
});
async function ready() {
  for (let i = 0; i < 40; i++) {
    if (
      (await fs
        .readFile(directory + "/workspaces/" + taskId + "/workspace/ready", "utf8")
        .catch(() => null)) === "ok"
    )
      return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error("Worker never became ready");
}
try {
  await listen();
  assert.equal((await request("/health", "GET", undefined, false)).status, 401);
  assert.equal((await request("/health")).status, 200);
  const first = bootstrap(ids[0]);
  assert.equal((await request("/attempts/" + ids[0], "PUT", first)).status, 200);
  await ready();
  await close();
  await listen();
  assert.equal((await request("/attempts/" + ids[0], "PUT", first)).status, 200);
  assert.equal((await request("/attempts/" + ids[1], "PUT", bootstrap(ids[1]))).status, 409);
  assert.equal((await request("/attempts/" + ids[0] + "/stop", "POST")).status, 200);
  await fs.rm(directory + "/workspaces/" + taskId + "/workspace/ready");
  assert.equal((await request("/attempts/" + ids[1], "PUT", bootstrap(ids[1]))).status, 200);
  await ready();
  assert.equal(
    await fs.readFile(directory + "/workspaces/" + taskId + "/workspace/repository/runs", "utf8"),
    "xx",
  );
  assert.equal(
    await fs.readFile(directory + "/workspaces/" + taskId + "/home/vitre/proof", "utf8"),
    "ok",
  );
  console.log(
    "PASS: real systemd startup, host/credential/metadata isolation, restart idempotency, exclusive ownership, stop, persistent workspace and home",
  );
} finally {
  if (server) await close();
  for (const id of ids) await driver.stop(id).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(directory, { recursive: true, force: true });
  await fs.rm("/host-only-vitre-proof", { force: true });
}
