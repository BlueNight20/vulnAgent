import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AgentToolPermissionEntity,
  EvidenceEntity,
  McpServerEntity,
  McpToolEntity,
  TargetEntity,
  TaskEntity,
  ToolCallEntity,
} from '../../database/entities';
import { McpBootstrapService } from './mcp-bootstrap.service';
import { McpCallsService } from './mcp-calls.service';
import { McpClientFactory } from './mcp-client.factory';
import { McpController } from './mcp.controller';
import { McpHealthService } from './mcp-health.service';
import { McpPermissionsService } from './mcp-permissions.service';
import { McpServersService } from './mcp-servers.service';

/**
 * MCP 协议层：服务器配置、连接、工具发现与健康检查。
 *
 * 工具执行不再由本模块承担——审批与实际调用都在 tool 模块，
 * 这里只提供 `McpClientFactory`（传输层）与目录/配置管理。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      McpServerEntity,
      McpToolEntity,
      AgentToolPermissionEntity,
      ToolCallEntity,
      EvidenceEntity,
      TargetEntity,
      TaskEntity,
    ]),
  ],
  controllers: [McpController],
  providers: [
    McpClientFactory,
    McpServersService,
    McpHealthService,
    McpPermissionsService,
    McpCallsService,
    McpBootstrapService,
  ],
  exports: [McpHealthService, McpServersService, McpClientFactory],
})
export class McpModule {}
