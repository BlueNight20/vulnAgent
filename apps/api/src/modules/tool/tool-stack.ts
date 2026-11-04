import type { Repository } from 'typeorm';
import type {
  AgentSessionEntity,
  AgentToolPermissionEntity,
  InterceptRuleEntity,
  McpServerEntity,
  McpToolEntity,
  TargetEntity,
  TaskEntity,
  ToolCallEntity,
} from '../../database/entities';
import type { AuditService } from '../audit/audit.service';
import type { EventsGateway } from '../events/events.gateway';
import type { McpClientFactory } from '../mcp/mcp-client.factory';
import { ApprovalHook } from './approval-hook';
import { InterceptPolicyHook } from './intercept-hook';
import { InterceptService } from './intercept.service';
import { RetryLimitHook, WorkloadGuardHook } from './invocation-guards';
import { RuntimeGateHook } from './runtime-gate.hook';
import { SessionBudgetHook } from './session-budget.hook';
import { McpCallExecutor } from './mcp-call.executor';
import { PermissionHook } from './permission-hook';
import type { McpDriver } from './mcp-tool-source';
import { ScopeGuardHook } from './scope-guard.hook';
import { ToolInvoker } from './tool-invoker';
import { ToolRecorder } from './tool-recorder';
import { ToolRegistry } from './tool-registry';

export interface ToolStackInput {
  servers: Repository<McpServerEntity>;
  tools: Repository<McpToolEntity>;
  targets: Repository<TargetEntity>;
  tasks: Repository<TaskEntity>;
  permissions: Repository<AgentToolPermissionEntity>;
  rules: Repository<InterceptRuleEntity>;
  calls: Repository<ToolCallEntity>;
  factory: Pick<McpClientFactory, 'callTool'>;
  events: EventsGateway;
  audit: AuditService;
  /** 会话额度闸门需要读会话表；不传则该闸门不启用（仅限无会话的独立脚本） */
  sessions?: Repository<AgentSessionEntity>;
}

/**
 * 工具层装配（供测试与回归脚本复用真实实现）。
 *
 * 钩子顺序固定：引擎开关(-200) → 拦截规则(-100) → 范围(10) → 权限(20) → 审批(30)。
 * 全自动模式下权限与审批钩子恒放行，模型可自由选择任意已注册工具。
 * 生产环境由 Nest 装配同一组 provider；这里保证两条路径行为一致，
 * 回归脚本因此验证的就是线上那条链路。
 */
export function createToolStack(input: ToolStackInput) {
  const registry = new ToolRegistry();
  const invoker = new ToolInvoker(registry);
  invoker.bindManager(() => input.tasks.manager);
  const executor = new McpCallExecutor(input.servers, input.tools, input.factory as McpClientFactory);
  invoker.registerExecutor(executor);
  invoker.registerExecutor({ kind: 'internal', run: (tool, params, ctx) => tool.call(params, ctx) });

  const intercept = new InterceptService(input.rules, input.audit);
  const scope = new ScopeGuardHook(input.targets, input.tasks, invoker);
  const permission = new PermissionHook(invoker);
  const approval = new ApprovalHook(invoker);
  const policy = new InterceptPolicyHook(intercept);
  const workload = new WorkloadGuardHook(input.tasks);
  const retryLimit = new RetryLimitHook();
  // 最外层闸门：执行引擎关闭时任何工具调用（含已获批重放）都不得发起。
  const runtimeGate = new RuntimeGateHook(() => input.tasks.manager);
  const sessionBudget = input.sessions ? new SessionBudgetHook(input.sessions) : null;
  // 顺序：引擎开关 → 会话额度 → 策略拦截 → 负载上限 → 重试上限 → 范围 → 权限 → 审批。
  for (const hook of [runtimeGate, ...(sessionBudget ? [sessionBudget] : []), policy, workload, retryLimit, scope, permission, approval]) invoker.hooks.add(hook);

  const recorder = new ToolRecorder(input.calls, input.events);
  return { registry, invoker, executor, recorder, driver: executor as McpDriver, intercept, scope, permission, approval, workload, retryLimit };
}
