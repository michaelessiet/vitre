// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Standalone CI deployment through the AWS CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as NodeTimersPromises from "node:timers/promises";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

export function validateRuntimeConfiguration(env: Record<string, string | undefined>): string[] {
  const errors: string[] = [];
  for (const key of [
    "VITRE_CLOUD_AWS_ROLE_ARN",
    "VITRE_CLOUD_AWS_REGION",
    "VITRE_CLOUD_INSTANCE_ID",
    "VITRE_CLOUD_RUNTIME_BUCKET",
    "VITRE_CLOUD_RUNTIME_URL",
  ]) {
    if (!env[key]?.trim()) errors.push(`${key} is required for runtime deployment`);
  }
  if (env.VITRE_CLOUD_INSTANCE_ID && !/^i-[a-f0-9]{8,17}$/.test(env.VITRE_CLOUD_INSTANCE_ID))
    errors.push("VITRE_CLOUD_INSTANCE_ID must identify the existing EC2 host");
  if (env.VITRE_CLOUD_RUNTIME_URL) {
    try {
      runtimeUrl(env.VITRE_CLOUD_RUNTIME_URL, "0".repeat(40), "0".repeat(64));
    } catch {
      errors.push("VITRE_CLOUD_RUNTIME_URL must be an HTTPS artifact origin without credentials");
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
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Invalid runtime artifact origin");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return new URL(runtimeKey(revision, sha256), url).href;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function upgradeCommand(
  url: string,
  sha256: string,
  revision: string,
  installer: string,
  bytes: number,
) {
  runtimeKey(revision, sha256);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error("Runtime archive size is required");
  // Only build artifacts and reviewed installer code go through SSM. Host credentials stay local.
  return [
    "set -eu",
    "exec 9>/run/lock/vitre-cloud-deploy.lock",
    "flock -n 9 || { echo 'Another runtime deployment is running' >&2; exit 1; }",
    "work=$(mktemp -d /opt/vitre-machine/.download-XXXXXX)",
    "trap 'rm -rf -- \"$work\"' EXIT",
    `python3 -c 'import shutil; assert shutil.disk_usage("/opt/vitre-machine").free > ${bytes} + 536870912, "Insufficient runtime download space"'`,
    `curl --fail --silent --show-error --proto '=https' --retry 3 --max-time 900 --max-filesize ${bytes} ${quote(url)} -o "$work/runtime.tar.gz"`,
    `printf '%s' ${quote(Buffer.from(installer).toString("base64"))} | base64 --decode > "$work/upgrade.py"`,
    `python3 "$work/upgrade.py" "$work/runtime.tar.gz" ${quote(sha256)} ${quote(revision)}`,
  ].join("\n");
}

export interface Invocation {
  Status: string;
  StandardOutputContent?: string;
}

export function verifiedInvocation(invocation: Invocation, revision: string, sha256: string) {
  if (invocation.Status !== "Success") throw new Error(`Runtime deployment: ${invocation.Status}`);
  const output = invocation.StandardOutputContent?.trim().split("\n").at(-1);
  const result = output ? JSON.parse(output) : null;
  if (result?.revision !== revision || result.sha256 !== sha256 || result.health !== "ready")
    throw new Error("Runtime deployment did not verify the requested revision");
  return result as {
    revision: string;
    sha256: string;
    health: string;
    warmWorkersPreserved: number;
  };
}

if (import.meta.main) {
  const [revision, sha256, archive] = process.argv.slice(2);
  if (!revision || !sha256 || !archive)
    throw new Error("Usage: cloud-runtime.ts REVISION SHA256 ARCHIVE");
  const bytes = NodeFS.statSync(archive).size;
  const instance = process.env.VITRE_CLOUD_INSTANCE_ID;
  const region = process.env.VITRE_CLOUD_AWS_REGION;
  if (!instance || !/^i-[a-f0-9]{8,17}$/.test(instance) || !region)
    throw new Error("The existing instance ID and AWS region are required");
  const url = runtimeUrl(process.env.VITRE_CLOUD_RUNTIME_URL!, revision, sha256);
  const installer = NodeFS.readFileSync(
    new URL("../vitre/cloud/upgrade-machine.py", import.meta.url),
    "utf8",
  );
  const aws = async (args: string[]) =>
    JSON.parse(
      (
        await exec("aws", [...args, "--region", region, "--output", "json"], {
          maxBuffer: 1024 * 1024,
        })
      ).stdout,
    );
  const sent = await aws([
    "ssm",
    "send-command",
    "--instance-ids",
    instance,
    "--document-name",
    "AWS-RunShellScript",
    "--comment",
    `Vitre cloud runtime ${revision}`,
    "--parameters",
    JSON.stringify({
      commands: [upgradeCommand(url, sha256, revision, installer, bytes)],
      executionTimeout: ["1800"],
    }),
    "--timeout-seconds",
    "120",
  ]);
  const commandId = sent.Command.CommandId as string;
  console.log(`Runtime command: ${commandId}`);
  const until = Date.now() + 32 * 60_000;
  while (true) {
    await NodeTimersPromises.setTimeout(5_000);
    const invocation = (await aws([
      "ssm",
      "get-command-invocation",
      "--command-id",
      commandId,
      "--instance-id",
      instance,
    ]).catch((error: Error) => {
      if (error.message.includes("InvocationDoesNotExist")) return { Status: "Pending" };
      throw error;
    })) as Invocation;
    if (!["Pending", "InProgress", "Delayed"].includes(invocation.Status)) {
      const result = verifiedInvocation(invocation, revision, sha256);
      console.log(
        `Verified runtime ${result.revision}; preserved ${result.warmWorkersPreserved} running workers.`,
      );
      break;
    }
    if (Date.now() > until)
      throw new Error(`Runtime command ${commandId} timed out; inspect it before retrying`);
  }
}
