import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('model_usage')
@Index(['taskId'])
@Index(['createdAt'])
export class ModelUsageEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  taskId: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  agentSessionId: string | null;

  @Column({ length: 40 })
  provider: string;

  @Column({ length: 80 })
  modelName: string;

  @Column({ type: 'integer', default: 0 })
  inputTokens: number;

  @Column({ type: 'integer', default: 0 })
  outputTokens: number;

  @Column({ type: 'real', default: 0 })
  costUsd: number;

  @Column({ type: 'integer', nullable: true })
  latencyMs: number | null;

  @CreateDateColumn()
  createdAt: Date;
}
