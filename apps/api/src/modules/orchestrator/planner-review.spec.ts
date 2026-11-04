import { describe, expect, it } from 'vitest';
import { parsePlannerResult } from './result-parser';

describe('Planner 待执行计划复核', () => {
  it('接纳有明确依据的复核，并限制优先级范围', () => {
    const parsed = parsePlannerResult(JSON.stringify({ analysis: '新证据改变方向', intents: [], intentReviews: [
      { id: 'old', action: 'retire', reason: '服务已证实关闭' },
      { id: 'keep', action: 'keep', reason: '发现新的验证证据', priority: 900 },
    ] }));
    expect(parsed?.intentReviews).toEqual([
      { id: 'old', action: 'retire', reason: '服务已证实关闭' },
      { id: 'keep', action: 'keep', reason: '发现新的验证证据', priority: 100 },
    ]);
  });
  it('无依据或非法动作不会改变待执行计划', () => {
    const parsed = parsePlannerResult(JSON.stringify({ intents: [], intentReviews: [
      { id: 'old', action: 'retire', reason: '' }, { id: 'old', action: 'delete', reason: 'test' }, null,
    ] }));
    expect(parsed?.intentReviews).toEqual([]);
  });
});
