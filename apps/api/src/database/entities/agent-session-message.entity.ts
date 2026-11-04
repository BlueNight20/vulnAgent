import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Session 消息持久化。
 * messageJson 保存完整结构化 AgentMessage（含 toolCall / toolResult / usage），
 * 用于进程重启后重建 Agent 会话上下文。
 */
@Entity('agent_session_messages')
@Index(['sessionId', 'seq'], { unique: true })
@Index(['taskId', 'createdAt'])
export class AgentSessionMessageEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ length: 36 })
  sessionId: string;

  @Column({ type: 'integer' })
  seq: number;

  @Column({ length: 16 })
  role: 'system' | 'user' | 'assistant' | 'toolResult';

  /** 纯文本摘要，仅用于列表展示与检索 */
  @Column({ type: 'text', default: '' })
  content: string;

  /** 完整结构化消息，恢复会话的唯一依据 */
  @Column({ type: 'simple-json', nullable: true })
  messageJson: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  toolCallId: string | null;

  @Column({ type: 'varchar', length: 140, nullable: true })
  toolName: string | null;

  @Column({ type: 'simple-json', nullable: true })
  usage: { input: number; output: number; cost: number } | null;

  @CreateDateColumn()
  createdAt: Date;
}
