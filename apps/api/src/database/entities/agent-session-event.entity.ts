import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/** Session 事件时间线（Agent 事件、生命周期、编排事件） */
@Entity('agent_session_events')
@Index(['taskId', 'createdAt'])
@Index(['sessionId', 'createdAt'])
export class AgentSessionEventEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ length: 36 })
  sessionId: string;

  @Column({ length: 40 })
  type: string;

  @Column({ type: 'simple-json', nullable: true })
  payload: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}
