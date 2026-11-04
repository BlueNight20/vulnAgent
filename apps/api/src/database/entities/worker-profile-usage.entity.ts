import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { WorkerProfileId } from '@vulnagent/shared';

/** Worker 档案与技能加载记录，用于追踪「本次 Worker 实际加载了哪些专业能力」 */
@Entity('worker_profile_loads')
@Index(['taskId'])
export class WorkerProfileLoadEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ length: 36 })
  sessionId: string;

  @Column({ length: 24 })
  profileId: WorkerProfileId;

  @Column({ type: 'simple-json' })
  skillIds: string[];

  /** 本次加载允许使用的工具名（来自 MCP 目录与策略交集） */
  @Column({ type: 'simple-json' })
  allowedTools: string[];

  @Column({ type: 'simple-json' })
  expectedEvidence: string[];

  @Column({ type: 'integer' })
  tokenBudget: number;

  @Column({ type: 'text' })
  systemPromptVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
