import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { runtimeEnabled } from '../../database/runtime-control';
import type { PreToolUseEvent, PreToolUseOutcome, ToolHook } from './tool-hooks';

/**
 * 执行引擎开关闸门（最外层钩子，order 极小）。
 *
 * 关闭引擎时必须挡住所有真实工具调用，而不只是挡住编排循环：
 * 否则关闭开关后仍然能通过审批重放或直接调用触发远程操作。
 * 已获批的重放也不能绕过——这是操作者的全局意图。
 */
@Injectable()
export class RuntimeGateHook implements ToolHook {
  readonly name = 'runtime-gate';
  readonly order = -200;

  constructor(private readonly manager: () => EntityManager) {}

  async preToolUse(_event: PreToolUseEvent): Promise<PreToolUseOutcome> {
    if (await runtimeEnabled(this.manager())) return { action: 'allow' };
    return {
      action: 'block',
      message: '执行引擎已关闭，本次工具调用未发起。请在系统设置中启用执行引擎后重试。',
      policy: false,
    };
  }
}
