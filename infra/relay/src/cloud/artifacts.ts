import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CloudError } from "./policy.ts";
import { fromPromise } from "./service.ts";
import { sha256 } from "./crypto.ts";

export interface CloudObjectStorage {
  put: (
    key: string,
    data: Uint8Array<ArrayBuffer>,
    metadata: Record<string, string>,
  ) => Promise<void>;
  get: (key: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  head: (key: string) => Promise<{ size: number; metadata: Record<string, string> } | null>;
  delete: (keys: string[]) => Promise<void>;
  deletePrefix?: (prefix: string) => Promise<void>;
}
export class CloudArtifacts extends Context.Service<CloudArtifacts, CloudObjectStorage>()(
  "t3code-relay/cloud/artifacts/CloudArtifacts",
) {}
const encodeManifest = Schema.encodeEffect(Schema.UnknownFromJsonString);
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

export interface ArtifactChunk {
  index: number;
  sha256: string;
  sizeBytes: number;
}
export interface CheckpointManifest {
  version: 1;
  taskId: string;
  attemptId: string;
  checkpointId: string;
  chunks: ArtifactChunk[];
  result: {
    summary: string;
    diff: string;
    conversation: unknown;
    testOutput: string;
    testExitCode: number | null;
  };
}

export function artifactPrefix(
  userId: string,
  taskId: string,
  attemptId: string,
  checkpointId: string,
): string {
  return ["cloud", userId, taskId, attemptId, checkpointId].map(encodeURIComponent).join("/");
}

export const uploadChunk = Effect.fn("cloud.upload_chunk")(function* (
  prefix: string,
  index: number,
  bytes: Uint8Array<ArrayBuffer>,
) {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= 2048 ||
    bytes.length > MAX_CHUNK_BYTES ||
    bytes.length === 0
  )
    return yield* Effect.fail(
      new CloudError(
        "invalid_chunk",
        "Checkpoint chunk must be 1 byte to 8 MiB with a valid index",
        400,
      ),
    );
  const storage = yield* CloudArtifacts;
  const digest = yield* fromPromise(() => sha256(bytes));
  // Content-addressing makes retries safe and prevents replacing a reviewed artifact.
  const key = `${prefix}/${index}-${digest}`;
  yield* fromPromise(() => storage.put(key, bytes, { sha256: digest }));
  return { index, sha256: digest, sizeBytes: bytes.length };
});

export const finalizeManifest = Effect.fn("cloud.finalize_manifest")(function* (
  userId: string,
  manifest: CheckpointManifest,
) {
  const storage = yield* CloudArtifacts;
  if (manifest.version !== 1 || !manifest.chunks.length || manifest.chunks.length > 1280)
    return yield* Effect.fail(
      new CloudError("invalid_manifest", "Invalid checkpoint manifest", 400),
    );
  const prefix = artifactPrefix(userId, manifest.taskId, manifest.attemptId, manifest.checkpointId);
  let sizeBytes = 0;
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (
      chunk.index !== index ||
      !/^[a-f0-9]{64}$/.test(chunk.sha256) ||
      !Number.isSafeInteger(chunk.sizeBytes) ||
      chunk.sizeBytes < 1 ||
      chunk.sizeBytes > MAX_CHUNK_BYTES
    )
      return yield* Effect.fail(
        new CloudError("invalid_manifest", "Checkpoint chunks are invalid or out of order", 400),
      );
    const object = yield* fromPromise(() => storage.head(`${prefix}/${index}-${chunk.sha256}`));
    if (!object || object.size !== chunk.sizeBytes || object.metadata.sha256 !== chunk.sha256)
      return yield* Effect.fail(
        new CloudError("incomplete_checkpoint", "Checkpoint upload is incomplete"),
      );
    sizeBytes += object.size;
  }
  const serialized = yield* encodeManifest(manifest).pipe(
    Effect.mapError(
      () => new CloudError("invalid_manifest", "Checkpoint manifest is not serializable", 400),
    ),
  );
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.length > MAX_CHUNK_BYTES)
    return yield* Effect.fail(
      new CloudError("result_too_large", "Result exceeds the 8 MiB limit", 400),
    );
  const digest = yield* fromPromise(() => sha256(bytes));
  const objectKey = `${prefix}/manifest-${digest}.json`;
  yield* fromPromise(() => storage.put(objectKey, bytes, { sha256: digest }));
  return { objectKey, sha256: digest, sizeBytes };
});
