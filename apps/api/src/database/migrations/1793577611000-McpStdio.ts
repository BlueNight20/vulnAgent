import type { MigrationInterface, QueryRunner } from 'typeorm';
export class McpStdio1793577611000 implements MigrationInterface {
  name = 'McpStdio1793577611000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE mcp_servers ADD COLUMN stdioConfigEncrypted text NULL');
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = await runner.query('SELECT COUNT(*) AS count FROM mcp_servers WHERE stdioConfigEncrypted IS NOT NULL');
    if (Number(rows[0].count)) throw new Error('stdio 配置非空，拒绝丢失连接信息');
    await runner.query('ALTER TABLE mcp_servers DROP COLUMN stdioConfigEncrypted');
  }
}
