import type { FactCategory } from '@vulnagent/shared';
import { buildTool, errorResult, textResult, type CoreTool } from './core-tool';
import type { FactsService } from '../blackboard/facts.service';
import type { FindingsService } from '../blackboard/findings.service';
import type { HypothesisService } from '../blackboard/hypothesis.service';
import { classifyClue } from '../blackboard/fact-classifier';

/**
 * 业务工具：把"记录事实 / 上报候选漏洞 / 提出假设"变成模型可见的工具，
 * 而不是事后靠解析自然语言。与靶机工具走同一 Registry 与同一执行入口，
 * 因此参数校验、审计与权限规则自动一致。
 *
 * 三个工具都声明 readOnly=true：它们只写黑板，不触达目标主机。
 */

export interface BusinessToolDeps {
  facts: FactsService;
  findings: FindingsService;
  hypotheses: HypothesisService;
}

const EVIDENCE_HINT = '必须引用已存在的证据 ID；本会话没有证据时请先执行测量类工具。';

export function buildBusinessTools(deps: BusinessToolDeps): CoreTool[] {
  return [
    buildTool({
      name: 'record_fact',
      description: '记录一条有证据支持的事实（目标状态、服务、端口、路径等）。',
      prompt: EVIDENCE_HINT,
      source: 'business',
      readOnly: true,
      concurrencySafe: false,
      inputSchema: {
        type: 'object',
        required: ['subject', 'predicate', 'object', 'evidenceIds'],
        properties: {
          subject: { type: 'string', description: '主体，例如 192.168.56.101:22/tcp' },
          predicate: { type: 'string', description: '关系，例如 has_open_port / exposes_service / has_path' },
          object: { type: 'string', description: '客体，例如 ssh / Apache 2.4.49' },
          category: { type: 'string', enum: ['asset', 'service', 'technology', 'credential', 'vulnerability', 'privilege', 'network'], description: '事实类别，默认 service' },
          targetIp: { type: 'string', description: '归属目标，可留空' },
          evidenceIds: { type: 'array', items: { type: 'string' }, description: '支撑该事实的证据 ID' },
          status: { type: 'string', enum: ['observed', 'verified', 'inferred'], description: '没有证据时只能是 inferred' },
        },
      },
      exec: { kind: 'internal', handler: 'record_fact' },
      run: async (input, ctx) => {
        const sourceEvidenceIds = Array.isArray(input.evidenceIds) ? input.evidenceIds.map(String) : [];
        if (!sourceEvidenceIds.length) {
          return errorResult('record_fact 需要至少一个证据 ID；没有证据的结论请明确说明是推断，不要当作观测事实。');
        }
        const fact = await deps.facts.create({
          taskId: ctx.taskId,
          agentSessionId: ctx.sessionId,
          category: (input.category as FactCategory) ?? 'service',
          subject: String(input.subject ?? ''),
          predicate: String(input.predicate ?? ''),
          object: String(input.object ?? ''),
          status: (input.status as 'observed' | 'verified' | 'inferred') ?? 'observed',
          sourceEvidenceIds,
          targetIp: input.targetIp ? String(input.targetIp) : null,
          sourceTool: 'record_fact',
          createdBy: 'agent',
        });
        return textResult(`事实已记录：${fact.id}（${fact.subject} ${fact.predicate} ${fact.object}）`, { factId: fact.id });
      },
    }),

    buildTool({
      name: 'report_finding',
      description: '上报一个待独立验证的漏洞候选。仅提交候选，不代表已确认；确认必须经过独立验证流程。',
      prompt: `必须携带证据 ID。若候选来自黑板已有漏洞事实，填写 sourceFactIds，以合并同一资源的同一现象并保留溯源。不同路径、参数或认证身份应分别描述。${EVIDENCE_HINT}`,
      source: 'business',
      readOnly: true,
      concurrencySafe: false,
      inputSchema: {
        type: 'object',
        required: ['title', 'description', 'evidenceIds'],
        properties: {
          title: { type: 'string', description: '漏洞标题' },
          sourceFactIds: { type: 'array', items: { type: 'string' }, description: '当前任务中描述同一漏洞现象的来源事实 ID；不要引用验证结果或其他目标的事实' },
          description: { type: 'string', description: '基于原文的描述；不要编造输出中不存在的内容' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          targetIp: { type: 'string' },
          cve: { type: 'string' },
          cwe: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
      exec: { kind: 'internal', handler: 'report_finding' },
      run: async (input, ctx) => {
        const evidenceIds = Array.isArray(input.evidenceIds) ? input.evidenceIds.map(String) : [];
        if (!evidenceIds.length) return errorResult('report_finding 需要至少一个证据 ID；没有证据的猜测不要上报为漏洞候选。');
        // 否定性观测（登录被拒、爆破无结果、匿名被禁）说明目标具备防护，不是漏洞；
        // 拒收而非静默丢弃，让模型知道该结论应记录为事实而不是"发现"。
        const clue = classifyClue({
          predicate: String(input.title ?? ''),
          object: `${String(input.description ?? '')} ${String(input.cwe ?? '')}`,
        });
        if (clue.level === 'non-finding') {
          return errorResult(`该内容属于否定性观测，不构成漏洞候选（${clue.reason}）。请用 record_fact 记录为普通事实。`);
        }
        const finding = await deps.findings.createCandidate({
          taskId: ctx.taskId,
          title: String(input.title ?? ''),
          description: String(input.description ?? ''),
          severity: (input.severity as string) ?? 'medium',
          targetIp: input.targetIp ? String(input.targetIp) : null,
          cve: input.cve ? String(input.cve) : null,
          cwe: input.cwe ? String(input.cwe) : null,
          evidenceIds,
          agentSessionId: ctx.sessionId,
          sourceFactIds: Array.isArray(input.sourceFactIds) ? input.sourceFactIds.map(String) : [],
        });
        return textResult(`漏洞候选已登记：${finding.id}（状态 ${finding.status}）。必须经过独立验证才会确认。`, { findingId: finding.id });
      },
    }),

    buildTool({
      name: 'propose_hypothesis',
      description: '提出一个待验证假设。假设不是结论，需要后续证据支持或反驳。',
      prompt: EVIDENCE_HINT,
      source: 'business',
      readOnly: true,
      concurrencySafe: false,
      inputSchema: {
        type: 'object',
        required: ['title', 'description'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          targetIp: { type: 'string' },
        },
      },
      exec: { kind: 'internal', handler: 'propose_hypothesis' },
      run: async (input, ctx) => {
        if (!String(input.title ?? '').trim() || !String(input.description ?? '').trim()) {
          return errorResult('propose_hypothesis 需要非空标题与说明。');
        }
        const hypothesis = await deps.hypotheses.create({
          taskId: ctx.taskId,
          title: String(input.title),
          description: String(input.description),
          targetIp: input.targetIp ? String(input.targetIp) : null,
          createdBy: 'agent',
        });
        return textResult(`假设已登记：${hypothesis.id}（状态 ${hypothesis.status}）。后续需要明确证据支持或反驳。`, { hypothesisId: hypothesis.id });
      },
    }),
  ];
}
