import { excludedDirectories } from "./transfer-policy.mjs";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";

import * as NodeStreamPromises from "node:stream/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import { exportAttachmentFiles, restoreAttachmentFiles } from "./attachments.mjs";
import { exportSessions, restoreSessions } from "./sessions.mjs";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const gitEnvironment = {
  PATH: process.env.PATH,
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Vitre Cloud",
  GIT_AUTHOR_EMAIL: "vitre@localhost",
  GIT_COMMITTER_NAME: "Vitre Cloud",
  GIT_COMMITTER_EMAIL: "vitre@localhost",
};

async function git(repository, args, env = {}) {
  const result = await exec(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      `safe.directory=${NodePath.resolve(repository)}`,
      ...args,
    ],
    {
      cwd: repository,
      env: { ...gitEnvironment, ...env },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return result.stdout.trim();
}

// These files must never enter a checkpoint, even if accidentally staged.
export function isCredentialPath(path) {
  return path
    .split("/")
    .some(
      (part) =>
        [
          ".codex",
          ".claude",
          ".ssh",
          ".aws",
          ".azure",
          ".gnupg",
          "auth.json",
          ".credentials.json",
          ".npmrc",
          ".netrc",
          ".pypirc",
          ".git-credentials",
        ].includes(part) ||
        part === ".env" ||
        (part.startsWith(".env.") &&
          ![".env.example", ".env.sample", ".env.template"].includes(part)),
    );
}

/** Use SQLite's backup API, including committed WAL pages, then remove auth material. */
export async function backupDatabase(source, destination, secrets = []) {
  const db = new NodeSqlite.DatabaseSync(source, { readOnly: true });
  try {
    await NodeSqlite.backup(db, destination);
  } finally {
    db.close();
  }
  const copy = new NodeSqlite.DatabaseSync(destination);
  try {
    copy.exec("PRAGMA secure_delete=ON");
    for (const table of ["auth_pairing_links", "auth_sessions"]) {
      if (copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        copy.exec(`DELETE FROM ${table}`);
      }
    }
    const quote = (name) => `"${name.replaceAll('"', '""')}"`;
    for (const { name } of copy
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      for (const column of copy.prepare(`PRAGMA table_info(${quote(name)})`).all()) {
        for (const secret of secrets.filter((value) => value.length >= 8)) {
          copy
            .prepare(
              `UPDATE ${quote(name)} SET ${quote(column.name)} = replace(${quote(column.name)}, ?, '[redacted]') WHERE typeof(${quote(column.name)}) = 'text' AND instr(${quote(column.name)}, ?) > 0`,
            )
            .run(secret, secret);
        }
      }
    }
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }
}

/** The caller must quiesce agent writes first. The real Git index/HEAD are untouched. */
export async function createCheckpoint({
  repository,
  database,
  directory,
  baseSha,
  secrets = [],
  providerHomes = {},
  additionalRoots = [],
  attachmentsDirectory,
  objectDirectory,
}) {
  if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("Invalid base commit");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await NodeFSP.mkdtemp(NodePath.join(NodePath.resolve(directory), "checkpoint-"));
  const index = NodePath.join(staging, "index");
  const ref = `refs/vitre-checkpoints/${NodeCrypto.randomUUID()}`;
  let env;
  try {
    // Repository setup/agent code can change .git/config. Use a new Git directory
    // so checkpointing never runs repository-defined filters or hooks as root.
    const gitDir = NodePath.join(staging, "git");
    await git(staging, ["init", "--bare", gitDir]);
    env = {
      GIT_INDEX_FILE: index,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: NodePath.resolve(repository),
      GIT_ALTERNATE_OBJECT_DIRECTORIES:
        objectDirectory ?? NodePath.join(NodePath.resolve(repository), ".git/objects"),
    };
    await git(repository, ["read-tree", baseSha], env);
    await git(
      repository,
      [
        "add",
        "--all",
        "--",
        ".",
        ...excludedDirectories.map((name) => `:(glob,exclude)**/${name}/**`),
      ],
      env,
    );
    // Installed dependencies and credentials never enter a checkpoint, but files
    // the repository itself tracks under those names (test fixtures, vendored
    // packages) are source: stage their current state explicitly, otherwise the
    // commit records them as deleted and every restore removes them.
    const baseEntries = new Map(
      (
        await exec("git", ["ls-tree", "-r", "-z", baseSha], {
          cwd: repository,
          env: { ...gitEnvironment, ...env },
          maxBuffer: 64 * 1024 * 1024,
        })
      ).stdout
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          const [mode, , sha] = line.slice(0, tab).split(" ");
          return [line.slice(tab + 1), { mode, sha }];
        }),
    );
    const inExcludedDirectory = (file) =>
      file.split("/").some((part) => excludedDirectories.includes(part));
    // Include fixtures added in unpublished commits or the real index since the
    // pinned base. The temporary checkpoint index otherwise never sees them.
    const trackedSourceFiles = new Set([
      ...baseEntries.keys(),
      ...(await git(repository, ["ls-files", "-z"]).catch(() => "")).split("\0").filter(Boolean),
    ]);
    const trackedFixtures = [...trackedSourceFiles].filter(
      (file) => inExcludedDirectory(file) && !isCredentialPath(file),
    );
    for (let offset = 0; offset < trackedFixtures.length; offset += 500) {
      const batch = (
        await Promise.all(
          trackedFixtures
            .slice(offset, offset + 500)
            .map(async (file) =>
              baseEntries.has(file) ||
              (await NodeFSP.lstat(NodePath.join(repository, file)).catch(() => null))
                ? file
                : null,
            ),
        )
      ).filter(Boolean);
      if (batch.length)
        await git(
          repository,
          ["add", "--all", "--force", "--", ...batch.map((file) => `:(literal)${file}`)],
          env,
        );
    }
    const files = (
      await exec("git", ["ls-files", "-z"], {
        cwd: repository,
        env: { ...gitEnvironment, ...env },
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout
      .split("\0")
      .filter(Boolean);
    // A tracked credential path stays pinned at its base version, which the
    // repository already holds; untracked ones and installed packages are dropped.
    const excludedFile = (file) =>
      isCredentialPath(file) || (inExcludedDirectory(file) && !trackedSourceFiles.has(file));
    for (const file of files.filter(excludedFile)) {
      const base = baseEntries.get(file);
      if (base)
        await git(
          repository,
          ["update-index", "--cacheinfo", `${base.mode},${base.sha},${file}`],
          env,
        );
      else await git(repository, ["update-index", "--force-remove", "--", file], env);
    }
    // Refuse an artifact if a tool wrote an injected credential into source code.
    // Keep only a rolling window, including matches split across read boundaries.
    const needles = secrets.filter((value) => value.length >= 8).map((value) => Buffer.from(value));
    const overlap = Math.max(0, ...needles.map((value) => value.length - 1));
    if (needles.length)
      for (const file of files.filter((file) => !excludedFile(file))) {
        const path = NodePath.join(repository, file);
        if (!(await NodeFSP.lstat(path)).isFile()) continue;
        let previous = Buffer.alloc(0);
        for await (const chunk of NodeFS.createReadStream(path)) {
          const bytes = Buffer.concat([previous, chunk]);
          if (needles.some((needle) => bytes.includes(needle)))
            throw new Error("Checkpoint contains an injected credential; sandbox retained");
          previous = bytes.subarray(Math.max(0, bytes.length - overlap));
        }
      }
    const tree = await git(repository, ["write-tree"], env);
    const commit = await git(
      repository,
      ["commit-tree", tree, "-p", baseSha, "-m", "Vitre cloud checkpoint"],
      env,
    );
    await git(repository, ["update-ref", ref, commit], env);
    // Bundle only the new commit: the immutable base is fetched from GitHub on recovery.
    await git(
      repository,
      ["bundle", "create", NodePath.join(staging, "repository.bundle"), ref, `^${baseSha}`],
      env,
    );
    const diff = await git(
      repository,
      ["diff", "--no-ext-diff", "--no-textconv", "--binary", baseSha, commit],
      env,
    );
    await backupDatabase(database, NodePath.join(staging, "state.sqlite"), secrets);
    await NodeFSP.writeFile(
      NodePath.join(staging, "sessions.json"),
      JSON.stringify(await exportSessions(providerHomes, secrets)),
      { mode: 0o600 },
    );
    const workspaceMembers = [];
    if (attachmentsDirectory) {
      const attachments = await exportAttachmentFiles(attachmentsDirectory);
      if (
        attachments.some((file) =>
          needles.some((needle) => Buffer.from(file.base64, "base64").includes(needle)),
        )
      )
        throw new Error("Attachment contains an injected credential; sandbox retained");
      await NodeFSP.writeFile(
        NodePath.join(staging, "attachments.json"),
        JSON.stringify(attachments),
        { mode: 0o600 },
      );
      workspaceMembers.push("attachments.json");
    }
    {
      if (additionalRoots.some((root) => root.id === "primary"))
        throw new Error("Reserved workspace root id");
      const { captureWorkspace } = await import("./workspace.mjs");
      const chunkDirectory = NodePath.join(staging, "workspace-chunks");
      await NodeFSP.mkdir(chunkDirectory);
      const manifest = await captureWorkspace(
        [{ id: "primary", path: repository }, ...additionalRoots],
        async (hash, bytes) => {
          if (needles.some((needle) => Buffer.from(bytes).includes(needle)))
            throw new Error("Checkpoint contains an injected credential; sandbox retained");
          const name = `workspace-chunks/${hash}`;
          await NodeFSP.writeFile(NodePath.join(staging, name), bytes, { mode: 0o600 });
          if (!workspaceMembers.includes(name)) workspaceMembers.push(name);
        },
      );
      await NodeFSP.writeFile(NodePath.join(staging, "workspace.json"), JSON.stringify(manifest), {
        mode: 0o600,
      });
      workspaceMembers.push("workspace.json");
    }
    await NodeFSP.writeFile(
      NodePath.join(staging, "metadata.json"),
      JSON.stringify({ version: 2, baseSha, commit, ref }),
      { mode: 0o600 },
    );
    await exec("tar", [
      "-czf",
      NodePath.join(staging, "checkpoint.tar.gz"),
      "-C",
      staging,
      "metadata.json",
      "repository.bundle",
      "state.sqlite",
      "sessions.json",
      ...workspaceMembers,
    ]);
    return {
      path: NodePath.join(staging, "checkpoint.tar.gz"),
      workspace: JSON.parse(
        await NodeFSP.readFile(NodePath.join(staging, "workspace.json"), "utf8"),
      ),
      readWorkspaceChunk: (hash) => {
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid workspace chunk hash");
        return NodeFSP.readFile(NodePath.join(staging, "workspace-chunks", hash));
      },
      commit,
      diff,
      dispose: () => NodeFSP.rm(staging, { recursive: true, force: true }),
    };
  } catch (error) {
    await NodeFSP.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Extract only portable workspace bytes; chat, sessions and credentials never enter a fork. */
export async function projectWorkspaceFromCheckpoint({
  archive,
  directory,
  prepareLegacyRepository,
  baseSha,
  legacyLocal = false,
}) {
  const staging = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.resolve(directory), "project-seed-"),
  );
  try {
    const entries = (await exec("tar", ["-tzf", archive], { maxBuffer: 16 * 1024 * 1024 })).stdout
      .trim()
      .split("\n");
    if (new Set(entries).size !== entries.length || entries.length > 100_000)
      throw new Error("Invalid project checkpoint archive");
    const read = async (name, limit) => {
      if (!entries.includes(name)) throw new Error(`Checkpoint is missing ${name}`);
      return (await exec("tar", ["-xOzf", archive, name], { encoding: "buffer", maxBuffer: limit }))
        .stdout;
    };
    const metadata = JSON.parse((await read("metadata.json", 4096)).toString());
    if (
      ![1, 2].includes(metadata.version) ||
      (baseSha !== null && metadata.baseSha !== baseSha) ||
      !/^[a-f0-9]{40}$/.test(metadata.commit) ||
      !/^refs\/vitre-checkpoints\/[a-f0-9-]{36}$/.test(metadata.ref)
    )
      throw new Error("Project checkpoint metadata does not match its source");
    const { validateManifest, restoreWorkspace, captureWorkspace } =
      await import("./workspace.mjs");
    let workspace = entries.includes("workspace.json")
      ? JSON.parse((await read("workspace.json", 8 * 1024 * 1024)).toString())
      : null;
    const readChunk = (hash) => {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid workspace chunk hash");
      return read(`workspace-chunks/${hash}`, 4 * 1024 * 1024);
    };
    if (metadata.version === 2) {
      if (!workspace) throw new Error("Checkpoint has no portable workspace");
      validateManifest(workspace);
      return {
        workspace,
        readWorkspaceChunk: readChunk,
        dispose: () => NodeFSP.rm(staging, { recursive: true, force: true }),
      };
    }
    // Older checkpoints kept the primary root as a Git delta from the pinned base.
    // The caller provides an isolated clone. Never restore the source database.
    const destination = NodePath.join(staging, "repository");
    let repository;
    if (legacyLocal) {
      // Version-1 uploads used this deterministic empty baseline, not GitHub.
      repository = destination;
      await NodeFSP.mkdir(repository);
      await git(repository, ["init", "--initial-branch=main"]);
      await git(
        repository,
        [
          "-c",
          "user.name=Vitre",
          "-c",
          "user.email=vitre@localhost",
          "commit",
          "--allow-empty",
          "-m",
          "Local workspace baseline",
        ],
        {
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
          GIT_AUTHOR_NAME: "Vitre",
          GIT_AUTHOR_EMAIL: "vitre@localhost",
          GIT_COMMITTER_NAME: "Vitre",
          GIT_COMMITTER_EMAIL: "vitre@localhost",
        },
      );
    } else repository = await prepareLegacyRepository(destination);
    const bundle = NodePath.join(staging, "repository.bundle");
    await NodeFSP.writeFile(bundle, await read("repository.bundle", 256 * 1024 * 1024));
    await git(repository, ["bundle", "verify", bundle]);
    await git(repository, ["fetch", bundle, metadata.ref]);
    if ((await git(repository, ["rev-parse", "FETCH_HEAD"])) !== metadata.commit)
      throw new Error("Project checkpoint commit mismatch");
    await git(repository, ["reset", "--hard", metadata.commit]);
    if (legacyLocal)
      await NodeFSP.rm(NodePath.join(repository, ".git"), { recursive: true, force: true });
    const roots = [{ id: "primary", path: repository }];
    if (workspace) {
      validateManifest(workspace);
      if (workspace.roots.some((root) => root.id === "primary"))
        throw new Error("Duplicate primary workspace");
      const extra = NodePath.join(staging, "roots");
      await restoreWorkspace(workspace, extra, readChunk);
      roots.push(
        ...workspace.roots.map((root) => ({ id: root.id, path: NodePath.join(extra, root.id) })),
      );
    }
    const chunks = NodePath.join(staging, "chunks");
    await NodeFSP.mkdir(chunks);
    workspace = await captureWorkspace(roots, (hash, bytes) =>
      NodeFSP.writeFile(NodePath.join(chunks, hash), bytes),
    );
    return {
      workspace,
      readWorkspaceChunk: (hash) => {
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid workspace chunk hash");
        return NodeFSP.readFile(NodePath.join(chunks, hash));
      },
      dispose: () => NodeFSP.rm(staging, { recursive: true, force: true }),
    };
  } catch (error) {
    await NodeFSP.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Restore into an empty workspace only; never overwrite a surviving worker's disk. */
export async function restoreCheckpoint({
  archive,
  repository,
  database,
  directory,
  baseSha,
  providerHomes = {},
  additionalRoots = [],
  attachmentsDirectory,
}) {
  const staging = await NodeFSP.mkdtemp(NodePath.join(NodePath.resolve(directory), "restore-"));
  try {
    const { stdout } = await exec("tar", ["-tzf", archive]);
    const entries = stdout.trim().split("\n").sort();
    const required = ["metadata.json", "repository.bundle", "state.sqlite"];
    if (
      new Set(entries).size !== entries.length ||
      !required.every((entry) => entries.includes(entry)) ||
      entries.length > 100_000 ||
      entries.some(
        (entry) =>
          ![...required, "sessions.json", "workspace.json", "attachments.json"].includes(entry) &&
          !/^workspace-chunks\/[a-f0-9]{64}$/.test(entry),
      )
    )
      throw new Error("Invalid checkpoint archive");
    await NodeFSP.mkdir(NodePath.join(staging, "workspace-chunks"));
    // Extract each member to stdout, not onto paths controlled by the archive.
    for (const name of entries) {
      const child = NodeChildProcess.spawn("tar", ["-xOzf", archive, name], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const completed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error("Checkpoint extraction failed")),
        );
      });
      await Promise.all([
        NodeStreamPromises.pipeline(
          child.stdout,
          NodeFS.createWriteStream(NodePath.join(staging, name), { flags: "wx", mode: 0o600 }),
        ),
        completed,
      ]);
    }
    const metadata = JSON.parse(
      await NodeFSP.readFile(NodePath.join(staging, "metadata.json"), "utf8"),
    );
    if (
      ![1, 2].includes(metadata.version) ||
      metadata.baseSha !== baseSha ||
      !/^[a-f0-9]{40}$/.test(metadata.commit) ||
      !/^refs\/vitre-checkpoints\/[a-f0-9-]{36}$/.test(metadata.ref)
    )
      throw new Error("Checkpoint base does not match the task");
    if (entries.includes("workspace.json")) {
      const { restoreWorkspace } = await import("./workspace.mjs");
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(staging, "workspace.json"), "utf8"),
      );
      const destinations =
        metadata.version === 2
          ? [{ id: "primary", path: repository }, ...additionalRoots]
          : additionalRoots;
      if (manifest.roots.some((root) => !destinations.some((allowed) => allowed.id === root.id)))
        throw new Error("Checkpoint contains an unknown workspace root");
      const restored = NodePath.join(staging, "restored-roots");
      await restoreWorkspace(manifest, restored, (hash) =>
        NodeFSP.readFile(NodePath.join(staging, "workspace-chunks", hash)),
      );
      for (const root of destinations) {
        if (!manifest.roots.some((entry) => entry.id === root.id))
          throw new Error("Checkpoint is missing a workspace root");
        await NodeFSP.rm(root.path, { recursive: true, force: true });
        await NodeFSP.cp(NodePath.join(restored, root.id), root.path, {
          recursive: true,
          dereference: false,
        });
      }
    }
    if (metadata.version === 1) {
      await git(repository, ["bundle", "verify", NodePath.join(staging, "repository.bundle")]);
      await git(repository, ["fetch", NodePath.join(staging, "repository.bundle"), metadata.ref]);
      if ((await git(repository, ["rev-parse", "FETCH_HEAD"])) !== metadata.commit)
        throw new Error("Checkpoint commit mismatch");
      await git(repository, ["reset", "--hard", metadata.commit]);
    } else if (!entries.includes("workspace.json")) {
      throw new Error("Checkpoint is missing its portable workspace");
    }
    if (entries.includes("attachments.json")) {
      if (!attachmentsDirectory) throw new Error("Attachment destination is required");
      const archivePath = NodePath.join(staging, "attachments.json");
      if ((await NodeFSP.stat(archivePath)).size > 360 * 1024 * 1024)
        throw new Error("Attachment archive too large");
      await restoreAttachmentFiles(
        JSON.parse(await NodeFSP.readFile(archivePath, "utf8")),
        attachmentsDirectory,
      );
    }
    await backupDatabase(NodePath.join(staging, "state.sqlite"), database);
    if (entries.includes("sessions.json")) {
      if ((await NodeFSP.stat(NodePath.join(staging, "sessions.json"))).size > 256 * 1024 * 1024)
        throw new Error("Session archive too large");
      await restoreSessions(
        JSON.parse(await NodeFSP.readFile(NodePath.join(staging, "sessions.json"), "utf8")),
        providerHomes,
      );
    }
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}
