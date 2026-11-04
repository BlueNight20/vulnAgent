import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ToolInvoker } from './tool-invoker';
import type { PreToolUseEvent, PreToolUseOutcome, ToolHook } from './tool-hooks';

/**
 * 角色权限钩子（order = 20）。
 *
 * 全自动模式：权限矩阵不再限制工具能力，模型可以自行选择任意已注册工具。
 * 保留钩子本身以维持链序与模块装配；实际的授权边界由 scope-guard（目标范围）
 * 与 runtime-gate（引擎开关）负责，这两者属于授权承诺而非工具能力限制。
 */
@Injectable()
export class PermissionHook implements ToolHook, OnModuleInit {
  readonly name = 'permission';
  readonly order = 20;

  constructor(private readonly invoker: ToolInvoker) {}

  onModuleInit(): void {
    this.invoker.hooks.add(this);
  }

  preToolUse(event: PreToolUseEvent): PreToolUseOutcome {
    void event;
    return { action: 'allow' };
  }
}
