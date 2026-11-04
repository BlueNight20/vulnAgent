import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';
import type { EvidenceAttachmentDto } from '@vulnagent/shared';

export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_CALL_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
export function safeFilename(value: string): string {
  const name = value.replace(/\\/g, '/').split('/').pop()!.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 150);
  return name && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? name : 'attachment.bin';
}
export function safeMime(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value) && value.length <= 100 ? value.toLowerCase() : 'application/octet-stream';
}
export function attachmentDisposition(filename: string, inline = false): string {
  const encoded = encodeURIComponent(safeFilename(filename)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="attachment.bin"; filename*=UTF-8''${encoded}`;
}
/** Only small raster images whose signatures and dimensions match can be served inline. */
export function previewableImage(data: Buffer, mime: string): boolean {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime) || data.length > MAX_ATTACHMENT_BYTES) return false;
  try {
    const info = imageSize(data);
    return `image/${info.type === 'jpg' ? 'jpeg' : info.type}` === mime && info.width > 0 && info.height > 0 && info.width <= 8192 && info.height <= 8192 && info.width * info.height <= 32_000_000;
  } catch { return false; }
}
export function attachmentDto(row: { id: string; evidenceId: string; filename: string; mimeType: string; sha256: string; sizeBytes: number; sourceUri: string | null; data: Buffer }): EvidenceAttachmentDto {
  const computedSha256 = sha256(row.data); const computedSizeBytes = row.data.length;
  const integrity = computedSha256 === row.sha256 && computedSizeBytes === row.sizeBytes ? 'match' : 'mismatch';
  return { id: row.id, evidenceId: row.evidenceId, filename: row.filename, mimeType: row.mimeType, sha256: row.sha256, sizeBytes: row.sizeBytes, sourceUri: row.sourceUri, computedSha256, computedSizeBytes, integrity, previewable: integrity === 'match' && previewableImage(row.data, row.mimeType) };
}
