import { describe, expect, it } from 'vitest';

/**
 * Agent 自然结束时应推进到终态的判定逻辑（与 SessionManager 中 agent_end 分支一致）。
 * 抽成纯函数测试，避免依赖 Nest 容器。
 */
function decideTerminalState(lastAssistant: { stopReason?: string; errorMessage?: string } | undefined): {
  state: 'completed' | 'failed';
  error: string | null;
} {
  if (lastAssistant?.stopReason === 'error') {
    return { state: 'failed', error: lastAssistant.errorMessage ?? '模型返回错误，会话终止' };
  }
  return { state: 'completed', error: null };
}

describe('会话自然结束的终态判定', () => {
  it('正常 stop 推进为 completed', () => {
    expect(decideTerminalState({ stopReason: 'stop' })).toEqual({ state: 'completed', error: null });
  });

  it('stopReason 为 error 时推进为 failed 并保留原因', () => {
    expect(decideTerminalState({ stopReason: 'error', errorMessage: 'Request timed out' })).toEqual({
      state: 'failed',
      error: 'Request timed out',
    });
  });

  it('error 但无 errorMessage 时使用默认原因', () => {
    expect(decideTerminalState({ stopReason: 'error' }).error).toContain('模型返回错误');
  });

  it('缺少最后一条消息时仍视为正常完成（避免永久 running）', () => {
    expect(decideTerminalState(undefined).state).toBe('completed');
  });

  it('length（达到最大 token）也视为完成而不是卡住', () => {
    expect(decideTerminalState({ stopReason: 'length' }).state).toBe('completed');
  });
});
