import { MAX_ATTACHMENT_BYTES, MAX_CALL_ATTACHMENT_BYTES, safeFilename, safeMime } from '../blackboard/attachment-utils';

export interface EmbeddedAttachment { filename: string; mimeType: string; sourceUri: string | null; data: Buffer }
export interface ParsedMcpContent { text: string; attachments: EmbeddedAttachment[]; references: { uri: string; name: string }[]; unsupported: { type: string; mimeType: string | null }[] }
const extension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/vnd.tcpdump.pcap': 'pcap', 'application/octet-stream': 'bin', 'application/pdf': 'pdf', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };

/** Parses embedded MCP blocks only; never reads a local file or follows a URI. */
export function parseMcpContent(raw: unknown, fallback: string): ParsedMcpContent {
  const result: ParsedMcpContent = { text: fallback, attachments: [], references: [], unsupported: [] };
  if (!raw || typeof raw !== 'object') return result;
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) { const structured = (raw as { structuredContent?: unknown }).structuredContent; if (structured && typeof structured === 'object') result.text = JSON.stringify(structured); return result; }
  const texts: string[] = []; let bytes = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const value = block as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string') { texts.push(value.text); continue; }
    if (value.type === 'resource_link' && typeof value.uri === 'string') { result.references.push({ uri: value.uri.slice(0, 1000), name: safeFilename(String(value.name ?? 'external-resource')) }); continue; }
    const resource = value.type === 'resource' && value.resource && typeof value.resource === 'object' ? value.resource as Record<string, unknown> : null;
    if (resource && typeof resource.text === 'string') { texts.push(resource.text); continue; }
    const encoded = resource?.blob ?? (['image', 'audio'].includes(String(value.type)) ? value.data : null);
    if (typeof encoded !== 'string') { result.unsupported.push({ type: String(value.type ?? 'unknown'), mimeType: typeof value.mimeType === 'string' ? value.mimeType : null }); continue; }
    if (result.attachments.length >= 32) throw new Error('单次工具结果最多保存 32 个附件，未保存部分结果');
    if (encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4) throw new Error('单个附件超过 16 MiB，未保存部分结果');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('MCP 附件不是有效的 Base64');
    const data = Buffer.from(encoded, 'base64');
    if (data.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('MCP 附件 Base64 编码不规范，拒绝保存损坏内容');
    bytes += data.length;
    if (data.length > MAX_ATTACHMENT_BYTES || bytes > MAX_CALL_ATTACHMENT_BYTES) throw new Error('附件超过单文件 16 MiB 或单次结果合计 32 MiB，未保存部分结果');
    const mimeType = safeMime(resource?.mimeType ?? value.mimeType);
    const sourceUri = typeof resource?.uri === 'string' ? resource.uri.slice(0, 1000) : null;
    let filename = `attachment-${result.attachments.length + 1}.${extension[mimeType] ?? 'bin'}`;
    if (sourceUri) { try { filename = safeFilename(decodeURIComponent(new URL(sourceUri).pathname)); } catch { /* Generated name. */ } }
    result.attachments.push({ filename, mimeType, sourceUri, data });
  }
  const structured = (raw as { structuredContent?: unknown }).structuredContent;
  result.text = texts.join('\n');
  if (!result.text && structured && typeof structured === 'object') result.text = JSON.stringify(structured);
  return result;
}
