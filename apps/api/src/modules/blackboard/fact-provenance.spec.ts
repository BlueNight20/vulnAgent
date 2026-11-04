import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  isEvidenceBacked,
  validateFactDraft,
} from './fact-provenance';

const base = {
  category: 'service' as const,
  subject: '192.168.56.101:80',
  predicate: 'runs',
  object: 'Apache httpd 2.4.29',
};

describe('事实溯源规则', () => {
  it('模型推断允许无证据但置信度受限', () => {
    validateFactDraft({
      ...base,
      status: 'inferred',
      createdBy: 'agent',
      sourceEvidenceIds: [],
      confidence: 0.4,
    });
    expect(() =>
      validateFactDraft({
        ...base,
        status: 'inferred',
        createdBy: 'agent',
        sourceEvidenceIds: [],
        confidence: 0.9,
      }),
    ).toThrow(/置信度/);
  });

  it('observed 必须有关联证据', () => {
    expect(() =>
      validateFactDraft({
        ...base,
        status: 'observed',
        createdBy: 'tool',
        sourceEvidenceIds: [],
        confidence: 0.9,
      }),
    ).toThrow(/证据/);
  });

  it('observed 有证据时通过', () => {
    validateFactDraft({
      ...base,
      status: 'observed',
      createdBy: 'tool',
      sourceEvidenceIds: ['ev-1'],
      confidence: 0.9,
    });
  });

  it('Agent 不能直接把结论标记为 observed', () => {
    expect(() =>
      validateFactDraft({
        ...base,
        status: 'observed',
        createdBy: 'agent',
        sourceEvidenceIds: ['ev-1'],
        confidence: 0.9,
      }),
    ).toThrow(/工具证据/);
  });

  it('工具产出的事实不能标记为 inferred', () => {
    expect(() =>
      validateFactDraft({
        ...base,
        status: 'inferred',
        createdBy: 'tool',
        sourceEvidenceIds: [],
        confidence: 0.3,
      }),
    ).toThrow();
  });

  it('refuted 需要推翻依据', () => {
    expect(() =>
      validateFactDraft({
        ...base,
        status: 'refuted',
        createdBy: 'user',
        sourceEvidenceIds: [],
        confidence: 0.9,
      }),
    ).toThrow(/推翻依据/);
  });

  it('状态迁移：inferred 不能直接到 verified', () => {
    expect(canTransition('inferred', 'verified')).toBe(false);
    expect(() => assertTransition('inferred', 'verified', ['ev-1'])).toThrow();
  });

  it('状态迁移：observed 到 verified 需要证据', () => {
    expect(canTransition('observed', 'verified')).toBe(true);
    expect(() => assertTransition('observed', 'verified', [])).toThrow(/证据/);
    expect(() => assertTransition('observed', 'verified', ['ev-1'])).not.toThrow();
  });

  it('refuted 为终态', () => {
    expect(canTransition('refuted', 'verified')).toBe(false);
  });

  it('仅 observed / verified 可作为漏洞证据', () => {
    expect(isEvidenceBacked('inferred')).toBe(false);
    expect(isEvidenceBacked('observed')).toBe(true);
    expect(isEvidenceBacked('verified')).toBe(true);
    expect(isEvidenceBacked('refuted')).toBe(false);
  });
});
