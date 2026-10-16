import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CloudArtifacts, type CloudObjectStorage } from "./artifacts.ts";
import {
  finalizeWorkspace,
  workspaceChunkStatus,
  putWorkspaceChunk,
  readWorkspace,
  verifyAttachments,
  uploadedGitHead,
} from "./workspaces.ts";
import type { CloudWorkspaceManifest } from "@t3tools/contracts/cloud";
function fixture() {
  const objects = new Map<
    string,
    { data: Uint8Array<ArrayBuffer>; metadata: Record<string, string> }
  >();
  const storage: CloudObjectStorage = {
    put: async (key, data, metadata) => {
      objects.set(key, { data, metadata });
    },
    get: async (key) => objects.get(key)?.data ?? null,
    head: async (key) => {
      const value = objects.get(key);
      return value ? { size: value.data.length, metadata: value.metadata } : null;
    },
    delete: async (keys) => {
      keys.forEach((key) => objects.delete(key));
    },
  };
  return <A, E>(effect: Effect.Effect<A, E, CloudArtifacts>) =>
    effect.pipe(Effect.provideService(CloudArtifacts, storage));
}
describe("workspace uploads", () => {
  it("requires a valid nonempty primary Git bundle before bypassing remote resolution", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const blob = { sha256: "b".repeat(64), sizeBytes: 1, chunks: ["c".repeat(64)] };
    const git = { head: "a".repeat(40), branch: "feature", bundle: blob, index: blob };
    const manifest = { version: 2, roots: [{ id: "primary", name: "repo", git }], entries: [] };
    expect(uploadedGitHead(encode(manifest))).toBe(git.head);
    expect(
      uploadedGitHead(encode({ ...manifest, roots: [{ id: "primary", name: "legacy" }] })),
    ).toBeNull();
    expect(() =>
      uploadedGitHead(
        encode({
          ...manifest,
          roots: [
            {
              id: "primary",
              name: "repo",
              git: { ...git, bundle: { ...blob, sizeBytes: 0, chunks: [] } },
            },
          ],
        }),
      ),
    ).toThrow("bundle is empty");
    expect(() =>
      uploadedGitHead(
        encode({
          ...manifest,
          roots: [{ id: "primary", name: "repo", git: { ...git, head: "invalid" } }],
        }),
      ),
    ).toThrow("Invalid workspace manifest");
  });
  it.effect("validates packed file ranges and keeps legacy manifests compatible", () =>
    Effect.gen(function* () {
      const run = fixture();
      const chunk = yield* run(putWorkspaceChunk("owner", new TextEncoder().encode("abcdefgh")));
      const manifest: CloudWorkspaceManifest = {
        version: 2,
        roots: [{ id: "root", name: "test" }],
        entries: [
          {
            rootId: "root",
            path: "file",
            kind: "file",
            executable: false,
            sizeBytes: 4,
            sha256: chunk.sha256,
            chunks: [chunk.sha256],
            chunkOffset: 4,
            target: null,
          },
        ],
      };
      const saved = yield* run(finalizeWorkspace("owner", manifest));
      const reordered = {
        entries: manifest.entries.map(({ chunkOffset, ...entry }) => ({
          ...(chunkOffset === undefined ? {} : { chunkOffset }),
          ...entry,
        })),
        roots: manifest.roots,
        version: manifest.version,
      };
      expect(yield* run(finalizeWorkspace("owner", reordered))).toEqual(saved);
      expect((yield* Effect.flip(run(finalizeWorkspace("other", manifest)))).code).toBe(
        "incomplete_workspace",
      );
      const invalid = { ...manifest, entries: [{ ...manifest.entries[0]!, chunkOffset: 5 }] };
      expect((yield* Effect.flip(run(finalizeWorkspace("owner", invalid)))).code).toBe(
        "incomplete_workspace",
      );
      expect(
        (yield* Effect.flip(run(finalizeWorkspace("owner", { ...manifest, version: 1 })))).code,
      ).toBe("invalid_manifest");
    }),
  );
  it.effect("checks attachment ownership and completeness before queuing a task", () =>
    Effect.gen(function* () {
      const run = fixture();
      const chunk = yield* run(putWorkspaceChunk("owner", new TextEncoder().encode("file")));
      const attachment = {
        type: "file" as const,
        name: "file.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: chunk.sha256,
        chunks: [chunk.sha256],
      };
      yield* run(verifyAttachments("owner", [attachment]));
      expect((yield* Effect.flip(run(verifyAttachments("other", [attachment])))).code).toBe(
        "incomplete_attachment",
      );
      expect(
        (yield* Effect.flip(run(verifyAttachments("owner", [{ ...attachment, chunks: [] }])))).code,
      ).toBe("invalid_attachment");
      expect(
        (yield* Effect.flip(run(verifyAttachments("owner", [{ ...attachment, sizeBytes: 5 }]))))
          .code,
      ).toBe("incomplete_attachment");
    }),
  );
  it.effect("requires complete user-owned chunks and supports immutable retries", () =>
    Effect.gen(function* () {
      const run = fixture();
      const bytes = new TextEncoder().encode("file");
      const chunk = yield* run(putWorkspaceChunk("owner", bytes));
      const manifest: CloudWorkspaceManifest = {
        version: 1,
        roots: [{ id: "root", name: "project" }],
        entries: [
          {
            rootId: "root",
            path: "file",
            kind: "file",
            executable: false,
            sizeBytes: bytes.length,
            sha256: chunk.sha256,
            chunks: [chunk.sha256],
            target: null,
          },
        ],
      };
      expect(yield* run(workspaceChunkStatus("owner", chunk.sha256))).toEqual({ present: true });
      expect(yield* run(workspaceChunkStatus("other", chunk.sha256))).toEqual({ present: false });
      const saved = yield* run(finalizeWorkspace("owner", manifest));
      expect(yield* run(finalizeWorkspace("owner", manifest))).toEqual(saved);
      expect(yield* run(readWorkspace("owner", saved.sha256))).toBeDefined();
      expect((yield* Effect.flip(run(finalizeWorkspace("other", manifest)))).code).toBe(
        "incomplete_workspace",
      );
      expect((yield* Effect.flip(run(readWorkspace("other", saved.sha256)))).code).toBe(
        "incomplete_workspace",
      );
      expect(
        (yield* Effect.flip(
          run(
            finalizeWorkspace("owner", {
              ...manifest,
              entries: [{ ...manifest.entries[0]!, path: "../escape" }],
            }),
          ),
        )).code,
      ).toBe("invalid_manifest");
    }),
  );
});
