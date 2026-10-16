// @effect-diagnostics nodeBuiltinImport:off - Durable transfer filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { CloudConversationSnapshot, CloudWorkspaceBlob } from "@t3tools/contracts/cloud";
import { digest } from "../../../../scripts/vitre/cloud/workspace.mjs";
import { ConversationChunkStore } from "./conversationTransfer.ts";

export async function durableJson(path: string, value: unknown): Promise<void> {
  const directory = NodePath.dirname(path);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await NodeFSP.mkdtemp(NodePath.join(directory, ".write-"));
  try {
    const file = await NodeFSP.open(NodePath.join(temporary, "data"), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFSP.rename(NodePath.join(temporary, "data"), path);
    const parent = await NodeFSP.open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}

export async function readJson(path: string): Promise<unknown | null> {
  return NodeFSP.readFile(path, "utf8")
    .then(JSON.parse)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
}

export function snapshotHashes(snapshot: CloudConversationSnapshot): string[] {
  return [
    ...new Set([
      ...snapshot.history.chunks,
      ...snapshot.workspace.entries.flatMap((entry) => entry.chunks),
      ...snapshot.workspace.roots.flatMap((root) =>
        root.git ? [...root.git.bundle.chunks, ...root.git.index.chunks] : [],
      ),
    ]),
  ];
}

export async function readBlob(
  chunks: ConversationChunkStore,
  blob: typeof CloudWorkspaceBlob.Type,
): Promise<Uint8Array> {
  if (blob.sizeBytes > 360 * 1024 * 1024) throw new Error("Conversation exceeds transfer limit");
  const parts = [];
  for (const hash of blob.chunks) parts.push(await chunks.get(hash));
  const bytes = Buffer.concat(parts);
  if (bytes.length !== blob.sizeBytes || digest(bytes) !== blob.sha256)
    throw new Error("Conversation integrity check failed");
  return bytes;
}
