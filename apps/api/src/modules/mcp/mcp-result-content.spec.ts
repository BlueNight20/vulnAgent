import { describe, expect, it } from 'vitest';
import { parseMcpContent } from './mcp-result-content';
import { MAX_ATTACHMENT_BYTES, previewableImage, safeFilename } from '../blackboard/attachment-utils';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
describe('MCP 内嵌附件解析', () => {
  it('保存文本与原始字节，不把图片占位文本当作工具原文', () => {
    const result = parseMcpContent({ content: [{ type: 'text', text: '原文🙂' }, { type: 'image', data: png, mimeType: 'image/png' }, { type: 'resource', resource: { uri: 'file:///tmp/capture.pcap', mimeType: 'application/vnd.tcpdump.pcap', blob: 'AAECAw==' } }] }, '[image]');
    expect(result.text).toBe('原文🙂'); expect(result.attachments).toHaveLength(2);
    expect(result.attachments[1].data).toEqual(Buffer.from([0, 1, 2, 3])); expect(result.attachments[1].filename).toBe('capture.pcap');
    expect(parseMcpContent({ content: [{ type: 'image', data: png, mimeType: 'image/png' }] }, '[image]').text).toBe('');
  });
  it('资源文本和结构化结果保持可读；未知 URI 只保存引用', () => {
    expect(parseMcpContent({ content: [{ type: 'resource', resource: { uri: 'x:test', text: 'resource text' } }] }, '').text).toBe('resource text');
    expect(parseMcpContent({ content: [], structuredContent: { return_code: 0, stdout: 'observed' } }, '').text).toContain('observed');
    const result = parseMcpContent({ content: [{ type: 'resource_link', uri: 'https://unfetched.invalid/file', name: '../outside.bin' }] }, '');
    expect(result.references).toEqual([{ uri: 'https://unfetched.invalid/file', name: 'outside.bin' }]); expect(result.attachments).toHaveLength(0);
  });
  it('非 Base64、非规范编码、超大附件或过多附件不能静默截断', () => {
    for (const data of ['not-base64!', 'AB==', 'a']) expect(() => parseMcpContent({ content: [{ type: 'image', data, mimeType: 'image/png' }] }, '')).toThrow();
    expect(() => parseMcpContent({ content: [{ type: 'image', data: 'A'.repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 8) }] }, '')).toThrow('16 MiB');
    expect(() => parseMcpContent({ content: Array.from({ length: 33 }, () => ({ type: 'audio', data: '', mimeType: 'audio/wav' })) }, '')).toThrow('32 个');
  });
  it('图片预览检查实际格式和维度，SVG 或伪装 HTML 只能下载', () => {
    expect(previewableImage(Buffer.from(png, 'base64'), 'image/png')).toBe(true);
    expect(previewableImage(Buffer.from('<script>alert(1)</script>'), 'image/png')).toBe(false);
    expect(previewableImage(Buffer.from('<svg></svg>'), 'image/svg+xml')).toBe(false);
    const huge = Buffer.from(png, 'base64'); huge.writeUInt32BE(100000, 16);
    expect(previewableImage(huge, 'image/png')).toBe(false);
  });
  it('附件文件名不能保留路径、控制字符或 Windows 设备名', () => {
    expect(safeFilename('../../escape.exe')).toBe('escape.exe'); expect(safeFilename('C:\\tmp\\clip.pcap')).toBe('clip.pcap');
    expect(safeFilename('CON')).toBe('attachment.bin'); expect(safeFilename('a\r\nb.png')).toBe('a__b.png');
  });
});
