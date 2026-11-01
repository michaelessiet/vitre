// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Standalone CI deployment through the existing host pull updater.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeTimersPromises from "node:timers/promises";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

export function validateRuntimeConfiguration(env: Record<string, string | undefined>): string[] {
  const errors: string[] = [];
  for (const key of [
    "VITRE_CLOUD_MACHINE_URL",
    "VITRE_CLOUD_MACHINE_TOKEN",
    "VITRE_CLOUD_ALLOWED_USER_ID",
    "VITRE_CLOUD_RUNTIME_BUCKET",
    "VITRE_CLOUD_RUNTIME_URL",
  ]) {
    if (!env[key]?.trim()) errors.push(`${key} is required for runtime deployment`);
  }
  for (const key of ["VITRE_CLOUD_RUNTIME_URL", "VITRE_CLOUD_MACHINE_URL"]) {
    if (!env[key]) continue;
    try {
      runtimeUrl(env[key], "0".repeat(40), "0".repeat(64));
    } catch {
      errors.push(`${key} must be an HTTPS origin without credentials or a path`);
    }
  }
  return errors;
}

export function runtimeKey(revision: string, sha256: string): string {
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("A full source revision and runtime SHA-256 are required");
  return `runtime-${revision}-${sha256}.tar.gz`;
}

export function runtimeUrl(origin: string, revision: string, sha256: string): string {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error("Invalid runtime artifact origin");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return new URL(runtimeKey(revision, sha256), url).href;
}

export function runtimeHealthMatches(body: unknown, revision: string, sha256: string): boolean {
  if (!body || typeof body !== "object") return false;
  const result = body as {
    ready?: unknown;
    protocol?: unknown;
    runtime?: { revision?: unknown; sha256?: unknown };
  };
  return (
    result.ready === true &&
    result.protocol === 1 &&
    result.runtime?.revision === revision &&
    result.runtime.sha256 === sha256
  );
}

export async function waitForRuntime(input: {
  origin: string;
  token: string;
  owner: string;
  revision: string;
  sha256: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
}) {
  const until = Date.now() + (input.timeoutMs ?? 32 * 60_000);
  const url = new URL("/v1/health", input.origin);
  while (true) {
    const response = await (input.fetcher ?? fetch)(url, {
      headers: { authorization: `Bearer ${input.token}`, "x-vitre-owner": input.owner },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (response?.status === 401 || response?.status === 403)
      throw new Error("Runtime verification credentials were rejected");
    if (
      response?.ok &&
      runtimeHealthMatches(await response.json().catch(() => null), input.revision, input.sha256)
    )
      return;
    if (response && !response.bodyUsed) await response.body?.cancel();
    if (Date.now() >= until)
      throw new Error(
        `Runtime ${input.revision} was not installed before the deadline; inspect vitre-runtime-pull.service on the host`,
      );
    await NodeTimersPromises.setTimeout(input.intervalMs ?? 5000);
  }
}

if (import.meta.main) {
  const [revision, sha256, archive] = process.argv.slice(2);
  if (!revision || !sha256 || !archive)
    throw new Error("Usage: cloud-runtime.ts REVISION SHA256 ARCHIVE");
  runtimeKey(revision, sha256);
  const errors = validateRuntimeConfiguration(process.env);
  if (errors.length) throw new Error(errors.join("\n"));
  if (!NodeFS.statSync(archive).isFile()) throw new Error("Runtime archive is required");
  await exec(
    process.execPath,
    [
      NodeURL.fileURLToPath(new URL("../vitre/cloud/publish-runtime-release.mjs", import.meta.url)),
      revision,
      sha256,
      archive,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  console.log(`Published runtime ${revision}; waiting for the existing host to install it.`);
  await waitForRuntime({
    origin: process.env.VITRE_CLOUD_MACHINE_URL!,
    token: process.env.VITRE_CLOUD_MACHINE_TOKEN!,
    owner: process.env.VITRE_CLOUD_ALLOWED_USER_ID!,
    revision,
    sha256,
  });
  console.log(`Verified installed runtime ${revision}.`);
}
