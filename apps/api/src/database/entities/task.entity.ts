import { Column, CreateDateColumn, Entity, Index, OneToMany, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { EngineStatus, StopReason, TaskGoal, TaskScope, TaskStatus } from '@vulnagent/shared';
import { TargetEntity } from './target.entity';

@Entity('tasks')
@Index(['status'])
@Index(['createdAt'])
export class TaskEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;
  @Column({ type: 'simple-json', nullable: true })
  goal: TaskGoal | null;

  @Column({ length: 120 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 用户可见状态 */
  @Column({ length: 24, default: 'pending' })
  status: TaskStatus;

  /** 执行引擎状态，与用户可见状态解耦 */
  @Column({ length: 24, default: 'idle' })
  engineStatus: EngineStatus;

  @Column({ type: 'varchar', length: 40, nullable: true })
  stopReason: StopReason | null;

  @Column({ type: 'simple-json' })
  scope: TaskScope;

  @Column({ type: 'varchar', length: 200, nullable: true })
  authorizationRef: string | null;

  @Column({ length: 40 })
  modelProvider: string;

  @Column({ length: 80 })
  modelName: string;

  @Column({ type: 'integer', default: 200000 })
  tokenBudget: number;

  @Column({ type: 'integer', default: 60 })
  timeBudgetMinutes: number;

  @Column({ type: 'integer', default: 2 })
  workerCount: number;

  @Column({ type: 'integer', default: 0 })
  tokensUsed: number;

  @Column({ type: 'varchar', length: 36, nullable: true }) budgetEpoch: string | null;
  @Column({ type: 'integer', default: 0 }) tokenBaseline: number;
  @Column({ type: 'real', default: 0 }) costBaseline: number;
  /** 从请求账本计算，不作为可覆写的数据库计数保存。 */
  tokensCommitted?: number;

  @Column({ type: 'real', default: 0 })
  costUsd: number;

  @Column({ type: 'integer', default: 0 })
  progress: number;

  @Column({ type: 'varchar', length: 40, nullable: true })
  currentPhase: string | null;

  @Column({ type: 'datetime', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  finishedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => TargetEntity, (target) => target.task)
  targets: TargetEntity[];
}
