import { describe, expect, it } from 'vitest';
import { knowledgeProgressKeys, recordKnowledgeProgress, type ProgressFact } from './knowledge-progress';

const fact = (over: Partial<ProgressFact> = {}): ProgressFact => ({ targetIp: 'example.test', subject: 'example.test:80', predicate: 'port_state', object: 'open', status: 'observed', observationKind: 'target_state', sourceEvidenceIds: ['e1'], ...over });
const valid = new Set(['e1', 'e2']);

describe('evidence-backed knowledge progress', () => {
  it('does not reward duplicate rows, whitespace, or new evidence IDs for the same observation', () => {
    const keys = knowledgeProgressKeys([fact(), fact({ object: '  open  ', sourceEvidenceIds: ['e2'] })], valid);
    expect(keys).toHaveLength(1);
    const seen = new Set(keys);
    expect(recordKnowledgeProgress(seen, keys)).toBe(0);
    recordKnowledgeProgress(seen, []);
    expect(recordKnowledgeProgress(seen, keys)).toBe(0);
  });
  it('counts negative target results, verification and evidence-backed refutation as new knowledge', () => {
    const seen = new Set(knowledgeProgressKeys([fact()], valid));
    expect(recordKnowledgeProgress(seen, knowledgeProgressKeys([fact({ status: 'verified' })], valid))).toBe(1);
    expect(recordKnowledgeProgress(seen, knowledgeProgressKeys([fact({ status: 'refuted' })], valid))).toBe(1);
    expect(recordKnowledgeProgress(seen, knowledgeProgressKeys([fact({ object: 'closed', observationKind: 'target_negative' })], valid))).toBe(1);
  });
  it('does not treat tool failures, model guesses or dangling/cross-task evidence as progress', () => {
    expect(knowledgeProgressKeys([
      fact({ observationKind: 'probe_error' }), fact({ status: 'inferred' }),
      fact({ sourceEvidenceIds: [] }), fact({ sourceEvidenceIds: ['other-task'] }),
    ], valid)).toEqual([]);
  });
  it('preserves distinct targets, resources and case-sensitive observation values', () => {
    expect(knowledgeProgressKeys([fact(), fact({ targetIp: 'other.test' }), fact({ subject: 'example.test:443' }), fact({ object: 'Open' })], valid)).toHaveLength(4);
  });
});
