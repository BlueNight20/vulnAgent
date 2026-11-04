import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { EvidenceKind } from '@vulnagent/shared';

@Entity('evidence')
@Index(['taskId'])
@Index(['taskId', 'kind'])
export class EvidenceEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  taskId: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  agentSessionId: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  toolCallId: string | null;

  @Column({ length: 24 })
  kind: EvidenceKind;

  @Column({ length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  mimeType: string | null;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ type: 'varchar', length: 400, nullable: true })
  filePath: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  sha256: string | null;

  @Column({ type: 'integer', nullable: true })
  sizeBytes: number | null;

  @Column({ type: 'simple-json', nullable: true })
  meta: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}
