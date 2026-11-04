import type { MigrationInterface, QueryRunner } from 'typeorm';
import snapshot from './intercept-rules-sqlite.json';
import { schemaSignature } from './schema-signature';

/**
 * 第十一条：新增工具调用拦截规则表。
 *
 * 历史数据不受影响（新表为空表示"无任何规则"，即不额外拦截）。
 * 表数由 31 增至 32；本表不属于任务所属表，删除任务时不清理（规则是全局策略）。
 */
export class InterceptRules1793577610000 implements MigrationInterface {
  name = 'InterceptRules1793577610000';

  async up(runner: QueryRunner): Promise<void> {
    const existing = await Promise.all(snapshot.tables.map((t) => runner.getTable(t.name)));
    if (existing.some(Boolean)) {
      if (existing.some((t, i) => !t || schemaSignature(t) !== snapshot.tables[i].signature)) {
        throw new Error('拦截规则表部分存在或与冻结迁移结构不一致，拒绝自动修改');
      }
      return;
    }
    for (const query of snapshot.queries) await runner.query(query);
  }

  async down(runner: QueryRunner): Promise<void> {
    for (const table of snapshot.tables) {
      const rows = await runner.query(`SELECT COUNT(*) AS n FROM "${table.name}"`);
      if (rows[0].n) throw new Error('拦截规则数据非空，拒绝删除；请先删除规则或使用备份恢复');
    }
    for (const table of snapshot.tables) await runner.dropTable(table.name);
  }
}
