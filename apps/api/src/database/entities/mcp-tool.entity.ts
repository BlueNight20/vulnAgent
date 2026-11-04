import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ToolRiskLevel } from '@vulnagent/shared';

@Entity('mcp_tools')
@Index(['mcpServerId', 'name'], { unique: true })
export class McpToolEntity {
  @PrimaryColumn('varchar', { length: 36 })
  id: string;

  @Column({ length: 36 })
  mcpServerId: string;

  @Column({ length: 140 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'simple-json' })
  inputSchema: Record<string, unknown>;

  @Column({ length: 16, default: 'safe' })
  riskLevel: ToolRiskLevel;

  @Column({ type: 'datetime' })
  syncedAt: Date;
}
