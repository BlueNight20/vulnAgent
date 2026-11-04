import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type {
  DashboardSummary,
  ServiceHealthItem,
  TaskStatus,
  UsageTrend,
  UsageTrendPoint,
} from '@vulnagent/shared';
import { FindingEntity, ModelUsageEntity } from '../../database/entities';
import { nowIso } from '../../common/utils/id';
import { McpServersService } from '../mcp/mcp-servers.service';
import { TasksService } from '../tasks/tasks.service';

@Injectable()
export class DashboardService {
  private readonly startedAt = Date.now();

  constructor(
    @InjectRepository(FindingEntity) private readonly findings: Repository<FindingEntity>,
    @InjectRepository(ModelUsageEntity) private readonly usage: Repository<ModelUsageEntity>,
    private readonly dataSource: DataSource,
    private readonly tasks: TasksService,
    private readonly mcpServers: McpServersService,
  ) {}

  async summary(): Promise<DashboardSummary> {
    const taskStats = await this.countTasks();
    const findingStats = await this.countFindings();
    const usage = await this.sumUsage();
    const services = await this.serviceHealth();
    const recentTasks = await this.tasks.recent(6);

    return {
      tasks: {
        total: Object.values(taskStats).reduce((a, b) => a + b, 0),
        running: taskStats.running ?? 0,
        pending: taskStats.pending ?? 0,
        paused: taskStats.paused ?? 0,
        stopped: taskStats.stopped ?? 0,
        completed: taskStats.completed ?? 0,
        failed: taskStats.failed ?? 0,
      },
      findings: findingStats,
      usage,
      services,
      recentTasks,
    };
  }

  async usageTrend(days = 7): Promise<UsageTrend> {
    const safeDays = Math.min(Math.max(1, Math.trunc(days)), 90);
    const rows = await this.usage
      .createQueryBuilder('u')
      .select("strftime('%Y-%m-%d', u.createdAt)", 'date')
      .addSelect('SUM(u.inputTokens + u.outputTokens)', 'tokens')
      .addSelect('SUM(u.costUsd)', 'cost')
      .groupBy('date')
      .orderBy('date', 'ASC')
      .getRawMany<{ date: string; tokens: string | number; cost: string | number }>();

    const byDate = new Map(rows.map((r) => [r.date, r]));
    const points: UsageTrendPoint[] = [];
    for (let i = safeDays - 1; i >= 0; i -= 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const row = byDate.get(key);
      points.push({
        date: key,
        tokens: row ? Number(row.tokens) : 0,
        costUsd: row ? Number(Number(row.cost).toFixed(4)) : 0,
      });
    }
    return { points };
  }

  private async countTasks(): Promise<Record<string, number>> {
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('t.status', 'status')
      .addSelect('COUNT(1)', 'count')
      .from('tasks', 't')
      .groupBy('t.status')
      .getRawMany<{ status: TaskStatus; count: string | number }>();
    const stats: Record<string, number> = {};
    for (const row of rows) stats[row.status] = Number(row.count);
    return stats;
  }

  private async countFindings() {
    const rows = await this.findings
      .createQueryBuilder('f')
      .select('f.status', 'status')
      .addSelect('COUNT(1)', 'count')
      .groupBy('f.status')
      .getRawMany<{ status: string; count: string | number }>();
    const stats: Record<string, number> = {};
    for (const row of rows) stats[row.status] = Number(row.count);
    return {
      total: Object.values(stats).reduce((a, b) => a + b, 0),
      candidate: stats.candidate ?? 0,
      verifying: stats.verifying ?? 0,
      confirmed: stats.confirmed ?? 0,
      unconfirmed: stats.unconfirmed ?? 0,
      refuted: stats.refuted ?? 0,
    };
  }

  private async sumUsage(): Promise<{ tokens: number; costUsd: number }> {
    const row = await this.usage
      .createQueryBuilder('u')
      .select('SUM(u.inputTokens + u.outputTokens)', 'tokens')
      .addSelect('SUM(u.costUsd)', 'cost')
      .getRawOne<{ tokens: string | number | null; cost: string | number | null }>();
    return {
      tokens: row?.tokens ? Number(row.tokens) : 0,
      costUsd: row?.cost ? Number(Number(row.cost).toFixed(4)) : 0,
    };
  }

  /** 服务状态：MCP 来自最近一次真实检测（不主动发起新连接），API/DB 实时探测 */
  private async serviceHealth(): Promise<ServiceHealthItem[]> {
    const items: ServiceHealthItem[] = [];

    const servers = await this.mcpServers.list();
    for (const server of servers) {
      items.push({
        name: `MCP · ${server.name}`,
        kind: 'mcp',
        status:
          server.status === 'online'
            ? 'online'
            : server.status === 'unknown'
              ? 'unknown'
              : 'offline',
        latencyMs: server.latencyMs,
        detail:
          server.status === 'online'
            ? `${server.toolCount} 个工具 · ${server.endpoint}`
            : (server.lastError ?? `尚未检测（${server.endpoint}）`),
        checkedAt: server.lastCheckedAt ?? nowIso(),
      });
    }

    items.push({
      name: 'API 服务',
      kind: 'api',
      status: 'online',
      latencyMs: 0,
      detail: `已运行 ${Math.floor((Date.now() - this.startedAt) / 1000)} 秒`,
      checkedAt: nowIso(),
    });

    const dbStart = Date.now();
    let dbOk = true;
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      dbOk = false;
    }
    items.push({
      name: '数据库',
      kind: 'database',
      status: dbOk ? 'online' : 'offline',
      latencyMs: Date.now() - dbStart,
      detail: dbOk ? `SQLite · ${this.dataSource.options.type}` : '查询失败',
      checkedAt: nowIso(),
    });

    return items;
  }
}
