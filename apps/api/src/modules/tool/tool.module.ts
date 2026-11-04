import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AgentToolPermissionEntity,
  EvidenceEntity,
  InterceptRuleEntity,
  McpServerEntity,
  McpToolEntity,
  TargetEntity,
  TaskEntity,
  ToolCallEntity,
} from '../../database/entities';
import { McpModule } from '../mcp/mcp.module';
import { BlackboardModule } from '../blackboard/blackboard.module';
import { ApprovalService } from '../mcp/approval.service';
import { BusinessToolRegistrar } from './business-tool-registrar';
import { InterceptService } from './intercept.service';
import { InterceptController } from './intercept.controller';
import { InterceptPolicyHook } from './intercept-hook';
import { ScopeGuardHook } from './scope-guard.hook';
import { PermissionHook } from './permission-hook';
import { ApprovalHook } from './approval-hook';
import { McpCallExecutor } from './mcp-call.executor';
import { ToolCatalogService, MCP_DRIVER } from './tool-catalog.service';
import { ToolRecorder } from './tool-recorder';
import { ToolExecutorBinder } from './tool-bootstrap.service';
import { ToolInvoker } from './tool-invoker';
import { ToolRegistry } from './tool-registry';

/**
 * 工具层装配。
 *
 * 对外只暴露三样东西：
 *  - ToolRegistry：模型 schema 的唯一出口；
 *  - ToolInvoker：工具执行的唯一入口（钩子顺序：runtime-gate → 拦截规则 → 范围）；
 *  - InterceptService：策略规则。
 * 其余模块不得直接执行工具，也不得绕过 Invoker。
 *
 * 全自动模式：不再有工具审批与角色权限阻塞，模型可自行选择任意已注册工具；
 * 仅保留引擎开关与授权范围两条授权边界。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      InterceptRuleEntity, McpServerEntity, McpToolEntity,
      TargetEntity, TaskEntity, AgentToolPermissionEntity, ToolCallEntity,
      EvidenceEntity,
    ]),
    McpModule,
    BlackboardModule,
  ],
  controllers: [InterceptController],
  providers: [
    ToolRegistry,
    ToolInvoker,
    // 必须排在 ToolCatalogService 之前：先接执行器，再注册可调用工具。
    ToolExecutorBinder,
    InterceptService,
    InterceptPolicyHook,
    ScopeGuardHook,
    PermissionHook,
    ApprovalHook,
    McpCallExecutor,
    { provide: MCP_DRIVER, useExisting: McpCallExecutor },
    ToolCatalogService,
    BusinessToolRegistrar,
    ToolRecorder,
    ApprovalService,
  ],
  exports: [ToolRegistry, ToolInvoker, ToolRecorder, InterceptService, ToolCatalogService, McpCallExecutor, PermissionHook, ApprovalService],
})
export class ToolModule {}
