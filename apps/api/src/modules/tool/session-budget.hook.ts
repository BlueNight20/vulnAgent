import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentSessionEntity } from '../../database/entities';
import type { PreToolUseEvent, PreToolUseOutcome, ToolHook } from './tool-hooks';

/**
 * 会话 Token 额度闸门。
 *
 * 模型 SDK 层已经拦截超额的 toolUse，但工具层必须独立再查一次：
 * 任何绕过 SDK 的调用（审批重放、脚本、未来新增入口）都不能在额度耗尽后继续触碰远端。
 */
@Injectable()
export class SessionBudgetHook implements ToolHook {
  readonly name = 'session-budget';
  readonly order = -180;

  constructor(@InjectRepository(AgentSessionEntity) private readonly sessions: Repository<AgentSessionEntity>) {}

  async preToolUse(event: PreToolUseEvent): Promise<PreToolUseOutcome> {
    if (!event.sessionId) return { action: 'allow' };
    const session = await this.sessions.findOne({ where: { id: event.sessionId } }).catch(() => null);
    if (!session?.tokenAllowance) return { action: 'allow' };
    const used = (session.tokenInput ?? 0) + (session.tokenOutput ?? 0);
    if (used < session.tokenAllowance) return { action: 'allow' };
    return {
      action: 'block',
      message: `会话 Token 额度已用尽（${used}/${session.tokenAllowance}），本次工具调用未发起。请缩小范围或由操作者调整预算后重新运行。`,
      policy: false,
    };
  }
}
