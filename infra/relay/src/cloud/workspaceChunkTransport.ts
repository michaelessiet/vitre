// @effect-diagnostics nodeBuiltinImport:off - The relay enables nodejs_compat; zlib enforces its output limit during decompression.
import * as NodeBuffer from "node:buffer";
import type { CloudWorkspaceChunkUpload } from "@t3tools/contracts/cloud";

const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(CHUNK_BYTES / 3) * 4;

/** Decode at the HTTP boundary. Stored bytes and hashes retain their original
 * representation, so old manifests and workers need no conversion. */
export async function decodeWorkspaceChunkUpload(
  payload: CloudWorkspaceChunkUpload,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    (payload.encoding !== undefined && payload.encoding !== "gzip") ||
    !payload.base64.length ||
    payload.base64.length > MAX_BASE64_LENGTH ||
    payload.base64.length % 4 !== 0
  )
    throw new Error("Invalid workspace chunk encoding");
  const encoded = NodeBuffer.Buffer.from(payload.base64, "base64");
  if (
    !encoded.length ||
    encoded.length > CHUNK_BYTES ||
    encoded.toString("base64") !== payload.base64
  )
    throw new Error("Invalid workspace chunk encoding");
  // Loading Node's compression stack at module scope adds work to every relay
  // isolate startup. Legacy/raw uploads do not need it at all.
  const decoded =
    payload.encoding === "gzip"
      ? (await import("node:zlib")).gunzipSync(encoded, { maxOutputLength: CHUNK_BYTES })
      : encoded;
  if (!decoded.length || decoded.length > CHUNK_BYTES)
    throw new Error("Invalid workspace chunk size");
  return new Uint8Array(decoded);
}
