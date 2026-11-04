import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Worker 结构化结果卡。
 * 完整 Session 消息与原始证据另外保存在 agent_session_messages / evidence，
 * 结果卡只是给 Orchestrator 与 Planner 消费的摘要视图。
 */
@Entity('worker_result_cards')
@Index(['taskId', 'createdAt'])
export class WorkerResultCardEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ length: 36 })
  workerTaskId: string;

  @Column({ length: 36 })
  sessionId: string;

  @Column({ type: 'text' })
  objective: string;

  @Column({ type: 'text' })
  summary: string;

  @Column({ type: 'simple-json' })
  newFactIds: string[];

  @Column({ type: 'simple-json' })
  supportedHypothesisIds: string[];

  @Column({ type: 'simple-json' })
  refutedHypothesisIds: string[];

  @Column({ type: 'simple-json' })
  evidenceIds: string[];

  @Column({ type: 'simple-json' })
  openQuestions: string[];

  @Column({ type: 'simple-json' })
  nextSteps: string[];

  @Column({ type: 'integer', default: 0 })
  tokensUsed: number;

  @Column({ type: 'integer', default: 0 })
  durationMs: number;

  /** 模型输出无法解析时由程序确定性汇总生成，标记为 synthetic 便于区分 */
  @Column({ type: 'boolean', default: false })
  synthetic: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
