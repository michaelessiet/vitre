import type { CloudWorkspaceManifest } from "../../../packages/contracts/src/cloud.ts";
export const CHUNK_BYTES: number;
export function digest(bytes: string | Uint8Array): string;
export function captureWorkspace(
  roots: readonly { id: string; path: string }[],
  putChunk: (hash: string, bytes: Uint8Array) => Promise<unknown>,
  options?: {
    signal?: AbortSignal;
    onProgress?: (progress: { files: number; bytes: number }) => void;
    beforeVerify?: () => Promise<void>;
  },
): Promise<CloudWorkspaceManifest>;
export function restoreWorkspace(
  manifest: CloudWorkspaceManifest,
  directory: string,
  getChunk: (hash: string) => Promise<Uint8Array>,
  options?: { prefetch?: boolean },
): Promise<void>;
export function validateManifest(manifest: CloudWorkspaceManifest): CloudWorkspaceManifest;
export function planWorkspaceReturn(
  baseline: CloudWorkspaceManifest,
  local: CloudWorkspaceManifest,
  remote: CloudWorkspaceManifest,
): {
  changes: { path: string; entry: CloudWorkspaceManifest["entries"][number] | null }[];
  conflicts: string[];
};
export function prepareWorkspaceReturn(input: {
  baseline: CloudWorkspaceManifest;
  local: CloudWorkspaceManifest;
  remote: CloudWorkspaceManifest;
  destination: string;
  getChunk: (hash: string) => Promise<Uint8Array>;
}): Promise<{ conflicts: string[]; directory: string | null }>;
