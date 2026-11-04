import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { ReportEntity } from './report.entity';

@Entity('report_attachments')
@Index('IDX_report_attachment_scope', ['taskId', 'reportId'])
export class ReportAttachmentEntity {
  @PrimaryColumn('varchar', { length: 36 }) reportId: string;
  @PrimaryColumn('varchar', { length: 36 }) attachmentId: string;
  @Column('varchar', { length: 36 }) taskId: string;
  @Column('varchar', { length: 36 }) evidenceId: string;
  @ManyToOne(() => ReportEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reportId', foreignKeyConstraintName: 'FK_attachment_report' }) report: ReportEntity;
  @Column('varchar', { length: 160 }) filename: string;
  @Column('varchar', { length: 100 }) mimeType: string;
  @Column('varchar', { length: 64 }) sha256: string;
  @Column('integer') sizeBytes: number;
  @Column({ type: 'blob', select: false }) data: Buffer;
}
