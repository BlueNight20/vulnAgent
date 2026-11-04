import { serialSave } from '../../database/serial-transaction';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { AppConfig } from '../../config/configuration';
import { AgentToolPermissionEntity, McpServerEntity } from '../../database/entities';
import { newId } from '../../common/utils/id';
import { DEFAULT_PERMISSIONS } from './default-permissions';
import { configuredCipher, validateHeaders } from '../../common/crypto/mcp-header-secrets';
import { upgradeStoredSecrets } from './stored-secret-upgrade';

interface EnvServerSpec {
  name: string;
  endpoint: string;
  enabled: boolean;
}

/**
 * 启动时把环境变量中的 MCP 服务同步为数据库记录。
 *
 * 支持两种配置方式：
 * 1. `MCP_GATEWAY_URL`（单条，兼容旧配置）
 * 2. `MCP_SERVERS`（JSON 数组，可配置多个服务）：
 *    [{"name":"kali","endpoint":"http://localhost:9001/mcp","enabled":true}, ...]
 *
 * 已存在的同名记录以数据库为准，避免环境变量覆盖用户在页面上的修改。
 */
@Injectable()
export class McpBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(McpBootstrapService.name);

  constructor(
    @InjectRepository(McpServerEntity) private readonly servers: Repository<McpServerEntity>,
    @InjectRepository(AgentToolPermissionEntity)
    private readonly permissions: Repository<AgentToolPermissionEntity>,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await upgradeStoredSecrets(this.servers.manager, this.config.get<AppConfig['security']>('security'));
    await this.syncServersFromEnv();
    await this.seedDefaultPermissions();
  }

  private collectSpecs(): EnvServerSpec[] {
    const cfg = this.config.get<AppConfig['mcp']>('mcp')!;
    const specs: EnvServerSpec[] = [];

    // 多服务配置优先
    const raw = process.env.MCP_SERVERS?.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as EnvServerSpec[];
        for (const item of parsed) {
          if (item?.name && item?.endpoint) {
            specs.push({
              name: item.name,
              endpoint: item.endpoint,
              enabled: item.enabled !== false,
            });
          }
        }
      } catch {
        this.logger.warn('MCP_SERVERS 不是合法 JSON 数组，已忽略');
      }
    }

    // 单网关配置（若与多服务配置同名则跳过）
    if (cfg.gatewayUrl && !specs.some((s) => s.name === cfg.gatewayName)) {
      specs.push({
        name: cfg.gatewayName,
        endpoint: cfg.gatewayUrl,
        enabled: cfg.gatewayEnabled,
      });
    }
    return specs;
  }

  private async syncServersFromEnv(): Promise<void> {
    const cfg = this.config.get<AppConfig['mcp']>('mcp')!;
    let headers: Record<string, string> | null = null;
    if (cfg.gatewayHeaders) {
      try {
        headers = validateHeaders(JSON.parse(cfg.gatewayHeaders));
      } catch {
        throw new Error('MCP_GATEWAY_HEADERS 必须是合法请求头对象；配置未导入');
      }
    }

    for (const spec of this.collectSpecs()) {
      const existing = await this.servers.findOne({ where: { name: spec.name } });
      if (existing) {
        this.logger.log(`复用已有 MCP 服务配置：${existing.name} → ${existing.endpoint}`);
        continue;
      }
      await serialSave(this.servers, 
        this.servers.create({
          id: newId(),
          name: spec.name,
          endpoint: spec.endpoint,
          transport: cfg.transport,
          enabled: spec.enabled,
          headers: null,
          headersEncrypted: headers && Object.keys(headers).length && spec.name === cfg.gatewayName && spec.endpoint === cfg.gatewayUrl
            ? configuredCipher(this.config.get<AppConfig['security']>('security')).encrypt(JSON.stringify(headers)) : null,
          status: 'unknown',
          toolCount: 0,
          source: 'env',
        }),
      );
      this.logger.log(`从环境变量写入 MCP 服务配置：${spec.name} → ${spec.endpoint}`);
    }
  }

  private async seedDefaultPermissions(): Promise<void> {
    const count = await this.permissions.count({ where: { taskId: IsNull() } });
    if (count > 0) return;
    const rows = DEFAULT_PERMISSIONS.map((p) =>
      this.permissions.create({
        id: newId(),
        taskId: null,
        agentRole: p.agentRole,
        toolPattern: p.toolPattern,
        allowed: p.allowed,
        requireApproval: p.requireApproval,
      }),
    );
    await serialSave(this.permissions, rows);
    this.logger.log(`写入 ${rows.length} 条默认 Agent 工具权限`);
  }
}
