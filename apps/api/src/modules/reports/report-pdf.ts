import { HttpException } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { resolve } from 'node:path';

const fontPath = resolve(__dirname, '../../assets/fonts/VulnAgentReportSans.ttf');
let coverage: Set<number> | undefined;
function printable(text: string): string {
  if (!coverage) {
    const font = (require('fontkit') as { openSync(path: string): { characterSet: number[] } }).openSync(fontPath);
    coverage = new Set(font.characterSet);
  }
  return [...text.replace(/\t/g, '    ')].map((c) => c === '\n' || coverage!.has(c.codePointAt(0)!) ? c : `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`).join('');
}
const decode = (text: string) => text.replace(/\\([\\`*_{}\[\]()#+.!|~-])/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Offline PDF rendering from the same immutable Markdown snapshot; no HTML or URL fetch. */
export async function renderReportPdf(markdown: string, title: string): Promise<Buffer> {
  if (Buffer.byteLength(markdown) > 2 * 1024 * 1024) throw new HttpException('报告正文超过 PDF 导出上限 2 MiB，请下载完整 Markdown 和证据包', 413);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 55, bottom: 55, left: 48, right: 48 }, bufferPages: true, info: { Title: title, Author: 'VulnAgent', Subject: '授权测试证据快照' } });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolveBuffer, reject) => { doc.on('data', (chunk: Buffer) => chunks.push(chunk)); doc.on('end', () => resolveBuffer(Buffer.concat(chunks))); doc.on('error', reject); });
  try {
    doc.font(fontPath);
    let fence: string | null = null; let pages = 1;
    doc.on('pageAdded', () => { if (++pages > 500) throw new HttpException('报告超过 PDF 500 页上限，请下载完整 Markdown 和证据包', 413); });
    for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
      if (fence) { if (line === fence) { fence = null; doc.moveDown(0.35); } else doc.fontSize(8).fillColor('#334155').text(printable(line), { lineGap: 2 }); continue; }
      const code = line.match(/^(`{3,})text$/);
      if (code) { fence = code[1]; continue; }
      if (!line.trim()) { doc.moveDown(0.3); continue; }
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      const value = printable(decode(heading ? heading[2] : line.replace(/^- /, '• ')));
      if (heading) {
        const size = heading[1].length === 1 ? 20 : heading[1].length === 2 ? 14 : 11;
        doc.fontSize(size);
        if (doc.y + doc.heightOfString(value, { width: 499 }) + 40 > doc.page.height - 55) doc.addPage();
        doc.moveDown(0.35).fillColor('#0f4260').text(value, { lineGap: 3 }); doc.moveDown(0.3);
      } else doc.fontSize(9).fillColor('#1e293b').text(value, { lineGap: 3, paragraphGap: 3 });
    }
    const range = doc.bufferedPageRange();
    for (let page = range.start; page < range.start + range.count; page++) {
      doc.switchToPage(page);
      doc.fontSize(8).fillColor('#64748b').text('VulnAgent | 授权测试报告', 48, 25, { lineBreak: false });
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.text(`${page + 1} / ${range.count}`, 48, doc.page.height - 32, { width: doc.page.width - 96, align: 'right', lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  } catch (error) { (doc as unknown as import('node:stream').Readable).destroy(error as Error); }
  return result;
}
