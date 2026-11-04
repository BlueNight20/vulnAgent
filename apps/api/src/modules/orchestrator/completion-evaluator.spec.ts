import { describe, expect, it } from 'vitest';
import { evaluateCompletion, type CompletionSignal } from './completion-evaluator';
import type { TaskAcceptance } from '@vulnagent/shared';

const acceptance = (over: Partial<TaskAcceptance> = {}): TaskAcceptance => ({ goal: null, configured: true, complete: false, checks: [{ id: 'ports', label: '80,443 端口覆盖', passed: false, evidenceIds: [] }], notes: [], ...over });
const base = (over: Partial<CompletionSignal> = {}): CompletionSignal => ({ plannerGoal: 'in_progress', acceptance: acceptance(), hasPendingIntents: false, hasActiveWorkers: false, noProgressRounds: 0, noProgressThreshold: 3, budgetExhausted: false, ...over });

describe('按任务验收结果决定完成', () => {
  it('Planner 说完成而验收项未满足时停滞并给出缺口', () => {
    const result = evaluateCompletion(base({ plannerGoal: 'goal_reached' }));
    expect(result.status).toBe('stalled'); expect(result.detail).toContain('80,443');
  });
  it('全部验收项实际满足后无需模型再次自称完成', () => {
    expect(evaluateCompletion(base({ acceptance: acceptance({ complete: true }) })).status).toBe('completed');
  });
  it('旧任务没有目标时要求配置，不按事实条数推断成功', () => {
    expect(evaluateCompletion(base({ plannerGoal: 'goal_reached', acceptance: acceptance({ configured: false }) })).status).toBe('needs_input');
  });
  it.each([{ hasActiveWorkers: true }, { hasPendingIntents: true }])('已有满足的验收结果仍不能丢弃在途工作 %j', (work) => {
    expect(evaluateCompletion(base({ acceptance: acceptance({ complete: true }), ...work })).finish).toBe(false);
  });
  it('全自动模式不再因审批而等待：无在途工作时直接按验收结论推进', () => {
    expect(evaluateCompletion(base({ acceptance: acceptance({ complete: true }) })).status).toBe('completed');
  });
  it.each(['budget_tokens', 'budget_time'] as const)('预算停止原因保持准确 %s', (reason) => {
    expect(evaluateCompletion(base({ budgetExhausted: true, budgetReason: reason, acceptance: acceptance({ complete: true }) })).reason).toBe(reason);
  });
  it('明确阻塞与无进展分别保留停滞信息', () => {
    expect(evaluateCompletion(base({ plannerGoal: 'blocked' })).detail).toContain('阻塞');
    expect(evaluateCompletion(base({ noProgressRounds: 3 })).status).toBe('stalled');
  });
  it('模型请求输入时不误报完成', () => { expect(evaluateCompletion(base({ plannerGoal: 'needs_input' })).status).toBe('needs_input'); });
  it('其余情况继续探索', () => { expect(evaluateCompletion(base()).finish).toBe(false); });
});
