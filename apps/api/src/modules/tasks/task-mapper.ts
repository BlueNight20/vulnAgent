import type { TargetDto, TaskDetail, TaskSummary } from '@vulnagent/shared';
import type { TargetEntity, TaskEntity } from '../../database/entities';
import { toIso } from '../../common/utils/id';

export function toTargetDto(entity: TargetEntity): TargetDto {
  return {
    id: entity.id,
    taskId: entity.taskId,
    ip: entity.ip,
    hostname: entity.hostname,
    kind: entity.kind,
    inScope: entity.inScope,
    note: entity.note,
  };
}

export function toTaskSummary(entity: TaskEntity, targets: TargetEntity[]): TaskSummary {
  return {
    id: entity.id,
    name: entity.name,
    goal: entity.goal ?? null,
    status: entity.status,
    scope: entity.scope,
    modelProvider: entity.modelProvider,
    modelName: entity.modelName,
    tokenBudget: entity.tokenBudget,
    tokensUsed: entity.tokensUsed,
    tokensCommitted: entity.tokensCommitted ?? 0,
    costUsd: entity.costUsd,
    timeBudgetMinutes: entity.timeBudgetMinutes,
    workerCount: entity.workerCount,
    progress: entity.progress,
    currentPhase: entity.currentPhase,
    targetIps: targets.map((t) => t.ip),
    startedAt: toIso(entity.startedAt),
    finishedAt: toIso(entity.finishedAt),
    lastError: entity.lastError,
    createdAt: toIso(entity.createdAt) ?? '',
    updatedAt: toIso(entity.updatedAt) ?? '',
  };
}

export function toTaskDetail(entity: TaskEntity, targets: TargetEntity[]): TaskDetail {
  return {
    ...toTaskSummary(entity, targets),
    description: entity.description,
    authorizationRef: entity.authorizationRef,
    targets: targets.map(toTargetDto),
  };
}
