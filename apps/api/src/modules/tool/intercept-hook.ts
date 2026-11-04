import { Injectable, Logger } from '@nestjs/common';
import { InterceptService } from './intercept.service';
import type { ToolHook, PreToolUseEvent, PreToolUseOutcome } from './tool-hooks';

/**
 * 平台策略钩子：把拦截规则接到 PreToolUse 链的最前面（order=-100）。
 *
 * 决策映射：
 *   allow → 放行；
 *   deny  → 阻断，把规则提供的理由返回模型（自动加上"平台管控"框定）；
 *   ask   → 全自动模式下无人可审批，等价于放行；需要硬性禁止请配置 deny 规则。
 */
@Injectable()
export class InterceptPolicyHook implements ToolHook {
  readonly name = 'intercept-policy';
  readonly order = -100;
  private readonly logger = new Logger(InterceptPolicyHook.name);

  constructor(private readonly rules: InterceptService) {}

  async preToolUse(event: PreToolUseEvent): Promise<PreToolUseOutcome> {
    const hit = await this.rules.match(event.toolName, event.input);
    if (!hit) return { action: 'allow' };
    this.logger.debug(`${event.toolName} ${hit.reason} → ${hit.action}`);
    if (hit.action === 'allow') return { action: 'allow' };
    if (hit.action === 'deny') {
      return { action: 'block', message: hit.message ?? hit.reason, policy: true };
    }
    // ask：全自动模式无人可审批，按放行处理（deny 规则仍可显式拦截）。
    this.logger.debug(`${event.toolName} 命中 ask 规则，已按全自动模式放行`);
    return { action: 'allow' };
  }
}
