import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ApprovalRequestDto, ToolRiskLevel } from '@vulnagent/shared';
import { McpToolEntity, ToolCallEntity } from '../../database/entities';
import { toIso } from '../../common/utils/id';

/**
 * 历史待审批记录的只读视图。
 *
 * 全自动模式已不再产生新的 pending_approval 记录，本服务仅用于：
 * 1. 读取旧版本遗留的待审批数据，便于核对与清理；
 * 2. 供编排器统计"是否还有历史遗留的未收尾调用"。
 *
 * 不再提供 approve / reject / reconcile，也不做重放执行。
 */
@Injectable()
export class ApprovalService {
  constructor(
    @InjectRepository(ToolCallEntity) private readonly calls: Repository<ToolCallEntity>,
    @InjectRepository(McpToolEntity) private readonly tools: Repository<McpToolEntity>,
  ) {}

  async listPending(taskId?: string): Promise<ApprovalRequestDto[]> {
    const where = taskId
      ? { taskId, status: 'pending_approval' as const }
      : { status: 'pending_approval' as const };
    const rows = await this.calls.find({ where, order: { createdAt: 'ASC' }, take: 100 });
    return Promise.all(rows.map((row) => this.toDto(row)));
  }

  async findById(id: string): Promise<ApprovalRequestDto> {
    const row = await this.calls.findOne({ where: { id } });
    if (!row) throw new NotFoundException('调用记录不存在');
    return this.toDto(row);
  }

  private async toDto(row: ToolCallEntity): Promise<ApprovalRequestDto> {
    const tool = await this.tools.findOne({ where: { name: row.toolName } });
    return {
      id: row.id,
      taskId: row.taskId,
      sessionId: row.agentSessionId,
      toolName: row.toolName,
      arguments: row.arguments,
      targetIp: row.targetIp,
      riskLevel: (tool?.riskLevel ?? 'intrusive') as ToolRiskLevel,
      reason: row.errorMessage ?? row.decisionReason,
      status: row.status,
      createdAt: toIso(row.createdAt) ?? '',
      expiresAt: toIso(row.approvalExpiresAt),
      approvedAt: toIso(row.approvedAt),
      approvedBy: row.approvedBy,
      executionState: row.status !== 'pending_approval' ? 'resolved'
        : row.approvedAt ? 'needs_review' : 'pending',
      replayOfId: row.replayOfId,
    };
  }
}
