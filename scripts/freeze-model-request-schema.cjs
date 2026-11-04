// One-time authoring helper; only creates an isolated in-memory table.
require('reflect-metadata');
const fs = require('node:fs'); const path = require('node:path');
const { DataSource } = require('typeorm');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const { ModelRequestEntity } = require('../apps/api/dist/database/entities/model-request.entity');
const { schemaSignature } = require('../apps/api/dist/database/migrations/schema-signature');
async function main() {
  const output = path.resolve(__dirname, '../apps/api/src/database/migrations/model-requests-sqlite.json');
  if (fs.existsSync(output)) throw new Error('Frozen migration already exists; create a new migration');
  const db = await new DataSource({ ...sqliteOptions(':memory:'), entities: [ModelRequestEntity], migrations: [] }).initialize();
  try {
    const queries = (await db.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query);
    for (const query of queries) await db.query(query);
    const table = await db.createQueryRunner().getTable('model_requests');
    fs.writeFileSync(output, JSON.stringify({ queries, signature: schemaSignature(table) }, null, 2) + '\n');
    console.log(`Frozen model_requests table: ${queries.length} statements`);
  } finally { await db.destroy(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
