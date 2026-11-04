import type { EntityManager } from 'typeorm';
import { AuditLogEntity, FindingEntity, FindingVerificationEntity, TaskEntity } from '../../database/entities';
import { serialTransaction } from '../../database/serial-transaction';
import { newId } from '../../common/utils/id';

/** 在 Worker 收尾后执行；事务内再次确认终态，避免旧取消回调影响恢复后的任务。 */
export async function reconcileTerminalVerifications(manager: EntityManager, taskId: string): Promise<void> {
  await serialTransaction(manager, async (tx) => {
    const task = await tx.findOne(TaskEntity, { where: { id: taskId } });
    if (!task || !['stopped', 'failed', 'completed'].includes(task.status)) return;
    const pending = await tx.find(FindingVerificationEntity, { where: { taskId, outcome: 'pending' } });
    for (const record of pending) {
      await tx.update(FindingVerificationEntity, record.id, {
        outcome: 'inconclusive', summary: `任务已结束（${task.stopReason ?? task.status}），验证未形成有效结论`,
      });
      await tx.update(FindingEntity, { id: record.findingId, taskId }, { status: 'unconfirmed' });
      await tx.insert(AuditLogEntity, { id: newId(), taskId, action: 'finding.verification_reconciled',
        entityType: 'finding', entityId: record.findingId,
        detail: { verificationId: record.id, taskStatus: task.status, outcome: 'inconclusive' } });
    }
  });
}
