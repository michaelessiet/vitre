// @effect-diagnostics nodeBuiltinImport:off - Fixtures exercise the relay's Node-compatible gzip boundary.
import { describe, expect, it } from "@effect/vitest";
import * as NodeBuffer from "node:buffer";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CloudWorkspaceChunkUpload } from "@t3tools/contracts/cloud";
import { CloudArtifacts } from "./artifacts.ts";
import { putWorkspaceChunk, readWorkspace } from "./workspaces.ts";
import { sha256 } from "./crypto.ts";
import { decodeWorkspaceChunkUpload } from "./workspaceChunkTransport.ts";

const CHUNK_BYTES = 4 * 1024 * 1024;
const decodePayload = Schema.decodeUnknownSync(CloudWorkspaceChunkUpload);
const compressed = (bytes: Uint8Array) => ({
  base64: NodeZlib.gzipSync(bytes, { level: 1 }).toString("base64"),
  encoding: "gzip" as const,
});

describe("workspace chunk transport", () => {
  it.effect("stores identical raw bytes and digests for legacy and compressed uploads", () =>
    Effect.gen(function* () {
      const bytes = NodeBuffer.Buffer.alloc(
        CHUNK_BYTES,
        "tracked source and unpublished Git objects",
      );
      const expectedHash = yield* Effect.promise(() => sha256(bytes));
      const objects = new Map<string, Uint8Array<ArrayBuffer>>();
      for (const payload of [{ base64: bytes.toString("base64") }, compressed(bytes)]) {
        const decoded = yield* Effect.promise(() =>
          decodeWorkspaceChunkUpload(decodePayload(payload)),
        );
        expect(NodeBuffer.Buffer.from(decoded).equals(bytes)).toBe(true);
        yield* Effect.gen(function* () {
          const saved = yield* putWorkspaceChunk("owner", decoded);
          expect(saved.sha256).toBe(expectedHash);
          const stored = yield* readWorkspace("owner", saved.sha256, true);
          expect(NodeBuffer.Buffer.from(stored).equals(bytes)).toBe(true);
        }).pipe(
          Effect.provideService(CloudArtifacts, {
            put: async (key, data) => {
              objects.set(key, data);
            },
            get: async (key) => objects.get(key) ?? null,
            head: async () => null,
            delete: async () => {},
          }),
        );
      }
      expect(objects.size).toBe(1);
    }),
  );

  it("rejects unsupported encodings at the wire schema", () => {
    expect(() => decodePayload({ base64: "YWJj", encoding: "br" })).toThrow();
  });

  it("rejects malformed and noncanonical base64", async () => {
    for (const base64 of ["", "%%%?", "YQ", "YQ=", "YQ===", "YR==", "YW Jj", "YWJj\n"])
      await expect(decodeWorkspaceChunkUpload({ base64 })).rejects.toThrow();
  });

  it("rejects oversized raw and encoded bodies before decompression", async () => {
    const base64 = NodeBuffer.Buffer.alloc(CHUNK_BYTES + 1).toString("base64");
    await expect(decodeWorkspaceChunkUpload({ base64 })).rejects.toThrow();
    await expect(decodeWorkspaceChunkUpload({ base64, encoding: "gzip" })).rejects.toThrow();
  });

  it("rejects truncated gzip, bad checksums and non-gzip data", async () => {
    const valid = NodeZlib.gzipSync(NodeBuffer.Buffer.from("source"));
    const badChecksum = NodeBuffer.Buffer.from(valid);
    badChecksum[badChecksum.length - 8]! ^= 1;
    for (const bytes of [valid.subarray(0, -1), badChecksum, NodeBuffer.Buffer.from("not gzip")])
      await expect(
        decodeWorkspaceChunkUpload({
          base64: bytes.toString("base64"),
          encoding: "gzip",
        }),
      ).rejects.toThrow();
  });

  it("rejects empty output and expansion beyond the 4MiB limit", async () => {
    for (const bytes of [
      NodeBuffer.Buffer.alloc(0),
      NodeBuffer.Buffer.alloc(CHUNK_BYTES + 1),
      NodeBuffer.Buffer.alloc(32 * 1024 * 1024),
    ])
      await expect(decodeWorkspaceChunkUpload(compressed(bytes))).rejects.toThrow();
  });

  it("applies the output limit across concatenated gzip members", async () => {
    const first = NodeZlib.gzipSync(NodeBuffer.Buffer.alloc(CHUNK_BYTES));
    const second = NodeZlib.gzipSync(NodeBuffer.Buffer.from("overflow"));
    await expect(
      decodeWorkspaceChunkUpload({
        base64: NodeBuffer.Buffer.concat([first, second]).toString("base64"),
        encoding: "gzip",
      }),
    ).rejects.toThrow();
  });
});
