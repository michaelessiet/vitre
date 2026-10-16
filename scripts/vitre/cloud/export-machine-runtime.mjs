/** Export an installed Linux filesystem once; worker startup never downloads it. */
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const [image, output] = process.argv.slice(2);
if (!image || !output)
  throw new Error("Usage: export-machine-runtime.mjs IMAGE:VERSION ROOTFS.tar");
let container;
try {
  container = (await exec("docker", ["create", "--platform", "linux/amd64", image])).stdout.trim();
  await exec("docker", ["export", "--output", NodePath.resolve(output), container]);
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(output)) hash.update(chunk);
  console.log(`Runtime SHA256: ${hash.digest("hex")}`);
} finally {
  if (container) await exec("docker", ["rm", container]).catch(() => {});
}
