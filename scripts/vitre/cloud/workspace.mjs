import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeOS from "node:os";
import { isCredentialPath } from "./checkpoint.mjs";
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const digest = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
import { excludedDirectories } from "./transfer-policy.mjs";
const excluded = new Set(excludedDirectories);
export function safePath(path) {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    NodePath.posix.isAbsolute(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    /^[a-z]:/i.test(path)
  )
    throw new Error("Invalid workspace path");
  return path;
}
function projectAgentFile(path) {
  return (
    // eslint-disable-next-line no-control-regex -- Git paths cannot contain NUL separators.
    /(?:^|\/)\.(?:codex|claude)\/(?:skills(?:\/[^\0]+\.md)?|[^/]+\.md)$/.test(path) ||
    /(?:^|\/)\.codex\/config\.toml$/.test(path)
  );
}
function agentConfigPath(path) {
  return /(?:^|\/)\.codex\/config\.toml$/.test(path);
}
function verifyAgentConfig(content) {
  // Project MCP configuration is not an account credential. Still reject
  // inline authentication fields and credential-shaped values conservatively.
  if (
    /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|private[_-]?key|authorization|bearer|credential|http_headers)["']?\s*[=:\]]/i.test(
      content,
    ) ||
    /(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,}|https?:\/\/[^\s/]+:[^\s/]+@)/.test(content)
  ) {
    throw new Error(
      "Project agent configuration contains credentials; remove inline secrets before cloud transfer",
    );
  }
}
function credentialPath(path) {
  if (projectAgentFile(path)) return false;
  return (
    isCredentialPath(path) ||
    path
      .split("/")
      .some((part) => [".npmrc", ".netrc", ".pypirc", ".git-credentials"].includes(part))
  );
}
function transferable(path) {
  return !credentialPath(path) && !path.split("/").some((part) => excluded.has(part));
}
/** Restorable entries: tracked fixtures may live under dependency directory
 * names, but nothing is ever written into Git metadata or credential paths. */
function restorable(path) {
  return !credentialPath(path) && !path.split("/").includes(".git");
}
const git = async (cwd, args) =>
  (
    await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        ...args,
      ],
      { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    )
  ).stdout;

/** Capture a consistent file set without following symlinks or changing the source. */
export async function captureWorkspace(roots, putChunk, options = {}) {
  if (!roots.length || roots.length > 16 || new Set(roots.map((r) => r.id)).size !== roots.length)
    throw new Error("Invalid workspace roots");
  const manifest = {
    version: 2,
    roots: roots.map(({ id, path }) => ({ id, name: NodePath.basename(path) })),
    entries: [],
  };
  let total = 0;
  const captured = [];
  const gitBoundaries = [];
  let packed = [],
    packedSize = 0;
  const flush = async () => {
    if (!packed.length) return;
    const bytes = Buffer.concat(packed.map(({ bytes }) => bytes));
    const hash = digest(bytes);
    await putChunk(hash, bytes);
    for (const { entry } of packed) entry.chunks.push(hash);
    packed = [];
    packedSize = 0;
  };
  const storeBytes = async (bytes) => {
    const chunks = [];
    if (bytes.length > 256 * 1024 * 1024) throw new Error("Git data exceeds transfer limit");
    if ((total += bytes.length) > 1024 * 1024 * 1024)
      throw new Error("Workspace exceeds transfer limit");
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const part = bytes.subarray(offset, offset + CHUNK_BYTES);
      const hash = digest(part);
      await putChunk(hash, part);
      chunks.push(hash);
    }
    return { sha256: digest(bytes), sizeBytes: bytes.length, chunks };
  };
  for (const root of roots) {
    options.signal?.throwIfAborted();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(root.id)) throw new Error("Invalid workspace root ID");
    const base = await NodeFSP.realpath(root.path);
    // A temporary bare repository supplies Git's ignore semantics for plain directories,
    // including nested .gitignore and .vitreignore, without initializing the source.
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-workspace-ignore-"));
    try {
      await git(temp, ["init", "--bare", "."]);
      const paths = (
        await git(base, [
          "--git-dir",
          temp,
          "--work-tree",
          base,
          "ls-files",
          "--others",
          ...[...excluded].map((name) => `--exclude=${name}/`),
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter(Boolean);
      const vitrePaths = new Set(
        (
          await git(base, [
            "--git-dir",
            temp,
            "--work-tree",
            base,
            "ls-files",
            "--others",
            ...[...excluded].map((name) => `--exclude=${name}/`),
            "--exclude-per-directory=.vitreignore",
            "-z",
          ])
        )
          .split("\0")
          .filter(Boolean),
      );
      // A selected subdirectory is a standalone source, not its parent repository.
      const gitRoot = await git(base, ["rev-parse", "--show-toplevel"])
        .then((path) => NodeFSP.realpath(path.trim()))
        .catch(() => null);
      const isRepositoryRoot = gitRoot === base;
      let tracked = [];
      try {
        if (isRepositoryRoot)
          tracked = (await git(base, ["ls-files", "-z", "--cached"])).split("\0").filter(Boolean);
      } catch {}
      // Excluded directory names identify installed dependencies and build
      // output, which are untracked. Files the repository tracks under such a
      // name (test fixtures, vendored packages) are source and must travel, or
      // the restored checkout reports them deleted. .vitreignore still applies.
      const trackedSet = new Set(tracked);
      const trackedExcludedPaths = tracked.filter((path) =>
        path.split("/").some((part) => excluded.has(part)),
      );
      // Query exact tracked files: scanning their parent node_modules directory
      // also enumerates installed packages, which can dominate every checkpoint.
      for (let offset = 0; offset < trackedExcludedPaths.length; offset += 500)
        for (const name of (
          await git(base, [
            "--git-dir",
            temp,
            "--work-tree",
            base,
            "ls-files",
            "--others",
            "--exclude-per-directory=.vitreignore",
            "-z",
            "--",
            ...trackedExcludedPaths.slice(offset, offset + 500).map((path) => `:(literal)${path}`),
          ])
        ).split("\0"))
          if (name && trackedSet.has(name)) vitrePaths.add(name);
      const wanted = (path) => (trackedSet.has(path) ? !credentialPath(path) : transferable(path));
      // Directory mtimes detect new/deleted paths, including files that were
      // created after discovery and therefore have no entry to recheck below.
      const directories = new Set([base]);
      for (const path of [...paths, ...tracked]) {
        if (!wanted(path) || path.endsWith("/")) continue;
        let directory = NodePath.dirname(NodePath.join(base, safePath(path)));
        while (directory !== base && directory.startsWith(base + NodePath.sep)) {
          directories.add(directory);
          directory = NodePath.dirname(directory);
        }
      }
      for (const full of directories) {
        const before = await NodeFSP.lstat(full).catch(() => null);
        if (before) captured.push({ full, before });
      }
      let head;
      try {
        if (isRepositoryRoot) head = (await git(base, ["rev-parse", "HEAD"])).trim();
      } catch {}
      if (head && /^[a-f0-9]{40}$/.test(head)) {
        const indexState = await git(base, ["diff", "--cached", "--raw", "-z"]);
        gitBoundaries.push({ base, head, indexState });
        // A bundle contains historical objects, including deleted files. Refuse
        // known credential paths instead of silently including excluded secrets.
        const historicalPaths = (await git(base, ["log", "--format=", "--name-only", "-z", "HEAD"]))
          .split("\0")
          .map((name) => name.replace(/^\n+/, ""))
          .filter(Boolean);
        for (const path of new Set(historicalPaths.filter(agentConfigPath))) {
          const commits = (await git(base, ["log", "--format=%H", "HEAD", "--", path]))
            .trim()
            .split("\n")
            .filter(Boolean);
          for (const commit of commits) {
            const content = await git(base, ["show", `${commit}:${path}`]).catch(() => "");
            verifyAgentConfig(content);
          }
        }
        if (historicalPaths.some(credentialPath))
          throw new Error(
            "Git history contains credential files; remove them from history before cloud transfer",
          );
        const bundlePath = NodePath.join(temp, "source.bundle");
        await git(base, ["-c", "pack.threads=1", "bundle", "create", bundlePath, "HEAD"]);
        if ((await NodeFSP.stat(bundlePath)).size > 256 * 1024 * 1024)
          throw new Error("Git data exceeds transfer limit");
        const bundle = await storeBytes(await NodeFSP.readFile(bundlePath));
        const staged = (await git(base, ["diff", "--cached", "--name-only", "-z"]))
          .split("\0")
          .filter(Boolean);
        // ls-files --others only lists existing files; staged deletions must travel too.
        const ignored = new Set();
        if (staged.length) {
          const result = await git(base, [
            "--git-dir",
            temp,
            "--work-tree",
            base,
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-per-directory=.vitreignore",
            "-z",
          ]);
          for (const name of result.split("\0")) ignored.add(name);
        }
        const safeTracked = [...new Set([...tracked, ...staged])].filter(
          (path) => wanted(path) && !ignored.has(path),
        );
        const patch = safeTracked.length
          ? await git(base, [
              "diff",
              "--cached",
              "--binary",
              "--full-index",
              "--no-ext-diff",
              "--no-textconv",
              "--",
              ...safeTracked,
            ])
          : "";
        const index = await storeBytes(Buffer.from(patch));
        const branch = await git(base, ["symbolic-ref", "--short", "HEAD"])
          .then((text) => text.trim())
          .catch(() => null);
        const remoteName = branch
          ? await git(base, ["config", "--get", `branch.${branch}.remote`])
              .then((text) => text.trim())
              .catch(() => "origin")
          : "origin";
        const url = await git(base, [
          "remote",
          "get-url",
          remoteName === "." ? "origin" : remoteName,
        ])
          .then((text) => text.trim())
          .catch(() => "");
        const github =
          /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
            url,
          );
        const publishedRevision = github
          ? await git(base, ["rev-parse", "@{upstream}"])
              .catch(() => git(base, ["config", "--get", "vitre.publishedRevision"]))
              .then((text) => text.trim())
              .catch(() => undefined)
          : undefined;
        const [commitName, commitEmail] = await Promise.all(
          ["user.name", "user.email"].map((key) =>
            git(base, ["config", "--get", key])
              .then((value) => value.trim())
              .catch(() => ""),
          ),
        );
        const commitIdentity = [commitName, commitEmail].every((value) =>
          /^[^\p{Cc}]{1,256}$/u.test(value),
        )
          ? { name: commitName, email: commitEmail }
          : undefined;
        manifest.roots.find((r) => r.id === root.id).git = {
          ...(commitIdentity ? { commitIdentity } : {}),
          head,
          branch,
          bundle,
          index,
          ...(github ? { githubRemote: `https://github.com/${github[1]}/${github[2]}.git` } : {}),
          ...(publishedRevision && /^[a-f0-9]{40}$/.test(publishedRevision)
            ? { publishedRevision }
            : {}),
        };
      }
      for (const path of [...new Set([...paths, ...tracked])].sort()) {
        options.signal?.throwIfAborted();
        if (!wanted(path) || !vitrePaths.has(path) || path.endsWith("/")) continue;
        safePath(path);
        const full = NodePath.join(base, path);
        // Ancestor symlinks must not bypass the root even for tracked entries.
        const parent = await NodeFSP.realpath(NodePath.dirname(full)).catch(() => null);
        if (!parent) continue;
        if (parent !== base && !parent.startsWith(base + NodePath.sep))
          throw new Error("Workspace path escapes its root");
        const before = await NodeFSP.lstat(full).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!before) continue;
        if (!before.isFile() && !before.isSymbolicLink()) continue;
        if (before.isFile() && agentConfigPath(path))
          verifyAgentConfig(await NodeFSP.readFile(full, "utf8"));
        if (before.size > 256 * 1024 * 1024 || (total += before.size) > 1024 * 1024 * 1024)
          throw new Error("Workspace exceeds transfer limit");
        if (before.isSymbolicLink()) {
          const target = await NodeFSP.readlink(full);
          captured.push({ full, before });
          const resolved = NodePath.resolve(NodePath.dirname(full), target);
          if (
            NodePath.isAbsolute(target) ||
            (resolved !== base && !resolved.startsWith(base + NodePath.sep))
          )
            throw new Error("Symlink escapes its workspace");
          manifest.entries.push({
            rootId: root.id,
            path,
            kind: "symlink",
            executable: false,
            sizeBytes: Buffer.byteLength(target),
            sha256: digest(target),
            chunks: [],
            target,
          });
          continue;
        }
        const handle = await NodeFSP.open(
          full,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
        );
        let bytes;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
            throw new Error("Workspace changed during transfer; retry");
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        captured.push({ full, before });
        const after = await NodeFSP.lstat(full);
        if (
          before.ino !== after.ino ||
          before.mtimeMs !== after.mtimeMs ||
          before.size !== after.size
        )
          throw new Error("Workspace changed during transfer; retry");
        const chunks = [];
        for (
          let offset = 0;
          bytes.length > CHUNK_BYTES && offset < bytes.length;
          offset += CHUNK_BYTES
        ) {
          const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
          const hash = digest(chunk);
          await putChunk(hash, chunk);
          chunks.push(hash);
        }
        const entry = {
          rootId: root.id,
          path,
          kind: "file",
          executable: !!(before.mode & 0o111),
          sizeBytes: bytes.length,
          sha256: digest(bytes),
          chunks,
          target: null,
        };
        if (bytes.length && bytes.length <= CHUNK_BYTES) {
          if (packedSize + bytes.length > CHUNK_BYTES) await flush();
          entry.chunkOffset = packedSize;
          packed.push({ entry, bytes });
          packedSize += bytes.length;
        }
        manifest.entries.push(entry);
        options.onProgress?.({ files: manifest.entries.length, bytes: total });
      }
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  await flush();
  await options.beforeVerify?.();
  options.signal?.throwIfAborted();
  // Recheck earlier files after the final upload; a per-file check alone misses
  // an editor changing an already uploaded file while a later file is in flight.
  for (const { base, head, indexState } of gitBoundaries) {
    if (
      (await git(base, ["rev-parse", "HEAD"])).trim() !== head ||
      (await git(base, ["diff", "--cached", "--raw", "-z"])) !== indexState
    )
      throw new Error("Workspace changed during transfer; retry");
  }
  for (const { full, before } of captured) {
    const after = await NodeFSP.lstat(full).catch(() => null);
    if (
      !after ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size ||
      before.mode !== after.mode
    )
      throw new Error("Workspace changed during transfer; retry");
  }
  return manifest;
}

export function validateManifest(manifest) {
  if (
    ![1, 2].includes(manifest.version) ||
    !Array.isArray(manifest.roots) ||
    !manifest.roots.length ||
    manifest.roots.length > 16 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > 100_000
  )
    throw new Error("Invalid workspace manifest");
  const roots = new Set(manifest.roots.map((root) => root.id));
  if (
    roots.size !== manifest.roots.length ||
    [...roots].some((id) => !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
  )
    throw new Error("Invalid workspace roots");
  const seen = new Set();
  let total = 0;
  for (const root of manifest.roots) {
    if (!root.git) continue;
    if (
      !/^[a-f0-9]{40}$/.test(root.git.head) ||
      (root.git.branch !== null && typeof root.git.branch !== "string") ||
      (root.git.githubRemote !== undefined &&
        !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(root.git.githubRemote)) ||
      (root.git.publishedRevision !== undefined &&
        !/^[a-f0-9]{40}$/.test(root.git.publishedRevision))
    )
      throw new Error("Invalid Git metadata");
    if (
      root.git.commitIdentity !== undefined &&
      (!root.git.commitIdentity ||
        ![root.git.commitIdentity.name, root.git.commitIdentity.email].every(
          (value) => typeof value === "string" && /^[^\p{Cc}]{1,256}$/u.test(value),
        ))
    )
      throw new Error("Invalid Git commit identity");
    for (const blob of [root.git.bundle, root.git.index]) {
      if (
        !blob ||
        !/^[a-f0-9]{64}$/.test(blob.sha256) ||
        !Number.isSafeInteger(blob.sizeBytes) ||
        blob.sizeBytes < 0 ||
        blob.sizeBytes > 256 * 1024 * 1024 ||
        !Array.isArray(blob.chunks) ||
        blob.chunks.length !== Math.ceil(blob.sizeBytes / CHUNK_BYTES) ||
        blob.chunks.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
      )
        throw new Error("Invalid Git metadata");
      total += blob.sizeBytes;
    }
  }
  for (const entry of manifest.entries) {
    safePath(entry.path);
    const key = `${entry.rootId}/${entry.path}`;
    if (
      !roots.has(entry.rootId) ||
      seen.has(key) ||
      !restorable(entry.path) ||
      !["file", "symlink"].includes(entry.kind) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      entry.sizeBytes > 256 * 1024 * 1024 ||
      !Array.isArray(entry.chunks) ||
      entry.chunks.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
    )
      throw new Error("Invalid workspace entry");
    seen.add(key);
    total += entry.sizeBytes;
    if (entry.kind === "symlink") {
      if (
        typeof entry.target !== "string" ||
        NodePath.posix.isAbsolute(entry.target) ||
        entry.target.includes("\\") ||
        entry.target.includes("\0")
      )
        throw new Error("Invalid symlink");
      const target = NodePath.posix.normalize(
        NodePath.posix.join(NodePath.posix.dirname(entry.path), entry.target),
      );
      if (
        target === ".." ||
        target.startsWith("../") ||
        entry.chunks.length ||
        entry.chunkOffset !== undefined ||
        digest(entry.target) !== entry.sha256
      )
        throw new Error("Symlink escapes its workspace");
    } else if (
      entry.target !== null ||
      (entry.chunkOffset !== undefined
        ? manifest.version !== 2 ||
          !Number.isSafeInteger(entry.chunkOffset) ||
          entry.chunkOffset < 0 ||
          entry.sizeBytes < 1 ||
          entry.chunkOffset + entry.sizeBytes > CHUNK_BYTES ||
          entry.chunks.length !== 1
        : entry.chunks.length !== Math.ceil(entry.sizeBytes / CHUNK_BYTES))
    )
      throw new Error("Invalid file chunks");
  }
  if (total > 1024 * 1024 * 1024) throw new Error("Workspace exceeds transfer limit");
  // Prevent an entry from using a file or symlink as a directory.
  for (const key of seen) {
    const parts = key.split("/");
    while (parts.length > 2) {
      parts.pop();
      if (seen.has(parts.join("/"))) throw new Error("Invalid workspace hierarchy");
    }
  }
  return manifest;
}

/** Restore only into an empty staging directory; activate it separately. */
export async function restoreWorkspace(manifest, directory, getChunk, options = {}) {
  validateManifest(manifest);
  if (options.prefetch) {
    await NodeFSP.mkdir(NodePath.dirname(directory), { recursive: true });
    const temporary = await NodeFSP.mkdtemp(
      NodePath.join(NodePath.dirname(directory), ".vitre-chunk-cache-"),
    );
    const hashes = [
      ...new Set([
        ...manifest.entries.flatMap((entry) => entry.chunks),
        ...manifest.roots.flatMap((root) =>
          root.git ? [...root.git.bundle.chunks, ...root.git.index.chunks] : [],
        ),
      ]),
    ];
    let next = 0,
      failure;
    try {
      // Disk spooling bounds memory to eight chunks, even for large workspaces.
      await Promise.all(
        Array.from({ length: Math.min(8, hashes.length) }, async () => {
          while (next < hashes.length && !failure) {
            const hash = hashes[next++];
            try {
              const bytes = await getChunk(hash);
              if (!bytes || bytes.length > CHUNK_BYTES || digest(bytes) !== hash)
                throw new Error("Workspace chunk failed verification");
              await NodeFSP.writeFile(NodePath.join(temporary, hash), bytes, {
                mode: 0o600,
                flag: "wx",
              });
            } catch (error) {
              failure ??= error;
            }
          }
        }),
      );
      if (failure) throw failure;
      return await restoreWorkspace(manifest, directory, (hash) =>
        NodeFSP.readFile(NodePath.join(temporary, hash)),
      );
    } finally {
      await NodeFSP.rm(temporary, { recursive: true, force: true });
    }
  }
  // Packed files share blobs. Bound the cache while avoiding a download per file.
  const cache = new Map();
  const readChunk = async (id) => {
    if (cache.has(id)) return cache.get(id);
    const bytes = await getChunk(id);
    if (!bytes || bytes.length > CHUNK_BYTES || digest(bytes) !== id)
      throw new Error("Workspace chunk failed verification");
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(id, bytes);
    return bytes;
  };
  await NodeFSP.mkdir(directory, { recursive: true });
  if ((await NodeFSP.readdir(directory)).length)
    throw new Error("Restore destination must be empty");
  const base = await NodeFSP.realpath(directory);
  for (const root of manifest.roots) await NodeFSP.mkdir(NodePath.join(base, root.id));
  for (const entry of manifest.entries) {
    const path = NodePath.join(base, entry.rootId, entry.path);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    if (entry.kind === "symlink") {
      await NodeFSP.symlink(entry.target, path);
      continue;
    }
    const file = await NodeFSP.open(path, "wx", entry.executable ? 0o755 : 0o644);
    const hash = NodeCrypto.createHash("sha256");
    let size = 0;
    try {
      for (const [index, id] of entry.chunks.entries()) {
        const chunk = await readChunk(id);
        const bytes =
          entry.chunkOffset === undefined
            ? chunk
            : chunk.subarray(entry.chunkOffset, entry.chunkOffset + entry.sizeBytes);
        const expectedSize = Math.min(CHUNK_BYTES, entry.sizeBytes - index * CHUNK_BYTES);
        if (bytes.length !== expectedSize) throw new Error("Workspace chunk failed verification");
        hash.update(bytes);
        size += bytes.length;
        await file.writeFile(bytes);
      }
      if (size !== entry.sizeBytes || hash.digest("hex") !== entry.sha256)
        throw new Error("Workspace file failed verification");
    } finally {
      await file.close();
    }
  }
  for (const root of manifest.roots) {
    if (!root.git) continue;
    const cwd = NodePath.join(base, root.id);
    const readBlob = async (blob) => {
      const parts = [];
      for (const id of blob.chunks) {
        const bytes = await getChunk(id);
        if (!bytes || digest(bytes) !== id) throw new Error("Git data failed verification");
        parts.push(bytes);
      }
      const bytes = Buffer.concat(parts);
      if (bytes.length !== blob.sizeBytes || digest(bytes) !== blob.sha256)
        throw new Error("Git data failed verification");
      return bytes;
    };
    const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-git-restore-"));
    try {
      const bundle = NodePath.join(temporary, "source.bundle");
      await NodeFSP.writeFile(bundle, await readBlob(root.git.bundle));
      await git(cwd, ["init"]);
      if (root.git.commitIdentity) {
        await git(cwd, ["config", "user.name", root.git.commitIdentity.name]);
        await git(cwd, ["config", "user.email", root.git.commitIdentity.email]);
      }
      if (root.git.githubRemote) await git(cwd, ["remote", "add", "origin", root.git.githubRemote]);
      if (root.git.publishedRevision)
        await git(cwd, ["config", "vitre.publishedRevision", root.git.publishedRevision]);
      await git(cwd, ["fetch", bundle, "HEAD"]);
      await git(cwd, ["reset", "--mixed", root.git.head]);
      if (root.git.branch) {
        await git(cwd, ["check-ref-format", "--branch", root.git.branch]);
        await git(cwd, ["symbolic-ref", "HEAD", `refs/heads/${root.git.branch}`]);
        await git(cwd, ["update-ref", "HEAD", root.git.head]);
      }
      const patch = await readBlob(root.git.index);
      if (patch.length) {
        const patchPath = NodePath.join(temporary, "index.patch");
        await NodeFSP.writeFile(patchPath, patch);
        await git(cwd, ["apply", "--cached", "--binary", patchPath]);
      }
    } finally {
      await NodeFSP.rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

/** Three-way plan. Absence represents deletion; differing executable bits also conflict. */
export function planWorkspaceReturn(baseline, local, remote) {
  for (const manifest of [baseline, local, remote]) validateManifest(manifest);
  const index = (manifest) => new Map(manifest.entries.map((e) => [`${e.rootId}/${e.path}`, e]));
  const b = index(baseline),
    l = index(local),
    r = index(remote);
  const same = (a, b) =>
    a === b ||
    !!(a && b && a.kind === b.kind && a.sha256 === b.sha256 && a.executable === b.executable);
  const changes = [],
    conflicts = [];
  for (const path of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
    if (same(b.get(path), r.get(path)) || same(l.get(path), r.get(path))) continue;
    if (!same(b.get(path), l.get(path))) conflicts.push(path);
    else changes.push({ path, entry: r.get(path) ?? null });
  }
  return { changes, conflicts };
}

/** Build the return workspace off to the side. Conflicts never touch either owner. */
export async function prepareWorkspaceReturn({ baseline, local, remote, destination, getChunk }) {
  const plan = planWorkspaceReturn(baseline, local, remote);
  const roots = local.roots.map((root) => {
    const original = baseline.roots.find((item) => item.id === root.id);
    const cloud = remote.roots.find((item) => item.id === root.id);
    if (!original || !cloud) {
      plan.conflicts.push(`${root.id}/`);
      return root;
    }
    // A new local commit or staged change must not be silently replaced by
    // a divergent cloud history, even when their working-tree files agree.
    const identity = (git) => (git ? `${git.head}:${git.index.sha256}` : null);
    if (
      identity(root.git) !== identity(original.git) &&
      identity(cloud.git) !== identity(original.git) &&
      identity(root.git) !== identity(cloud.git)
    )
      plan.conflicts.push(`${root.id}/.git`);
    return identity(cloud.git) !== identity(original.git)
      ? { ...root, ...(cloud.git ? { git: cloud.git } : {}) }
      : root;
  });
  for (const root of remote.roots)
    if (!local.roots.some((item) => item.id === root.id)) plan.conflicts.push(`${root.id}/`);
  if (plan.conflicts.length) return { conflicts: [...new Set(plan.conflicts)], directory: null };
  const entries = new Map(local.entries.map((entry) => [`${entry.rootId}/${entry.path}`, entry]));
  for (const change of plan.changes) {
    if (change.entry) entries.set(change.path, change.entry);
    else entries.delete(change.path);
  }
  const merged = { version: 2, roots, entries: [...entries.values()] };
  // Detect file/directory collisions caused by otherwise independent changes.
  validateManifest(merged);
  const parent = NodePath.dirname(destination);
  await NodeFSP.mkdir(parent, { recursive: true });
  const staging = await NodeFSP.mkdtemp(NodePath.join(parent, ".vitre-return-"));
  try {
    await restoreWorkspace(merged, staging, getChunk);
    const marker = await NodeFSP.open(NodePath.join(staging, ".vitre-return.json"), "wx", 0o600);
    try {
      await marker.writeFile(JSON.stringify({ version: 1 }));
      await marker.sync();
    } finally {
      await marker.close();
    }
    // Claim a new managed directory. Never replace a conversation's workspace.
    await NodeFSP.mkdir(destination);
    try {
      await NodeFSP.rename(staging, destination);
    } catch (error) {
      await NodeFSP.rmdir(destination).catch(() => {});
      throw error;
    }
    return { conflicts: [], directory: destination };
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}
