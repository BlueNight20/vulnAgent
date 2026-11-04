import { describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { availableActions, canApplyAction, isTerminal, nextStatus } from './task-state-machine';

describe('任务状态机', () => {
  it('运行中的任务可以暂停', () => {
    expect(nextStatus('running', 'pause')).toBe('paused');
  });

  it('暂停中的任务可以恢复', () => {
    expect(nextStatus('paused', 'resume')).toBe('running');
  });

  it('待启动任务不能暂停（给出明确冲突错误）', () => {
    expect(canApplyAction('pending', 'pause')).toBe(false);
    expect(() => nextStatus('pending', 'pause')).toThrow(ConflictException);
  });

  it('已完成任务可以重新运行', () => {
    expect(nextStatus('completed', 'rerun')).toBe('pending');
  });

  it('运行中的任务不能直接重新运行', () => {
    expect(canApplyAction('running', 'rerun')).toBe(false);
  });

  it('可用动作根据状态计算', () => {
    expect(availableActions('running').sort()).toEqual(['pause', 'stop']);
    expect(availableActions('paused').sort()).toEqual(['rerun', 'resume', 'stop']);
    expect(availableActions('completed')).toEqual(['rerun']);
  });

  it('终态判定', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('stopped')).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });
});
