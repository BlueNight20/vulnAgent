import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type {
  AgentRole,
  SessionState,
  StateCard,
  WorkerProfileId,
} from '@vulnagent/shared';

@Entity('agent_sessions')
@Index(['taskId'])
@Index(['taskId', 'role'])
export class AgentSessionEntity {
  @Column({ type: 'integer', nullable: true }) tokenAllowance: number | null;
  @Column({ type: 'boolean', default: false }) budgetManaged: boolean;
  @Column({ type: 'varchar', length: 36, nullable: true }) budgetEpoch: string | null;
  @Column({ type: 'integer', default: 0 }) baselineInput: number;
  @Column({ type: 'integer', default: 0 }) baselineOutput: number;
  @Column({ type: 'real', default: 0 }) baselineCost: number;
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ length: 24 })
  role: AgentRole;

  /** Worker 专业能力档案；Planner/Orchestrator 为 null */
  @Column({ type: 'varchar', length: 24, nullable: true })
  profileId: WorkerProfileId | null;

  /** Worker 归属的父 Session（通常是 Planner） */
  @Column({ type: 'varchar', length: 36, nullable: true })
  parentSessionId: string | null;

  /** 对应 Pi Agent 的 sessionId */
  @Column({ length: 120 })
  sessionKey: string;

  @Column({ length: 80 })
  modelName: string;

  @Column({ length: 20, default: 'created' })
  state: SessionState;

  @Column({ type: 'integer', default: 0 })
  tokenInput: number;

  @Column({ type: 'integer', default: 0 })
  tokenOutput: number;

  @Column({ type: 'real', default: 0 })
  costUsd: number;

  /** 状态卡：当前 Intent、阶段、阻塞点等 */
  @Column({ type: 'simple-json', nullable: true })
  stateCard: StateCard | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'datetime', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  endedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
