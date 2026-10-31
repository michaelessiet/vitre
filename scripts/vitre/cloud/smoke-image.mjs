import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const image = process.argv[2];
if (!image) throw new Error("Usage: node scripts/vitre/cloud/smoke-image.mjs IMAGE:VERSION");
const name = `vitre-cloud-smoke-${NodeCrypto.randomUUID()}`;
const token = NodeCrypto.randomUUID();
// Docker needs namespace syscalls for Chromium's sandbox. Production uses bwrap.
const seccompProfile = process.env.VITRE_SMOKE_SECCOMP_PROFILE;
try {
  const child = NodeChildProcess.spawn(
    "docker",
    [
      "run",
      "--rm",
      "--interactive",
      "--platform",
      "linux/amd64",
      "--name",
      name,
      "--user",
      "10001:10001",
      ...(seccompProfile ? ["--security-opt", `seccomp=${seccompProfile}`] : []),
      "--publish",
      "127.0.0.1::3773",
      "--entrypoint",
      "node",
      image,
      "/opt/vitre/server/dist/bin.mjs",
      "--bootstrap-fd",
      "0",
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  child.stdin.end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port: 3773,
      t3Home: "/home/vitre/.t3",
      host: "0.0.0.0",
      desktopBootstrapToken: token,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }) + "\n",
  );
  let startupError;
  child.once("error", (error) => {
    startupError = error;
  });
  let mapping = "";
  for (let i = 0; i < 30; i++) {
    if (startupError || child.exitCode !== null) throw new Error("Container startup failed");
    mapping = await exec("docker", ["port", name, "3773/tcp"])
      .then((result) => result.stdout.trim())
      .catch(() => "");
    if (mapping) break;
    await NodeTimersPromises.setTimeout(500);
  }
  if (!/^127\.0\.0\.1:\d+$/.test(mapping)) throw new Error("Unexpected container port binding");
  const origin = `http://${mapping}`;
  let accessToken;
  for (let i = 0; i < 45; i++) {
    try {
      const response = await fetch(`${origin}/oauth/token`, {
        method: "POST",
        signal: AbortSignal.timeout(1000),
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: token,
          subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          client_label: "Cloud image smoke test",
          client_device_type: "desktop",
        }),
      });
      if (response.ok) {
        accessToken = (await response.json()).access_token;
        break;
      }
    } catch {}
    await NodeTimersPromises.setTimeout(1000);
  }
  if (!accessToken) throw new Error("Packaged backend did not complete bootstrap token exchange");
  const snapshot = await fetch(`${origin}/api/orchestration/snapshot`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!snapshot.ok || !Array.isArray((await snapshot.json()).projects))
    throw new Error("Packaged backend snapshot failed");
  const ticket = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!ticket.ok || typeof (await ticket.json()).ticket !== "string")
    throw new Error("Packaged backend WebSocket authentication failed");
  const browserProbe = await exec(
    "docker",
    [
      "exec",
      "--user",
      "10001:10001",
      "--workdir",
      "/opt/vitre/server",
      name,
      "node",
      "--input-type=module",
      "-e",
      `
      import { chromium } from "playwright-core";
      const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
      try {
        const page = await browser.newPage();
        await page.setContent("<h1>Vitre cloud screenshot</h1>");
        const png = await page.screenshot();
        if (png.subarray(1, 4).toString() !== "PNG" || png.length < 1000)
          throw new Error("Chromium did not produce a PNG");
        console.log(png.length);
      } finally { await browser.close(); }
    `,
    ],
    { timeout: 45000 },
  );
  console.log(
    `Linux image smoke test passed: backend bootstrap, authenticated snapshot, WebSocket ticket, and sandboxed Chromium PNG (${browserProbe.stdout.trim()} bytes).`,
  );
} finally {
  await exec("docker", ["rm", "--force", name]).catch(() => {});
}
