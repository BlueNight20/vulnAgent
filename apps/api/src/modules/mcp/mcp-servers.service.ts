import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { configuredCipher, readStoredHeaders, validateHeaders } from '../../common/crypto/mcp-header-secrets';
import { McpClientFactory } from './mcp-client.factory';
import { CreateMcpServerDto, UpdateMcpServerDto } from './dto/mcp.dto';
import { AuditService } from '../audit/audit.service';
import { serialTransaction } from '../../database/serial-transaction';
import { serialSave } from '../../database/serial-transaction';
import { BadRequestException, ConflictException, NotFoundException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { McpServerDto, McpToolDto } from '@vulnagent/shared';
import { AuditLogEntity, McpServerEntity, McpToolEntity } from '../../database/entities';
import { newId, toIso } from '../../common/utils/id';
import { McpHealthService } from './mcp-health.service';

@Injectable()
export class McpServersService {
  constructor(
    @InjectRepository(McpServerEntity) private readonly servers: Repository<McpServerEntity>,
    @InjectRepository(McpToolEntity) private readonly tools: Repository<McpToolEntity>,
    private readonly health: McpHealthService,
    private readonly factory: McpClientFactory,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private connection(input: CreateMcpServerDto) {
    if (!input.name.trim()) throw new BadRequestException('请填写服务名称');
    if (input.transport === 'stdio') {
      if (!input.command?.trim() || /[\r\n\0]/.test(input.command)) throw new BadRequestException('请填写有效的可执行文件名称或路径');
      if (input.args?.some((arg) => arg.includes('\0'))) throw new BadRequestException('启动参数包含非法字符');
      if (input.env && Object.entries(input.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))) throw new BadRequestException('环境变量必须为合法字符串键值对象');
      if (input.token || Object.keys(input.headers ?? {}).length) throw new BadRequestException('stdio 请使用环境变量配置认证');
      const stdioConfigEncrypted = configuredCipher(this.config.get<AppConfig['security']>('security')).encrypt(JSON.stringify({ command: input.command.trim(), args: input.args ?? [], env: input.env }));
      return { endpoint: 'stdio://local', transport: input.transport, headers: null, stdioConfigEncrypted, timeoutMs: 15000 };
    }
    let url: URL;
    try { url = new URL(input.endpoint.trim()); } catch { throw new BadRequestException('服务地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new BadRequestException('服务地址必须为 HTTP 地址，不可包含账号密码或片段');
    if (!['streamable-http', 'sse'].includes(input.transport)) throw new BadRequestException('传输方式无效');
    if (/[\r\n\0]/.test(input.token ?? '')) throw new BadRequestException('令牌含非法字符');
    let headers: Record<string, string> | null;
    try { headers = validateHeaders(input.headers); } catch { throw new BadRequestException('请求头必须为合法字符串键值对象'); }
    if (input.token) {
      if (Object.keys(headers ?? {}).some((key) => key.toLowerCase() === 'authorization')) throw new BadRequestException('请勿同时配置令牌与 Authorization 请求头');
      headers = { ...headers, Authorization: `Bearer ${input.token}` };
    }
    return { endpoint: url.toString(), transport: input.transport, headers, timeoutMs: 15000 };
  }

  async testConnection(input: CreateMcpServerDto) {
    const result = await this.factory.probe(this.connection(input));
    return result.ok ? { ok: true, toolCount: result.tools.length, latencyMs: result.latencyMs } : result;
  }

  async create(input: CreateMcpServerDto): Promise<McpServerDto> {
    const connection = this.connection(input);
    const result = await this.factory.probe(connection);
    if (!result.ok) throw new BadRequestException(`连接失败：${result.error}`);
    const encrypted = connection.headers ? configuredCipher(this.config.get<AppConfig['security']>('security')).encrypt(JSON.stringify(connection.headers)) : null;
    const saved = await serialTransaction(this.servers.manager, async (manager) => {
      if (await manager.findOne(McpServerEntity, { where: { name: input.name.trim() } })) throw new ConflictException('服务名称已存在');
      const row = await manager.save(McpServerEntity, manager.create(McpServerEntity, {
        id: newId(), name: input.name.trim(), endpoint: connection.endpoint, transport: connection.transport,
        enabled: true, headers: null, headersEncrypted: encrypted, stdioConfigEncrypted: connection.stdioConfigEncrypted ?? null, status: 'unknown', toolCount: 0, source: 'manual',
      }));
      await this.audit.recordInTransaction(manager, { action: 'mcp.server_created', entityType: 'mcp_server', entityId: row.id, detail: { name: row.name, transport: row.transport } });
      return row;
    });
    await this.health.check(saved.id, true);
    return this.findOne(saved.id);
  }

  private async editedConnection(id: string, input: UpdateMcpServerDto) {
    const current = await this.servers.findOneBy({ id });
    if (!current) throw new NotFoundException('MCP 服务不存在');
    let resolved: CreateMcpServerDto = input;
    if (input.preserveCredentials) {
      if (input.transport !== current.transport) throw new BadRequestException('更换传输方式时请重新填写认证或启动配置');
      if (input.token || Object.keys(input.headers ?? {}).length || input.command || input.args || input.env) throw new BadRequestException('保留原配置时不可同时提交新的认证或启动配置');
      const security = this.config.get<AppConfig['security']>('security');
      if (current.transport === 'stdio') {
        if (!current.stdioConfigEncrypted) throw new BadRequestException('原启动配置缺失，请重新填写');
        resolved = { ...input, ...JSON.parse(configuredCipher(security).decrypt(current.stdioConfigEncrypted)) };
      } else resolved = { ...input, headers: readStoredHeaders(current, security) ?? undefined };
    }
    return { current, connection: this.connection(resolved) };
  }

  async testUpdate(id: string, input: UpdateMcpServerDto) {
    const { connection } = await this.editedConnection(id, input);
    const result = await this.factory.probe(connection);
    return result.ok ? { ok: true, toolCount: result.tools.length, latencyMs: result.latencyMs } : result;
  }

  async update(id: string, input: UpdateMcpServerDto): Promise<McpServerDto> {
    const { current, connection } = await this.editedConnection(id, input);
    const result = await this.factory.probe(connection);
    if (!result.ok) throw new BadRequestException(`连接失败：${result.error}`);
    const encrypted = connection.headers ? configuredCipher(this.config.get<AppConfig['security']>('security')).encrypt(JSON.stringify(connection.headers)) : null;
    await serialTransaction(this.servers.manager, async (manager) => {
      const latest = await manager.findOneBy(McpServerEntity, { id });
      if (!latest) throw new NotFoundException('MCP 服务不存在');
      if (latest.updatedAt.getTime() !== current.updatedAt.getTime() || latest.headersEncrypted !== current.headersEncrypted || latest.stdioConfigEncrypted !== current.stdioConfigEncrypted || latest.endpoint !== current.endpoint) throw new ConflictException('服务配置已变化，请刷新后重试');
      const duplicate = await manager.findOneBy(McpServerEntity, { name: input.name.trim() });
      if (duplicate && duplicate.id !== id) throw new ConflictException('服务名称已存在');
      await manager.update(McpServerEntity, id, {
        name: input.name.trim(), endpoint: connection.endpoint, transport: connection.transport,
        headers: null, headersEncrypted: encrypted, stdioConfigEncrypted: connection.stdioConfigEncrypted ?? null,
        status: 'unknown', toolCount: 0, latencyMs: null, lastCheckedAt: null, lastError: null, source: 'manual',
      });
      await manager.delete(McpToolEntity, { mcpServerId: id });
      await this.audit.recordInTransaction(manager, { action: 'mcp.server_updated', entityType: 'mcp_server', entityId: id, detail: { name: input.name.trim(), transport: connection.transport } });
    });
    await this.health.refresh(id);
    return this.findOne(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerDto> {
    await serialTransaction(this.servers.manager, async (manager) => {
      const server = await manager.findOne(McpServerEntity, { where: { id } });
      if (!server) throw new NotFoundException('MCP 服务不存在');
      if (server.enabled === enabled) return;
      await manager.update(McpServerEntity, id, { enabled, status: 'unknown', lastError: enabled ? null : '服务已停用' });
      await this.audit.recordInTransaction(manager, { action: enabled ? 'mcp.server_enabled' : 'mcp.server_disabled', entityType: 'mcp_server', entityId: id, detail: { enabled } });
    });
    if (enabled) await this.health.check(id, true);
    return this.findOne(id);
  }

  async diagnostics(id: string) {
    if (!await this.servers.existsBy({ id })) throw new NotFoundException('MCP 服务不存在');
    const rows = await this.servers.manager.find(AuditLogEntity, { where: { entityType: 'mcp_server', entityId: id }, order: { createdAt: 'DESC' }, take: 50 });
    return { items: rows.map((row) => ({ id: row.id, action: row.action, result: row.result, createdAt: row.createdAt.toISOString() })) };
  }

  async capabilities(id: string) {
    const server = await this.servers.findOne({ where: { id } });
    if (!server) throw new BadRequestException('MCP 服务不存在');
    if (!server.enabled) throw new BadRequestException('服务已停用');
    const result = await this.factory.probe({ ...server, timeoutMs: 15000 }, true);
    if (!result.ok) throw new BadRequestException(result.error);
    return { resources: result.resources ?? [], prompts: result.prompts ?? [] };
  }

  async list(): Promise<McpServerDto[]> {
    const rows = await this.servers.find({ order: { createdAt: 'ASC' } });
    return rows.map((row) => this.toDto(row));
  }

  async findOne(id: string): Promise<McpServerDto> {
    const row = await this.servers.findOne({ where: { id } });
    if (!row) throw new Error('MCP 服务不存在');
    return this.toDto(row);
  }

  async listTools(serverId?: string, keyword?: string): Promise<McpToolDto[]> {
    const qb = this.tools.createQueryBuilder('t').orderBy('t.name', 'ASC');
    if (serverId) qb.andWhere('t.mcpServerId = :serverId', { serverId });
    if (keyword) qb.andWhere('(t.name LIKE :kw OR t.description LIKE :kw)', { kw: `%${keyword}%` });
    const rows = await qb.getMany();
    const serverRows = await this.servers.find();
    const nameById = new Map(serverRows.map((s) => [s.id, s.name]));
    return rows.map((row) => ({
      id: row.id,
      serverId: row.mcpServerId,
      serverName: nameById.get(row.mcpServerId) ?? '未知服务',
      name: row.name,
      description: row.description,
      inputSchema: row.inputSchema ?? { type: 'object' },
      riskLevel: row.riskLevel,
      syncedAt: toIso(row.syncedAt) ?? '',
      paramCount: countParams(row.inputSchema),
    }));
  }

  /**
   * 探测本机常见 MCP 端口（blhackbox 默认部署），把可达的服务写入配置。
   * 只做 HTTP 探测，不启动、不修改任何外部容器。
   */
  async discoverLocal(): Promise<{ added: string[]; reachable: string[] }> {
    const candidates = [
      { name: 'blhackbox-kali-mcp', port: 9001, label: 'Kali MCP' },
      { name: 'blhackbox-wire-mcp', port: 9003, label: 'WireMCP' },
      { name: 'blhackbox-screenshot-mcp', port: 9004, label: 'Screenshot MCP' },
      { name: 'blhackbox-boaz-mcp', port: 9005, label: 'BOAZ MCP' },
      { name: 'blhackbox-hexstrike-mcp', port: 9006, label: 'HexStrike MCP' },
      { name: 'blhackbox-gateway', port: 8080, label: 'MCP Gateway' },
    ];

    const reachable: string[] = [];
    const added: string[] = [];

    for (const candidate of candidates) {
      const endpoint = `http://localhost:${candidate.port}/mcp`;
      const ok = await this.probeEndpoint(endpoint);
      if (!ok) continue;
      reachable.push(`${candidate.label} (:${candidate.port})`);
      const exists = await this.servers.findOne({ where: { name: candidate.name } });
      if (exists) continue;
      await serialSave(this.servers, 
        this.servers.create({
          id: newId(),
          name: candidate.name,
          endpoint,
          transport: 'streamable-http',
          enabled: true,
          headers: null,
          status: 'unknown',
          toolCount: 0,
          source: 'manual',
        }),
      );
      added.push(candidate.name);
    }
    return { added, reachable };
  }

  /** 用 MCP initialize 请求判断端点是否可用 */
  private async probeEndpoint(endpoint: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'vulnagent-probe', version: '0.1.0' },
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }

  toDto(row: McpServerEntity): McpServerDto {
    return {
      id: row.id,
      name: row.name,
      endpoint: row.endpoint,
      transport: row.transport,
      enabled: row.enabled,
      headersMasked: row.headersEncrypted != null ? '已加密保存请求头' : maskHeaders(row.headers),
      status: row.status,
      lastCheckedAt: toIso(row.lastCheckedAt),
      latencyMs: row.latencyMs,
      toolCount: row.toolCount,
      lastError: row.lastError,
      source: row.source,
    };
  }
}

function countParams(schema: Record<string, unknown> | null | undefined): number {
  const props = schema && typeof schema === 'object' ? (schema as { properties?: unknown }).properties : null;
  return props && typeof props === 'object' ? Object.keys(props as object).length : 0;
}

function maskHeaders(headers: Record<string, string> | null): string | null {
  if (!headers) return null;
  const keys = Object.keys(headers);
  if (keys.length === 0) return null;
  return keys
    .map((k) => `${k}: ****`)
    .join(', ');
}
