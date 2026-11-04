import type { EntityManager } from 'typeorm';
import { TaskStateEventEntity, type ToolCallEntity } from '../../database/entities';

export { serialTransaction as approvalTransaction } from '../../database/serial-transaction';

/** 与审批最终状态同一事务写入。事件 ID 复用审批 ID，确保一条审批只有一个结果事件。 */
export async function writeApprovalOutcome(manager: EntityManager, call: ToolCallEntity, requiresReview = false): Promise<void> {
  if (!call.taskId) return;
  await manager.insert(TaskStateEventEntity, {
    id: call.id, taskId: call.taskId, eventType: 'tool.approval_resolved',
    payload: { approvalId: call.id, ...(requiresReview ? { requiresReview: true } : {}) }, consumedAt: null,
  });
}
