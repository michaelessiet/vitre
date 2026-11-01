// @effect-diagnostics nodeBuiltinImport:off - CI entrypoints run directly in Node without workspace dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const sharedFiles = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vite.config.ts",
  "tsconfig.base.json",
  ".npmrc",
  ".node-version",
]);
const sharedPrefixes = [".github/actions/", "scripts/ci/", "scripts/lib/", "patches/"];
const nativeFiles = new Set(["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "deny.toml"]);
const nativePrefixes = [
  "crates/",
  "third_party/",
  ".cargo/",
  "apps/vitre/",
  "apps/server/",
  "packages/",
  "assets/vitre/",
  "scripts/vitre/",
];
const nativeWorkflows = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/vitre-ci.yml",
  ".github/workflows/build-vitre.yml",
]);

export function affectsNative(path: string): boolean {
  return (
    sharedFiles.has(path) ||
    nativeFiles.has(path) ||
    nativeWorkflows.has(path) ||
    [...sharedPrefixes, ...nativePrefixes].some((prefix) => path.startsWith(prefix))
  );
}

export function affectsRelay(path: string): boolean {
  return (
    affectsCloudRuntime(path) ||
    path.startsWith("infra/relay/") ||
    path === ".github/workflows/ci.yml" ||
    path === ".github/workflows/deploy-relay.yml"
  );
}

/** Inputs copied into the Linux runtime or used to build and install it. */
export function affectsCloudRuntime(path: string): boolean {
  return (
    sharedFiles.has(path) ||
    sharedPrefixes.some((prefix) => path.startsWith(prefix)) ||
    ["apps/server/", "packages/", "scripts/vitre/cloud/", "oxlint-plugin-t3code/"].some((prefix) =>
      path.startsWith(prefix),
    ) ||
    path === "scripts/vitre/prune-packaged-node-modules.mjs" ||
    path === "scripts/package.json" ||
    path === ".dockerignore" ||
    path === ".github/workflows/deploy-relay.yml"
  );
}

export type Git = (args: string[]) => string;
export const git: Git = (args) =>
  NodeChildProcess.execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

export function changedFiles(base: string, head: string, runGit: Git = git): string[] {
  // --no-renames includes both paths of a moved file; -z preserves unusual filenames.
  return runGit(["diff", "--name-only", "--no-renames", "-z", base, head, "--"])
    .split("\0")
    .filter(Boolean);
}

interface ChangeEvent {
  name: string;
  before?: string;
  base?: string;
  head: string;
}

export function selectChecks(event: ChangeEvent, runGit: Git = git) {
  if (event.name === "workflow_dispatch") return { native: true, reason: "Manual validation" };
  try {
    let base: string;
    if (event.name === "pull_request" && event.base) {
      base = runGit(["merge-base", event.base, event.head]).trim();
    } else if (event.name === "push" && event.before && !/^0+$/.test(event.before)) {
      base = event.before;
    } else {
      throw new Error("No comparison commit");
    }
    const native = changedFiles(base, event.head, runGit).some(affectsNative);
    return { native, reason: native ? "Native inputs changed" : "Native inputs unchanged" };
  } catch {
    return { native: true, reason: "Comparison unavailable; running native validation" };
  }
}

if (import.meta.main) {
  const event = JSON.parse(NodeFS.readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
  const result = selectChecks({
    name: process.env.GITHUB_EVENT_NAME!,
    before: event.before,
    base: event.pull_request?.base.sha,
    head: event.pull_request?.head.sha ?? process.env.GITHUB_SHA!,
  });
  NodeFS.appendFileSync(process.env.GITHUB_OUTPUT!, `native=${result.native}\n`);
  NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY!, `${result.reason}.\n`);
}
