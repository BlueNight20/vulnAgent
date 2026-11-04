import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type {
  IntentRejectReason,
  IntentStatus,
  WorkerProfileId,
} from '@vulnagent/shared';

/**
 * 探索意图：Planner 提出，Orchestrator 准入。
 * 结构完整描述「要验证什么假设、用什么能力、需要什么证据」。
 */
@Entity('intents')
@Index(['taskId', 'status'])
@Index(['taskId', 'dedupeKey'], { unique: true })
export class IntentEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  agentSessionId: string | null;

  @Column({ length: 200 })
  title: string;

  /** 待验证的攻击假设（自然语言，可关联 hypotheses） */
  @Column({ type: 'text', default: '' })
  hypothesis: string;

  /** 可测量的目标，例如「确认 80 端口是否运行 Apache 2.4.x」 */
  @Column({ type: 'text', default: '' })
  objective: string;

  @Column({ type: 'text', default: '' })
  rationale: string;

  /** 前置条件（依赖的事实描述） */
  @Column({ type: 'simple-json', default: '[]' })
  prerequisites: string[];

  /** 需要的 Worker 专业能力档案 */
  @Column({ length: 24, default: 'recon' })
  workerProfileId: WorkerProfileId;

  @Column({ type: 'simple-json', default: '[]' })
  suggestedTools: string[];

  /** 预期产出证据类型，用于校验 Worker 是否真的产出了东西 */
  @Column({ type: 'simple-json', default: '[]' })
  expectedEvidence: string[];

  @Column({ type: 'varchar', length: 64, nullable: true })
  targetIp: string | null;

  @Column({ type: 'integer', default: 50 })
  priority: number;

  /** 综合评分（Orchestrator 计算，可解释） */
  @Column({ type: 'real', nullable: true })
  score: number | null;

  @Column({ type: 'simple-json', nullable: true })
  scoreBreakdown: Record<string, number> | null;

  @Column({ length: 20, default: 'proposed' })
  status: IntentStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  rejectedReason: IntentRejectReason | null;

  /** 去重键：同一任务内唯一，重试时不修改 */
  @Column({ length: 200 })
  dedupeKey: string;

  /** 依赖的其他 Intent ID */
  @Column({ type: 'simple-json', default: '[]' })
  dependencies: string[];

  @Column({ type: 'simple-json', default: '[]' })
  factIds: string[];

  @Column({ type: 'integer', default: 2 })
  maxAttempts: number;

  @Column({ type: 'integer', default: 0 })
  attemptCount: number;

  @Column({ type: 'integer', default: 0 })
  dispatchCount: number;

  @Column({ type: 'integer', default: 0 })
  cycle: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
