import { exposedToolNames } from '../mcp/tool-names';
import { serialSave } from '../../database/serial-transaction';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { WorkerProfileId } from '@vulnagent/shared';
import { AgentToolPermissionEntity, McpServerEntity, McpToolEntity, WorkerProfileLoadEntity } from '../../database/entities';
import { newId } from '../../common/utils/id';
import { getProfile, listProfiles, selectTools, type WorkerProfile } from './profiles';
import { toolPermission } from '../mcp/tool-permission';

export interface ResolvedProfileTools {
  profile: WorkerProfile;
  /** 档案声明且 MCP 目录中确实存在的工具 */
  tools: string[];
  /** MCP 目录为空时的提示 */
  catalogEmpty: boolean;
}

/**
 * Worker Skills 注册表：
 * 把 Intent 的 workerProfileId 解析成实际的工具集合与提示词版本。
 */
@Injectable()
export class WorkerSkillsService {
  constructor(
    @InjectRepository(McpToolEntity) private readonly tools: Repository<McpToolEntity>,
    @InjectRepository(WorkerProfileLoadEntity) private readonly loads: Repository<WorkerProfileLoadEntity>,
    @InjectRepository(AgentToolPermissionEntity) private readonly permissions: Repository<AgentToolPermissionEntity>,
  ) {}

  list(): WorkerProfile[] {
    return listProfiles();
  }

  async catalogToolNames(): Promise<string[]> {
    const rows = await this.tools.find({ select: ['id', 'name', 'mcpServerId'] });
    const servers = await this.tools.manager.find(McpServerEntity, { where: { enabled: true }, select: ['id'] });
    const enabled = new Set(servers.map((s) => s.id));
    const names = exposedToolNames(rows);
    return [...new Set(rows.filter((r) => enabled.has(r.mcpServerId)).map((r) => names.get(r.id)!))];
  }

  async resolve(profileId: WorkerProfileId, extraTools: string[] = [], taskId?: string): Promise<ResolvedProfileTools> {
    const profile = getProfile(profileId);
    const catalog = await this.catalogToolNames();
    const selected = selectTools(profile, catalog);
    // Intent 中显式建议且目录中存在的工具也一并开放
    for (const tool of extraTools) {
      if (catalog.includes(tool) && !selected.includes(tool)) selected.push(tool);
    }
    const permissions = await this.permissions.find({ where: taskId ? [{ taskId }, { taskId: IsNull() }] : [{ taskId: IsNull() }] });
    return { profile, tools: selected.filter((tool) => toolPermission(permissions, profile.role, tool).allowed), catalogEmpty: catalog.length === 0 };
  }

  /** 记录本次加载（用于追溯 Worker 实际拥有哪些能力） */
  async recordLoad(input: {
    taskId: string;
    sessionId: string;
    profileId: WorkerProfileId;
    skillIds: string[];
    allowedTools: string[];
    expectedEvidence: string[];
    tokenBudget: number;
    promptVersion: string;
  }): Promise<void> {
    await serialSave(this.loads, 
      this.loads.create({
        id: newId(),
        taskId: input.taskId,
        sessionId: input.sessionId,
        profileId: input.profileId,
        skillIds: input.skillIds,
        allowedTools: input.allowedTools,
        expectedEvidence: input.expectedEvidence,
        tokenBudget: input.tokenBudget,
        systemPromptVersion: input.promptVersion,
      }),
    );
  }
}
