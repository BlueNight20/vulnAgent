import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { EvidenceEntity } from './evidence.entity';

@Entity('evidence_attachments')
@Index('IDX_evidence_attachment_scope', ['taskId', 'evidenceId'])
export class EvidenceAttachmentEntity {
  @PrimaryColumn('varchar', { length: 36 }) id: string;
  @Column('varchar', { length: 36, nullable: true }) taskId: string | null;
  @Column('varchar', { length: 36 }) evidenceId: string;
  @ManyToOne(() => EvidenceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'evidenceId', foreignKeyConstraintName: 'FK_attachment_evidence' }) evidence: EvidenceEntity;
  @Column('varchar', { length: 160 }) filename: string;
  @Column('varchar', { length: 100 }) mimeType: string;
  @Column('varchar', { length: 64 }) sha256: string;
  @Column('integer') sizeBytes: number;
  @Column('varchar', { length: 1000, nullable: true }) sourceUri: string | null;
  @Column({ type: 'blob', select: false }) data: Buffer;
  @CreateDateColumn() createdAt: Date;
}
