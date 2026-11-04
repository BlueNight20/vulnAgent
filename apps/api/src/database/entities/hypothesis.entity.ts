import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { HypothesisStatus, Severity } from '@vulnagent/shared';

/**
 * 攻击假设：贯穿事实、意图、证据与验证结论的核心实体。
 * 关系型实现，不引入图数据库。
 */
@Entity('hypotheses')
@Index(['taskId', 'status'])
export class HypothesisEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ length: 200 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ length: 16, default: 'proposed' })
  status: HypothesisStatus;

  @Column({ type: 'varchar', length: 16, nullable: true })
  severity: Severity | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  targetIp: string | null;

  /** 冗余计数，便于列表排序（以 hypothesis_links 为准） */
  @Column({ type: 'integer', default: 0 })
  supportCount: number;

  @Column({ type: 'integer', default: 0 })
  contradictCount: number;

  @Column({ type: 'real', default: 0.3 })
  confidence: number;

  @Column({ length: 16, default: 'agent' })
  createdBy: 'agent' | 'user' | 'planner';

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
