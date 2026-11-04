import { ConflictException, Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Response } from 'express';
import { EvidenceAttachmentEntity, EvidenceEntity, TaskEntity } from '../../database/entities';
import { attachmentDto, attachmentDisposition } from './attachment-utils';

@Controller('tasks/:taskId/evidence/:evidenceId/attachments')
export class EvidenceAttachmentsController {
  constructor(@InjectRepository(EvidenceAttachmentEntity) private readonly attachments: Repository<EvidenceAttachmentEntity>) {}
  private async requireEvidence(taskId: string, evidenceId: string) {
    if (!await this.attachments.manager.existsBy(TaskEntity, { id: taskId })) throw new NotFoundException('证据不存在');
    const row = await this.attachments.manager.findOne(EvidenceEntity, { where: { id: evidenceId, taskId }, select: ['id', 'meta'] });
    if (!row) throw new NotFoundException('证据不存在'); return row;
  }
  @Get() async list(@Param('taskId') taskId: string, @Param('evidenceId') evidenceId: string) {
    const evidence = await this.requireEvidence(taskId, evidenceId);
    const rows = await this.attachments.createQueryBuilder('a').addSelect('a.data').where('a.taskId = :taskId AND a.evidenceId = :evidenceId', { taskId, evidenceId }).orderBy('a.createdAt', 'ASC').addOrderBy('a.id', 'ASC').getMany();
    const missingIds = Array.isArray(evidence.meta?.attachmentIds) ? evidence.meta.attachmentIds.filter((id) => !rows.some((a) => a.id === id)) : [];
    return { items: rows.map(attachmentDto), missingIds, references: Array.isArray(evidence.meta?.externalReferences) ? evidence.meta.externalReferences : [], unsupportedBlocks: evidence.meta?.unsupportedBlocks ?? [] };
  }
  @Get(':id/download') download(@Param('taskId') taskId: string, @Param('evidenceId') evidenceId: string, @Param('id') id: string, @Res() response: Response) { return this.send(taskId, evidenceId, id, response, false); }
  @Get(':id/preview') preview(@Param('taskId') taskId: string, @Param('evidenceId') evidenceId: string, @Param('id') id: string, @Res() response: Response) { return this.send(taskId, evidenceId, id, response, true); }
  private async send(taskId: string, evidenceId: string, id: string, response: Response, inline: boolean) {
    await this.requireEvidence(taskId, evidenceId);
    const row = await this.attachments.createQueryBuilder('a').addSelect('a.data').where('a.id = :id AND a.taskId = :taskId AND a.evidenceId = :evidenceId', { id, taskId, evidenceId }).getOne();
    if (!row) throw new NotFoundException('附件不存在');
    const dto = attachmentDto(row);
    if (dto.integrity !== 'match') throw new ConflictException('附件内容与记录哈希或字节数不一致，已停止导出');
    if (inline && !dto.previewable) throw new ConflictException('该附件不支持安全图片预览，请下载后使用相应工具查看');
    response.setHeader('Content-Type', inline ? row.mimeType : 'application/octet-stream');
    response.setHeader('Content-Disposition', attachmentDisposition(row.filename, inline));
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); response.send(row.data);
  }
}
