import type { CloudAttachment } from "../../../packages/contracts/src/cloud.ts";
import type { UploadChatAttachment } from "../../../packages/contracts/src/orchestration.ts";
export interface ArchivedAttachment {
  name: string;
  sha256: string;
  base64: string;
}
export function exportAttachmentFiles(
  directory: string,
  selectedNames?: readonly string[],
): Promise<ArchivedAttachment[]>;
export function restoreAttachmentFiles(
  files: readonly ArchivedAttachment[],
  directory: string,
): Promise<void>;
export function uploadAttachments(
  attachments: readonly UploadChatAttachment[],
  putChunk: (hash: string, bytes: Uint8Array) => Promise<void>,
): Promise<CloudAttachment[]>;
export function downloadAttachments(
  attachments: readonly CloudAttachment[],
  getChunk: (hash: string) => Promise<Uint8Array>,
): Promise<UploadChatAttachment[]>;
