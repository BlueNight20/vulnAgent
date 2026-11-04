import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { FindingStatus, Severity } from '@vulnagent/shared';

@Entity('findings')
@Index(['taskId'])
@Index(['taskId', 'status'])
export class FindingEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  taskId: string;

  @Column({ length: 200 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ length: 16 })
  severity: Severity;

  /** 只有在有可靠依据时才填写 CWE/CVE */
  @Column({ type: 'varchar', length: 32, nullable: true })
  cwe: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  cve: string | null;

  @Column({ type: 'real', nullable: true })
  cvss: number | null;

  @Column({ length: 24, default: 'candidate' })
  status: FindingStatus;

  @Column({ length: 32, default: 'tool' })
  source: 'tool' | 'agent' | 'manual';

  @Column({ type: 'varchar', length: 64, nullable: true })
  targetIp: string | null;

  @Column({ type: 'simple-json' })
  evidenceIds: string[];

  @Column({ type: 'text', nullable: true })
  remediation: string | null;

  @Column({ type: 'integer', default: 0 })
  metadataRevision: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  canonicalKey: string | null;

  @Column({ type: 'simple-json', default: '[]' })
  sourceFactIds: string[];

  @Column({ type: 'varchar', length: 16, default: 'actionable' })
  clueLevel: 'actionable' | 'weakness';

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
