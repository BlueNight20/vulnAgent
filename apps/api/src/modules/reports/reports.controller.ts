import { BadRequestException, Controller, DefaultValuePipe, Get, NotFoundException, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { renderReportPdf } from './report-pdf';
import { zipSync, strToU8, type Zippable } from 'fflate';
import { safeFilename, attachmentDisposition } from '../blackboard/attachment-utils';

@Controller('tasks/:taskId/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}
  @Get() list(@Param('taskId') taskId: string, @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) {
    if (page < 1 || page > 100000) throw new BadRequestException('报告页码应为 1 到 100000');
    return this.reports.list(taskId, page);
  }
  @Post() generate(@Param('taskId') taskId: string) { return this.reports.generate(taskId); }
  @Get(':id') detail(@Param('taskId') taskId: string, @Param('id') id: string) { return this.reports.detail(taskId, id); }
  @Get(':id/download') async download(@Param('taskId') taskId: string, @Param('id') id: string, @Query('format') format: string = 'markdown', @Res() response: Response) {
    if (!['markdown', 'pdf', 'evidence', 'bundle'].includes(format)) throw new BadRequestException('格式必须是 markdown、pdf、evidence 或 bundle');
    const report = await this.reports.export(taskId, id);
    let data: Buffer; let mime: string; let extension: string;
    if (format === 'pdf') { data = await renderReportPdf(report.content, report.snapshot.task.name); mime = 'application/pdf'; extension = 'pdf'; }
    else if (format === 'evidence') { data = Buffer.from(JSON.stringify({ version: 1, reportId: id, taskId, stats: report.stats, snapshot: report.snapshot, files: report.files.map((a) => ({ id: a.attachmentId, evidenceId: a.evidenceId, filename: a.filename, mimeType: a.mimeType, sha256: a.sha256, sizeBytes: a.sizeBytes, dataBase64: a.data.toString('base64') })) }, null, 2)); mime = 'application/json'; extension = 'evidence.json'; }
    else if (format === 'bundle') {
      const archive: Zippable = Object.create(null) as Zippable;
      archive['report.md'] = strToU8(report.content);
      const files = report.files.map((a) => {
        const source = report.snapshot.attachments!.find((e) => e.id === a.attachmentId)!;
        const path = `${source.integrity === 'match' ? 'attachments' : 'untrusted-attachments'}/${safeFilename(a.attachmentId)}-${safeFilename(a.filename)}`;
        archive[path] = a.data;
        return { id: a.attachmentId, evidenceId: a.evidenceId, path, sha256: a.sha256, sizeBytes: a.sizeBytes, sourceIntegrity: source.integrity };
      });
      for (const e of report.snapshot.evidence) if (e.content !== null) archive[`evidence/${safeFilename(e.id)}.txt`] = strToU8(e.content);
      archive['manifest.json'] = strToU8(JSON.stringify({ version: 1, reportId: id, taskId, stats: report.stats, snapshot: report.snapshot, files }, null, 2));
      data = Buffer.from(zipSync(archive, { level: 0, mtime: new Date(report.snapshot.capturedAt) })); mime = 'application/zip'; extension = 'zip';
    }
    else { data = Buffer.from(report.content); mime = 'text/markdown; charset=utf-8'; extension = 'md'; }
    response.setHeader('Content-Type', mime); response.setHeader('Content-Disposition', `attachment; filename="report-${encodeURIComponent(id)}.${extension}"`);
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.send(data);
  }
  @Get(':id/attachments/:attachmentId') async attachment(@Param('taskId') taskId: string, @Param('id') id: string, @Param('attachmentId') attachmentId: string, @Res() response: Response) {
    const report = await this.reports.export(taskId, id);
    const file = report.files.find((f) => f.attachmentId === attachmentId);
    if (!file) throw new NotFoundException('报告快照中没有该附件');
    response.setHeader('Content-Type', 'application/octet-stream'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', attachmentDisposition(file.filename));
    response.send(file.data);
  }
  @Get(':id/evidence/:evidenceId') async evidence(@Param('taskId') taskId: string, @Param('id') id: string, @Param('evidenceId') evidenceId: string, @Res() response: Response) {
    const report = await this.reports.export(taskId, id);
    const evidence = report.snapshot.evidence.find((e) => e.id === evidenceId);
    if (!evidence || evidence.content === null) throw new NotFoundException('快照中没有该文本证据');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Content-Disposition', `attachment; filename="evidence-${encodeURIComponent(evidenceId)}.txt"`);
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.send(evidence.content);
  }
}
