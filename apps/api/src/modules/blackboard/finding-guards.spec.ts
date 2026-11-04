import { describe, expect, it } from 'vitest';
import { assertCandidateSource, assertNotExhausted } from './finding-guards';

describe('漏洞候选来源约束', () => {
  it('验证会话不允许上报新的漏洞候选', () => {
    expect(assertCandidateSource({ role: 'verifier', profileId: 'verification' })).toMatch(/验证会话不能上报/);
  });

  it('即使角色记为 executor，验证档案同样被拦截', () => {
    expect(assertCandidateSource({ role: 'executor', profileId: 'verification' })).toMatch(/验证会话不能上报/);
  });

  it('探索会话可以正常上报候选', () => {
    expect(assertCandidateSource({ role: 'executor', profileId: 'web' })).toBeNull();
    expect(assertCandidateSource(null)).toBeNull();
  });
});

describe('验证排队约束', () => {
  it('已有无法确认结论的候选不再自动重复排队', () => {
    expect(assertNotExhausted({ outcome: 'inconclusive' })).toMatch(/不再自动重复排队/);
  });

  it('新增有效证据后允许重新验证', () => {
    expect(assertNotExhausted({ outcome: 'inconclusive' }, true)).toBeNull();
  });

  it('已确认或已排除的候选允许复查', () => {
    expect(assertNotExhausted({ outcome: 'confirmed' })).toBeNull();
    expect(assertNotExhausted({ outcome: 'refuted' })).toBeNull();
    expect(assertNotExhausted(null)).toBeNull();
  });
});
