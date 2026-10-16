import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  CloudArtifacts,
  finalizeManifest,
  uploadChunk,
  artifactPrefix,
  type CheckpointManifest,
  type CloudObjectStorage,
} from "./artifacts.ts";

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
      const object = objects.get(key);
      return object ? { size: object.data.length, metadata: object.metadata } : null;
    },
    delete: async (keys) => {
      keys.forEach((key) => objects.delete(key));
    },
  };
  const run = <A, E>(effect: Effect.Effect<A, E, CloudArtifacts>) =>
    effect.pipe(Effect.provideService(CloudArtifacts, storage));
  const manifest: CheckpointManifest = {
    version: 1,
    taskId: "task",
    attemptId: "attempt",
    checkpointId: "checkpoint",
    chunks: [],
    result: { summary: "Done", diff: "", conversation: null, testOutput: "", testExitCode: 0 },
  };
  return {
    objects,
    run,
    manifest,
    prefix: artifactPrefix("user", "task", "attempt", "checkpoint"),
  };
}

describe("cloud artifact finalization", () => {
  it.effect("publishes a manifest only after every chunk is present and verified", () =>
    Effect.gen(function* () {
      const f = fixture();
      const chunk = yield* f.run(
        uploadChunk(f.prefix, 0, new TextEncoder().encode("archive bytes")),
      );
      f.manifest.chunks = [chunk];
      const first = yield* f.run(finalizeManifest("user", f.manifest));
      expect(yield* f.run(finalizeManifest("user", f.manifest))).toEqual(first);
      expect(f.objects.has(first.objectKey)).toBe(true);
      f.objects.delete(`${f.prefix}/0-${chunk.sha256}`);
      expect((yield* Effect.flip(f.run(finalizeManifest("user", f.manifest)))).message).toContain(
        "incomplete",
      );
    }),
  );
  it.effect("rejects foreign chunks, mismatched sizes, and invalid ordering", () =>
    Effect.gen(function* () {
      const f = fixture();
      const chunk = yield* f.run(uploadChunk(f.prefix, 0, new Uint8Array([1])));
      f.manifest.chunks = [chunk];
      expect(
        (yield* Effect.flip(f.run(finalizeManifest("other-user", f.manifest)))).message,
      ).toContain("incomplete");
      f.manifest.chunks = [{ ...chunk, sizeBytes: 2 }];
      expect((yield* Effect.flip(f.run(finalizeManifest("user", f.manifest)))).message).toContain(
        "incomplete",
      );
      f.manifest.chunks = [{ ...chunk, index: 1 }];
      expect((yield* Effect.flip(f.run(finalizeManifest("user", f.manifest)))).message).toContain(
        "out of order",
      );
      expect([...f.objects.keys()].every((key) => !key.includes("manifest-"))).toBe(true);
    }),
  );
});
