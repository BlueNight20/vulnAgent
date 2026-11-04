import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { OrchestratorStatus, StopReason } from '@vulnagent/shared';

/** 编排运行快照：一个任务同一时间只有一个活跃运行实例 */
@Entity('orchestrator_runs')
@Index(['taskId', 'status'])
export class OrchestratorRunEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ length: 24, default: 'idle' })
  status: OrchestratorStatus;

  @Column({ type: 'integer', default: 0 })
  cycleCount: number;

  @Column({ type: 'integer', default: 0 })
  activeWorkers: number;

  @Column({ type: 'integer', default: 0 })
  noProgressRounds: number;

  /** 幂等键：同一任务 + 相同启动请求不会重复创建运行实例 */
  @Column({ length: 120, unique: true })
  runKey: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  stopReason: StopReason | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  plannerSessionId: string | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'datetime', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
