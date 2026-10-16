import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeStream from "node:stream";
import { publishRuntime } from "./publish-runtime.mjs";
const directories = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await NodeFSP.rm(path, { recursive: true, force: true });
});
async function fixture() {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-publish-test-"));
  directories.push(dir);
  const file = NodePath.join(dir, "bundle.tgz");
  await NodeFSP.writeFile(file, Buffer.alloc(6 * 1024 * 1024, 7));
  const parts = [];
  const operations = [];
  let object, metadata;
  const client = {
    send: async (command) => {
      const op = command.constructor.name;
      operations.push(op);
      switch (op) {
        case "HeadObjectCommand":
          if (object) return { ContentLength: object.length, Metadata: metadata };
          throw Object.assign(new Error("Missing"), { $metadata: { httpStatusCode: 404 } });
        case "CreateMultipartUploadCommand":
          metadata = command.input.Metadata;
          return { UploadId: "upload" };
        case "UploadPartCommand":
          parts.push(command.input.Body);
          return { ETag: `part-${parts.length}` };
        case "CompleteMultipartUploadCommand":
          object = Buffer.concat(parts);
          return {};
        case "GetObjectCommand":
          return { Body: NodeStream.Readable.from([object]) };
        case "AbortMultipartUploadCommand":
          return {};
        default:
          throw new Error("Unexpected operation");
      }
    },
  };
  return {
    file,
    client,
    operations,
    options: { file, bucket: "artifacts", key: "v4.tgz", client, partBytes: 5 * 1024 * 1024 },
  };
}
describe("runtime publishing", () => {
  it("uploads multiple parts, verifies downloaded bytes and safely retries completed releases", async () => {
    const f = await fixture();
    const result = await publishRuntime(f.options);
    expect(result.sizeBytes).toBe(6 * 1024 * 1024);
    expect(f.operations.filter((op) => op === "UploadPartCommand")).toHaveLength(2);
    expect(f.operations).toContain("GetObjectCommand");
    expect((await publishRuntime(f.options)).reused).toBe(true);
    await NodeFSP.appendFile(f.file, "changed");
    await expect(publishRuntime(f.options)).rejects.toThrow("different bundle");
  });
  it("aborts failed multipart uploads and never accepts a corrupt download", async () => {
    const f = await fixture();
    const send = f.client.send;
    f.client.send = async (command) => {
      if (command.constructor.name === "UploadPartCommand") throw new Error("Upload interrupted");
      return send(command);
    };
    await expect(publishRuntime(f.options)).rejects.toThrow("interrupted");
    expect(f.operations).toContain("AbortMultipartUploadCommand");
    f.client.send = async (command) =>
      command.constructor.name === "GetObjectCommand"
        ? { Body: NodeStream.Readable.from([Buffer.from("corrupt")]) }
        : send(command);
    await expect(publishRuntime(f.options)).rejects.toThrow("checksum mismatch");
  });
});
