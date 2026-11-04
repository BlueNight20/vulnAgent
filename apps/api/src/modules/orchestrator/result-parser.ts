import { intentIdentity } from './intent-identity';
import type { FactCategory, Severity, VerificationResult, WorkerProfileId } from '@vulnagent/shared';

export interface ParsedFact {
  category: FactCategory;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  evidenceIndex: number | null;
}

export interface ParsedHypothesis {
  title: string;
  description: string;
  status: 'supported' | 'refuted' | 'proposed';
  severity: Severity | null;
  key: string | null;
  hypothesisId: string | null;
  targetIp: string | null;
  evidenceQuotes: { evidenceId: string; quote: string }[];
  factIds: string[];
  rationale: string;
}

export interface ParsedIntent {
  title: string;
  hypothesis: string;
  objective: string;
  rationale: string;
  workerProfileId: WorkerProfileId;
  suggestedTools: string[];
  expectedEvidence: string[];
  targetIp: string | null;
  priority: number;
  dedupeKey: string;
  hypothesisRefs: string[];
}

export interface ParsedWorkerResult {
  usedEvidenceIds?: string[];
  verification?: VerificationResult | null;
  summary: string;
  facts: ParsedFact[];
  hypotheses: ParsedHypothesis[];
  nextIntents: ParsedIntent[];
  openQuestions: string[];
  nextSteps: string[];
}

export interface ParsedPlannerResult {
  intentReviews?: Array<{ id: string; action: 'keep' | 'retire'; reason: string; priority?: number }>;
  analysis: string;
  goalStatus: 'in_progress' | 'goal_reached' | 'needs_input' | 'blocked';
  hypotheses: ParsedHypothesis[];
  intents: ParsedIntent[];
}

const PROFILE_IDS: WorkerProfileId[] = [
  'recon',
  'web',
  'service',
  'linux-audit',
  'vuln-analysis',
  'verification',
];

const CATEGORIES: FactCategory[] = [
  'asset',
  'service',
  'technology',
  'credential',
  'vulnerability',
  'privilege',
  'network',
];

/** 从模型输出中抽取最后一个 JSON 代码块并解析 */
export function extractJsonBlock(text: string): unknown | null {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidates = fenced.map((m) => m[1].trim());
  if (candidates.length === 0) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates.reverse()) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

function asCategory(value: unknown): FactCategory {
  const v = asString(value).toLowerCase() as FactCategory;
  return CATEGORIES.includes(v) ? v : 'service';
}

function asProfile(value: unknown): WorkerProfileId {
  const v = asString(value).toLowerCase() as WorkerProfileId;
  return PROFILE_IDS.includes(v) ? v : 'recon';
}

function asSeverity(value: unknown): Severity | null {
  const v = asString(value).toLowerCase();
  return ['critical', 'high', 'medium', 'low', 'info'].includes(v) ? (v as Severity) : null;
}

function parseFacts(value: unknown): ParsedFact[] {
  if (!Array.isArray(value)) return [];
  const out: ParsedFact[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const subject = asString(item.subject);
    const predicate = asString(item.predicate);
    const object = asString(item.object);
    if (!subject || !predicate || !object) continue;
    const evidenceIndex =
      typeof item.evidenceIndex === 'number' && Number.isFinite(item.evidenceIndex)
        ? Math.trunc(item.evidenceIndex)
        : null;
    const confidence = typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : 0.6;
    out.push({ category: asCategory(item.category), subject, predicate, object, confidence, evidenceIndex });
  }
  return out;
}

function parseHypotheses(value: unknown): ParsedHypothesis[] {
  if (!Array.isArray(value)) return [];
  const out: ParsedHypothesis[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const title = asString(item.title);
    if (!title) continue;
    const status = asString(item.status).toLowerCase();
    out.push({
      title: title.slice(0, 200),
      description: asString(item.description) || title,
      status: status === 'supported' || status === 'refuted' ? status : 'proposed',
      severity: asSeverity(item.severity),
      key: asString(item.key).slice(0, 64) || null,
      hypothesisId: asString(item.hypothesisId).slice(0, 64) || null,
      targetIp: asString(item.targetIp).slice(0, 64) || null,
      evidenceQuotes: parseQuotes(item.evidenceQuotes),
      factIds: asStringArray(item.factIds).slice(0, 20),
      rationale: asString(item.rationale).slice(0, 4000),
    });
  }
  return out;
}

function parseIntents(value: unknown): ParsedIntent[] {
  if (!Array.isArray(value)) return [];
  const out: ParsedIntent[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const title = asString(item.title);
    if (!title) continue;
    const targetIp = asString(item.targetIp);
    const dedupeKey = intentIdentity({ title, objective: asString(item.objective), hypothesis: asString(item.hypothesis),
      workerProfileId: asProfile(item.workerProfileId), targetIp: targetIp || null, suggestedTools: asStringArray(item.suggestedTools) });
    out.push({
      title: title.slice(0, 200),
      hypothesis: asString(item.hypothesis),
      objective: asString(item.objective),
      rationale: asString(item.rationale),
      workerProfileId: asProfile(item.workerProfileId),
      suggestedTools: asStringArray(item.suggestedTools),
      expectedEvidence: asStringArray(item.expectedEvidence),
      targetIp: targetIp || null,
      priority: typeof item.priority === 'number' ? Math.min(100, Math.max(1, item.priority)) : 50,
      dedupeKey,
      hypothesisRefs: asStringArray(item.hypothesisRefs).slice(0, 10),
    });
  }
  return out;
}

function parseQuotes(value: unknown): { evidenceId: string; quote: string }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((q) => q && typeof q.evidenceId === 'string' && q.evidenceId.length <= 64 && typeof q.quote === 'string' && q.quote.length <= 2000 ? [{ evidenceId: q.evidenceId, quote: q.quote }] : []);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export function parseWorkerResult(text: string): ParsedWorkerResult | null {
  const data = extractJsonBlock(text);
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  return {
    summary: asString(obj.summary),
    usedEvidenceIds: asStringArray(obj.usedEvidenceIds),
    verification: parseVerification(obj.verification),
    facts: parseFacts(obj.facts),
    hypotheses: parseHypotheses(obj.hypotheses),
    nextIntents: parseIntents(obj.nextIntents ?? obj.intents),
    openQuestions: asStringArray(obj.openQuestions),
    nextSteps: asStringArray(obj.nextSteps),
  };
}

function parseVerification(value: unknown): VerificationResult | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (!['confirmed', 'refuted', 'inconclusive'].includes(String(item.outcome))) return null;
  const quotes = Array.isArray(item.evidenceQuotes) ? item.evidenceQuotes : [];
  return {
    outcome: item.outcome as 'confirmed' | 'refuted' | 'inconclusive', summary: asString(item.summary),
    evidenceQuotes: quotes.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const quote = value as Record<string, unknown>;
      return typeof quote.evidenceId === 'string' && typeof quote.quote === 'string' ? [{ evidenceId: quote.evidenceId, quote: quote.quote }] : [];
    }),
  };
}

export function parsePlannerResult(text: string): ParsedPlannerResult | null {
  const data = extractJsonBlock(text);
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const goal = asString(obj.goalStatus).toLowerCase();
  const goalStatus: ParsedPlannerResult['goalStatus'] =
    goal === 'goal_reached' || goal === 'needs_input' || goal === 'blocked' ? goal : 'in_progress';
  return {
    analysis: asString(obj.analysis),
    goalStatus,
    hypotheses: parseHypotheses(obj.hypotheses),
    intents: parseIntents(obj.intents),
    intentReviews: Array.isArray(obj.intentReviews) ? obj.intentReviews.flatMap((review: unknown) => {
      if (!review || typeof review !== 'object') return [];
      const r = review as Record<string, unknown>;
      if (typeof r.id !== 'string' || !['keep', 'retire'].includes(String(r.action)) || typeof r.reason !== 'string' || !r.reason.trim()) return [];
      return [{ id: r.id, action: r.action as 'keep' | 'retire', reason: r.reason.slice(0, 1000),
        ...(typeof r.priority === 'number' && Number.isFinite(r.priority) ? { priority: Math.max(0, Math.min(100, r.priority)) } : {}) }];
    }) : [],
  };
}

/** 模型未输出结构化结果时的确定性降级：只保留文本摘要，不编造事实 */
export function fallbackWorkerResult(text: string, objective: string): ParsedWorkerResult {
  const summary = text.trim().slice(0, 600) || '本次执行未产生可解析的结构化结果';
  return {
    summary,
    facts: [],
    hypotheses: [],
    nextIntents: [],
    openQuestions: ['模型未按约定输出结构化结果，需要人工确认本次执行结论'],
    nextSteps: [`复核目标：${objective}`],
  };
}
