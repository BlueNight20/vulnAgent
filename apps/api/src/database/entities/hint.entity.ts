import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { HintStatus } from '@vulnagent/shared';

@Entity('hints')
@Index(['taskId', 'status'])
export class HintEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  /** 定向到某个 Session；null 表示供 Planner 后续规划使用的任务提示 */
  @Column({ type: 'varchar', length: 36, nullable: true })
  agentSessionId: string | null;

  /** 实际被哪个 Session 消费 */
  @Column({ type: 'varchar', length: 36, nullable: true })
  appliedToSessionId: string | null;

  @Column({ type: 'text' })
  content: string;

  @Column({ length: 20, default: 'pending' })
  status: HintStatus;

  @Column({ type: 'datetime', nullable: true })
  consumedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
