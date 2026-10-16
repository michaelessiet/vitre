import { describe, expect, it } from "vite-plus/test";
import { uploadAttachments, downloadAttachments } from "./attachments.mjs";
const upload = (bytes, type = "file", mimeType = "application/octet-stream") => ({
  type,
  name: "attachment.bin",
  mimeType,
  sizeBytes: bytes.length,
  dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
});
describe("cloud attachment transfer", () => {
  it("round trips binary, images, empty files and multiple chunks with unchanged metadata", async () => {
    const chunks = new Map();
    const inputs = [
      upload(Buffer.from([0, 255, 1])),
      upload(Buffer.alloc(4 * 1024 * 1024 + 17, 123)),
      upload(Buffer.alloc(0)),
      upload(Buffer.from("image"), "image", "image/png"),
    ];
    const saved = await uploadAttachments(inputs, async (hash, bytes) => {
      chunks.set(hash, Buffer.from(bytes));
    });
    expect(saved[1].chunks).toHaveLength(2);
    expect(await downloadAttachments(saved, async (hash) => chunks.get(hash))).toEqual(inputs);
  });
  it("rejects malformed input before uploading anything", async () => {
    let writes = 0;
    for (const input of [
      { ...upload(Buffer.from("ok")), sizeBytes: 4 },
      { ...upload(Buffer.from("ok")), dataUrl: "data:application/octet-stream;base64,b2s=!" },
      { ...upload(Buffer.from("ok")), mimeType: "text/plain\r\nx: y" },
      upload(Buffer.from("ok"), "image", "text/plain"),
    ])
      await expect(
        uploadAttachments([upload(Buffer.from("first")), input], async () => {
          writes++;
        }),
      ).rejects.toThrow();
    expect(writes).toBe(0);
  });
  it("rejects corrupted, missing and reordered chunks before provider dispatch", async () => {
    const chunks = new Map();
    const saved = await uploadAttachments(
      [upload(Buffer.alloc(4 * 1024 * 1024 + 1, 1))],
      async (hash, bytes) => {
        chunks.set(hash, Buffer.from(bytes));
      },
    );
    await expect(downloadAttachments(saved, async () => Buffer.from("bad"))).rejects.toThrow(
      "integrity",
    );
    await expect(
      downloadAttachments([{ ...saved[0], chunks: [] }], async () => Buffer.alloc(0)),
    ).rejects.toThrow("manifest");
    await expect(
      downloadAttachments([{ ...saved[0], sha256: "f".repeat(64) }], async (hash) =>
        chunks.get(hash),
      ),
    ).rejects.toThrow("integrity");
  });
});
