// Run inside the disposable Linux environment, as the unprivileged setup user.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import {
  uploadAttachments,
  downloadAttachments,
  exportAttachmentFiles,
  restoreAttachmentFiles,
} from "/opt/vitre/cloud/attachments.mjs";
import { captureWorkspace, restoreWorkspace } from "/opt/vitre/cloud/workspace.mjs";
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-workspace-smoke-"));
try {
  const attachmentChunks = new Map();
  const attachmentBytes = Buffer.alloc(4 * 1024 * 1024 + 3, 137);
  const uploadedAttachment = {
    type: "file",
    name: "binary.bin",
    mimeType: "application/octet-stream",
    sizeBytes: attachmentBytes.length,
    dataUrl: `data:application/octet-stream;base64,${attachmentBytes.toString("base64")}`,
  };
  const attachments = await uploadAttachments([uploadedAttachment], async (hash, bytes) =>
    attachmentChunks.set(hash, bytes),
  );
  NodeAssert.deepEqual(
    await downloadAttachments(attachments, async (hash) => attachmentChunks.get(hash)),
    [uploadedAttachment],
  );
  const attachmentDirectory = NodePath.join(root, "attachments");
  await NodeFSP.mkdir(attachmentDirectory);
  await NodeFSP.writeFile(NodePath.join(attachmentDirectory, "message-file.bin"), attachmentBytes);
  const savedAttachments = await exportAttachmentFiles(attachmentDirectory);
  await restoreAttachmentFiles(savedAttachments, NodePath.join(root, "restored-attachments"));
  NodeAssert.deepEqual(
    await NodeFSP.readFile(NodePath.join(root, "restored-attachments/message-file.bin")),
    attachmentBytes,
  );
  const payload = JSON.parse(Buffer.from(process.env.VITRE_SMOKE_PAYLOAD, "base64").toString());
  await restoreWorkspace(payload.manifest, NodePath.join(root, "local"), async (hash) =>
    Buffer.from(payload.chunks[hash], "base64"),
  );
  NodeAssert.deepEqual(
    await NodeFSP.readFile(NodePath.join(root, "local/root/binary")),
    Buffer.from([0, 255, 1]),
  );
  await NodeFSP.writeFile(NodePath.join(root, "local/root/file"), "changed in Linux cloud");
  const chunks = {};
  const manifest = await captureWorkspace(
    [{ id: "root", path: NodePath.join(root, "local/root") }],
    async (hash, bytes) => {
      chunks[hash] = Buffer.from(bytes).toString("base64");
    },
  );
  await exec(
    "git",
    ["clone", "https://github.com/octocat/Hello-World.git", NodePath.join(root, "github")],
    { timeout: 60_000 },
  );
  const gitChunks = new Map();
  const github = await captureWorkspace(
    [{ id: "root", path: NodePath.join(root, "github") }],
    async (hash, bytes) => gitChunks.set(hash, bytes),
  );
  await restoreWorkspace(github, NodePath.join(root, "github-restored"), async (hash) =>
    gitChunks.get(hash),
  );
  const head = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: NodePath.join(root, "github-restored/root") })
  ).stdout.trim();
  NodeAssert.equal(head, github.roots[0].git.head);
  console.log(
    `VITRE_WORKSPACE_RESULT=${Buffer.from(JSON.stringify({ manifest, chunks })).toString("base64")}`,
  );
  console.log("VITRE_WORKSPACE_SMOKE_PASS");
} finally {
  await NodeFSP.rm(root, { recursive: true, force: true });
}
