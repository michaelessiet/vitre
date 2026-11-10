// @effect-diagnostics nodeBuiltinImport:off - Builds real worktree layouts on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveDevHome, resolveGitWorktreePath, takeHomeDirArgument } from "./worktree-home.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

type Layout =
  | "worktree"
  | "checkout"
  | "none"
  | "submodule"
  | "unreadable-git-file"
  | "bare-repo-worktree"
  | "custom-common-dir-worktree";

function makeRepo(kind: Layout) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vitre-devhome-"));
  roots.push(root);
  const gitFile = (contents: string) => NodeFS.writeFileSync(NodePath.join(root, ".git"), contents);
  if (kind === "worktree") gitFile("gitdir: /elsewhere/.git/worktrees/x\n");
  if (kind === "bare-repo-worktree") gitFile("gitdir: /srv/myrepo.git/worktrees/x\n");
  if (kind === "custom-common-dir-worktree") gitFile("gitdir: /srv/store/worktrees/x\n");
  if (kind === "submodule") gitFile("gitdir: ../.git/modules/sub\n");
  if (kind === "unreadable-git-file") gitFile("not a gitdir pointer\n");
  if (kind === "checkout") NodeFS.mkdirSync(NodePath.join(root, ".git"));
  const nested = NodePath.join(root, "apps", "server", "src");
  NodeFS.mkdirSync(nested, { recursive: true });
  return { root: NodePath.resolve(root), nested };
}

describe("resolveGitWorktreePath", () => {
  it("finds a worktree root from a nested directory", () => {
    const { root, nested } = makeRepo("worktree");
    expect(resolveGitWorktreePath(nested)).toBe(root);
  });

  it("finds worktrees whose common dir is not named .git", () => {
    for (const kind of ["bare-repo-worktree", "custom-common-dir-worktree"] as const) {
      const { root, nested } = makeRepo(kind);
      expect(resolveGitWorktreePath(nested)).toBe(root);
    }
  });

  it("does not treat a main checkout, submodule, bad pointer, or no repository as a worktree", () => {
    for (const kind of ["checkout", "submodule", "unreadable-git-file", "none"] as const) {
      expect(resolveGitWorktreePath(makeRepo(kind).nested)).toBeUndefined();
    }
  });
});

describe("resolveDevHome", () => {
  it("uses the worktree's .t3 before it exists", () => {
    const { root, nested } = makeRepo("worktree");
    const home = resolveDevHome(nested);
    expect(home).toBe(NodePath.join(root, ".t3"));
    expect(NodeFS.existsSync(home!)).toBe(false);
  });

  it("lets an explicit home win, but not a blank one", () => {
    const { root, nested } = makeRepo("worktree");
    expect(resolveDevHome(nested, "/tmp/explicit")).toBe("/tmp/explicit");
    expect(resolveDevHome(nested, "  ")).toBe(NodePath.join(root, ".t3"));
  });

  it("leaves the caller's default in a main checkout", () => {
    expect(resolveDevHome(makeRepo("checkout").nested)).toBeUndefined();
  });
});

describe("takeHomeDirArgument", () => {
  it("extracts both spellings and keeps other arguments in order", () => {
    expect(takeHomeDirArgument(["--port", "1", "--home-dir", "/a", "x"])).toEqual({
      homeDir: "/a",
      rest: ["--port", "1", "x"],
    });
    expect(takeHomeDirArgument(["--home-dir=/b"])).toEqual({ homeDir: "/b", rest: [] });
    expect(takeHomeDirArgument(["--release"])).toEqual({ homeDir: undefined, rest: ["--release"] });
  });
});
