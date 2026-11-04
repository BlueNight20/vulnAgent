// One-time authoring helper. Never connects to a configured or existing database.
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { DataSource } = require('typeorm');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const { schemaSignature } = require('../apps/api/dist/database/migrations/schema-signature');
async function main() {
  const output = path.resolve(__dirname, '../apps/api/src/database/migrations/attachments-sqlite.json');
  if (fs.existsSync(output)) throw new Error('Frozen migration already exists; write a new migration instead of replacing it');
  const db = await new DataSource(sqliteOptions(':memory:')).initialize();
  try {
    await db.runMigrations();
    const log = await db.driver.createSchemaBuilder().log();
    const queries = log.upQueries.map((q) => q.query);
    const unexpected = queries.filter((q) => !/evidence_attachments|report_attachments|IDX_evidence_attachment_scope|IDX_report_attachment_scope/.test(q));
    if (unexpected.length) throw new Error(`Unexpected schema changes: ${unexpected.join('\n')}`);
    for (const query of queries) await db.query(query);
    const tables = await db.createQueryRunner().getTables(['evidence_attachments', 'report_attachments']);
    fs.writeFileSync(output, JSON.stringify({ queries, tables: tables.map((t) => ({ name: t.name, signature: schemaSignature(t) })) }, null, 2) + '\n');
    console.log(`Frozen ${tables.length} attachment tables, ${queries.length} statements`);
  } finally { await db.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
