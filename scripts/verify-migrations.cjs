const createTestApp = require('./create-test-app.cjs');
const backendRequire = require('./backend-require.cjs');
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { DataSource } = backendRequire('typeorm');
const apiRequire = createRequire(path.resolve(__dirname, '../apps/api/package.json'));
const Database = apiRequire('better-sqlite3');
const E = require('../apps/api/dist/database/entities');
const baseline = require('../apps/api/dist/database/migrations/baseline-sqlite.json');
const { sqliteOptions, SQLITE_MIGRATIONS } = require('../apps/api/dist/database/sqlite-options');

async function main() {
  const connections = [];
  const connect = async (options) => { const connection = new DataSource(options); connections.push(connection); return connection.initialize(); };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-migrations-'));
  try {
    const file = path.join(directory, 'new.sqlite');
    let db = await connect(sqliteOptions(file));
    assert.equal(db.options.synchronize, false);
    assert.equal((await db.runMigrations()).length, SQLITE_MIGRATIONS.length);
    assert.equal((await db.createQueryRunner().getTables()).filter((t) => !['migrations', 'sqlite_sequence'].includes(t.name)).length, E.ENTITIES.length);
    await db.destroy();
    db = await connect(sqliteOptions(file));
    assert.equal((await db.runMigrations()).length, 0);
    // Exercise TypeORM's actual glob importer after the patched glob dependency upgrade.
    const globEntities = await connect({ ...sqliteOptions(':memory:'), entities: [path.resolve(__dirname, '../apps/api/dist/database/entities/*.entity.js').replaceAll('\\', '/')] });
    assert.equal(globEntities.entityMetadatas.length, E.ENTITIES.length);
    await globEntities.runMigrations();
    assert.equal(await globEntities.getRepository(E.TaskEntity).count(), 0);
    await globEntities.destroy();
    await db.undoLastMigration(); // 空弱点分类可回滚。
    await db.undoLastMigration(); // 空漏洞来源关联可回滚。
    await db.undoLastMigration(); // 空 stdio 配置可回滚。
    await db.undoLastMigration(); // 空拦截规则表可回滚。
    await db.undoLastMigration(); // 仅移除全局权限索引，不删除合并后的规则和审计。
    await db.undoLastMigration(); // 无漏洞维护历史时，可回滚版本字段。
    await db.undoLastMigration(); // 无密文请求头时，可回滚请求头字段。
    await db.undoLastMigration(); // 无模型预算记录时，可回滚预算迁移。
    await db.undoLastMigration(); // 无新引用数据时，假设引用字段可回滚。
    await db.undoLastMigration(); // 无删除记录时，任务归属约束可回滚。
    await db.undoLastMigration(); // 空附件表可回滚。
    await db.undoLastMigration(); // 空目标列可回滚。
    await db.undoLastMigration(); // 空验证表可回滚。
    await assert.rejects(() => db.undoLastMigration(), /不提供删表回滚/);
    assert.ok(await db.createQueryRunner().hasTable('tasks'));
    await db.destroy();

    const legacyFile = path.join(directory, 'legacy.sqlite');
    const legacy = await connect({ ...sqliteOptions(legacyFile), migrations: [], synchronize: false });
    for (const sql of baseline.queries) await legacy.query(sql);
    await legacy.query('INSERT INTO tasks (id, name, modelName, modelProvider, scope) VALUES (?, ?, ?, ?, ?)', ['retained', 'retained task', 'test', 'test', '{}']);
    await legacy.destroy();
    const upgraded = await connect(sqliteOptions(legacyFile));
    try {
      assert.equal((await upgraded.runMigrations()).length, SQLITE_MIGRATIONS.length);
      assert.equal((await upgraded.getRepository(E.TaskEntity).findOneByOrFail({ id: 'retained' })).name, 'retained task');
      const backupName = fs.readdirSync(directory).find((name) => name.startsWith('legacy.sqlite.before-migrate-'));
      assert.ok(backupName);
      const backup = new Database(path.join(directory, backupName), { readonly: true, fileMustExist: true });
      try {
        assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
        assert.equal(backup.prepare('SELECT name FROM tasks WHERE id = ?').get('retained').name, 'retained task');
        assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'").get(), undefined);
      } finally { backup.close(); }
      assert.equal((await upgraded.runMigrations()).length, 0);
    } finally { await upgraded.destroy(); }

    const driftFile = path.join(directory, 'drift.sqlite');
    const drift = await connect({ ...sqliteOptions(driftFile), migrations: [], synchronize: false });
    for (const sql of baseline.queries) await drift.query(sql);
    await drift.query('ALTER TABLE tasks ADD COLUMN unknown_field TEXT');
    await drift.destroy();
    const refused = await connect(sqliteOptions(driftFile));
    try {
      await assert.rejects(() => refused.runMigrations(), /冻结基线不一致.*tasks/);
      assert.ok((await refused.createQueryRunner().getTable('tasks')).columns.some((c) => c.name === 'unknown_field'));
      assert.equal((await refused.query('SELECT COUNT(*) AS n FROM migrations'))[0].n, 0);
    } finally { await refused.destroy(); }

    const partial = await connect(sqliteOptions(':memory:'));
    try {
      await partial.query('CREATE TABLE tasks (id TEXT PRIMARY KEY)');
      await assert.rejects(() => partial.runMigrations(), /冻结基线不一致/);
      assert.equal(await partial.createQueryRunner().hasTable('findings'), false);
    } finally { await partial.destroy(); }
    console.log('PASS: fresh migrations, idempotent restart, legacy adoption preserving data, pre-migration backup, schema drift/partial DB refusal, no destructive baseline rollback');

    const cliPath = path.resolve(__dirname, '../node_modules/typeorm/cli.js');
    const datasourcePath = path.resolve(__dirname, '../apps/api/dist/database/data-source.js');
    const cliDb = path.join(directory, 'cli.sqlite');
    for (const command of ['migration:run', 'migration:show']) {
      const child = spawnSync(process.execPath, [cliPath, command, '-d', datasourcePath], {
        cwd: path.resolve(__dirname, '../apps/api'), encoding: 'utf8',
        env: { ...process.env, DB_TYPE: 'sqlite', DB_PATH: cliDb, DB_SYNCHRONIZE: 'false' },
      });
      assert.equal(child.status, 0, `CLI ${command} failed: ${child.stderr}`);
      if (command === 'migration:show') assert.ok(child.stdout.includes('[X]'), 'CLI 应显示已执行的基线迁移');
    }
    console.log('PASS: real migration CLI creates database and reports applied version');

    Object.assign(process.env, {
      DB_TYPE: 'sqlite', DB_PATH: path.join(directory, 'application.sqlite'), DB_SYNCHRONIZE: 'false',
      MCP_SERVERS: '[]', MCP_GATEWAY_ENABLED: 'false', PI_RUNTIME_ENABLED: 'false',
      MODEL_API_KEY: '', MODEL_BASE_URL: 'http://unused.invalid/v1',
      VA_ENCRYPTION_KEY: require('node:crypto').randomBytes(32).toString('base64'),
    });
    const { NestFactory } = backendRequire('@nestjs/core');
    const { WsAdapter } = backendRequire('@nestjs/platform-ws');
    const { AppModule } = require('../apps/api/dist/app.module');
    const app = await createTestApp(AppModule, { logger: false, abortOnError: false });
    try {
      app.setGlobalPrefix('api'); app.useWebSocketAdapter(new WsAdapter(app));
      await app.listen(0, '127.0.0.1');
      const response = await fetch(`${await app.getUrl()}/api/health`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).database, 'connected');
      const applicationDb = app.get(DataSource);
      assert.equal(applicationDb.options.synchronize, false);
      assert.equal((await applicationDb.query('SELECT COUNT(*) AS n FROM migrations'))[0].n, SQLITE_MIGRATIONS.length);
    } finally { await app.close(); }
    console.log('PASS: full Nest application boots with migrations, resolves all providers and serves healthy HTTP without auto synchronization');

    if (process.argv.includes('--check-live')) {
      const livePath = path.resolve(__dirname, '../apps/api/storage/vulnagent.sqlite');
      const clonePath = path.join(directory, 'live-copy.sqlite');
      const live = new Database(livePath, { readonly: true, fileMustExist: true });
      try { await live.backup(clonePath); } finally { live.close(); }
      const clone = await connect(sqliteOptions(clonePath));
      try {
        const before = await clone.getRepository(E.TaskEntity).count();
        await clone.runMigrations();
        assert.equal(await clone.getRepository(E.TaskEntity).count(), before);
        console.log('PASS: consistent read-only snapshot of the existing database migrates and preserves task count; original was not migrated');
      } finally { await clone.destroy(); }
    }
  } finally {
    for (const connection of connections) if (connection.isInitialized) await connection.destroy();
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
