import { MAX_PLANNER_INTENTS } from '@vulnagent/shared';
import type { ParsedPlannerResult } from './result-parser';

/** 选择优先级最高的可执行批次；未接纳方向仅留审计，不进入执行队列。 */
export function limitPlannerOutput(parsed: ParsedPlannerResult, available: number) {
  const limit = Math.max(0, Math.min(MAX_PLANNER_INTENTS, Math.floor(available)));
  const ordered = parsed.intents.map((intent, index) => ({ intent, index }))
    .sort((a, b) => b.intent.priority - a.intent.priority || a.index - b.index);
  const intents = ordered.slice(0, limit).map((row) => row.intent);
  const dropped = ordered.slice(limit).map((row) => row.intent);
  const retainedRefs = new Set(intents.flatMap((intent) => intent.hypothesisRefs));
  const droppedRefs = new Set(dropped.flatMap((intent) => intent.hypothesisRefs));
  // 独立研究假设仍有价值；仅由被推迟意图引用的假设暂不创建。
  const hypotheses = parsed.hypotheses.filter((h) => !h.key || retainedRefs.has(h.key) || !droppedRefs.has(h.key));
  return { intents, hypotheses, dropped, limit };
}

interface PendingIntent {
  id: string;
  priority: number;
  workerProfileId: string;
  dependencies: string[];
  createdAt: Date;
}

/** Keep dependency closures together; verification and dependencies of active work are protected. */
export function compactPendingQueue<T extends PendingIntent>(pending: T[], capacity: number, activeDependencies: string[] = []) {
  const byId = new Map(pending.map((row) => [row.id, row]));
  const kept = new Set<string>();
  const closure = (id: string, found = new Set<string>()): Set<string> => {
    if (found.has(id) || !byId.has(id)) return found;
    found.add(id);
    for (const dependency of byId.get(id)!.dependencies) closure(dependency, found);
    return found;
  };
  for (const id of [...activeDependencies, ...pending.filter((row) => row.workerProfileId === 'verification').map((row) => row.id)]) {
    for (const dependency of closure(id)) kept.add(dependency);
  }
  const protectedCount = kept.size;
  const ordered = [...pending].sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  for (const row of ordered) {
    const group = closure(row.id);
    const additions = [...group].filter((id) => !kept.has(id));
    if (kept.size + additions.length <= Math.max(0, Math.floor(capacity))) for (const id of additions) kept.add(id);
  }
  return { retained: pending.filter((row) => kept.has(row.id)), deferred: pending.filter((row) => !kept.has(row.id)), protectedCount };
}
