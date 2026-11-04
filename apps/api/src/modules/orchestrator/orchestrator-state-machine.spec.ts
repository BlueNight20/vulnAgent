import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  goalStatusToOrchestrator,
  isTerminal,
  shouldMarkStalled,
} from './orchestrator-state-machine';

describe('Orchestrator 状态机', () => {
  it('idle 可以进入 planning', () => {
    expect(canTransition('idle', 'planning')).toBe(true);
  });

  it('executing 可以回到 planning 进入下一轮', () => {
    expect(canTransition('executing', 'planning')).toBe(true);
  });

  it('终态不可再推进', () => {
    expect(canTransition('completed', 'planning')).toBe(false);
    expect(canTransition('stopped', 'planning')).toBe(false);
    expect(() => assertTransition('stopped', 'planning')).toThrow();
  });

  it('paused 可以恢复或停止', () => {
    expect(canTransition('paused', 'planning')).toBe(true);
    expect(canTransition('paused', 'stopping')).toBe(true);
  });

  it('无进展进入 stalled 而不是 completed', () => {
    expect(canTransition('planning', 'stalled')).toBe(true);
    expect(goalStatusToOrchestrator('blocked')).toEqual({ status: 'stalled', reason: 'no_progress' });
  });

  it('需要人工介入时进入 needs_input', () => {
    expect(goalStatusToOrchestrator('needs_input')).toEqual({
      status: 'needs_input',
      reason: 'needs_input',
    });
  });

  it('目标达成才进入 completed', () => {
    expect(goalStatusToOrchestrator('goal_reached')).toEqual({
      status: 'completed',
      reason: 'goal_reached',
    });
  });

  it('in_progress 不切换状态', () => {
    expect(goalStatusToOrchestrator('in_progress')).toEqual({ status: null, reason: null });
  });

  it('无进展轮数阈值', () => {
    expect(shouldMarkStalled(2, 3)).toBe(false);
    expect(shouldMarkStalled(3, 3)).toBe(true);
  });

  it('终态判定', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('planning')).toBe(false);
    expect(isTerminal('stalled')).toBe(false);
  });
});
