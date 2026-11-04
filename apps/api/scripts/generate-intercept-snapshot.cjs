/**
 * 冻结拦截规则表结构：用项目自己的 SQLite 驱动选项在内存库建表，
 * 导出建表 SQL 与落库结构签名，写入 src/database/migrations/intercept-rules-sqlite.json。
 *
 * 仅在新增迁移时运行一次；生成后不要再改这个 JSON。
 */
const path = require('node:path');
const fs = require('node:fs');
const backendRequire = require('../../../scripts/backend-require.cjs');

backendRequire('reflect-metadata');
const { DataSource } = backendRequire('typeorm');
const dist = path.join(__dirname, '../dist');
const { sqliteOptions } = require(path.join(dist, 'database/sqlite-options'));
const { schemaSignature } = require(path.join(dist, 'database/migrations/schema-signature'));
const { ENTITIES } = require(path.join(dist, 'database/entities'));

async function main() {
  const entity = ENTITIES.find((item) => item.name === 'InterceptRuleEntity');
  if (!entity) throw new Error('未找到 InterceptRuleEntity');
  const statements = [];
  const db = new DataSource({
    ...sqliteOptions(':memory:'),
    entities: [entity],
    synchronize: true,
    migrations: [],
    logging: ['schema'],
  });
  db.setOptions({
    logger: {
      logQuery: (query) => { if (/^CREATE\s+(TABLE|INDEX)/i.test(query)) statements.push(query.trim().replace(/;$/, '')); },
      logQueryError: () => undefined,
      logQuerySlow: () => undefined,
      logSchemaBuild: () => undefined,
      logMigration: () => undefined,
      log: () => undefined,
    },
  });
  await db.initialize();
  const name = db.getRepository(entity).metadata.tableName;
  const described = await db.createQueryRunner().getTable(name);
  const snapshot = { queries: statements, tables: [{ name, signature: schemaSignature(described) }] };
  const file = path.join(__dirname, '../src/database/migrations/intercept-rules-sqlite.json');
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`写入 ${file}`);
  console.log(statements.join('\n'));
  await db.destroy();
}

main().catch((error) => { console.error(error); process.exit(1); });
