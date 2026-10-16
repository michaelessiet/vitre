import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { excludedDirectories } from "./transfer-policy.mjs";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

/** Lockfiles select the installer; no project strings are evaluated as shell code. */
export async function dependencySetup(directory) {
  let manifest;
  try {
    manifest = JSON.parse(await NodeFSP.readFile(NodePath.join(directory, "package.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Could not read package.json for cloud dependency setup", { cause: error });
  }
  const names = new Set(await NodeFSP.readdir(directory));
  if (
    !manifest.dependencies &&
    !manifest.devDependencies &&
    !manifest.optionalDependencies &&
    !manifest.workspaces &&
    !names.has("pnpm-workspace.yaml")
  )
    return null;
  const declared =
    typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : null;
  const manager =
    declared ??
    (names.has("pnpm-lock.yaml") || names.has("pnpm-workspace.yaml")
      ? "pnpm"
      : names.has("yarn.lock")
        ? "yarn"
        : names.has("bun.lock") || names.has("bun.lockb")
          ? "bun"
          : "npm");
  if (manager === "pnpm")
    return {
      binary: "pnpm",
      // Use install flags shared by supported pnpm versions. pnpm 11 rejects
      // legacy fetch-retries/fetch-timeout CLI options before installing anything.
      args: [
        "install",
        "--prefer-offline",
        ...(names.has("pnpm-lock.yaml") ? ["--frozen-lockfile"] : []),
      ],
      label: "Installing dependencies with pnpm",
    };
  if (manager === "npm")
    return {
      binary: "npm",
      args: [
        names.has("package-lock.json") || names.has("npm-shrinkwrap.json") ? "ci" : "install",
        "--prefer-offline",
        "--no-audit",
        "--no-fund",
      ],
      label: "Installing dependencies with npm",
    };
  if (manager === "yarn")
    return { binary: "yarn", args: ["install"], label: "Installing dependencies with Yarn" };
  throw new Error(
    `Automatic dependency setup does not support ${manager}; configure a repository setup command`,
  );
}

const setupInputs = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
];

/** Reuse a successful installation only while its dependency inputs match.
 * Configuration contents stay local; callers persist only the digest. */
export async function dependencySetupFingerprint(directory, setupCommand = "") {
  const installation = setupCommand.trim()
    ? { binary: "/bin/sh", args: ["-c", setupCommand] }
    : await dependencySetup(directory);
  const paths = new Set(setupInputs);
  let manifests;
  try {
    manifests = (
      await exec(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          `safe.directory=${NodePath.resolve(directory)}`,
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          ":(glob)**/package.json",
          ...excludedDirectories.map((name) => `:(glob,exclude)**/${name}/**`),
        ],
        { cwd: directory, maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout.split("\0");
  } catch {
    // Plain local folders also support workspaces. Enumerate directories only,
    // pruning dependencies/caches and never following symlinks.
    manifests = [];
    const visit = async (relative = "") => {
      for (const entry of await NodeFSP.readdir(NodePath.join(directory, relative), {
        withFileTypes: true,
      })) {
        const path = NodePath.join(relative, entry.name);
        if (entry.isDirectory() && !excludedDirectories.includes(entry.name)) await visit(path);
        else if (entry.isFile() && entry.name === "package.json") manifests.push(path);
      }
    };
    await visit();
  }
  for (const path of manifests)
    if (path && !NodePath.isAbsolute(path) && !path.split(/[\\/]/).includes("..")) paths.add(path);
  const hash = NodeCrypto.createHash("sha256");
  hash.update(JSON.stringify([1, installation?.binary, installation?.args, setupCommand]));
  for (const path of [...paths].sort()) {
    const content = await NodeFSP.readFile(NodePath.join(directory, path)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    hash.update(JSON.stringify([path, content?.toString("base64") ?? null]));
  }
  return hash.digest("hex");
}

/** Where the worker keeps the complete installer output. The agent's home is
 * bind-mounted per task, so the log survives stops without entering the
 * repository or its checkpoints. */
export const SETUP_LOG_PATH = "/home/vitre/setup-output.log";

// Only these error classes are named in the notice. Raw installer output can
// carry registry URLs with embedded credentials and never reaches the task.
const knownFailures = [
  [
    /ERR_PNPM_OUTDATED_LOCKFILE|lockfile.{0,80}(not up to date|out of date|needs updates)|npm ci.{0,120}package-lock\.json.{0,120}(sync|out of sync)/is,
    "the lockfile is out of date with package.json (ERR_PNPM_OUTDATED_LOCKFILE). Update it locally and move the conversation again.",
  ],
  [
    /ERR_PNPM_FETCH_404|E404|ERR_PNPM_NO_MATCHING_VERSION|ETARGET|No matching version/i,
    "a locked package could not be found in the registry (404).",
  ],
  [
    /E401|E403|ERR_PNPM_FETCH_40[13]|ERR_PNPM_REGISTRY_AUTH|Unable to authenticate/i,
    "a package registry requires access credentials that are not available in the cloud workspace.",
  ],
  [
    /ERR_PNPM_UNSUPPORTED_ENGINE|EBADENGINE|Unsupported engine|engine ".{0,40}" is incompatible/i,
    "the project requires a different Node.js or package-manager version than the cloud workspace provides (ERR_PNPM_UNSUPPORTED_ENGINE).",
  ],
  [
    /ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_ERROR|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch timeout|network request.{0,40}failed/i,
    "the package registry could not be reached from the cloud workspace (network error).",
  ],
  [/ENOSPC|no space left on device/i, "the cloud workspace ran out of disk space."],
  [
    /ERR_PNPM_PREPARE_PKG_FAILURE|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL|ELIFECYCLE|postinstall|preinstall|prepare script/i,
    "a package install script failed (ELIFECYCLE).",
  ],
];

export function dependencyFailure(output = "", { code, signal } = {}) {
  const known = knownFailures.find(([pattern]) => pattern.test(output))?.[1];
  const detail =
    known ??
    (signal
      ? `installation was stopped before it finished (${signal}).`
      : `installation exited with code ${typeof code === "number" ? code : "unknown"}.`);
  return `Dependency setup needs attention: ${detail} You can continue chatting; ask the agent to read ${SETUP_LOG_PATH} and repair the installation.`;
}
