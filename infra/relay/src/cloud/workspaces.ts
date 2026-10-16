import { stableStringify } from "@t3tools/shared/relaySigning";
// @effect-diagnostics preferSchemaOverJson:off - Manifests are content addressed using identical JSON bytes on Node and Workers.
import { CloudWorkspaceManifest, type CloudAttachment } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CloudArtifacts } from "./artifacts.ts";
import { sha256 } from "./crypto.ts";
import { CloudError } from "./policy.ts";
import { fromPromise } from "./service.ts";

const CHUNK_BYTES = 4 * 1024 * 1024;
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(CloudWorkspaceManifest));

/** An owned, finalized snapshot carries its own repository, including unpublished commits. */
export function uploadedGitHead(bytes: Uint8Array): string | null {
  let manifest: CloudWorkspaceManifest;
  try {
    manifest = decodeManifest(new TextDecoder().decode(bytes));
  } catch {
    throw new CloudError("invalid_manifest", "Invalid workspace manifest", 400);
  }
  const git = manifest.roots[0]?.git;
  if (!git) return null;
  if (!git.bundle.sizeBytes || !git.bundle.chunks.length)
    throw new CloudError("invalid_manifest", "Workspace Git bundle is empty", 400);
  return git.head;
}

export const workspacePrefix = (userId: string) => `cloud-workspaces/${encodeURIComponent(userId)}`;
export const verifyConversationBlob = Effect.fn("cloud.conversation.verify")(function* (
  userId: string,
  blob: { sizeBytes: number; sha256: string; chunks: readonly string[] },
) {
  const storage = yield* CloudArtifacts;
  if (
    blob.sizeBytes > 360 * 1024 * 1024 ||
    blob.chunks.length !== Math.ceil(blob.sizeBytes / CHUNK_BYTES)
  )
    return yield* Effect.fail(
      new CloudError("invalid_conversation", "Conversation transfer is too large", 400),
    );
  for (const [index, hash] of blob.chunks.entries()) {
    const object = yield* fromPromise(() =>
      storage.head(`${workspacePrefix(userId)}/chunks/${hash}`),
    );
    if (
      !object ||
      object.metadata.sha256 !== hash ||
      object.size !== Math.min(CHUNK_BYTES, blob.sizeBytes - index * CHUNK_BYTES)
    )
      return yield* Effect.fail(
        new CloudError("incomplete_conversation", "Conversation upload is incomplete", 409),
      );
  }
});
export const putWorkspaceChunk = Effect.fn("cloud.workspace.upload")(function* (
  userId: string,
  bytes: Uint8Array<ArrayBuffer>,
): Effect.fn.Return<{ sha256: string }, CloudError, CloudArtifacts> {
  if (!bytes.length || bytes.length > CHUNK_BYTES)
    return yield* Effect.fail(
      new CloudError("invalid_chunk", "Workspace chunks must be between 1 byte and 4 MiB", 400),
    );
  const storage = yield* CloudArtifacts;
  const hash = yield* fromPromise(() => sha256(bytes));
  yield* fromPromise(() =>
    storage.put(`${workspacePrefix(userId)}/chunks/${hash}`, bytes, { sha256: hash }),
  );
  return { sha256: hash };
});
export const workspaceChunkStatus = Effect.fn("cloud.workspace.chunk_status")(function* (
  userId: string,
  hash: string,
) {
  const storage = yield* CloudArtifacts;
  const object = yield* fromPromise(() =>
    storage.head(`${workspacePrefix(userId)}/chunks/${hash}`),
  );
  return {
    present:
      !!object && object.metadata.sha256 === hash && object.size > 0 && object.size <= CHUNK_BYTES,
  };
});
export const finalizeWorkspace = Effect.fn("cloud.workspace.finalize")(function* (
  userId: string,
  manifest: CloudWorkspaceManifest,
): Effect.fn.Return<{ id: string; sha256: string }, CloudError, CloudArtifacts> {
  if (
    ![1, 2].includes(manifest.version) ||
    !manifest.roots.length ||
    manifest.roots.length > 16 ||
    manifest.entries.length > 100_000
  )
    return yield* Effect.fail(new CloudError("invalid_manifest", "Invalid workspace size", 400));
  const storage = yield* CloudArtifacts;
  const roots = new Set(manifest.roots.map((root) => root.id));
  const checked = new Map<string, ReturnType<typeof storage.head>>();
  const head = (hash: string) => {
    let pending = checked.get(hash);
    if (!pending) {
      pending = storage.head(`${workspacePrefix(userId)}/chunks/${hash}`);
      checked.set(hash, pending);
    }
    return pending;
  };
  // Bound storage fan-out while avoiding one network round trip per file.
  const hashes = new Set(manifest.entries.flatMap((entry) => entry.chunks));
  for (const root of manifest.roots) {
    for (const blob of root.git ? [root.git.bundle, root.git.index] : [])
      for (const hash of blob.chunks) hashes.add(hash);
  }
  yield* Effect.forEach([...hashes], (hash) => fromPromise(() => head(hash)), {
    concurrency: 16,
    discard: true,
  });
  const paths = new Set<string>();
  let total = 0;
  if (roots.size !== manifest.roots.length)
    return yield* Effect.fail(new CloudError("invalid_manifest", "Duplicate workspace roots", 400));
  for (const entry of manifest.entries) {
    const key = `${entry.rootId}/${entry.path}`;
    if (
      !roots.has(entry.rootId) ||
      paths.has(key) ||
      entry.path.includes("\\") ||
      entry.path.includes("\0") ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      /^[a-z]:/i.test(entry.path)
    )
      return yield* Effect.fail(new CloudError("invalid_manifest", "Invalid workspace path", 400));
    paths.add(key);
    total += entry.sizeBytes;
    if (
      entry.sizeBytes > 256 * 1024 * 1024 ||
      total > 1024 * 1024 * 1024 ||
      (entry.chunkOffset !== undefined &&
        (manifest.version !== 2 ||
          entry.kind !== "file" ||
          !Number.isSafeInteger(entry.chunkOffset) ||
          entry.chunkOffset < 0 ||
          entry.sizeBytes < 1 ||
          entry.chunkOffset + entry.sizeBytes > CHUNK_BYTES ||
          entry.chunks.length !== 1)) ||
      entry.chunks.length !== (entry.kind === "file" ? Math.ceil(entry.sizeBytes / CHUNK_BYTES) : 0)
    )
      return yield* Effect.fail(
        new CloudError("invalid_manifest", "Workspace exceeds transfer limits", 400),
      );
    for (const [index, hash] of entry.chunks.entries()) {
      const object = yield* fromPromise(() => head(hash));
      if (
        !object ||
        object.metadata.sha256 !== hash ||
        (entry.chunkOffset === undefined
          ? object.size !== Math.min(CHUNK_BYTES, entry.sizeBytes - index * CHUNK_BYTES)
          : object.size > CHUNK_BYTES || entry.chunkOffset + entry.sizeBytes > object.size)
      )
        return yield* Effect.fail(
          new CloudError("incomplete_workspace", "Workspace upload is incomplete", 409),
        );
    }
  }
  for (const root of manifest.roots) {
    if (!root.git) continue;
    for (const blob of [root.git.bundle, root.git.index]) {
      total += blob.sizeBytes;
      if (
        total > 1024 * 1024 * 1024 ||
        blob.sizeBytes > 256 * 1024 * 1024 ||
        blob.chunks.length !== Math.ceil(blob.sizeBytes / CHUNK_BYTES)
      )
        return yield* Effect.fail(new CloudError("invalid_manifest", "Invalid Git data size", 400));
      for (const [index, hash] of blob.chunks.entries()) {
        const object = yield* fromPromise(() => head(hash));
        if (
          !object ||
          object.metadata.sha256 !== hash ||
          object.size !== Math.min(CHUNK_BYTES, blob.sizeBytes - index * CHUNK_BYTES)
        )
          return yield* Effect.fail(
            new CloudError("incomplete_workspace", "Git data upload is incomplete", 409),
          );
      }
    }
  }
  const bytes = new TextEncoder().encode(
    manifest.version === 2 ? stableStringify(manifest) : JSON.stringify(manifest),
  );
  if (bytes.length > 8 * 1024 * 1024)
    return yield* Effect.fail(
      new CloudError("invalid_manifest", "Workspace manifest is too large", 400),
    );
  const hash = yield* fromPromise(() => sha256(bytes));
  yield* fromPromise(() =>
    storage.put(`${workspacePrefix(userId)}/manifests/${hash}`, bytes, { sha256: hash }),
  );
  return { id: hash, sha256: hash };
});
export const readWorkspace = Effect.fn("cloud.workspace.read")(function* (
  userId: string,
  hash: string,
  chunk = false,
): Effect.fn.Return<Uint8Array<ArrayBuffer>, CloudError, CloudArtifacts> {
  const storage = yield* CloudArtifacts;
  const bytes = yield* fromPromise(() =>
    storage.get(`${workspacePrefix(userId)}/${chunk ? "chunks" : "manifests"}/${hash}`),
  );
  if (!bytes || (yield* fromPromise(() => sha256(bytes))) !== hash)
    return yield* Effect.fail(
      new CloudError("incomplete_workspace", "Workspace content is unavailable", 409),
    );
  return bytes;
});

export const verifyAttachments = Effect.fn("cloud.attachments.verify")(function* (
  userId: string,
  attachments: readonly CloudAttachment[],
) {
  if (attachments.length > 8)
    return yield* Effect.fail(new CloudError("invalid_attachment", "Too many attachments", 400));
  for (const attachment of attachments) {
    if (
      attachment.sizeBytes > 10 * 1024 * 1024 ||
      attachment.chunks.length !== Math.ceil(attachment.sizeBytes / CHUNK_BYTES) ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) ||
      (attachment.type === "image" && !attachment.mimeType.startsWith("image/"))
    )
      return yield* Effect.fail(
        new CloudError("invalid_attachment", "Invalid attachment metadata", 400),
      );
    const bytes = new Uint8Array(attachment.sizeBytes);
    for (const [index, hash] of attachment.chunks.entries()) {
      const part = yield* readWorkspace(userId, hash, true).pipe(
        Effect.mapError(
          () => new CloudError("incomplete_attachment", "Attachment upload is incomplete", 409),
        ),
      );
      if (part.length !== Math.min(CHUNK_BYTES, attachment.sizeBytes - index * CHUNK_BYTES))
        return yield* Effect.fail(
          new CloudError("incomplete_attachment", "Attachment upload is incomplete", 409),
        );
      bytes.set(part, index * CHUNK_BYTES);
    }
    if ((yield* fromPromise(() => sha256(bytes))) !== attachment.sha256)
      return yield* Effect.fail(
        new CloudError("invalid_attachment", "Attachment checksum does not match", 400),
      );
  }
});
