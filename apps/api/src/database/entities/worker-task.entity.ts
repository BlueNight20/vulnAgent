import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { WorkerProfileId, WorkerTaskStatus } from '@vulnagent/shared';

@Entity('worker_tasks')
@Index(['taskId', 'status'])
@Index(['status', 'leaseExpiresAt'])
export class WorkerTaskEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  intentId: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  parentWorkerTaskId: string | null;

  @Column({ length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 24, nullable: true })
  profileId: WorkerProfileId | null;

  @Column({ length: 20, default: 'queued' })
  status: WorkerTaskStatus;

  /** 重试计数，与 dedupeKey 解耦（重试不修改 dedupeKey） */
  @Column({ type: 'integer', default: 0 })
  attempt: number;

  @Column({ type: 'integer', default: 2 })
  maxAttempts: number;

  @Column({ type: 'varchar', length: 200, nullable: true })
  dedupeKey: string | null;

  @Column({ type: 'integer', default: 300 })
  timeoutSeconds: number;

  /** 租约到期时间，用于超时回收 */
  @Column({ type: 'datetime', nullable: true })
  leaseExpiresAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  tokensSpent: number;

  @Column({ type: 'simple-json', default: '[]' })
  evidenceIds: string[];

  @Column({ type: 'simple-json', nullable: true })
  input: Record<string, unknown> | null;

  @Column({ type: 'simple-json', nullable: true })
  output: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  resultCardId: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'datetime', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  endedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
