import { BadRequestException, Body, Controller, DefaultValuePipe, Get, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EvidenceKind, type EvidenceSummaryDto, type EvidenceDetailDto } from '@vulnagent/shared';
import { normalizePagination } from '../../common/utils/pagination';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { IntentRejectReason } from '@vulnagent/shared';
import { EvidenceEntity, TaskEntity } from '../../database/entities';
import { AuditService } from '../audit/audit.service';
import { FactsService } from './facts.service';
import { HintsService } from './hints.service';
import { HypothesisService } from './hypothesis.service';
import { IntentsService } from './intents.service';
import { WorkerStateService } from './worker-state.service';

class CreateHintDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content: string;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  sessionId?: string | null;

  @IsOptional()
  @IsBoolean()
  broadcast?: boolean;
}

class HypothesisQuoteDto {
  @IsString() @MaxLength(64)
  evidenceId: string;
  @IsString() @MinLength(8) @MaxLength(2000)
  quote: string;
}
class LinkHypothesisDto {
  @IsIn(['supports', 'contradicts', 'depends_on', 'refines'])
  linkType: 'supports' | 'contradicts' | 'depends_on' | 'refines';
  @IsIn(['fact', 'evidence', 'intent'])
  targetType: 'fact' | 'evidence' | 'intent';
  @IsString() @MaxLength(64)
  targetId: string;
  @IsOptional() @IsString() @MaxLength(4000)
  note?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => HypothesisQuoteDto)
  evidenceQuotes?: HypothesisQuoteDto[];
}

class RejectIntentDto {
  @IsOptional()
  @IsString()
  reason?: IntentRejectReason;
}

class CreateHypothesisDto {
  @IsString()
  @MaxLength(200)
  title: string;

  @IsString()
  @MaxLength(4000)
  description: string;

  @IsOptional()
  @IsString()
  targetIp?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  factIds?: string[];
}

@Controller('tasks/:taskId')
export class BlackboardController {
  constructor(
    @InjectRepository(TaskEntity) private readonly tasks: Repository<TaskEntity>,
    @InjectRepository(EvidenceEntity) private readonly evidence: Repository<EvidenceEntity>,
    private readonly facts: FactsService,
    private readonly intents: IntentsService,
    private readonly hints: HintsService,
    private readonly hypotheses: HypothesisService,
    private readonly workers: WorkerStateService,
    private readonly audit: AuditService,
  ) {}

  @Get('facts')
  listFacts(
    @Param('taskId') taskId: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.facts.list(taskId, {
      category,
      status,
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 50,
    });
  }

  /** 事实冲突列表（只读诊断；冲突由引擎自动裁决，无需人工确认） */
  @Get('facts/conflicts')
  listConflicts(@Param('taskId') taskId: string) {
    return this.facts.listConflicts(taskId).then((items) => ({ items }));
  }

  @Get('intents')
  listIntents(
    @Param('taskId') taskId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.intents.list(taskId, {
      status,
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 50,
    });
  }

  @Post('intents/:intentId/reject')
  async rejectIntent(
    @Param('taskId') taskId: string,
    @Param('intentId') intentId: string,
    @Body() dto: RejectIntentDto,
  ) {
    const intent = await this.intents.reject(intentId, dto.reason ?? 'manual');
    await this.audit.record({
      action: 'intent.reject',
      entityType: 'intent',
      entityId: intentId,
      taskId,
      detail: { reason: dto.reason ?? 'manual', title: intent.title },
    });
    return intent;
  }

  @Get('hints')
  listHints(@Param('taskId') taskId: string) {
    return this.hints.list(taskId).then((items) => ({ items }));
  }

  @Post('hints')
  async createHint(@Param('taskId') taskId: string, @Body() dto: CreateHintDto) {
    const hint = await this.hints.create(taskId, dto.content, dto.broadcast ? null : dto.sessionId ?? null);
    return hint;
  }

  @Get('hypotheses')
  listHypotheses(@Param('taskId') taskId: string) {
    return this.hypotheses.list(taskId).then((items) => ({ items }));
  }

  @Post('hypotheses')
  createHypothesis(@Param('taskId') taskId: string, @Body() dto: CreateHypothesisDto) {
    return this.hypotheses.create({
      taskId,
      title: dto.title,
      description: dto.description,
      targetIp: dto.targetIp ?? null,
      createdBy: 'user',
    });
  }

  @Get('hypotheses/:id')
  hypothesisDetail(@Param('taskId') taskId: string, @Param('id') id: string) {
    return this.hypotheses.detail(taskId, id);
  }

  @Post('hypotheses/:id/links')
  async linkHypothesis(@Param('taskId') taskId: string, @Param('id') id: string, @Body() input: LinkHypothesisDto) {
    await this.hypotheses.link(id, input.linkType, input.targetType, input.targetId, taskId, input.note, { source: 'user', evidenceQuotes: input.evidenceQuotes });
    return this.hypotheses.detail(taskId, id);
  }

  @Get('evidence/:evidenceId/relations')
  evidenceRelations(@Param('taskId') taskId: string, @Param('evidenceId') evidenceId: string) {
    return this.hypotheses.relationsForEvidence(taskId, evidenceId);
  }

  @Get('workers')
  listWorkers(@Param('taskId') taskId: string) {
    return this.workers.listByTask(taskId).then((items) => ({ items }));
  }

  @Get('result-cards')
  listResultCards(@Param('taskId') taskId: string) {
    return this.workers.listResultCards(taskId).then((items) => ({ items }));
  }

  @Get('evidence')
  async listEvidence(
    @Param('taskId') taskId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(25), ParseIntPipe) pageSize: number,
    @Query('kind') kind?: EvidenceKind,
    @Query('sessionId') sessionId?: string,
  ) {
    if (kind && !Object.values(EvidenceKind).includes(kind)) throw new BadRequestException('未知证据类型');
    const { skip, take } = normalizePagination(page, pageSize);
    const qb = this.evidence.createQueryBuilder('e').where('e.taskId = :taskId', { taskId })
      .orderBy('e.createdAt', 'DESC').addOrderBy('e.id', 'DESC').skip(skip).take(take);
    if (kind) qb.andWhere('e.kind = :kind', { kind });
    if (sessionId) qb.andWhere('e.agentSessionId = :sessionId', { sessionId });
    // 预览在数据库端截取，避免列表加载全部原始输出。
    qb.select(['e.id', 'e.taskId', 'e.kind', 'e.title', 'e.agentSessionId', 'e.toolCallId', 'e.sizeBytes', 'e.sha256', 'e.createdAt']);
    qb.addSelect('SUBSTR(e.content, 1, 300)', 'preview');
    const total = await qb.getCount();
    const { entities: rows, raw } = await qb.getRawAndEntities();
    return {
      items: rows.map((row, index): EvidenceSummaryDto => ({
        id: row.id,
          taskId: row.taskId,
        kind: row.kind,
        title: row.title,
        agentSessionId: row.agentSessionId,
          toolCallId: row.toolCallId,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
          createdAt: row.createdAt.toISOString(),
          preview: String(raw[index]?.preview ?? ''),
      })),
      total,
    };
  }

  @Get('evidence/:evidenceId')
  async evidenceDetail(@Param('taskId') taskId: string, @Param('evidenceId') evidenceId: string): Promise<EvidenceDetailDto> {
    const row = await this.evidence.findOne({ where: { id: evidenceId, taskId } });
    if (!row) throw new NotFoundException('证据不存在');
    const computedSha256 = row.content === null ? null : createHash('sha256').update(row.content).digest('hex');
    const computedSizeBytes = row.content === null ? null : Buffer.byteLength(row.content, 'utf8');
    return {
      id: row.id, taskId: row.taskId, kind: row.kind, title: row.title,
      agentSessionId: row.agentSessionId, toolCallId: row.toolCallId,
      sizeBytes: row.sizeBytes, sha256: row.sha256, createdAt: row.createdAt.toISOString(),
      preview: (row.content ?? '').slice(0, 300), content: row.content, mimeType: row.mimeType,
      computedSha256, computedSizeBytes,
      integrity: !row.sha256 || computedSha256 === null ? 'unavailable'
        : row.sha256 === computedSha256 && (row.sizeBytes === null || row.sizeBytes === computedSizeBytes) ? 'match' : 'mismatch',
    };
  }

  @Get('overview')
  async overview(@Param('taskId') taskId: string) {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException('任务不存在');
    const [factCounts, intentCounts] = await Promise.all([
      this.facts.counts(taskId),
      this.intents.counts(taskId),
    ]);
    return { taskId, factCounts, intentCounts };
  }
}
