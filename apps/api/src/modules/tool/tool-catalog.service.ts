import { exposedToolNames } from '../mcp/tool-names';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { McpServerEntity, McpToolEntity } from '../../database/entities';
import { ToolRegistry } from './tool-registry';
import type { CoreTool } from './core-tool';
import { buildMcpTool, type McpDriver, type McpSourceTool } from './mcp-tool-source';

export const MCP_DRIVER = Symbol('MCP_DRIVER');

/**
 * 工具目录同步：把数据库里的 MCP 工具同步成 Registry 中的 CoreTool。
 *
 * 规则：
 * - 只有启用的服务器、且目录里真实存在的工具才会注册；
 * - 同步是"全量替换 mcp 来源"，不会留下已删除工具的影子；
 * - 单个工具注册失败只跳过该工具并记日志，不影响其他工具。
 */
@Injectable()
export class ToolCatalogService implements OnModuleInit {
  private readonly logger = new Logger(ToolCatalogService.name);

  constructor(
    @InjectRepository(McpServerEntity) private readonly servers: Repository<McpServerEntity>,
    @InjectRepository(McpToolEntity) private readonly tools: Repository<McpToolEntity>,
    private readonly registry: ToolRegistry,
    @Inject(MCP_DRIVER) private readonly driver: McpDriver,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sync().catch((error) => this.logger.warn(`工具目录初始化失败：${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * 全量重建 mcp 来源的工具。
   *
   * 重名处理：不同 MCP 服务可能提供同名工具（例如两个服务都有 generate_payload）。
   * Registry 要求工具名唯一，因此按「服务名 + 工具名」生成暴露名，保留可区分性；
   * 同名且同服务的重复行才是真正的数据重复，跳过并告警，绝不让整批同步失败——
   * 之前一个重名就让所有工具都注册不上，任务里于是表现为「未注册执行器 / 未知工具」。
   */
  async sync(): Promise<{ registered: number; skipped: number; renamed: string[] }> {
    const [servers, tools] = await Promise.all([this.servers.find(), this.tools.find()]);
    const enabled = new Map(servers.filter((s) => s.enabled).map((s) => [s.id, s]));
    let registered = 0;
    let skipped = 0;
    const renamed: string[] = [];
    const built: CoreTool[] = [];
    const seen = new Set<string>();
    const exposed = exposedToolNames(tools);

    for (const tool of tools) {
      const server = enabled.get(tool.mcpServerId);
      if (!server) { skipped += 1; continue; }
      const source: McpSourceTool = {
        serverId: server.id,
        serverName: server.name,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        riskLevel: tool.riskLevel,
      };
      try {
        const name = exposed.get(tool.id)!;
        if (seen.has(name)) { skipped += 1; continue; }
        if (name !== tool.name) renamed.push(`${server.name}/${tool.name} → ${name}`);
        built.push(buildMcpTool(source, this.driver, { nameOf: () => name }));
        seen.add(name);
        registered += 1;
      } catch (error) {
        skipped += 1;
        this.logger.warn(`工具 ${tool.name} 注册失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.registry.replaceSource('mcp', built);
    this.logger.log(
      `工具目录已同步：注册 ${registered} 个 MCP 工具，跳过 ${skipped} 个`
      + (renamed.length ? `，重名改名 ${renamed.length} 个（${renamed.join('；')}）` : ''),
    );
    return { registered, skipped, renamed };
  }
}
