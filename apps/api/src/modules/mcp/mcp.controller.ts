import { Body, Controller, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { McpHealthService } from './mcp-health.service';
import { McpServersService } from './mcp-servers.service';
import { McpPermissionsService } from './mcp-permissions.service';
import { McpCallsService } from './mcp-calls.service';
import { UpdateMcpServerDto, SetMcpEnabledDto, CreateMcpServerDto, QueryCallsDto, QueryToolsDto, UpdatePermissionDto } from './dto/mcp.dto';

@Controller('mcp')
export class McpController {
  constructor(
    private readonly servers: McpServersService,
    private readonly health: McpHealthService,
    private readonly permissions: McpPermissionsService,
    private readonly calls: McpCallsService,
  ) {}

  @Post('servers/test')
  testConnection(@Body() dto: CreateMcpServerDto) { return this.servers.testConnection(dto); }

  @Post('servers')
  createServer(@Body() dto: CreateMcpServerDto) { return this.servers.create(dto); }

  @Put('servers/:id')
  updateServer(@Param('id') id: string, @Body() dto: UpdateMcpServerDto) { return this.servers.update(id, dto); }

  @Post('servers/:id/test')
  testUpdate(@Param('id') id: string, @Body() dto: UpdateMcpServerDto) { return this.servers.testUpdate(id, dto); }

  @Get('servers')
  listServers() {
    return this.servers.list().then((items) => ({ items }));
  }

  @Get('servers/:id')
  async getServer(@Param('id') id: string) {
    try {
      return await this.servers.findOne(id);
    } catch {
      throw new NotFoundException('MCP 服务不存在');
    }
  }

  @Post('servers/:id/check')
  async check(@Param('id') id: string) {
    try {
      return await this.health.check(id, true);
    } catch {
      throw new NotFoundException('MCP 服务不存在');
    }
  }

  @Post('servers/:id/sync')
  async sync(@Param('id') id: string) {
    const result = await this.health.check(id, true);
    return { ...result, message: result.status === 'online' ? '工具目录已同步' : '同步失败：服务不可用' };
  }

  @Put('servers/:id/enabled')
  setEnabled(@Param('id') id: string, @Body() dto: SetMcpEnabledDto) { return this.servers.setEnabled(id, dto.enabled); }

  @Get('servers/:id/diagnostics')
  diagnostics(@Param('id') id: string) { return this.servers.diagnostics(id); }

  @Get('servers/:id/capabilities')
  capabilities(@Param('id') id: string) { return this.servers.capabilities(id); }

  @Get('servers/:id/tools')
  listServerTools(@Param('id') id: string, @Query() query: QueryToolsDto) {
    return this.servers.listTools(id, query.keyword).then((items) => ({ items }));
  }

  @Get('tools')
  listTools(@Query() query: QueryToolsDto) {
    return this.servers.listTools(undefined, query.keyword).then((items) => ({ items }));
  }

  @Get('permissions')
  matrix(@Query('taskId') taskId?: string) {
    return this.permissions.matrix(taskId);
  }

  @Put('permissions')
  updatePermission(@Body() dto: UpdatePermissionDto) {
    return this.permissions.upsert(dto);
  }

  @Get('calls')
  listCalls(@Query() query: QueryCallsDto) {
    return this.calls.list(query.taskId, query.page, query.pageSize);
  }

  /** 探测本机常见 MCP 端口并写入服务配置（不启动任何外部进程，只做 HTTP 探测） */
  @Post('discover')
  discover() {
    return this.servers.discoverLocal();
  }
}
