import type { MigrationInterface, QueryRunner } from 'typeorm';
import snapshot from './baseline-sqlite.json';
import { schemaSignature } from './schema-signature';

/** 冻结的第三阶段基线；新库建表，完全匹配的旧库仅登记版本，不重建任何表。 */
export class SqliteBaseline1793577600000 implements MigrationInterface {
  name = 'SqliteBaseline1793577600000';

  async up(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type !== 'better-sqlite3') throw new Error('当前迁移仅支持 SQLite');
    const expected: Record<string, string> = snapshot.tables;
    const names = Object.keys(expected);
    if (!names.length) throw new Error('缺少冻结数据库基线');
    const existing = (await runner.getTables()).filter((t) => !['migrations', 'sqlite_sequence'].includes(t.name));
    if (existing.length === 0) {
      for (const sql of snapshot.queries) await runner.query(sql);
      return;
    }
    const differences = names.filter((name) => {
      const table = existing.find((t) => t.name === name);
      return !table || schemaSignature(table) !== expected[name];
    });
    differences.push(...existing.filter((t) => !(t.name in expected)).map((t) => t.name));
    if (differences.length) throw new Error(`数据库与冻结基线不一致：${[...new Set(differences)].join(', ')}。已拒绝自动改表；请先检查备份并编写升级迁移。`);
  }

  async down(): Promise<void> {
    throw new Error('基线迁移不提供删表回滚。请使用已验证的 SQLite 备份恢复。');
  }
}
