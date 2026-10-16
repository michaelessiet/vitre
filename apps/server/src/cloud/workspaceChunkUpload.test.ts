// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the Node transfer compression boundary.
import { describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { encodeWorkspaceChunkUpload } from "./workspaceChunkUpload.ts";

describe("workspace chunk upload encoding", () => {
  it("compresses source chunks without changing decoded bytes or their digest", async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, "export const fixture = 'tracked source';\n");
    const encoded = await encodeWorkspaceChunkUpload(bytes);
    expect(encoded.encoding).toBe("gzip");
    expect(JSON.stringify(encoded).length).toBeLessThan(
      JSON.stringify({ base64: bytes.toString("base64") }).length,
    );
    const decoded = NodeZlib.gunzipSync(Buffer.from(encoded.base64, "base64"));
    expect(decoded.equals(bytes)).toBe(true);
    expect(NodeCrypto.createHash("sha256").update(decoded).digest("hex")).toBe(
      NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    );
  });

  it("keeps tiny and incompressible chunks in the legacy representation", async () => {
    for (const bytes of [Buffer.from("abc"), NodeCrypto.randomBytes(4096)]) {
      expect(await encodeWorkspaceChunkUpload(bytes)).toEqual({ base64: bytes.toString("base64") });
    }
  });

  it("rejects empty and oversized source chunks before compression", async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(4 * 1024 * 1024 + 1)])
      await expect(encodeWorkspaceChunkUpload(bytes)).rejects.toThrow("chunk size");
  });
});
