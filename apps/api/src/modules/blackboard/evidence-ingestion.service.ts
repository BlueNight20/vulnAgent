import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { In, Repository } from 'typeorm';
import { EvidenceEntity } from '../../database/entities';
import { extractFacts } from '../orchestrator/evidence-fact-extractor';
import { FactsService } from './facts.service';

/** Worker 和审批结果共用证据回写；只读取本任务、完整性正确的原文。 */
@Injectable()
export class EvidenceIngestionService {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    @InjectRepository(EvidenceEntity) private readonly evidence: Repository<EvidenceEntity>,
    private readonly facts: FactsService,
  ) {}

  async ingest(taskId: string, evidenceIds: string[]): Promise<string[]> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.apply(taskId, evidenceIds));
    this.queues.set(taskId, work);
    try { return await work; }
    finally { if (this.queues.get(taskId) === work) this.queues.delete(taskId); }
  }

  private async apply(taskId: string, evidenceIds: string[]): Promise<string[]> {
    const ids = new Set<string>();
    // 不设总数截断，分批处理，避免 Worker 证据超过 30 条时被静默丢弃。
    const unique = [...new Set(evidenceIds)];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const rows = await this.evidence.find({ where: { taskId, id: In(unique.slice(offset, offset + 100)) } });
      for (const row of rows) {
        if (!row.content || !row.sha256 || createHash('sha256').update(row.content).digest('hex') !== row.sha256) continue;
        if (row.sizeBytes !== null && row.sizeBytes !== Buffer.byteLength(row.content, 'utf8')) continue;
        const tool = typeof row.meta?.tool === 'string' ? row.meta.tool : null;
        const target = typeof row.meta?.targetIp === 'string' ? row.meta.targetIp : null;
        if (!tool) continue;
        for (const fact of extractFacts(tool, target, row.content)) {
          const saved = await this.facts.create({
            taskId, agentSessionId: row.agentSessionId, ...fact, status: 'observed',
            sourceEvidenceIds: [row.id], createdBy: 'tool', sourceTool: tool,
            targetIp: fact.targetIp ?? target, observedAt: row.createdAt,
          });
          ids.add(saved.id);
        }
      }
    }
    return [...ids];
  }
}
