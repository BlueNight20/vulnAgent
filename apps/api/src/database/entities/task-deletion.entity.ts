import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** 仅保存已删除任务 ID，阻止旧异步回调通过 save() 重新插入任务。 */
@Entity('task_deletions')
export class TaskDeletionEntity {
  @PrimaryColumn('varchar', { length: 36 }) taskId: string;
  @CreateDateColumn() deletedAt: Date;
}
