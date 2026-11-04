import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { McpServerStatus, McpTransport } from '@vulnagent/shared';

@Entity('mcp_servers')
export class McpServerEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 80, unique: true })
  name: string;

  @Column({ length: 300 })
  endpoint: string;

  @Column({ length: 24, default: 'streamable-http' })
  transport: McpTransport;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'simple-json', nullable: true })
  headers: Record<string, string> | null;

  @Column({ type: 'text', nullable: true })
  headersEncrypted: string | null;

  @Column({ type: 'text', nullable: true })
  stdioConfigEncrypted: string | null;

  /** 只能由真实健康检查写入 */
  @Column({ length: 20, default: 'unknown' })
  status: McpServerStatus;

  @Column({ type: 'datetime', nullable: true })
  lastCheckedAt: Date | null;

  @Column({ type: 'integer', nullable: true })
  latencyMs: number | null;

  @Column({ type: 'integer', default: 0 })
  toolCount: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ length: 16, default: 'env' })
  source: 'env' | 'manual';

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
