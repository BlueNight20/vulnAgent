import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { HypothesisLinkType } from '@vulnagent/shared';

/** 假设与事实 / 证据 / 意图之间的有向关系 */
@Entity('hypothesis_links')
@Index(['hypothesisId', 'linkType'])
@Index(['targetType', 'targetId'])
export class HypothesisLinkEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ length: 36 })
  hypothesisId: string;

  @Column({ length: 20 })
  linkType: HypothesisLinkType;

  @Column({ length: 12 })
  targetType: 'fact' | 'evidence' | 'intent';

  @Column({ length: 36 })
  targetId: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'simple-json', default: '[]' })
  evidenceQuotes: { evidenceId: string; quote: string }[];

  @Column({ type: 'varchar', length: 16, default: 'legacy' })
  assessmentSource: 'legacy' | 'agent' | 'user';

  @Column({ type: 'varchar', length: 36, nullable: true })
  agentSessionId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
