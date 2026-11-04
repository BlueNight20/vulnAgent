import type { MigrationInterface, QueryRunner } from 'typeorm';

export class HypothesisQuotes1793577605000 implements MigrationInterface {
  name = 'HypothesisQuotes1793577605000';
  async up(runner: QueryRunner): Promise<void> {
    const columns = [
      ['evidenceQuotes', "text NOT NULL DEFAULT '[]'", 'text'],
      ['assessmentSource', "varchar(16) NOT NULL DEFAULT 'legacy'", 'varchar'],
      ['agentSessionId', 'varchar(36)', 'varchar'],
    ];
    const table = await runner.getTable('hypothesis_links');
    for (const [name, sql, type] of columns) {
      const column = table?.findColumnByName(name);
      if (!column) await runner.query(`ALTER TABLE hypothesis_links ADD COLUMN "${name}" ${sql}`);
      else if (column.type !== type || column.isNullable !== (name === 'agentSessionId') ||
        (name !== 'agentSessionId' && String(column.default).replace(/^'|'$/g, '') !== (name === 'evidenceQuotes' ? '[]' : 'legacy'))) throw new Error(`假设引用字段不匹配：${name}`);
    }
  }
  async down(runner: QueryRunner): Promise<void> {
    const [row] = await runner.query("SELECT COUNT(*) AS n FROM hypothesis_links WHERE evidenceQuotes != '[]' OR assessmentSource != 'legacy' OR agentSessionId IS NOT NULL");
    if (row.n) throw new Error('假设引用数据非空，拒绝删除；请使用备份恢复');
    for (const name of ['agentSessionId', 'assessmentSource', 'evidenceQuotes']) await runner.query(`ALTER TABLE hypothesis_links DROP COLUMN "${name}"`);
  }
}
