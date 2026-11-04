import { describe, expect, it } from 'vitest';
import { compactPendingQueue, limitPlannerOutput } from './planner-capacity';
import type { ParsedPlannerResult } from './result-parser';

function plan(): ParsedPlannerResult {
  return {
    analysis: '', goalStatus: 'in_progress',
    intents: Array.from({ length: 71 }, (_, index) => ({ title: `方向 ${index}`, priority: index,
      hypothesis: '', objective: '', rationale: '', workerProfileId: 'recon', suggestedTools: [], expectedEvidence: [],
      targetIp: null, dedupeKey: `${index}`, hypothesisRefs: [`h${index}`, 'shared'] })),
    hypotheses: ['h0', 'h70', 'shared', 'independent'].map((key) => ({ key, title: key, description: '',
      status: 'proposed', severity: null, hypothesisId: null, targetIp: null, evidenceQuotes: [], factIds: [], rationale: '' })),
  };
}

describe('规划容量约束', () => {
  const row = (id: string, priority: number, dependencies: string[] = [], workerProfileId = 'recon') => ({ id, priority, dependencies, workerProfileId, createdAt: new Date(0) });
  it('复评后将 71 个旧方向收敛到容量，优先保留高优先级方向', () => {
    const result = compactPendingQueue(Array.from({ length: 71 }, (_, i) => row(`${i}`, i)), 4);
    expect(result.retained.map((i) => i.priority)).toEqual([67, 68, 69, 70]);
    expect(result.deferred).toHaveLength(67);
  });
  it('保留完整依赖链，不因高优先级子任务挤掉前置任务', () => {
    const result = compactPendingQueue([row('parent', 1), row('child', 100, ['parent']), row('other', 90)], 2);
    expect(result.retained.map((i) => i.id)).toEqual(['parent', 'child']);
  });
  it('保护验证与活动任务依赖，并显式报告必要的容量例外', () => {
    const result = compactPendingQueue([row('a', 1), row('v', 10, ['a'], 'verification'), row('b', 2), row('other', 99)], 2, ['b']);
    expect(result.retained.map((i) => i.id)).toEqual(['a', 'v', 'b']);
    expect(result.protectedCount).toBe(3);
    expect(result.deferred.map((i) => i.id)).toEqual(['other']);
  });
  it('循环依赖不会导致递归失控，也不会超过普通队列容量', () => {
    expect(compactPendingQueue([row('a', 2, ['b']), row('b', 1, ['a'])], 1).retained).toHaveLength(0);
  });
  it('71 个方向只接纳最高优先级的 3 个，保留共享和独立假设', () => {
    const source = plan();
    const batch = limitPlannerOutput(source, 8);
    expect(batch.intents.map((i) => i.title)).toEqual(['方向 70', '方向 69', '方向 68']);
    expect(batch.dropped).toHaveLength(68);
    expect(batch.hypotheses.map((h) => h.key)).toEqual(['h70', 'shared', 'independent']);
    expect(source.intents).toHaveLength(71);
  });
  it('遵守剩余队列容量，满队列不再增加意图', () => {
    expect(limitPlannerOutput(plan(), 1).intents).toHaveLength(1);
    expect(limitPlannerOutput(plan(), 0).intents).toHaveLength(0);
  });
});
