import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/** 只保存预算和供应商用量，不保存提示词、请求头或密钥。 */
@Entity('model_requests')
@Index('IDX_model_request_task_epoch', ['taskId', 'budgetEpoch'])
@Index('IDX_model_request_session', ['sessionId'])
export class ModelRequestEntity {
  /** 本次调用剩余墙钟预算；不落库、不把历史请求误当成仍在执行。 */
  timeoutMs?: number;
  @PrimaryColumn('varchar', { length: 36 }) id: string;
  @Column('varchar', { length: 36 }) taskId: string;
  @Column('varchar', { length: 36 }) sessionId: string;
  @Column('varchar', { length: 36 }) budgetEpoch: string;
  @Column('varchar', { length: 16 }) state: 'reserved' | 'settled' | 'uncertain' | 'cancelled';
  @Column('varchar', { length: 120 }) modelName: string;
  @Column('varchar', { length: 80 }) provider: string;
  @Column('integer') inputEstimate: number;
  @Column('integer') maxOutputTokens: number;
  @Column('integer') reservedTokens: number;
  @Column('integer', { nullable: true }) inputTokens: number | null;
  @Column('integer', { nullable: true }) outputTokens: number | null;
  @Column('real', { nullable: true }) costUsd: number | null;
  @Column('text', { nullable: true }) errorMessage: string | null;
  @CreateDateColumn() createdAt: Date;
  @Column('datetime', { nullable: true }) finishedAt: Date | null;
}
