import { createHash } from 'node:crypto';

/** 标题是展示文案，不应改变同一探索动作的身份。保留资源、认证条件和假设差异。 */
export function intentIdentity(input: {
  title: string; objective?: string; hypothesis?: string; workerProfileId?: string;
  targetIp?: string | null; suggestedTools?: string[]; factIds?: string[];
}): string {
  const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const objective = normalize(input.objective || input.title);
  const hypothesis = normalize(input.hypothesis ?? '');
  const target = input.targetIp?.trim() ?? '';
  const identity = [input.workerProfileId ?? 'recon', target, objective, hypothesis,
    [...new Set(input.suggestedTools ?? [])].sort(), [...new Set(input.factIds ?? [])].sort()];
  return `intent:v2:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}
