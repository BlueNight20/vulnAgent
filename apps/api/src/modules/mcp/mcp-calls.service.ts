import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { McpCallDto } from '@vulnagent/shared';
import { ToolCallEntity } from '../../database/entities';
import { toIso } from '../../common/utils/id';
import { normalizePagination } from '../../common/utils/pagination';

@Injectable()
export class McpCallsService {
  constructor(
    @InjectRepository(ToolCallEntity) private readonly repo: Repository<ToolCallEntity>,
  ) {}

  async list(taskId?: string, page?: number, pageSize?: number): Promise<{ items: McpCallDto[]; total: number }> {
    const { skip, take } = normalizePagination(page, pageSize);
    const qb = this.repo.createQueryBuilder('c').orderBy('c.createdAt', 'DESC').skip(skip).take(take);
    if (taskId) qb.andWhere('c.taskId = :taskId', { taskId });
    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        agentSessionId: row.agentSessionId,
        toolName: row.toolName,
        arguments: row.arguments,
        argumentsHash: row.argumentsHash,
        targetIp: row.targetIp,
        decision: row.decision,
        decisionReason: row.decisionReason,
        status: row.status,
        latencyMs: row.latencyMs,
        errorMessage: row.errorMessage,
        failureKind: row.failureKind,
        rawOutputRef: row.rawOutputRef,
        approvedAt: toIso(row.approvedAt),
        approvedBy: row.approvedBy,
        replayOfId: row.replayOfId,
        createdAt: toIso(row.createdAt) ?? '',
      })),
      total,
    };
  }
}
