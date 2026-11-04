import { serialTransaction } from '../../database/serial-transaction';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { McpHealthCheckResult, McpServerStatus } from '@vulnagent/shared';
import type { AppConfig } from '../../config/configuration';
import { McpServerEntity, McpToolEntity } from '../../database/entities';
import { inferToolRisk, newId } from '../../common/utils/id';
import { AuditService } from '../audit/audit.service';
import { EventsGateway } from '../events/events.gateway';
import { McpClientFactory, type McpProbeResult } from './mcp-client.factory';

/** 失败结果的缓存时长：远短于成功结果，避免瞬时故障被长期记忆 */
const FAILURE_CACHE_TTL_MS = 10_000;

interface CacheEntry {
  result: McpHealthCheckResult;
  at: number;
}

/**
 * MCP 真实健康检查。
 * 状态只能由这里写入，前端不允许使用任何硬编码在线状态。
 */
@Injectable()
export class McpHealthService {
  private readonly logger = new Logger(McpHealthService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<McpHealthCheckResult>>();

  constructor(
    @InjectRepository(McpServerEntity) private readonly servers: Repository<McpServerEntity>,
    @InjectRepository(McpToolEntity) private readonly tools: Repository<McpToolEntity>,
    private readonly factory: McpClientFactory,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly events: EventsGateway,
  ) {}

  /** 执行一次真实检测（force=true 时忽略缓存） */
  async check(serverId: string, force = false): Promise<McpHealthCheckResult> {
    const cfg = this.config.get<AppConfig['mcp']>('mcp')!;
    const running = this.inflight.get(serverId);
    if (running) return running;

    const cached = this.cache.get(serverId);
    if (!force && cached && Date.now() - cached.at < cfg.healthCacheTtlMs) {
      return { ...cached.result, cached: true };
    }

    // 健康检查超时必须随工具规模伸缩：HexStrike 的 150 个工具在冷启动时
    // 需要数秒才能返回 tools/list，固定 5s 会把在线服务误判为 unreachable。
    const promise = this.runCheck(serverId, cfg.healthTimeoutMs, cfg.healthTimeoutMaxMs).finally(
      () => {
        this.inflight.delete(serverId);
      },
    );
    this.inflight.set(serverId, promise);
    return promise;
  }

  invalidate(serverId: string): void { this.cache.delete(serverId); }

  async refresh(serverId: string): Promise<McpHealthCheckResult> {
    await this.inflight.get(serverId)?.catch(() => undefined);
    this.invalidate(serverId);
    return this.check(serverId, true);
  }

  peekCache(serverId: string): McpHealthCheckResult | null {
    return this.cache.get(serverId)?.result ?? null;
  }

  private async runCheck(
    serverId: string,
    baseTimeoutMs: number,
    maxTimeoutMs: number,
  ): Promise<McpHealthCheckResult> {
    const server = await this.servers.findOne({ where: { id: serverId } });
    if (!server) throw new Error('MCP 服务不存在');

    // 已知工具数越多，tools/list 越慢，给更长的预算（上限 maxTimeoutMs）
    const timeoutMs = Math.min(
      maxTimeoutMs,
      Math.max(baseTimeoutMs, baseTimeoutMs + Math.floor(server.toolCount / 10) * 1000),
    );

    if (!server.enabled) {
      const result: McpHealthCheckResult = {
        serverId: server.id,
        name: server.name,
        endpoint: server.endpoint,
        status: 'unknown',
        latencyMs: null,
        toolCount: server.toolCount,
        lastError: '服务已在配置中禁用，未执行检测',
        checkedAt: new Date().toISOString(),
        cached: false,
      };
      await this.persist(server, result);
      return result;
    }

    const probe = await this.factory.probe({
      endpoint: server.endpoint,
      transport: server.transport,
      headers: server.headers,
      headersEncrypted: server.headersEncrypted,
      stdioConfigEncrypted: server.stdioConfigEncrypted,
      timeoutMs,
    });

    const status: McpServerStatus = probe.ok ? 'online' : 'unreachable';
    const result: McpHealthCheckResult = {
      serverId: server.id,
      name: server.name,
      endpoint: server.endpoint,
      status,
      latencyMs: probe.latencyMs,
      toolCount: probe.ok ? probe.tools.length : 0,
      lastError: probe.ok ? null : probe.error,
      checkedAt: new Date().toISOString(),
      cached: false,
    };

    if (!await this.persist(server, result, probe)) return result;
    // 成功结果缓存完整 TTL；失败结果只缓存很短时间，
    // 避免一次瞬时抖动被固化成长期的 "unreachable"（曾把在线服务误报为离线）。
    const cacheTtlMs = this.config.get<AppConfig['mcp']>('mcp')!.healthCacheTtlMs;
    this.cache.set(server.id, {
      result,
      at: probe.ok ? Date.now() : Date.now() - cacheTtlMs + FAILURE_CACHE_TTL_MS,
    });

    await this.audit.record({
      action: 'mcp.health_check',
      entityType: 'mcp_server',
      entityId: server.id,
      result: probe.ok ? 'success' : 'failure',
      detail: {
        name: server.name,
        endpoint: server.endpoint,
        status: result.status,
        toolCount: result.toolCount,
        latencyMs: result.latencyMs,
        error: result.lastError,
      },
    });

    this.events.broadcast('mcp.health', result);
    this.logger.log(`MCP 检测 ${server.name}: ${result.status}（${result.latencyMs}ms）`);
    return result;
  }

  private async persist(server: McpServerEntity, result: McpHealthCheckResult, probe?: McpProbeResult): Promise<boolean> {
    return serialTransaction(this.servers.manager, async (manager) => {
      const current = await manager.findOne(McpServerEntity, { where: { id: server.id } });
      // A probe started before configuration changes must not restore old tools or status.
      if (!current || (['endpoint', 'transport', 'enabled', 'headersEncrypted', 'stdioConfigEncrypted'] as const).some((key) => current[key] !== server[key]) || JSON.stringify(current.headers) !== JSON.stringify(server.headers)) return false;
      if (probe?.ok) {
        const existing = await manager.find(McpToolEntity, { where: { mcpServerId: server.id } });
        const names = new Set(probe.tools.map((tool) => tool.name));
        for (const old of existing) if (!names.has(old.name)) await manager.delete(McpToolEntity, old.id);
        for (const tool of probe.tools) {
          await manager.save(McpToolEntity, manager.create(McpToolEntity, {
            id: existing.find((row) => row.name === tool.name)?.id ?? newId(), mcpServerId: server.id,
            name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
            riskLevel: inferToolRisk(tool.name, tool.description), syncedAt: new Date(result.checkedAt),
          }));
        }
      }
      await manager.update(McpServerEntity, server.id, {
        status: result.status, lastCheckedAt: new Date(result.checkedAt), latencyMs: result.latencyMs,
        toolCount: result.toolCount, lastError: result.lastError,
      });
      return true;
    });
  }
}
