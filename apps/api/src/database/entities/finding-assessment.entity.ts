import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { FindingMetadata } from '@vulnagent/shared';

@Entity('finding_assessments')
@Index('IDX_finding_assessment_revision', ['taskId', 'findingId', 'revision'], { unique: true })
export class FindingAssessmentEntity {
  @PrimaryColumn('varchar', { length: 36 }) id: string;
  @Column('varchar', { length: 36 }) taskId: string;
  @Column('varchar', { length: 36 }) findingId: string;
  @Column('integer') revision: number;
  @Column('simple-json') metadata: FindingMetadata & { before?: FindingMetadata };
  @Column('text') note: string;
  @Column('simple-json') evidenceQuotes: { evidenceId: string; quote: string }[];
  @CreateDateColumn() createdAt: Date;
}
