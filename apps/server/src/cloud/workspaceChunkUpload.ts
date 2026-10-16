// @effect-diagnostics nodeBuiltinImport:off - Node-only transfer compression; keep compression off the event loop.
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import type { CloudWorkspaceChunkUpload } from "@t3tools/contracts/cloud";

const gzip = NodeUtil.promisify(NodeZlib.gzip);
const CHUNK_BYTES = 4 * 1024 * 1024;
const GZIP_FIELD_BYTES = ',"encoding":"gzip"'.length;

export async function encodeWorkspaceChunkUpload(
  bytes: Uint8Array,
): Promise<CloudWorkspaceChunkUpload> {
  if (!bytes.length || bytes.length > CHUNK_BYTES) throw new Error("Invalid workspace chunk size");
  const compressed = await gzip(bytes, { level: 1 });
  // Include JSON/base64 overhead: small or incompressible chunks stay raw.
  if (Math.ceil(compressed.length / 3) * 4 + GZIP_FIELD_BYTES < Math.ceil(bytes.length / 3) * 4)
    return { base64: compressed.toString("base64"), encoding: "gzip" };
  return { base64: Buffer.from(bytes).toString("base64") };
}
