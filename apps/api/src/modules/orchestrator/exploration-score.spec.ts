import { describe, expect, it } from 'vitest';
import { estimateCost, isHighValueTarget, scoreIntent } from './exploration-score';

const intent = {
  title: 'Web 目录枚举',
  hypothesis: '存在未授权访问目录',
  targetIp: '192.168.56.101',
  suggestedTools: ['gobuster_dir'],
  priority: 50,
};

const facts = {
  relatedFactCount: 3,
  hasEvidenceBackedFact: true,
  sameTargetExecutedCount: 0,
  hypothesisConfidence: 0.5,
  estimatedCost: 0.2,
  dependentsCount: 0,
  highValueTarget: true,
};

describe('探索评分', () => {
  it('假设依据只作有限排序信号，冲突/无依据为中性且不阻止继续验证', () => {
    const neutral = scoreIntent(intent, { ...facts, hypothesisConfidence: 0.3 });
    const supported = scoreIntent(intent, { ...facts, hypothesisConfidence: 0.6 });
    const contradicted = scoreIntent(intent, { ...facts, hypothesisConfidence: 0.1 });
    expect(supported.score).toBeGreaterThan(neutral.score);
    expect(contradicted.score).toBeLessThan(neutral.score);
    expect(supported.score - contradicted.score).toBeLessThan(0.03);
    expect(contradicted.score).toBeGreaterThan(0);
  });
  it('评分在 0..1.05 区间并给出可解释 breakdown', () => {
    const result = scoreIntent(intent, facts);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1.05);
    expect(result.breakdown.evidenceSupport).toBeGreaterThan(0);
    expect(result.explanation).toContain('评分');
  });

  it('已重复探索的目标新颖度下降', () => {
    const fresh = scoreIntent(intent, facts);
    const repeated = scoreIntent(intent, { ...facts, sameTargetExecutedCount: 3 });
    expect(repeated.breakdown.novelty).toBeLessThan(fresh.breakdown.novelty);
    expect(repeated.score).toBeLessThan(fresh.score);
  });

  it('成本高时评分下降', () => {
    const cheap = scoreIntent(intent, facts);
    const expensive = scoreIntent(intent, { ...facts, estimatedCost: 0.95 });
    expect(expensive.score).toBeLessThan(cheap.score);
  });

  it('被其他意图依赖时解锁价值提升', () => {
    const solo = scoreIntent(intent, facts);
    const blocking = scoreIntent(intent, { ...facts, dependentsCount: 3 });
    expect(blocking.breakdown.unlockValue).toBeGreaterThan(solo.breakdown.unlockValue);
  });

  it('Planner 优先级只产生轻微偏置', () => {
    const low = scoreIntent({ ...intent, priority: 1 }, facts);
    const high = scoreIntent({ ...intent, priority: 100 }, facts);
    expect(Math.abs(high.score - low.score)).toBeLessThan(0.12);
  });

  it('识别高价值服务', () => {
    expect(isHighValueTarget('192.168.56.101:80 http')).toBe(true);
    expect(isHighValueTarget('192.168.56.101:111 rpcbind')).toBe(false);
  });

  it('成本估算随工具数量与风险上升', () => {
    expect(estimateCost(1, false)).toBeLessThan(estimateCost(6, false));
    expect(estimateCost(6, true)).toBeGreaterThan(estimateCost(6, false));
    expect(estimateCost(20, true)).toBeLessThanOrEqual(1);
  });
});
