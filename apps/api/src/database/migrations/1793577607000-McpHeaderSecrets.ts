import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Schema only: encryption needs the runtime master key and is performed atomically at bootstrap. */
export class McpHeaderSecrets1793577607000 implements MigrationInterface {
  name = 'McpHeaderSecrets1793577607000';
  async up(runner: QueryRunner): Promise<void> {
    const column = (await runner.getTable('mcp_servers'))?.findColumnByName('headersEncrypted');
    if (!column) await runner.query('ALTER TABLE mcp_servers ADD COLUMN headersEncrypted text');
    else if (column.type !== 'text' || !column.isNullable) throw new Error('MCP 请求头密文字段不匹配');
  }
  async down(runner: QueryRunner): Promise<void> {
    const [row] = await runner.query('SELECT COUNT(*) AS n FROM mcp_servers WHERE headersEncrypted IS NOT NULL');
    if (row.n) throw new Error('MCP 密文请求头非空，拒绝删除；请使用原主密钥及备份恢复');
    await runner.query('ALTER TABLE mcp_servers DROP COLUMN headersEncrypted');
  }
}
