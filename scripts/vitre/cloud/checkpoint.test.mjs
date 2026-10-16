import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import {
  backupDatabase,
  createCheckpoint,
  isCredentialPath,
  restoreCheckpoint,
} from "./checkpoint.mjs";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-cloud-checkpoint-"));
  roots.push(root);
  const repo = NodePath.join(root, "repo");
  await NodeFSP.mkdir(repo);
  const git = async (...args) => (await exec("git", args, { cwd: repo })).stdout.trim();
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await NodeFSP.writeFile(NodePath.join(repo, "tracked.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  const baseSha = await git("rev-parse", "HEAD");
  const database = NodePath.join(root, "live.sqlite");
  const db = new NodeSqlite.DatabaseSync(database);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES ('conversation'); CREATE TABLE auth_sessions(token TEXT); INSERT INTO auth_sessions VALUES ('must-not-export'); CREATE TABLE auth_pairing_links(credential TEXT); INSERT INTO auth_pairing_links VALUES ('pairing-secret');",
  );
  return { root, repo, git, baseSha, database, db };
}

describe("cloud checkpoints", () => {
  it("checkpoints fixtures added after the pinned base without changing their staged state", async () => {
    const f = await fixture();
    try {
      const fixtureDirectory = "tests/fixtures/node_modules/pkg";
      await NodeFSP.mkdir(NodePath.join(f.repo, fixtureDirectory), { recursive: true });
      const committed = `${fixtureDirectory}/committed.js`;
      const staged = `${fixtureDirectory}/[staged].js`;
      const removed = `${fixtureDirectory}/removed.js`;
      await NodeFSP.writeFile(NodePath.join(f.repo, committed), "unpublished fixture\n");
      await f.git("add", "--force", "--", committed);
      await f.git("commit", "-m", "Add unpublished fixture");
      await NodeFSP.writeFile(NodePath.join(f.repo, staged), "staged fixture\n");
      await NodeFSP.writeFile(NodePath.join(f.repo, removed), "staged then removed\n");
      await f.git("add", "--force", "--", staged, removed);
      await NodeFSP.rm(NodePath.join(f.repo, removed));
      await NodeFSP.writeFile(NodePath.join(f.repo, staged), "unstaged fixture\n");
      const status = await f.git("status", "--porcelain");
      const checkpoint = await createCheckpoint({
        repository: f.repo,
        database: f.database,
        directory: f.root,
        baseSha: f.baseSha,
      });
      expect(checkpoint.diff).toContain("unpublished fixture");
      expect(checkpoint.diff).toContain("unstaged fixture");
      expect(checkpoint.diff).not.toContain("staged then removed");
      expect(await f.git("status", "--porcelain")).toBe(status);
      const restored = NodePath.join(f.root, "restored");
      await restoreCheckpoint({
        archive: checkpoint.path,
        repository: restored,
        database: NodePath.join(f.root, "restored.sqlite"),
        directory: f.root,
        baseSha: f.baseSha,
      });
      expect((await exec("git", ["status", "--porcelain"], { cwd: restored })).stdout.trim()).toBe(
        status,
      );
      expect((await exec("git", ["show", `:${staged}`], { cwd: restored })).stdout).toBe(
        "staged fixture\n",
      );
      expect(await NodeFSP.readFile(NodePath.join(restored, staged), "utf8")).toBe(
        "unstaged fixture\n",
      );
      await checkpoint.dispose();
    } finally {
      f.db.close();
    }
  });

  it("keeps internal checkpoint Git metadata out of a non-Git workspace", async () => {
    const f = await fixture();
    try {
      await NodeFSP.mkdir(NodePath.join(f.repo, "node_modules", "installed"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(f.repo, "node_modules", "installed", "index.js"),
        "installed dependency",
      );
      const internal = NodePath.join(f.root, "internal-git");
      await NodeFSP.rename(NodePath.join(f.repo, ".git"), internal);
      const saved = await createCheckpoint({
        repository: f.repo,
        database: f.database,
        directory: f.root,
        baseSha: f.baseSha,
        objectDirectory: NodePath.join(internal, "objects"),
      });
      const restored = NodePath.join(f.root, "restored");
      await restoreCheckpoint({
        archive: saved.path,
        repository: restored,
        database: NodePath.join(f.root, "copy.sqlite"),
        directory: f.root,
        baseSha: f.baseSha,
      });
      expect(await NodeFSP.readFile(NodePath.join(restored, "tracked.txt"), "utf8")).toBe("base\n");
      await expect(NodeFSP.stat(NodePath.join(restored, ".git"))).rejects.toThrow();
      await expect(NodeFSP.stat(NodePath.join(restored, "node_modules"))).rejects.toThrow();
      expect(saved.diff).not.toContain("node_modules");
      await saved.dispose();
    } finally {
      f.db.close();
    }
  });
  it("preserves unpublished commits, the real index and unstaged binary work", async () => {
    const f = await fixture();
    try {
      await NodeFSP.writeFile(NodePath.join(f.repo, "committed"), "unpublished");
      await f.git("add", "committed");
      await f.git("commit", "-m", "local-only");
      const head = await f.git("rev-parse", "HEAD");
      await NodeFSP.writeFile(NodePath.join(f.repo, "tracked.txt"), "staged\n");
      await f.git("add", "tracked.txt");
      const binary = Buffer.from([0, 255, 12, 0]);
      await NodeFSP.writeFile(NodePath.join(f.repo, "tracked.txt"), binary);
      await NodeFSP.writeFile(NodePath.join(f.repo, "untracked"), "draft");
      const status = await f.git("status", "--porcelain");
      const saved = await createCheckpoint({
        repository: f.repo,
        database: f.database,
        directory: f.root,
        baseSha: f.baseSha,
      });
      const restored = NodePath.join(f.root, "restored");
      await exec("git", ["clone", "--no-local", f.repo, restored]);
      await restoreCheckpoint({
        archive: saved.path,
        repository: restored,
        database: NodePath.join(f.root, "copy.sqlite"),
        directory: f.root,
        baseSha: f.baseSha,
      });
      const git = async (...args) => (await exec("git", args, { cwd: restored })).stdout.trim();
      expect(await git("rev-parse", "HEAD")).toBe(head);
      expect(await git("status", "--porcelain")).toBe(status);
      expect(await git("show", ":tracked.txt")).toBe("staged");
      expect(await NodeFSP.readFile(NodePath.join(restored, "tracked.txt"))).toEqual(binary);
      await saved.dispose();
    } finally {
      f.db.close();
    }
  });
  it("preserves explicit attachments across a checkpoint and rejects symlinks", async () => {
    const f = await fixture();
    try {
      const attachmentsDirectory = NodePath.join(f.root, "attachments");
      await NodeFSP.mkdir(attachmentsDirectory);
      const bytes = Buffer.from([0, 1, 255, 10]);
      await NodeFSP.writeFile(NodePath.join(attachmentsDirectory, "message-file.bin"), bytes);
      const checkpoint = await createCheckpoint({
        repository: f.repo,
        database: f.database,
        directory: f.root,
        baseSha: f.baseSha,
        attachmentsDirectory,
      });
      const restored = NodePath.join(f.root, "restored-attachments");
      await restoreCheckpoint({
        archive: checkpoint.path,
        repository: f.repo,
        database: NodePath.join(f.root, "restored.sqlite"),
        directory: f.root,
        baseSha: f.baseSha,
        attachmentsDirectory: restored,
      });
      expect(await NodeFSP.readFile(NodePath.join(restored, "message-file.bin"))).toEqual(bytes);
      await NodeFSP.symlink(f.database, NodePath.join(attachmentsDirectory, "secret.bin"));
      await expect(
        createCheckpoint({
          repository: f.repo,
          database: f.database,
          directory: f.root,
          baseSha: f.baseSha,
          attachmentsDirectory,
        }),
      ).rejects.toThrow("Unsafe attachment");
    } finally {
      f.db.close();
    }
  });
  it("captures committed WAL data and removes credentials without altering the live database", async () => {
    const f = await fixture();
    try {
      const destination = NodePath.join(f.root, "backup.sqlite");
      await backupDatabase(f.database, destination);
      const copy = new NodeSqlite.DatabaseSync(destination);
      try {
        expect(copy.prepare("SELECT body FROM messages").get().body).toBe("conversation");
        expect(copy.prepare("SELECT * FROM auth_sessions").all()).toEqual([]);
        expect(copy.prepare("SELECT * FROM auth_pairing_links").all()).toEqual([]);
        expect(f.db.prepare("SELECT * FROM auth_sessions").all()).toHaveLength(1);
        expect((await NodeFSP.readFile(destination)).includes(Buffer.from("must-not-export"))).toBe(
          false,
        );
      } finally {
        copy.close();
      }
    } finally {
      f.db.close();
    }
  });

  it("recovers tracked changes and untracked files without touching the original index or archiving credential caches", async () => {
    const f = await fixture();
    try {
      await NodeFSP.writeFile(NodePath.join(f.repo, "tracked.txt"), "changed\n");
      await NodeFSP.writeFile(NodePath.join(f.repo, "new file.txt"), "new work\n");
      await NodeFSP.mkdir(NodePath.join(f.repo, ".codex"));
      await NodeFSP.writeFile(NodePath.join(f.repo, ".codex", "auth.json"), "private-credential");
      await NodeFSP.writeFile(NodePath.join(f.repo, ".env"), "SECRET=private");
      const before = await f.git("status", "--porcelain");
      const checkpoint = await createCheckpoint({
        repository: f.repo,
        database: f.database,
        directory: f.root,
        baseSha: f.baseSha,
      });
      expect(await f.git("status", "--porcelain")).toBe(before);
      expect(await f.git("rev-parse", "HEAD")).toBe(f.baseSha);
      expect(checkpoint.diff).toContain("new file.txt");
      expect(checkpoint.diff).not.toContain("private-credential");
      const restored = NodePath.join(f.root, "restored");
      await exec("git", ["clone", "--no-local", f.repo, restored]);
      await restoreCheckpoint({
        archive: checkpoint.path,
        repository: restored,
        database: NodePath.join(f.root, "restored.sqlite"),
        directory: f.root,
        baseSha: f.baseSha,
      });
      expect(await NodeFSP.readFile(NodePath.join(restored, "tracked.txt"), "utf8")).toBe(
        "changed\n",
      );
      expect(await NodeFSP.readFile(NodePath.join(restored, "new file.txt"), "utf8")).toBe(
        "new work\n",
      );
      await expect(
        NodeFSP.readFile(NodePath.join(restored, ".codex", "auth.json")),
      ).rejects.toThrow();
      await expect(NodeFSP.readFile(NodePath.join(restored, ".env"))).rejects.toThrow();
      await checkpoint.dispose();
    } finally {
      f.db.close();
    }
  });

  it("keeps tracked files under excluded directory names while dropping installed dependencies", async () => {
    const f = await fixture();
    try {
      // Test fixtures committed under node_modules/ are part of the repository.
      const fixtureFile = NodePath.join(f.repo, "tests", "fixtures", "node_modules", "pkg");
      await NodeFSP.mkdir(fixtureFile, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(fixtureFile, "index.js"), "fixture\n");
      await f.git("add", "-f", ".");
      await f.git("commit", "-m", "fixtures");
      const baseSha = await f.git("rev-parse", "HEAD");
      // Cloud-side edits: installed dependencies, a modified tracked fixture and a
      // new credential file.
      await NodeFSP.mkdir(NodePath.join(f.repo, "node_modules", "installed"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(f.repo, "node_modules", "installed", "index.js"),
        "installed dependency",
      );
      await NodeFSP.writeFile(NodePath.join(fixtureFile, "index.js"), "fixture edited\n");
      await NodeFSP.writeFile(NodePath.join(f.repo, ".npmrc"), "//example.test/:_authToken=tok\n");
      await NodeFSP.writeFile(NodePath.join(f.repo, "tracked.txt"), "changed\n");
      const checkpoint = await createCheckpoint({
        repository: f.repo,
        database: f.database,
        directory: f.root,
        baseSha,
      });
      expect(checkpoint.diff).not.toContain("installed dependency");
      expect(checkpoint.diff).not.toContain("_authToken");
      expect(checkpoint.diff).toContain("fixture edited");
      expect(checkpoint.diff).not.toContain("deleted file mode");
      const restored = NodePath.join(f.root, "restored");
      await exec("git", ["clone", "--no-local", f.repo, restored]);
      await restoreCheckpoint({
        archive: checkpoint.path,
        repository: restored,
        database: NodePath.join(f.root, "restored.sqlite"),
        directory: f.root,
        baseSha,
      });
      expect(await NodeFSP.readFile(NodePath.join(restored, "tracked.txt"), "utf8")).toBe(
        "changed\n",
      );
      expect(
        await NodeFSP.readFile(
          NodePath.join(restored, "tests", "fixtures", "node_modules", "pkg", "index.js"),
          "utf8",
        ),
      ).toBe("fixture edited\n");
      await expect(NodeFSP.readFile(NodePath.join(restored, ".npmrc"))).rejects.toThrow();
      await expect(
        NodeFSP.readFile(NodePath.join(restored, "node_modules", "installed", "index.js")),
      ).rejects.toThrow();
      // The fixture is restored as a modified tracked file, never as a deletion.
      expect(await exec("git", ["status", "--porcelain"], { cwd: restored })).toMatchObject({
        stdout: expect.stringContaining(" M tests/fixtures/node_modules/pkg/index.js"),
      });
      expect(await exec("git", ["status", "--porcelain"], { cwd: restored })).toMatchObject({
        stdout: expect.not.stringMatching(/^ ?D /m),
      });
      await checkpoint.dispose();
    } finally {
      f.db.close();
    }
  });

  it("restores additional non-Git roots with their cloud edits", async () => {
    const f = await fixture();
    try {
      const extra = NodePath.join(f.root, "extra");
      await NodeFSP.mkdir(extra);
      await NodeFSP.writeFile(NodePath.join(extra, "file"), "cloud change");
      const saved = await createCheckpoint({
        repository: f.repo,
        database: f.database,
        directory: f.root,
        baseSha: f.baseSha,
        additionalRoots: [{ id: "extra", path: extra }],
      });
      const restored = NodePath.join(f.root, "restored");
      await exec("git", ["clone", "--no-local", f.repo, restored]);
      const destination = NodePath.join(f.root, "extra-restored");
      await restoreCheckpoint({
        archive: saved.path,
        repository: restored,
        database: NodePath.join(f.root, "restored.sqlite"),
        directory: f.root,
        baseSha: f.baseSha,
        additionalRoots: [{ id: "extra", path: destination }],
      });
      expect(await NodeFSP.readFile(NodePath.join(destination, "file"), "utf8")).toBe(
        "cloud change",
      );
      await saved.dispose();
    } finally {
      f.db.close();
    }
  });
  it("distinguishes credential files from checked-in setup examples", () => {
    expect(isCredentialPath("nested/.env.production")).toBe(true);
    expect(isCredentialPath(".aws/credentials")).toBe(true);
    expect(isCredentialPath(".env.example")).toBe(false);
    expect(isCredentialPath("src/auth.ts")).toBe(false);
  });
  it("does not execute repository-configured Git filters while checkpointing", async () => {
    const f = await fixture();
    try {
      const marker = NodePath.join(f.root, "filter-executed");
      await f.git("config", "filter.untrusted.clean", `touch '${marker}'; cat`);
      await NodeFSP.writeFile(NodePath.join(f.repo, ".gitattributes"), "*.txt filter=untrusted\n");
      const checkpoint = await createCheckpoint({
        repository: f.repo,
        database: f.database,
        directory: f.root,
        baseSha: f.baseSha,
      });
      await expect(NodeFSP.readFile(marker)).rejects.toThrow();
      await checkpoint.dispose();
    } finally {
      f.db.close();
    }
  });
  it("refuses source artifacts containing an injected credential", async () => {
    const f = await fixture();
    try {
      await NodeFSP.writeFile(
        NodePath.join(f.repo, "accidental-secret.txt"),
        "credential=subscription-secret",
      );
      await expect(
        createCheckpoint({
          repository: f.repo,
          database: f.database,
          directory: f.root,
          baseSha: f.baseSha,
          secrets: ["subscription-secret"],
        }),
      ).rejects.toThrow("injected credential");
      expect(await f.git("rev-parse", "HEAD")).toBe(f.baseSha);
    } finally {
      f.db.close();
    }
  });
});
