import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import * as Crypto from "expo-crypto";
import { fromByteArray } from "base64-js";
import type { CloudClient } from "@t3tools/client-runtime/cloud";
import type { CloudAttachment } from "@t3tools/contracts/cloud";

export interface LocalAttachment {
  id: string;
  name: string;
  mimeType: string;
  uri: string;
  size: number;
  type: "image" | "file";
}
export async function pickAttachments(images: boolean): Promise<LocalAttachment[]> {
  if (images) {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 8,
    });
    return result.canceled
      ? []
      : result.assets.map((asset) => ({
          id: Crypto.randomUUID(),
          name: asset.fileName ?? "image.jpg",
          mimeType: asset.mimeType ?? "image/jpeg",
          uri: asset.uri,
          size: asset.fileSize ?? new FileSystem.File(asset.uri).size,
          type: "image",
        }));
  }
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  return result.canceled
    ? []
    : result.assets.map((asset) => ({
        id: Crypto.randomUUID(),
        name: asset.name,
        mimeType: asset.mimeType ?? "application/octet-stream",
        uri: asset.uri,
        size: asset.size ?? new FileSystem.File(asset.uri).size,
        type: "file",
      }));
}
const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
export async function uploadAttachments(
  client: CloudClient,
  files: readonly LocalAttachment[],
): Promise<CloudAttachment[]> {
  if (files.length > 8 || files.some((file) => file.size > 10 * 1024 * 1024))
    throw new Error("Attach up to 8 files, each at most 10 MiB.");
  const uploaded: CloudAttachment[] = [];
  for (const file of files) {
    const bytes = await new FileSystem.File(file.uri).bytes();
    if (bytes.length > 10 * 1024 * 1024) throw new Error(`${file.name} exceeds 10 MiB.`);
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) {
      const chunk = bytes.subarray(offset, offset + 4 * 1024 * 1024);
      const result = await client.uploadChunk(fromByteArray(chunk));
      if (result.sha256 !== (await hash(chunk)))
        throw new Error("Attachment upload failed integrity verification. Retry the upload.");
      chunks.push(result.sha256);
    }
    uploaded.push({
      type: file.type,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: bytes.length,
      sha256: await hash(bytes),
      chunks,
    });
  }
  return uploaded;
}
