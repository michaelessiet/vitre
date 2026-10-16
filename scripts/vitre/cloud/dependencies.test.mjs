import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { dependencySetup, dependencyFailure, dependencySetupFingerprint } from "./dependencies.mjs";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

it("selects locked installers without evaluating package metadata and handles plain folders", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-deps-"));
  try {
    expect(await dependencySetup(root)).toBeNull();
    await NodeFSP.writeFile(
      NodePath.join(root, "package.json"),
      JSON.stringify({ dependencies: { foo: "1.0.0" } }),
    );
    expect((await dependencySetup(root)).args[0]).toBe("install");
    await NodeFSP.writeFile(NodePath.join(root, "package-lock.json"), "{}");
    expect((await dependencySetup(root)).args[0]).toBe("ci");
    await NodeFSP.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    expect(await dependencySetup(root)).toMatchObject({
      binary: "pnpm",
      args: ["install", "--prefer-offline", "--frozen-lockfile"],
    });
    await NodeFSP.writeFile(
      NodePath.join(root, "package.json"),
      JSON.stringify({ dependencies: {}, packageManager: "$(touch /tmp/unsafe)" }),
    );
    await expect(dependencySetup(root)).rejects.toThrow("does not support");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("installs optional-only packages and pnpm workspaces with an empty root manifest", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-deps-"));
  try {
    await NodeFSP.writeFile(
      NodePath.join(root, "package.json"),
      JSON.stringify({ optionalDependencies: { foo: "1.0.0" } }),
    );
    expect((await dependencySetup(root)).binary).toBe("npm");
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"private":true}');
    await NodeFSP.writeFile(NodePath.join(root, "pnpm-workspace.yaml"), "packages: [packages/*]\n");
    expect((await dependencySetup(root)).binary).toBe("pnpm");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "invalidates dependency reuse on package, lock, config and workspace changes (git=%s)",
  async (withGit) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-deps-"));
    const write = async (path, text) => {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(root, path), text);
    };
    try {
      if (withGit) await exec("git", ["init"], { cwd: root });
      await write("package.json", '{"private":true,"workspaces":["packages/*"]}');
      await write("packages/app/package.json", '{"dependencies":{"a":"1.0.0"}}');
      if (withGit) await exec("git", ["add", "."], { cwd: root });
      const baseline = await dependencySetupFingerprint(root);
      expect(baseline).toMatch(/^[a-f0-9]{64}$/);
      expect(await dependencySetupFingerprint(root)).toBe(baseline);
      await write("packages/app/index.js", "source change");
      await write("node_modules/installed/package.json", '{"version":"2.0.0"}');
      expect(await dependencySetupFingerprint(root)).toBe(baseline);
      for (const [path, content] of [
        ["packages/app/package.json", '{"dependencies":{"a":"2.0.0"}}'],
        [
          "package.json",
          '{"private":true,"workspaces":["packages/*"],"packageManager":"npm@11.0.0"}',
        ],
        ["package-lock.json", '{"lockfileVersion":3}'],
        [".npmrc", "//registry.test/:_authToken=local-secret"],
      ]) {
        const previous = await dependencySetupFingerprint(root);
        await write(path, content);
        expect(await dependencySetupFingerprint(root)).not.toBe(previous);
      }
      const configured = await dependencySetupFingerprint(root);
      await NodeFSP.rm(NodePath.join(root, "package-lock.json"));
      expect(await dependencySetupFingerprint(root)).not.toBe(configured);
      expect(await dependencySetupFingerprint(root, "npm install")).not.toBe(
        await dependencySetupFingerprint(root, "npm ci"),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

it("turns installer errors into safe actionable notices without leaking registry credentials", () => {
  const message = dependencyFailure(
    "ERR_PNPM_FETCH_404 https://secret@registry.test/private?token=hidden",
  );
  expect(message).toContain("404");
  expect(message).toContain("continue chatting");
  expect(message).not.toContain("secret");
  expect(message).not.toContain("hidden");
});

it("names the installer error class and exit status instead of a generic notice", () => {
  expect(
    dependencyFailure(" ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile", {
      code: 1,
    }),
  ).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
  expect(dependencyFailure("Unsupported engine for foo@1.0.0", { code: 1 })).toContain("Node.js");
  expect(
    dependencyFailure("FetchError: request to https://x@registry.test failed, reason: ETIMEDOUT", {
      code: 1,
    }),
  ).toContain("could not be reached");
  expect(dependencyFailure("", { code: 137, signal: "SIGKILL" })).toContain("SIGKILL");
  expect(dependencyFailure("", { code: 2 })).toContain("exited with code 2");
  expect(dependencyFailure("", { code: 2 })).toContain("setup-output.log");
});
