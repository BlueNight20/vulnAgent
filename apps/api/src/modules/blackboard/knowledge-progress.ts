import { createHash } from 'node:crypto';
import type { FactObservationKind, FactStatus } from '@vulnagent/shared';

export interface ProgressFact {
  targetIp: string | null;
  subject: string;
  predicate: string;
  object: string;
  status: FactStatus;
  observationKind: FactObservationKind;
  sourceEvidenceIds: string[];
}

/** Count knowledge changes, not new rows or repeated evidence attachments. */
export function knowledgeProgressKeys(facts: ProgressFact[], validEvidenceIds: Set<string>): string[] {
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const keys = new Set<string>();
  for (const fact of facts) {
    if (!['observed', 'verified', 'refuted'].includes(fact.status)) continue;
    if (!['target_state', 'target_negative'].includes(fact.observationKind)) continue;
    if (!fact.sourceEvidenceIds?.some((id) => validEvidenceIds.has(id))) continue;
    const identity = [fact.targetIp?.toLowerCase() ?? '', normalize(fact.subject),
      normalize(fact.predicate).toLowerCase().replace(/[ -]+/g, '_'), normalize(fact.object),
      fact.observationKind, fact.status];
    keys.add(createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
  }
  return [...keys].sort();
}

/** Retain seen identities so removal/reinsertion cannot repeatedly reset stagnation. */
export function recordKnowledgeProgress(seen: Set<string>, current: string[]): number {
  let gained = 0;
  for (const key of current) {
    if (!seen.has(key)) { seen.add(key); gained++; }
  }
  return gained;
}
