import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
const PART_BYTES = 16 * 1024 * 1024;
export async function fileDigest(file) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const bytes of NodeFS.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
/** Immutable object names make ambiguous completion safe to retry. */
export async function publishRuntime({
  file,
  bucket,
  key,
  client,
  partBytes = PART_BYTES,
  progress = () => {},
}) {
  if (!Number.isInteger(partBytes) || partBytes < 5 * 1024 * 1024)
    throw new Error("Multipart parts must be at least 5 MiB");
  const before = await NodeFSP.stat(file);
  if (!before.isFile() || !before.size || Math.ceil(before.size / partBytes) > 10_000)
    throw new Error("Invalid runtime bundle size");
  const sha256 = await fileDigest(file);
  const verify = async () => {
    const remote = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!remote.Body) throw new Error("Published bundle has no body");
    const hash = NodeCrypto.createHash("sha256");
    let size = 0;
    for await (const bytes of remote.Body) {
      hash.update(bytes);
      size += bytes.length;
    }
    if (size !== before.size || hash.digest("hex") !== sha256)
      throw new Error("Published bundle checksum mismatch");
  };
  const existing = await client
    .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    .catch((error) => {
      if (error.$metadata?.httpStatusCode === 404) return null;
      throw error;
    });
  if (existing) {
    if (existing.ContentLength !== before.size || existing.Metadata?.sha256 !== sha256)
      throw new Error("Artifact key already contains a different bundle; choose a new version");
    await verify();
    return { sha256, sizeBytes: before.size, reused: true };
  }
  const { UploadId } = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: "application/gzip",
      Metadata: { sha256 },
    }),
  );
  if (!UploadId) throw new Error("Multipart upload did not return an ID");
  const handle = await NodeFSP.open(file, "r");
  let completed = false;
  try {
    const parts = [];
    for (let offset = 0, PartNumber = 1; offset < before.size; offset += partBytes, PartNumber++) {
      const buffer = Buffer.alloc(Math.min(partBytes, before.size - offset));
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, offset + read);
        if (!bytesRead) throw new Error("Runtime bundle changed during upload");
        read += bytesRead;
      }
      const { ETag } = await client.send(
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber, Body: buffer }),
      );
      if (!ETag) throw new Error("Multipart part did not return an ETag");
      parts.push({ ETag, PartNumber });
      progress(Math.min(offset + buffer.length, before.size), before.size);
    }
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      (await fileDigest(file)) !== sha256
    )
      throw new Error("Runtime bundle changed during upload");
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    completed = true;
    await verify();
    return { sha256, sizeBytes: before.size, reused: false };
  } finally {
    await handle.close();
    if (!completed)
      await client
        .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId }))
        .catch(() => {});
  }
}
export async function createArtifactClient(env = process.env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  let accessKeyId = env.R2_ACCESS_KEY_ID,
    secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    const token = env.CLOUDFLARE_API_TOKEN;
    if (!token)
      throw new Error("R2 credentials or a Cloudflare account token with R2 access are required");
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/tokens/verify`,
      { headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
    );
    const result = await response.json();
    if (!response.ok || !result.success || result.result?.status !== "active")
      throw new Error("Cloudflare account token verification failed");
    accessKeyId = result.result.id;
    secretAccessKey = NodeCrypto.createHash("sha256").update(token).digest("hex");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 4,
  });
}
async function main() {
  const [file, bucket, key] = process.argv.slice(2);
  if (!file || !bucket || !key)
    throw new Error("Usage: publish-runtime.mjs FILE BUCKET IMMUTABLE_KEY");
  const client = await createArtifactClient();
  try {
    const result = await publishRuntime({
      file,
      bucket,
      key,
      client,
      progress: (done, total) => console.error(`Uploaded ${Math.round((done / total) * 100)}%`),
    });
    console.log(`Verified ${result.sizeBytes} bytes\nVITRE_RUNTIME_SHA256=${result.sha256}`);
  } finally {
    client.destroy();
  }
}
if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
