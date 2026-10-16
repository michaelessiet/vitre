// @effect-diagnostics nodeBuiltinImport:off - Isolated merge workspace, never the user's original directory.
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import type { CloudWorkspaceManifest } from "@t3tools/contracts/cloud";
import {
  planWorkspaceReturn,
  restoreWorkspace,
} from "../../../../scripts/vitre/cloud/workspace.mjs";
import { ConversationChunkStore } from "./conversationTransfer.ts";

export function mergeConflictChoice(
  baseline: CloudWorkspaceManifest,
  local: CloudWorkspaceManifest,
  remote: CloudWorkspaceManifest,
  conflicts: readonly string[],
  choice: "local" | "cloud",
): CloudWorkspaceManifest {
  const entries = new Map(local.entries.map((entry) => [`${entry.rootId}/${entry.path}`, entry]));
  for (const change of planWorkspaceReturn(baseline, local, remote).changes) {
    if (change.entry) entries.set(change.path, change.entry);
    else entries.delete(change.path);
  }
  const selected = choice === "local" ? local : remote;
  for (const path of conflicts) {
    const entry = selected.entries.find((entry) => `${entry.rootId}/${entry.path}` === path);
    if (entry) entries.set(path, entry);
    else entries.delete(path);
  }
  return {
    version: 2,
    entries: [...entries.values()],
    roots: local.roots.map((root) => {
      const original = baseline.roots.find((item) => item.id === root.id);
      const cloud = remote.roots.find((item) => item.id === root.id);
      if (conflicts.includes(`${root.id}/.git`))
        return selected.roots.find((item) => item.id === root.id) ?? root;
      return cloud && JSON.stringify(cloud.git) !== JSON.stringify(original?.git) ? cloud : root;
    }),
  };
}

export async function createConflictWorkspace(input: {
  baseline: CloudWorkspaceManifest;
  local: CloudWorkspaceManifest;
  remote: CloudWorkspaceManifest;
  conflicts: readonly string[];
  destination: string;
  chunks: ConversationChunkStore;
}) {
  const { baseline, local, remote, conflicts, destination, chunks } = input;
  const merged = mergeConflictChoice(baseline, local, remote, conflicts, "cloud");
  const staging = `${destination}-staging`;
  await NodeFSP.rm(staging, { recursive: true, force: true });
  await restoreWorkspace(merged, staging, (hash) => chunks.get(hash));
  for (const path of conflicts) {
    const left = local.entries.find((entry) => `${entry.rootId}/${entry.path}` === path);
    const right = remote.entries.find((entry) => `${entry.rootId}/${entry.path}` === path);
    if (
      left?.kind !== "file" ||
      right?.kind !== "file" ||
      left.sizeBytes > 1024 * 1024 ||
      right.sizeBytes > 1024 * 1024
    )
      continue;
    const a = Buffer.concat(await Promise.all(left.chunks.map((hash) => chunks.get(hash))));
    const b = Buffer.concat(await Promise.all(right.chunks.map((hash) => chunks.get(hash))));
    if (a.includes(0) || b.includes(0)) continue;
    await NodeFSP.writeFile(
      NodePath.join(staging, path),
      `<<<<<<< Local\n${a.toString("utf8")}\n=======\n${b.toString("utf8")}\n>>>>>>> Cloud\n`,
    );
  }
  await NodeFSP.rename(staging, destination);
  return merged.roots.map((root) => ({ id: root.id, path: NodePath.join(destination, root.id) }));
}
