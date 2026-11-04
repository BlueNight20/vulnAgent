import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * 任务状态事件（持久化事件总线）。
 * tasks.service 只写该表，Orchestrator 通过轮询消费，
 * 避免 TaskService 与 Orchestrator 之间的双向依赖。
 */
@Entity('task_state_events')
@Index(['consumedAt'])
@Index(['taskId', 'createdAt'])
export class TaskStateEventEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  /** task.created / task.paused / task.resumed / task.stopped / task.rerun / task.deleted */
  @Column({ length: 40 })
  eventType: string;

  @Column({ type: 'simple-json', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({ type: 'datetime', nullable: true })
  consumedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
