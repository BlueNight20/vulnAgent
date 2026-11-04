import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { VerificationOutcome } from '@vulnagent/shared';

@Entity('finding_verifications')
@Index('IDX_verification_task', ['taskId'])
@Index('UQ_verification_intent', ['intentId'], { unique: true })
export class FindingVerificationEntity {
  @PrimaryColumn('varchar', { length: 36 }) id: string;
  @Column('varchar', { length: 36 }) taskId: string;
  @Column('varchar', { length: 36 }) findingId: string;
  @Column('varchar', { length: 36 }) intentId: string;
  @Column('varchar', { length: 36, nullable: true }) agentSessionId: string | null;
  @Column('varchar', { length: 20, default: 'pending' }) outcome: VerificationOutcome;
  @Column('text', { default: '' }) summary: string;
  @Column('simple-json', { default: '[]' }) baselineEvidenceIds: string[];
  @Column('simple-json', { default: '[]' }) evidenceIds: string[];
  @Column('simple-json', { default: '[]' }) evidenceQuotes: { evidenceId: string; quote: string }[];
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
