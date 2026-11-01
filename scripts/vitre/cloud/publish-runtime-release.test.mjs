import { afterEach, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { publishRelease } from "./publish-runtime-release.mjs";
const cleanups = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});

async function fixture() {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-release-"));
  cleanups.push(() => NodeFSP.rm(dir, { recursive: true, force: true }));
  const archive = NodePath.join(dir, "runtime.gz"),
    installer = NodePath.join(dir, "upgrade.py");
  const bytes = Buffer.from("runtime"),
    code = Buffer.from("reviewed installer");
  await NodeFSP.writeFile(archive, bytes);
  await NodeFSP.writeFile(installer, code);
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const objects = new Map(),
    writes = [];
  const client = {
    send: async (command) => {
      const { Key, Body } = command.input;
      switch (command.constructor.name) {
        case "HeadObjectCommand":
          return { ContentLength: bytes.length, Metadata: { sha256 } };
        case "PutObjectCommand":
          objects.set(Key, Body);
          writes.push(command.input);
          return {};
        case "GetObjectCommand":
          return { Body: { transformToByteArray: async () => objects.get(Key) } };
        default:
          throw new Error("Unexpected request");
      }
    },
  };
  return {
    objects,
    writes,
    client,
    options: {
      client,
      bucket: "releases",
      revision: "a".repeat(40),
      sha256,
      archive,
      installer,
      now: 1000,
    },
  };
}

it("publishes the mutable release pointer last, after verifying immutable inputs", async () => {
  const f = await fixture();
  const manifest = await publishRelease(f.options);
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0].Key).toBe(
    `runtime-installer-${manifest.revision}-${manifest.installerSha256}.py`,
  );
  expect(f.writes[1].Key).toBe("runtime-production.json");
  expect(f.writes[1].CacheControl).toBe("no-store");
  expect(JSON.parse(f.objects.get("runtime-production.json"))).toEqual(manifest);
});

it("never publishes a release pointer for a missing runtime or corrupt installer", async () => {
  const f = await fixture();
  const send = f.client.send;
  f.client.send = async (command) =>
    command.constructor.name === "HeadObjectCommand" ? { ContentLength: 1 } : send(command);
  await expect(publishRelease(f.options)).rejects.toThrow("runtime must be published");
  expect(f.writes).toHaveLength(0);
  f.client.send = async (command) =>
    command.constructor.name === "GetObjectCommand"
      ? { Body: { transformToByteArray: async () => Buffer.from("bad") } }
      : send(command);
  await expect(publishRelease(f.options)).rejects.toThrow("verification failed");
  expect(f.objects.has("runtime-production.json")).toBe(false);
});
