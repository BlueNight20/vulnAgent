import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetryLimitHook } from './invocation-guards';
const event = { taskId: 'task', sessionId: 'one', toolName: 'probe', input: { target: 'host', options: { a: 1, b: 2 } }, role: 'explore' };
afterEach(() => vi.useRealTimers());
describe('任务级失败冷却', () => {
  it('换会话和改变参数键顺序都不能原样重复失败', () => {
    const hook = new RetryLimitHook();
    hook.postToolUse({ ...event, isError: true }); hook.postToolUse({ ...event, isError: true });
    expect(hook.preToolUse({ ...event, sessionId: 'two', input: { options: { b: 2, a: 1 }, target: 'host' } }).action).toBe('block');
    expect(hook.preToolUse({ ...event, taskId: 'another' }).action).toBe('allow');
    expect(hook.preToolUse({ ...event, input: { target: 'host', ports: '80' } }).action).toBe('allow');
  });
  it('冷却后允许验证环境恢复，成功调用清除失败记录', () => {
    vi.useFakeTimers();
    const hook = new RetryLimitHook();
    hook.postToolUse({ ...event, isError: true }); hook.postToolUse({ ...event, isError: true });
    vi.advanceTimersByTime(300001);
    expect(hook.preToolUse(event).action).toBe('allow');
    hook.postToolUse({ ...event, isError: true }); hook.postToolUse({ ...event, isError: false });
    expect(hook.preToolUse(event).action).toBe('allow');
  });
});
