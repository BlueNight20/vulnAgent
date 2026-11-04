import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type EntityManager } from 'typeorm';
import { createHash } from 'node:crypto';
import type { EvidenceKind } from '@vulnagent/shared';
import { EvidenceAttachmentEntity, EvidenceEntity, ToolCallEntity } from '../../database/entities';
import { newId } from '../../common/utils/id';
import { argumentFingerprint, extractTargets } from '../mcp/scope-guard';
import { approvalTransaction } from '../mcp/approval-outcome';
import { EventsGateway } from '../events/events.gateway';
import type { InvokeOutcome } from './tool-invoker';
import type { ToolAttachmentInput } from './core-tool';
import { evidenceTextOf } from './tool-result';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

export interface RecordInput {
  taskId: string;
  sessionId: string | null;
  role: string;
  outcome: InvokeOutcome;
  input: Record<string, unknown>;
}

export interface RecordResult {
  toolCallId: string;
  evidenceId: string | null;
  attachmentIds: string[];
}

function statusOf(outcome: InvokeOutcome): string {
  if (outcome.failureKind === 'cancelled') return 'cancelled';
  if (outcome.failureKind === 'timeout') return 'timeout';
  if (outcome.failureKind === 'blocked') return 'denied';
  return outcome.encoded.isError ? 'error' : 'success';
}

function primaryTarget(input: Record<string, unknown>): string | null {
  const found = extractTargets(input).map((t) => t.normalized).find((value) => value.length <= 64);
  return found ?? null;
}

/**
 * 记录写入本体（纯函数，调用方负责事务）。
 *
 * 独立导出以便回归脚本直接复用真实实现，而不是另写一份近似逻辑。
 * 只有"真正执行过"的调用才产生证据；被拦截/取消的调用只留审计记录，
 * 避免"没发生的操作"污染证据链。
 */
export async function writeToolRecord(manager: EntityManager, input: RecordInput): Promise<RecordResult> {
  const { outcome } = input;
  const attachments = (outcome.result.content as unknown[])
    .filter((block): block is ToolAttachmentInput & { type: 'attachment' } =>
      typeof block === 'object' && block !== null && (block as { type?: string }).type === 'attachment' && 'data' in (block as object));
  const targetIp = primaryTarget(input.input);
  const status = statusOf(outcome);
  const toolCallId = newId();
  // 只有"真正拿到结果"的调用才产生证据：被拦截/取消/结果未知都不写，
  // 否则会把没发生的操作写进证据链。
  const evidenceId = outcome.failureKind ? null : newId();
  const attachmentIds: string[] = [];

  if (evidenceId) {
    // 先分配附件 ID：证据 meta.attachmentIds 必须与随后插入的附件一致，
    // 否则附件列表接口无法判断"来源附件已丢失"。
    for (const attachment of attachments) {
      const id = attachment.id || newId();
      attachmentIds.push(id);
      (attachment as { resolvedId?: string }).resolvedId = id;
    }
    // 证据保存未截断全文：模型上下文受限，但复核必须能逐字比对原始输出。
    const content = evidenceTextOf(outcome.result);
    const kind: EvidenceKind = attachments.length && attachments.every((a) => a.mimeType.startsWith('image/'))
      ? 'screenshot'
      : attachments.some((a) => /pcap/.test(a.mimeType) || /\.pcap(?:ng)?$/i.test(a.filename)) ? 'pcap'
        : attachments.length && !content.trim() ? 'file' : 'command_output';
    await manager.insert(EvidenceEntity, {
      id: evidenceId, taskId: input.taskId, agentSessionId: input.sessionId, toolCallId,
      kind, title: `${outcome.tool}${targetIp ? ` → ${targetIp}` : ''}`,
      mimeType: attachments.length && !content.trim() ? attachments[0].mimeType : 'text/plain',
      content: content || null, filePath: null,
      sha256: sha256(Buffer.from(content, 'utf8')),
      sizeBytes: Buffer.byteLength(content),
      meta: {
        tool: outcome.tool, targetIp, latencyMs: outcome.durationMs, role: input.role,
        attachmentIds,
        externalReferences: outcome.result.content
          .filter((block): block is { type: 'reference'; name: string; uri: string } => block.type === 'reference')
          .map((block) => ({ name: block.name, uri: block.uri })),
        modelContextTruncated: outcome.encoded.truncation.truncated,
        removedFromModelContext: outcome.encoded.truncation.removed,
        failureKind: outcome.failureKind,
      },
      createdAt: new Date(),
    } as never);

    for (const attachment of attachments) {
      const id = (attachment as { resolvedId?: string }).resolvedId ?? attachment.id ?? newId();
      await manager.insert(EvidenceAttachmentEntity, {
        id, taskId: input.taskId, evidenceId,
        filename: attachment.filename.slice(0, 160), mimeType: attachment.mimeType,
        sha256: attachment.sha256 || sha256(attachment.data),
        sizeBytes: attachment.data.length, sourceUri: attachment.sourceUri ?? null,
        data: attachment.data, createdAt: new Date(),
      } as never);
    }
  }

  await manager.insert(ToolCallEntity, {
    id: toolCallId, taskId: input.taskId, agentSessionId: input.sessionId,
    mcpServerId: String(outcome.result.details?.serverId ?? '') || null,
    toolName: outcome.tool, arguments: input.input,
    argumentsHash: argumentFingerprint(outcome.tool, input.input),
    targetIp, decision: outcome.failureKind === 'blocked' ? 'deny' : 'allow',
    decisionReason: outcome.blockReason ?? null, status, latencyMs: outcome.durationMs,
    rawOutputRef: evidenceId, errorMessage: outcome.encoded.isError ? outcome.encoded.text.slice(0, 2000) : null,
    failureKind: null, createdAt: new Date(),
  } as never);

  return { toolCallId, evidenceId, attachmentIds };
}

/**
 * 工具调用落库：审计记录 + 原始输出证据。
 *
 * 与执行分离：Invoker 只负责"调用是否被允许、结果是什么"，
 * 这里负责"把一次调用变成可复核的记录"。落库失败时仍然返回模型可见结果，
 * 但会标明"结果已产生、证据未保存"，避免冒充成功。
 */
@Injectable()
export class ToolRecorder {
  constructor(
    @InjectRepository(ToolCallEntity) private readonly calls: Repository<ToolCallEntity>,
    private readonly events: EventsGateway,
  ) {}

  async record(input: RecordInput): Promise<RecordResult & { storageError: string | null }> {
    try {
      const saved = await approvalTransaction(this.calls.manager, (manager) => writeToolRecord(manager, input));
      try {
        this.events.broadcast('tool.call', {
          taskId: input.taskId, sessionId: input.sessionId, toolCallId: saved.toolCallId,
          toolName: input.outcome.tool, targetIp: primaryTarget(input.input),
          status: statusOf(input.outcome), latencyMs: input.outcome.durationMs,
          summary: input.outcome.encoded.text.slice(0, 300), evidenceId: saved.evidenceId,
        });
      } catch { /* 推送失败不影响已提交的记录。 */ }
      return { ...saved, storageError: null };
    } catch (error) {
      // 远端可能已经执行；只能如实说明"结果未知、本地未保存"，不能重放。
      const storageError = `工具调用记录保存失败，执行结果需人工核实（不能当作未执行）：${error instanceof Error ? error.message : String(error)}`;
      // 失败也必须留下审计痕迹：否则并发场景下失败调用会从记录里消失。
      try {
        const failedId = newId();
        await this.calls.manager.getRepository(ToolCallEntity).save({
          id: failedId,
          taskId: input.taskId, agentSessionId: input.sessionId, mcpServerId: null,
          toolName: input.outcome.tool, arguments: input.input,
          argumentsHash: argumentFingerprint(input.outcome.tool, input.input),
          targetIp: primaryTarget(input.input), decision: 'allow', decisionReason: null,
          status: 'error', latencyMs: input.outcome.durationMs, rawOutputRef: null,
          errorMessage: storageError.slice(0, 2000), failureKind: null, createdAt: new Date(),
        } as never);
        return { toolCallId: failedId, evidenceId: null, attachmentIds: [], storageError };
      } catch {
        return { toolCallId: '', evidenceId: null, attachmentIds: [], storageError };
      }
    }
  }
}
