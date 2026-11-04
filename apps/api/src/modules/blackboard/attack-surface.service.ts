import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { In, Repository } from 'typeorm';
import type { AttackSurfaceDto } from '@vulnagent/shared';
import { EvidenceEntity, FactEntity, FindingEntity, TargetEntity, TaskEntity } from '../../database/entities';
import { buildAttackSurface } from './attack-surface-builder';

@Injectable()
export class AttackSurfaceService {
  constructor(@InjectRepository(FactEntity) private readonly facts: Repository<FactEntity>) {}
  async get(taskId: string): Promise<AttackSurfaceDto> {
    const manager = this.facts.manager;
    const task = await manager.findOne(TaskEntity, { where: { id: taskId } });
    if (!task) throw new NotFoundException('任务不存在');
    const [targets, facts, findings] = await Promise.all([
      manager.find(TargetEntity, { where: { taskId } }), this.facts.find({ where: { taskId } }),
      manager.find(FindingEntity, { where: { taskId } }),
    ]);
    const ids = [...new Set(facts.flatMap((f) => f.sourceEvidenceIds))];
    const validIds: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const rows = await manager.find(EvidenceEntity, { where: { taskId, id: In(ids.slice(offset, offset + 100)) } });
      for (const row of rows) {
        if (row.content?.trim() && row.sha256 === createHash('sha256').update(row.content).digest('hex') && (row.sizeBytes === null || row.sizeBytes === Buffer.byteLength(row.content, 'utf8'))) validIds.push(row.id);
      }
    }
    return buildAttackSurface(taskId, targets, task.scope,
      facts.map((f) => ({ ...f, createdAt: f.createdAt.toISOString(), observedAt: f.observedAt?.toISOString() ?? null })),
      findings.map((f) => ({ ...f, createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString() })), validIds);
  }
  async summary(taskId: string): Promise<string> {
    const surface = await this.get(taskId);
    const summary = surface.assets.slice(0, 60).map((asset) => [
      `${asset.address} [${asset.inScope ? '范围内' : '范围外，仅供观察'}] ${asset.kind === 'cidr' ? '授权网段' : asset.aliveObserved ? '有存活证据' : '存活未知'}`,
      ...asset.ports.map((port) => `  ${port.port}/${port.protocol}: ${port.states.join('|') || '状态未知'}; ${port.services.join(' / ') || '服务未识别'}`),
      ...asset.technologies.slice(0, 8).map((fact) => `  ${fact.predicate}: ${fact.value} [事实 ${fact.factId}]`),
      ...asset.endpoints.slice(0, 8).map((fact) => `  ${fact.subject} ${fact.predicate}: ${fact.value} [事实 ${fact.factId}]`),
      ...asset.gaps.map((gap) => `  缺口: ${gap}`),
    ].join('\n')).join('\n');
    return `资产记录 ${surface.assets.length}，摘要最多 60 条；缺少观测不等于服务不存在。\n${summary.slice(0, 20000)}${summary.length > 20000 || surface.assets.length > 60 ? '\n摘要已截断，不能据此判定全部目标已覆盖。' : ''}`;
  }
}
