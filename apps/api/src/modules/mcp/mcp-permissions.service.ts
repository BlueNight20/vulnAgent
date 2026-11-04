import { serialTransaction } from '../../database/serial-transaction';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  MCP_PERMISSION_NOTICE,
  type AgentRole,
  type McpPermissionDto,
  type McpPermissionMatrix,
} from '@vulnagent/shared';
import { AgentToolPermissionEntity, McpToolEntity, TaskEntity } from '../../database/entities';
import { newId } from '../../common/utils/id';
import { AuditService } from '../audit/audit.service';
import { MATRIX_ROLES } from './default-permissions';
import { UpdatePermissionDto } from './dto/mcp.dto';

@Injectable()
export class McpPermissionsService {
  constructor(
    @InjectRepository(AgentToolPermissionEntity)
    private readonly repo: Repository<AgentToolPermissionEntity>,
    @InjectRepository(McpToolEntity) private readonly tools: Repository<McpToolEntity>,
    private readonly audit: AuditService,
  ) {}

  async matrix(taskId?: string): Promise<McpPermissionMatrix> {
    const where = taskId ? [{ taskId }, { taskId: IsNull() }] : [{ taskId: IsNull() }];
    const permissions = await this.repo.find({ where, order: { agentRole: 'ASC' } });
    const toolRows = await this.tools.find({ order: { name: 'ASC' }, take: 200 });
    return {
      roles: MATRIX_ROLES,
      tools: toolRows.map((t) => ({ name: t.name, serverName: 'MCP', riskLevel: t.riskLevel })),
      permissions: permissions.map((p) => this.toDto(p)),
      notice: MCP_PERMISSION_NOTICE,
    };
  }

  async list(taskId?: string): Promise<McpPermissionDto[]> {
    const where = taskId ? [{ taskId }, { taskId: IsNull() }] : [{ taskId: IsNull() }];
    const rows = await this.repo.find({ where, order: { agentRole: 'ASC' } });
    return rows.map((r) => this.toDto(r));
  }

  async upsert(dto: UpdatePermissionDto): Promise<McpPermissionDto> {
    const taskId = dto.taskId ?? null;
    const toolPattern = dto.toolPattern.trim();
    if (!toolPattern) throw new BadRequestException('工具模式不能为空');
    const { permission, audit } = await serialTransaction(this.repo.manager, async (manager) => {
      if (taskId !== null && !await manager.existsBy(TaskEntity, { id: taskId })) throw new NotFoundException('任务不存在');
      const repo = manager.getRepository(AgentToolPermissionEntity);
      const existing = await repo.findOne({ where: { taskId: taskId === null ? IsNull() : taskId, agentRole: dto.agentRole, toolPattern } });
      const previous = existing ? { allowed: existing.allowed, requireApproval: existing.requireApproval } : null;
      const saved = await repo.save(repo.create({ id: existing?.id ?? newId(), taskId, agentRole: dto.agentRole, toolPattern,
        allowed: dto.allowed, requireApproval: dto.requireApproval ?? existing?.requireApproval ?? false }));
      const audit = await this.audit.recordInTransaction(manager, {
        action: 'mcp.permission_update', entityType: 'agent_tool_permission', entityId: saved.id, taskId,
        detail: { agentRole: saved.agentRole, toolPattern, allowed: saved.allowed, requireApproval: saved.requireApproval, previous },
      });
      return { permission: this.toDto(saved), audit };
    });
    this.audit.publish(audit);
    return permission;
  }

  private toDto(entity: AgentToolPermissionEntity): McpPermissionDto {
    return {
      id: entity.id,
      taskId: entity.taskId,
      agentRole: entity.agentRole as AgentRole,
      toolPattern: entity.toolPattern,
      allowed: entity.allowed,
      requireApproval: entity.requireApproval,
    };
  }
}
