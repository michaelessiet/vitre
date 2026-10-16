import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = 10 * 1024 * 1024;
const digest = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
function metadata(attachment) {
  if (
    !["file", "image"].includes(attachment.type) ||
    typeof attachment.name !== "string" ||
    !attachment.name.trim() ||
    attachment.name.length > 255 ||
    typeof attachment.mimeType !== "string" ||
    !/^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) ||
    (attachment.type === "image" && !attachment.mimeType.startsWith("image/")) ||
    !Number.isSafeInteger(attachment.sizeBytes) ||
    attachment.sizeBytes < 0 ||
    attachment.sizeBytes > MAX_BYTES
  )
    throw new Error("Invalid cloud attachment");
  return {
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
}
export async function uploadAttachments(attachments, putChunk) {
  if (attachments.length > 8) throw new Error("Too many attachments");
  // Validate the entire request before sending any bytes.
  const uploads = attachments.map((attachment) => {
    const meta = metadata(attachment);
    const prefix = `data:${meta.mimeType};base64,`;
    if (typeof attachment.dataUrl !== "string" || !attachment.dataUrl.startsWith(prefix))
      throw new Error("Invalid attachment data URL");
    const encoded = attachment.dataUrl.slice(prefix.length);
    if (encoded.length > Math.ceil(MAX_BYTES / 3) * 4)
      throw new Error("Invalid attachment encoding");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== meta.sizeBytes || bytes.toString("base64") !== encoded)
      throw new Error("Attachment size mismatch");
    return { meta, bytes };
  });
  const result = [];
  for (const { meta, bytes } of uploads) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
      const hash = digest(chunk);
      await putChunk(hash, chunk);
      chunks.push(hash);
    }
    result.push({ ...meta, sha256: digest(bytes), chunks });
  }
  return result;
}
export async function downloadAttachments(attachments, getChunk) {
  if (attachments.length > 8) throw new Error("Too many attachments");
  const result = [];
  for (const attachment of attachments) {
    const meta = metadata(attachment);
    if (
      !/^[a-f0-9]{64}$/.test(attachment.sha256) ||
      attachment.chunks.length !== Math.ceil(meta.sizeBytes / CHUNK_BYTES)
    )
      throw new Error("Invalid attachment manifest");
    const parts = [];
    for (const [index, hash] of attachment.chunks.entries()) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid attachment chunk");
      const bytes = Buffer.from(await getChunk(hash));
      if (
        bytes.length !== Math.min(CHUNK_BYTES, meta.sizeBytes - index * CHUNK_BYTES) ||
        digest(bytes) !== hash
      )
        throw new Error("Attachment integrity check failed");
      parts.push(bytes);
    }
    const bytes = Buffer.concat(parts);
    if (digest(bytes) !== attachment.sha256) throw new Error("Attachment integrity check failed");
    result.push({ ...meta, dataUrl: `data:${meta.mimeType};base64,${bytes.toString("base64")}` });
  }
  return result;
}

// Conversation attachment files are outside the workspace. Archive them explicitly;
// workspace ignore rules must not discard something the user deliberately attached.
export async function exportAttachmentFiles(directory, selectedNames) {
  const stat = await NodeFSP.lstat(directory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return [];
  if (!stat.isDirectory()) throw new Error("Unsafe attachment directory");
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const result = [];
  let total = 0;
  for (const entry of entries) {
    if (selectedNames && !selectedNames.includes(entry.name)) continue;
    if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?$/.test(entry.name) || !entry.isFile())
      throw new Error("Unsafe attachment file");
    const handle = await NodeFSP.open(
      NodePath.join(directory, entry.name),
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    try {
      const before = await handle.stat();
      total += before.size;
      if (!before.isFile() || before.size > MAX_BYTES || total > 256 * 1024 * 1024)
        throw new Error("Attachment archive exceeds transfer limits");
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        before.size !== bytes.length ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("Attachment changed during capture");
      result.push({ name: entry.name, sha256: digest(bytes), base64: bytes.toString("base64") });
    } finally {
      await handle.close();
    }
  }
  return result;
}
export async function restoreAttachmentFiles(files, directory) {
  const names = new Set();
  let total = 0;
  if (!Array.isArray(files) || files.length > 100_000)
    throw new Error("Invalid attachment archive");
  // Validate every member before making any destination changes.
  const decoded = files.map((file) => {
    if (
      !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?$/.test(file.name) ||
      names.has(file.name) ||
      typeof file.base64 !== "string" ||
      file.base64.length > Math.ceil(MAX_BYTES / 3) * 4
    )
      throw new Error("Invalid attachment archive");
    names.add(file.name);
    const bytes = Buffer.from(file.base64, "base64");
    total += bytes.length;
    if (
      bytes.length > MAX_BYTES ||
      total > 256 * 1024 * 1024 ||
      digest(bytes) !== file.sha256 ||
      bytes.toString("base64") !== file.base64
    )
      throw new Error("Attachment integrity check failed");
    return { name: file.name, bytes };
  });
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await NodeFSP.lstat(directory)).isDirectory())
    throw new Error("Unsafe attachment directory");
  for (const file of decoded) {
    const target = NodePath.join(directory, file.name);
    // Atomic file replacement never follows an existing symlink.
    const temporary = await NodeFSP.mkdtemp(NodePath.join(directory, ".restore-"));
    try {
      const staged = NodePath.join(temporary, "file");
      await NodeFSP.writeFile(staged, file.bytes, { mode: 0o600, flag: "wx" });
      await NodeFSP.rename(staged, target);
    } finally {
      await NodeFSP.rm(temporary, { recursive: true, force: true });
    }
  }
}
