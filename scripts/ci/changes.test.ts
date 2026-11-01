// @effect-diagnostics nodeBuiltinImport:off - Tests exercise real temporary Git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  affectsCloudRuntime,
  affectsNative,
  affectsRelay,
  changedFiles,
  selectChecks,
  type Git,
} from "./changes.ts";
import { checkResults } from "./result.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vitre-ci-changes-"));
  directories.push(root);
  const git: Git = (args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "CI Test"]);
  git(["config", "user.email", "ci@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  const write = (name: string, content: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, name), content);
  };
  const commit = () => {
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  return { git, root, write, commit };
}

describe("CI change selection", () => {
  it.each([
    "crates/vitre-app/src/main.rs",
    "third_party/gpui-frost/gpui/Cargo.toml",
    "apps/server/src/bin.ts",
    "packages/shared/src/git.ts",
    "apps/vitre/dev.mjs",
    "assets/vitre/icon.png",
    "Cargo.lock",
    "rust-toolchain.toml",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "scripts/vitre/build-dmg.sh",
    "scripts/lib/public-config.ts",
    "patches/effect.patch",
    ".github/actions/setup-tools/action.yml",
    ".github/workflows/build-vitre.yml",
    ".github/workflows/ci.yml",
    "scripts/ci/changes.ts",
  ])("validates native changes to %s", (path) => expect(affectsNative(path)).toBe(true));

  it.each([
    "docs/README.md",
    "README.md",
    "apps/marketing/src/pages/index.astro",
    ".github/labels.json",
  ])("does not request native compilation for %s", (path) =>
    expect(affectsNative(path)).toBe(false),
  );

  it("covers relay dependencies and tooling without deploying for native UI or documentation", () => {
    for (const path of [
      "infra/relay/src/worker.ts",
      "scripts/vitre/cloud/lens.mjs",
      "scripts/vitre/cloud/Dockerfile",
      "scripts/vitre/cloud/toolchain.json",
      "apps/server/src/bootstrap.ts",
      "scripts/vitre/prune-packaged-node-modules.mjs",
      ".dockerignore",
      "packages/shared/src/relay.ts",
      "pnpm-lock.yaml",
      "scripts/ci/relay.ts",
      ".github/workflows/deploy-relay.yml",
    ])
      expect(affectsRelay(path)).toBe(true);
    for (const path of [
      "docs/operations/release.md",
      "crates/vitre-app/src/main.rs",
      "apps/mobile/src/Composer.tsx",
    ])
      expect(affectsRelay(path)).toBe(false);
  });

  it("rebuilds the runtime for packaged dependencies but not relay-only changes", () => {
    for (const path of [
      "apps/server/src/bin.ts",
      "packages/contracts/src/model.ts",
      "pnpm-lock.yaml",
      "scripts/vitre/cloud/worker.mjs",
      "scripts/vitre/prune-packaged-node-modules.mjs",
      ".dockerignore",
    ])
      expect(affectsCloudRuntime(path)).toBe(true);
    for (const path of [
      "infra/relay/src/worker.ts",
      "crates/vitre-app/src/lens.rs",
      "docs/lens.md",
    ])
      expect(affectsCloudRuntime(path)).toBe(false);
  });

  it("selects push checks for deletions and both sides of moves", () => {
    const repo = repository();
    repo.write("apps/server/deleted.ts", "export const removed = 1;\n");
    repo.write("apps/server/moved.ts", "export const moved = 1;\n");
    const before = repo.commit();
    NodeFS.unlinkSync(NodePath.join(repo.root, "apps/server/deleted.ts"));
    NodeFS.renameSync(
      NodePath.join(repo.root, "apps/server/moved.ts"),
      NodePath.join(repo.root, "moved.ts"),
    );
    const head = repo.commit();
    expect(changedFiles(before, head, repo.git)).toEqual([
      "apps/server/deleted.ts",
      "apps/server/moved.ts",
      "moved.ts",
    ]);
    expect(selectChecks({ name: "push", before, head }, repo.git).native).toBe(true);
  });

  it("uses the PR merge base instead of changes made only on main", () => {
    const repo = repository();
    repo.write("README.md", "initial\n");
    repo.commit();
    repo.git(["checkout", "-b", "docs"]);
    repo.write("README.md", "documentation change\n");
    const head = repo.commit();
    repo.git(["checkout", "main"]);
    repo.write("apps/server/new.ts", "export {};\n");
    const base = repo.commit();
    expect(selectChecks({ name: "pull_request", base, head }, repo.git).native).toBe(false);
  });

  it("runs native validation for missing refs, initial pushes, and manual requests", () => {
    const unavailable: Git = () => {
      throw new Error("unknown commit");
    };
    expect(
      selectChecks({ name: "push", before: "missing", head: "missing" }, unavailable).native,
    ).toBe(true);
    expect(
      selectChecks({ name: "push", before: "0".repeat(40), head: "head" }, unavailable).native,
    ).toBe(true);
    expect(selectChecks({ name: "workflow_dispatch", head: "head" }, unavailable).native).toBe(
      true,
    );
  });
});

describe("aggregate validation", () => {
  const passed = {
    changes: { result: "success" },
    check: { result: "success" },
    test: { result: "success" },
    native: { result: "success" },
  };
  it("allows only intentional native skips", () => {
    expect(checkResults(passed, true)).toEqual([]);
    expect(checkResults({ ...passed, native: { result: "skipped" } }, false)).toEqual([]);
    expect(checkResults({ ...passed, native: { result: "skipped" } }, true)).toHaveLength(1);
  });
  it.each(["failure", "cancelled", "skipped"])("fails when required validation is %s", (result) => {
    expect(checkResults({ ...passed, test: { result } }, true)).toHaveLength(1);
  });
  it("fails if a required job is absent", () => expect(checkResults({}, false)).toHaveLength(4));
});
