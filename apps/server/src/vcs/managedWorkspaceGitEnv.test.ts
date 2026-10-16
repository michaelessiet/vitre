// @effect-diagnostics nodeBuiltinImport:off - Real Git tests use disposable directories only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterEach, expect, it } from "vite-plus/test";
import {
  managedWorkspaceGitEnv,
  withManagedWorkspaceGitCeiling,
} from "./managedWorkspaceGitEnv.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await NodeFSP.rm(directory, { recursive: true, force: true });
});

it("bounds managed cloud returns while recognizing their own repositories and linked worktrees", async () => {
  const parent = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-git-ceiling-"));
  directories.push(parent);
  const state = NodePath.join(parent, "userdata");
  const managed = NodePath.join(state, "cloud-workspaces");
  const plain = NodePath.join(managed, "returned", "primary");
  const nested = NodePath.join(plain, "nested");
  await NodeFSP.mkdir(nested, { recursive: true });
  const git = async (cwd: string, args: string[], bounded = true) =>
    (
      await exec("git", args, {
        cwd,
        env: {
          ...process.env,
          ...(bounded ? managedWorkspaceGitEnv(cwd, state) : {}),
        },
      })
    ).stdout.trim();
  await git(parent, ["init", "--initial-branch=parent"]);
  await NodeFSP.writeFile(NodePath.join(parent, "README.md"), "parent repository");
  await git(parent, ["add", "README.md"]);
  await git(parent, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  expect(await git(plain, ["branch", "--show-current"], false)).toBe("parent");
  await expect(git(plain, ["rev-parse", "--show-toplevel"])).rejects.toThrow();
  await expect(git(nested, ["rev-parse", "--show-toplevel"])).rejects.toThrow();
  if (NodePath.sep !== "\\") {
    // A shared provider or terminal starts elsewhere and later runs in this root.
    const shellGit = (cwd: string) =>
      exec("sh", ["-c", 'git -C "$1" branch --show-current', "vitre-test", cwd], {
        cwd: parent,
        env: { ...process.env, ...withManagedWorkspaceGitCeiling(state) },
      });
    await expect(shellGit(nested)).rejects.toThrow();
    expect((await shellGit(parent)).stdout.trim()).toBe("parent");
  }

  await git(plain, ["init", "--initial-branch=returned"]);
  expect(await git(nested, ["branch", "--show-current"])).toBe("returned");
  const linked = NodePath.join(managed, "linked");
  await git(parent, ["worktree", "add", "--detach", linked, "HEAD"]);
  expect((await NodeFSP.stat(NodePath.join(linked, ".git"))).isFile()).toBe(true);
  expect(await git(linked, ["rev-parse", "HEAD"])).toBe(await git(parent, ["rev-parse", "HEAD"]));

  const outside = NodePath.join(parent, "ordinary-subdirectory");
  const similarPrefix = NodePath.join(state, "cloud-workspaces-other");
  for (const cwd of [outside, similarPrefix]) {
    await NodeFSP.mkdir(cwd, { recursive: true });
    expect(await git(cwd, ["branch", "--show-current"])).toBe("parent");
  }
});

it("appends the managed ceiling and preserves caller environment outside it", () => {
  const state = NodePath.join(NodeOS.tmpdir(), "vitre-state");
  const env = { GIT_CEILING_DIRECTORIES: "/existing", GIT_INDEX_FILE: "/custom-index" };
  expect(
    managedWorkspaceGitEnv(NodePath.join(state, "cloud-workspaces", "root"), state, env),
  ).toEqual({
    ...env,
    GIT_CEILING_DIRECTORIES: `/existing${NodePath.delimiter}${NodePath.join(state, "cloud-workspaces")}`,
  });
  expect(managedWorkspaceGitEnv(NodePath.join(state, "other"), state, env)).toBe(env);
  expect(managedWorkspaceGitEnv("/repo", undefined, env)).toBe(env);
});
