import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
import {
  captureWorkspace,
  restoreWorkspace,
  planWorkspaceReturn,
  prepareWorkspaceReturn,
  digest,
} from "./workspace.mjs";
const temps = [];
afterEach(async () => {
  for (const path of temps.splice(0))
    await NodeFSP.rm(path, { recursive: true, force: true, maxRetries: 3 });
});
async function fixture() {
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-workspace-test-"));
  temps.push(path);
  const chunks = new Map();
  const capture = () =>
    captureWorkspace([{ id: "root", path }], async (id, bytes) => chunks.set(id, bytes));
  return { path, chunks, capture };
}
describe("portable workspaces", () => {
  it("preserves Git history, index and tracked fixtures across capture and branching with a different owner", async () => {
    const f = await fixture();
    const git = async (...args) => (await exec("git", args, { cwd: f.path })).stdout.trim();
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.com");
    await NodeFSP.mkdir(NodePath.join(f.path, "fixtures/node_modules"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(f.path, "fixtures/node_modules/source.js"), "fixture\n");
    await NodeFSP.writeFile(NodePath.join(f.path, "tracked.txt"), "base\n");
    await git("add", "-f", ".");
    await git("commit", "-m", "Unpublished fixture");
    const head = await git("rev-parse", "HEAD");
    await NodeFSP.writeFile(NodePath.join(f.path, "tracked.txt"), "staged\n");
    await git("add", "tracked.txt");
    await NodeFSP.writeFile(NodePath.join(f.path, "tracked.txt"), "unstaged\n");
    const projectScript = NodePath.join(f.path, ".git", "project-script");
    await NodeFSP.writeFile(projectScript, '#!/bin/sh\nprintf called > "$0.invoked"\n', {
      mode: 0o755,
    });
    await git("config", "core.fsmonitor", projectScript);
    await git("config", "diff.external", projectScript);
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
    };
    await expect(
      exec("git", ["rev-parse", "--show-toplevel"], { cwd: f.path, env }),
    ).rejects.toThrow("dubious ownership");
    // Exercise Git's real ownership check in a child without changing the test runner environment.
    const script = `
      import { captureWorkspace } from ${JSON.stringify(new URL("./workspace.mjs", import.meta.url).href)};
      const chunks = new Map();
      const manifest = await captureWorkspace([{ id: "root", path: process.argv[1] }],
        async (hash, bytes) => chunks.set(hash, Buffer.from(bytes).toString("base64")));
      process.stdout.write(JSON.stringify({ manifest, chunks: [...chunks] }));
    `;
    const result = JSON.parse(
      (await exec(process.execPath, ["--input-type=module", "--eval", script, f.path], { env }))
        .stdout,
    );
    expect(result.manifest.roots[0].git.head).toBe(head);
    expect(await NodeFSP.stat(`${projectScript}.invoked`).catch(() => null)).toBeNull();
    expect(result.manifest.entries.map((entry) => entry.path)).toContain(
      "fixtures/node_modules/source.js",
    );
    const chunks = new Map(
      result.chunks.map(([hash, bytes]) => [hash, Buffer.from(bytes, "base64")]),
    );
    const out = await fixture();
    await restoreWorkspace(result.manifest, NodePath.join(out.path, "restored"), async (hash) =>
      chunks.get(hash),
    );
    const copy = NodePath.join(out.path, "restored/root");
    const hook = NodePath.join(copy, ".git/hooks/post-checkout");
    await NodeFSP.writeFile(hook, '#!/bin/sh\nprintf called > "$0.invoked"\n', { mode: 0o755 });
    await expect(
      exec("git", ["checkout", "-b", "vitre/new-task"], { cwd: copy, env }),
    ).rejects.toThrow("dubious ownership");
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { createWorkspaceBranch } from ${JSON.stringify(new URL("./workspace.mjs", import.meta.url).href)};
      await createWorkspaceBranch(process.argv[1], "vitre/new-task");
    `,
        copy,
      ],
      { env },
    );
    expect((await exec("git", ["branch", "--show-current"], { cwd: copy })).stdout.trim()).toBe(
      "vitre/new-task",
    );
    expect(await git("branch", "--show-current")).toBe("main");
    expect(await NodeFSP.stat(`${hook}.invoked`).catch(() => null)).toBeNull();
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: copy })).stdout.trim()).toBe(head);
    expect((await exec("git", ["show", ":tracked.txt"], { cwd: copy })).stdout).toBe("staged\n");
    expect(await NodeFSP.readFile(NodePath.join(copy, "tracked.txt"), "utf8")).toBe("unstaged\n");
    expect(
      await NodeFSP.readFile(NodePath.join(copy, "fixtures/node_modules/source.js"), "utf8"),
    ).toBe("fixture\n");
  });

  it("refuses to silently capture unreadable Git metadata as a plain directory", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(NodePath.join(f.path, "source.txt"), "source");
    await NodeFSP.writeFile(NodePath.join(f.path, ".git"), "gitdir: missing-repository\n");
    await expect(f.capture()).rejects.toThrow("Workspace Git metadata could not be read");
  });

  it("requires a readable commit before capturing a Git repository", async () => {
    const f = await fixture();
    await exec("git", ["init", "--initial-branch=main"], { cwd: f.path });
    await NodeFSP.writeFile(NodePath.join(f.path, "source.txt"), "source");
    await exec("git", ["add", "."], { cwd: f.path });
    await expect(f.capture()).rejects.toThrow("Workspace Git history could not be read");
  });

  it("prefetches remote chunks with bounded concurrency and verifies before restoration", async () => {
    const source = await fixture();
    for (let i = 0; i < 12; i++)
      await NodeFSP.writeFile(NodePath.join(source.path, String(i)), Buffer.alloc(1024 * 1024, i));
    const manifest = await source.capture();
    const destination = await fixture();
    let active = 0,
      peak = 0,
      reads = 0;
    await restoreWorkspace(
      manifest,
      NodePath.join(destination.path, "restored"),
      async (hash) => {
        reads++;
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return source.chunks.get(hash);
      },
      { prefetch: true },
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(reads).toBe(source.chunks.size);
    expect(await NodeFSP.readFile(NodePath.join(destination.path, "restored/root/7"))).toEqual(
      Buffer.alloc(1024 * 1024, 7),
    );
    await expect(
      restoreWorkspace(
        manifest,
        NodePath.join(destination.path, "bad"),
        async () => Buffer.from("corrupt"),
        { prefetch: true },
      ),
    ).rejects.toThrow("verification");
    await expect(NodeFSP.stat(NodePath.join(destination.path, "bad"))).rejects.toThrow();
  });

  it("packs many small binary files and downloads each shared chunk only once", async () => {
    const f = await fixture();
    const bytes = Buffer.from([0, 255, 1, 128]);
    for (let i = 0; i < 100; i++)
      await NodeFSP.writeFile(NodePath.join(f.path, `file-${i}`), bytes);
    await NodeFSP.chmod(NodePath.join(f.path, "file-0"), 0o755);
    const manifest = await f.capture();
    expect(manifest.version).toBe(2);
    expect(f.chunks.size).toBe(1);
    const out = await fixture();
    let reads = 0;
    await restoreWorkspace(manifest, NodePath.join(out.path, "ok"), async (hash) => {
      reads++;
      return f.chunks.get(hash);
    });
    expect(reads).toBe(1);
    expect(await NodeFSP.readFile(NodePath.join(out.path, "ok/root/file-99"))).toEqual(bytes);
    expect((await NodeFSP.stat(NodePath.join(out.path, "ok/root/file-0"))).mode & 0o111).not.toBe(
      0,
    );
    const invalid = structuredClone(manifest);
    invalid.entries[0].chunkOffset = 4194304;
    await expect(
      restoreWorkspace(invalid, NodePath.join(out.path, "bad"), async (hash) => f.chunks.get(hash)),
    ).rejects.toThrow("Invalid file chunks");
    const corrupt = new Map(f.chunks);
    const hash = manifest.entries[0].chunks[0];
    corrupt.set(hash, Buffer.from("corrupt"));
    await expect(
      restoreWorkspace(manifest, NodePath.join(out.path, "corrupt"), async (id) => corrupt.get(id)),
    ).rejects.toThrow("verification");
  });
  it("transfers project agent instructions and rejects inline credentials in config history", async () => {
    const f = await fixture();
    const git = async (...args) => (await exec("git", args, { cwd: f.path })).stdout.trim();
    await git("init");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.com");
    await NodeFSP.mkdir(NodePath.join(f.path, ".codex"));
    await NodeFSP.mkdir(NodePath.join(f.path, ".claude", "skills"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(f.path, ".claude", "skills", "SKILL.md"),
      "Project instructions",
    );
    const config = NodePath.join(f.path, ".codex", "config.toml");
    await NodeFSP.writeFile(
      config,
      '[mcp_servers.local]\ncommand = "node"\nargs = ["server.mjs"]\n',
    );
    await git("add", ".");
    await git("commit", "-m", "Project tooling");
    const snapshot = await f.capture();
    expect(snapshot.entries.map((entry) => entry.path)).toContain(".claude/skills/SKILL.md");
    expect(snapshot.entries.map((entry) => entry.path)).toContain(".codex/config.toml");
    await NodeFSP.writeFile(config, '[mcp_servers.local.env]\n"API_KEY" = "private-test-value"\n');
    await expect(f.capture()).rejects.toThrow("contains credentials");
    await git("add", ".");
    await git("commit", "-m", "Unsafe config");
    await NodeFSP.writeFile(config, '[mcp_servers.local]\ncommand = "node"\n');
    await git("add", ".");
    await git("commit", "-m", "Remove inline credential");
    await expect(f.capture()).rejects.toThrow("contains credentials");
  });
  it("prunes dependency folders before enumerating portable paths", async () => {
    const f = await fixture();
    await NodeFSP.mkdir(NodePath.join(f.path, "node_modules", "dependency"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(f.path, "node_modules", "dependency", "ignored"),
      "dependency",
    );
    await NodeFSP.mkdir(NodePath.join(f.path, ".claude", "worktrees", "nested"), {
      recursive: true,
    });
    await exec("git", ["init"], { cwd: NodePath.join(f.path, ".claude", "worktrees", "nested") });
    await NodeFSP.writeFile(NodePath.join(f.path, "source.txt"), "source");
    expect((await f.capture()).entries.map((entry) => entry.path)).toEqual(["source.txt"]);
  });

  it("keeps tracked fixtures under dependency directory names while pruning installed packages", async () => {
    const f = await fixture();
    const git = async (...args) => (await exec("git", args, { cwd: f.path })).stdout.trim();
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.com");
    const fixtureDir = NodePath.join(f.path, "tests", "fixtures", "node_modules", "pkg");
    await NodeFSP.mkdir(fixtureDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(fixtureDir, "index.js"), "fixture");
    await NodeFSP.writeFile(NodePath.join(fixtureDir, "skipped.js"), "vitre-ignored fixture");
    await NodeFSP.writeFile(NodePath.join(f.path, ".vitreignore"), "skipped.js\n");
    await NodeFSP.writeFile(NodePath.join(f.path, "source.txt"), "source");
    await git("add", "-f", ".");
    await git("commit", "-m", "fixtures");
    await NodeFSP.mkdir(NodePath.join(f.path, "node_modules", "dependency"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(f.path, "node_modules", "dependency", "x.js"), "dep");
    await NodeFSP.writeFile(NodePath.join(fixtureDir, "untracked.js"), "not committed");
    const manifest = await f.capture();
    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual([
      ".vitreignore",
      "source.txt",
      "tests/fixtures/node_modules/pkg/index.js",
    ]);
    const out = await fixture();
    await restoreWorkspace(manifest, NodePath.join(out.path, "restored"), async (id) =>
      f.chunks.get(id),
    );
    const restoredRoot = NodePath.join(out.path, "restored/root");
    expect(
      await NodeFSP.readFile(
        NodePath.join(restoredRoot, "tests/fixtures/node_modules/pkg/index.js"),
        "utf8",
      ),
    ).toBe("fixture");
    // The restored checkout must not report the tracked fixture as deleted.
    expect(
      (await exec("git", ["status", "--porcelain"], { cwd: restoredRoot })).stdout,
    ).not.toContain("pkg/index.js");
  });

  it("round trips a plain folder with binary files, executable bits, symlinks and ignore rules", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(NodePath.join(f.path, "binary"), Buffer.from([0, 255, 3]));
    await NodeFSP.writeFile(NodePath.join(f.path, "run"), "#!/bin/sh\n", { mode: 0o755 });
    await NodeFSP.symlink("binary", NodePath.join(f.path, "link"));
    await NodeFSP.writeFile(NodePath.join(f.path, ".gitignore"), "ignored\n");
    await NodeFSP.writeFile(NodePath.join(f.path, ".vitreignore"), "private\n");
    for (const name of ["ignored", "private", ".env", ".npmrc", ".netrc"])
      await NodeFSP.writeFile(NodePath.join(f.path, name), "secret");
    const manifest = await f.capture();
    expect(manifest.entries.map((e) => e.path)).toEqual([
      ".gitignore",
      ".vitreignore",
      "binary",
      "link",
      "run",
    ]);
    const out = await fixture();
    await restoreWorkspace(manifest, NodePath.join(out.path, "restored"), async (id) =>
      f.chunks.get(id),
    );
    expect(await NodeFSP.readFile(NodePath.join(out.path, "restored/root/binary"))).toEqual(
      Buffer.from([0, 255, 3]),
    );
    expect(
      (await NodeFSP.stat(NodePath.join(out.path, "restored/root/run"))).mode & 0o111,
    ).toBeTruthy();
    expect(await NodeFSP.readlink(NodePath.join(out.path, "restored/root/link"))).toBe("binary");
  });
  it("preserves unpublished commits, staged and unstaged edits without copying Git configuration", async () => {
    const f = await fixture();
    const git = async (...args) => (await exec("git", args, { cwd: f.path })).stdout.trim();
    await git("init", "--initial-branch=feature");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.com");
    await NodeFSP.writeFile(NodePath.join(f.path, "file"), "committed");
    await git("add", ".");
    await git("commit", "-m", "unpublished");
    const head = await git("rev-parse", "HEAD");
    await git("config", "http.extraheader", "secret");
    await NodeFSP.writeFile(NodePath.join(f.path, "file"), "staged");
    await git("add", "file");
    await NodeFSP.writeFile(NodePath.join(f.path, "file"), "unstaged");
    const status = await git("status", "--porcelain");
    const manifest = await f.capture();
    expect(await git("status", "--porcelain")).toBe(status);
    const out = await fixture();
    await restoreWorkspace(manifest, NodePath.join(out.path, "restored"), async (id) =>
      f.chunks.get(id),
    );
    const restored = async (...args) =>
      (await exec("git", args, { cwd: NodePath.join(out.path, "restored/root") })).stdout.trim();
    expect(await restored("rev-parse", "HEAD")).toBe(head);
    expect(await restored("symbolic-ref", "--short", "HEAD")).toBe("feature");
    expect(await restored("show", ":file")).toBe("staged");
    expect(await NodeFSP.readFile(NodePath.join(out.path, "restored/root/file"), "utf8")).toBe(
      "unstaged",
    );
    expect(await restored("status", "--porcelain")).toBe(status);
    expect(
      await NodeFSP.readFile(NodePath.join(out.path, "restored/root/.git/config"), "utf8"),
    ).not.toContain("secret");
  });
  it("preserves staged deletions and rejects credentials in historical commits", async () => {
    const f = await fixture();
    const git = async (...args) => (await exec("git", args, { cwd: f.path })).stdout.trim();
    await git("init");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.com");
    await NodeFSP.writeFile(NodePath.join(f.path, "removed"), "original");
    await git("add", ".");
    await git("commit", "-m", "base");
    await git("rm", "removed");
    const manifest = await f.capture();
    const out = await fixture();
    await restoreWorkspace(manifest, NodePath.join(out.path, "restored"), async (id) =>
      f.chunks.get(id),
    );
    expect(
      (
        await exec("git", ["status", "--porcelain"], {
          cwd: NodePath.join(out.path, "restored/root"),
        })
      ).stdout,
    ).toBe("D  removed\n");
    await NodeFSP.writeFile(NodePath.join(f.path, ".env"), "SECRET=value");
    await git("add", ".env");
    await git("commit", "-m", "credential");
    await git("rm", ".env");
    await git("commit", "-m", "remove credential");
    await expect(f.capture()).rejects.toThrow("Git history contains credential files");
  });
  it("rejects changes to files captured earlier in the upload", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(NodePath.join(f.path, "a"), "first");
    await NodeFSP.writeFile(NodePath.join(f.path, "b"), "second");
    await expect(
      captureWorkspace([{ id: "root", path: f.path }], async (_id, bytes) => {
        if (Buffer.from(bytes).toString().includes("second"))
          await NodeFSP.writeFile(NodePath.join(f.path, "a"), "changed");
      }),
    ).rejects.toThrow("Workspace changed during transfer");
  });
  it("rejects files added after snapshot discovery", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(NodePath.join(f.path, "a"), "source");
    await expect(
      captureWorkspace([{ id: "root", path: f.path }], async () => {
        await NodeFSP.writeFile(NodePath.join(f.path, "new-file"), "new");
      }),
    ).rejects.toThrow("Workspace changed during transfer");
  });
  it("rejects escaping symlinks, traversal and corrupted chunks", async () => {
    const f = await fixture();
    await NodeFSP.symlink("../escape", NodePath.join(f.path, "link"));
    await expect(f.capture()).rejects.toThrow("escapes");
    await NodeFSP.unlink(NodePath.join(f.path, "link"));
    await NodeFSP.writeFile(NodePath.join(f.path, "file"), "safe");
    const manifest = await f.capture();
    const out = await fixture();
    await expect(
      restoreWorkspace(manifest, NodePath.join(out.path, "bad"), async () => Buffer.from("evil")),
    ).rejects.toThrow("verification");
    const malicious = structuredClone(manifest);
    malicious.entries[0].path = "../escape";
    await expect(
      restoreWorkspace(malicious, NodePath.join(out.path, "escape"), async () => null),
    ).rejects.toThrow("path");
  });
  it("detects conflicting edits and delete/edit races without overwriting local changes", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(NodePath.join(f.path, "file"), "base");
    const base = await f.capture();
    await NodeFSP.writeFile(NodePath.join(f.path, "file"), "local");
    const local = await f.capture();
    await NodeFSP.writeFile(NodePath.join(f.path, "file"), "remote");
    const remote = await f.capture();
    expect(planWorkspaceReturn(base, local, remote).conflicts).toEqual(["root/file"]);
    expect(planWorkspaceReturn(base, base, remote).changes).toHaveLength(1);
    expect(planWorkspaceReturn(base, local, local).changes).toHaveLength(0);
    expect(planWorkspaceReturn(base, local, { ...remote, entries: [] }).conflicts).toEqual([
      "root/file",
    ]);
    expect(planWorkspaceReturn(base, base, { ...remote, entries: [] }).changes[0].entry).toBeNull();
  });
  it("prepares a clean return in a managed directory and preserves concurrent local edits", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(NodePath.join(f.path, "a"), "base");
    await NodeFSP.writeFile(NodePath.join(f.path, "b"), "base");
    const baseline = await f.capture();
    await NodeFSP.writeFile(NodePath.join(f.path, "a"), "local");
    const local = await f.capture();
    await NodeFSP.writeFile(NodePath.join(f.path, "a"), "base");
    await NodeFSP.writeFile(NodePath.join(f.path, "b"), "cloud");
    const remote = await f.capture();
    const out = await fixture();
    const destination = NodePath.join(out.path, "managed");
    const result = await prepareWorkspaceReturn({
      baseline,
      local,
      remote,
      destination,
      getChunk: async (hash) => f.chunks.get(hash),
    });
    expect(result.conflicts).toEqual([]);
    expect(await NodeFSP.readFile(NodePath.join(destination, "root/a"), "utf8")).toBe("local");
    expect(await NodeFSP.readFile(NodePath.join(destination, "root/b"), "utf8")).toBe("cloud");
    await expect(
      prepareWorkspaceReturn({
        baseline,
        local,
        remote,
        destination,
        getChunk: async (hash) => f.chunks.get(hash),
      }),
    ).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(destination, "root/a"), "utf8")).toBe("local");
    const conflicted = await prepareWorkspaceReturn({
      baseline,
      local,
      remote: local,
      destination: NodePath.join(out.path, "same"),
      getChunk: async (hash) => f.chunks.get(hash),
    });
    expect(conflicted.conflicts).toEqual([]);
  });
  it("does not restore a symlink ancestor followed by a nested file", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(NodePath.join(f.path, "file"), "x");
    const manifest = await f.capture();
    manifest.entries.push({
      rootId: "root",
      path: "nested",
      kind: "symlink",
      target: ".",
      sha256: digest("."),
      chunks: [],
      executable: false,
      sizeBytes: 1,
    });
    manifest.entries[0].path = "nested/file";
    await expect(
      restoreWorkspace(manifest, NodePath.join(f.path, "out"), async () => null),
    ).rejects.toThrow("hierarchy");
  });
});

it("does not upload parent Git history when selecting a plain subfolder", async () => {
  const f = await fixture();
  await exec("git", ["init"], { cwd: f.path });
  await NodeFSP.writeFile(NodePath.join(f.path, "parent.txt"), "outside selected workspace");
  await exec("git", ["add", "."], { cwd: f.path });
  await exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "parent"],
    { cwd: f.path },
  );
  const selected = NodePath.join(f.path, "folder");
  await NodeFSP.mkdir(selected);
  await NodeFSP.writeFile(NodePath.join(selected, "child.txt"), "selected");
  const manifest = await captureWorkspace([{ id: "root", path: selected }], async () => {});
  expect(manifest.roots[0].git).toBeUndefined();
  expect(manifest.entries.map((entry) => entry.path)).toEqual(["child.txt"]);
});

it("restores commit identity without copying credential or command configuration", async () => {
  const f = await fixture();
  const git = async (...args) => (await exec("git", args, { cwd: f.path })).stdout.trim();
  await git("init");
  await git("config", "user.name", "Workspace Author");
  await git("config", "user.email", "author@example.com");
  await git("config", "credential.helper", "do-not-transfer");
  await git("commit", "--allow-empty", "-m", "baseline");
  const snapshot = await f.capture();
  expect(snapshot.roots[0].git.commitIdentity).toEqual({
    name: "Workspace Author",
    email: "author@example.com",
  });
  const out = await fixture();
  await restoreWorkspace(snapshot, NodePath.join(out.path, "restored"), async (id) =>
    f.chunks.get(id),
  );
  const cwd = NodePath.join(out.path, "restored", snapshot.roots[0].id);
  expect((await exec("git", ["config", "--local", "user.name"], { cwd })).stdout.trim()).toBe(
    "Workspace Author",
  );
  expect((await exec("git", ["config", "--local", "user.email"], { cwd })).stdout.trim()).toBe(
    "author@example.com",
  );
  await expect(exec("git", ["config", "--local", "credential.helper"], { cwd })).rejects.toThrow();
  snapshot.roots[0].git.commitIdentity.name = "bad\nidentity";
  await expect(
    restoreWorkspace(snapshot, NodePath.join(out.path, "bad"), async (id) => f.chunks.get(id)),
  ).rejects.toThrow("Invalid Git commit identity");
});
