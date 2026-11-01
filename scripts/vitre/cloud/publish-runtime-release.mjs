/** Publish a release pointer only after its immutable runtime and installer exist. */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createArtifactClient, fileDigest } from "./publish-runtime.mjs";

export async function publishRelease({
  client,
  bucket,
  revision,
  sha256,
  archive,
  installer,
  now = Date.now(),
}) {
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("A full source revision and runtime SHA-256 are required");
  const sizeBytes = (await NodeFSP.stat(archive)).size;
  if (!sizeBytes || sizeBytes > 32 * 1024 ** 3 || (await fileDigest(archive)) !== sha256)
    throw new Error("Invalid runtime archive");
  const runtime = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: `runtime-${revision}-${sha256}.tar.gz`,
    }),
  );
  if (runtime.ContentLength !== sizeBytes || runtime.Metadata?.sha256 !== sha256)
    throw new Error("The verified runtime must be published before the release pointer");
  const code = await NodeFSP.readFile(installer);
  if (!code.length || code.length > 1024 ** 2) throw new Error("Invalid runtime installer");
  const installerSha256 = NodeCrypto.createHash("sha256").update(code).digest("hex");
  const key = `runtime-installer-${revision}-${installerSha256}.py`;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: code,
      ContentType: "text/plain",
      CacheControl: "public, max-age=31536000, immutable",
      Metadata: { sha256: installerSha256 },
    }),
  );
  const remote = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const verified = remote.Body ? await remote.Body.transformToByteArray() : null;
  if (!verified || !code.equals(Buffer.from(verified)))
    throw new Error("Installer verification failed");
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid release timestamp");
  const manifest = {
    version: 1,
    revision,
    sha256,
    sizeBytes,
    installerSha256,
    installerSizeBytes: code.length,
    publishedAt: now,
  };
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "runtime-production.json",
      Body: JSON.stringify(manifest),
      ContentType: "application/json",
      CacheControl: "no-store",
    }),
  );
  return manifest;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [revision, sha256, archive] = process.argv.slice(2);
  const client = await createArtifactClient();
  try {
    await publishRelease({
      client,
      bucket: process.env.VITRE_CLOUD_RUNTIME_BUCKET,
      revision,
      sha256,
      archive,
      installer: NodeURL.fileURLToPath(new URL("./upgrade-machine.py", import.meta.url)),
    });
    console.log(`Published runtime release ${revision}`);
  } finally {
    client.destroy();
  }
}
