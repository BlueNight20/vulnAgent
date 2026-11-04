// Temporary files/SQLite and loopback production API only; no model or target requests.
const backendRequire = require('./backend-require.cjs'); const createTestApp = require('./create-test-app.cjs');
backendRequire('reflect-metadata');
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const http = require('node:http'); const { spawn } = require('node:child_process'); const { once } = require('node:events'); const { randomBytes } = require('node:crypto');
const { DataSource } = backendRequire('typeorm'); const { Module, ValidationPipe } = backendRequire('@nestjs/common');
const E = require('../apps/api/dist/database/entities'); const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const { RuntimeLogger } = require('../apps/api/dist/common/logging/runtime-logger');
const { SettingsService } = require('../apps/api/dist/modules/settings/settings.service'); const { SettingsController } = require('../apps/api/dist/modules/settings/settings.controller');
const configuration = require('../apps/api/dist/config/configuration').default;
async function until(predicate) { for (let i = 0; i < 1000; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error('fixture logging wait timed out'); }
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-logging-')); let app; let db; let child;
  const logger = new RuntimeLogger(path.join(directory, 'logs')); const consoleEntries = [];
  logger.console = Object.fromEntries(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'].map((level) => [level, (...args) => consoleEntries.push({ level, args })]));
  try {
    db = await new DataSource(sqliteOptions(':memory:')).initialize(); await db.runMigrations();
    const cfg = configuration(); cfg.security = { encryptionKey: randomBytes(32).toString('base64'), encryptionKeyFile: '' }; cfg.model.apiKey = 'fixture-sensitive-key'; cfg.logging = { level: 'info', toFile: false, dir: path.join(directory, 'logs') };
    const events = { broadcast() {} }; const audit = new (require('../apps/api/dist/modules/audit/audit.service').AuditService)(db.getRepository(E.AuditLogEntity), events);
    const settings = new SettingsService(db.getRepository(E.SystemSettingEntity), { get: (key) => cfg[key] }, audit); settings.registerLogging(logger);
    class TestModule {} Module({ controllers: [SettingsController], providers: [{ provide: SettingsService, useValue: settings }] })(TestModule);
    app = await createTestApp(TestModule, { logger: false }); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const put = (runtime) => fetch(`${base}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime }) });
    assert.equal((await put({ defaultTokenBudget: 10000001 })).status, 400); assert.equal((await put({ defaultTimeBudgetMinutes: 1441 })).status, 400);
    const current = () => settings.get(); const entries = () => fs.readFileSync(path.join(directory, 'logs', 'vulnagent.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    logger.debug('hidden debug'); logger.log('visible console'); assert.equal(consoleEntries.length, 1); assert.equal(fs.existsSync(path.join(directory, 'logs')), false);
    assert.equal((await put({ logLevel: 'warn', logToFile: true })).status, 200);
    logger.debug('hidden-debug'); logger.log('hidden-info'); logger.warn('visible-warn'); logger.error('visible-error');
    assert.deepEqual(entries().map((row) => row.message), ['visible-warn', 'visible-error']); assert.equal((await current()).loggingStatus.level, 'warn');
    const before = logger.status; const beforeSize = fs.statSync(before.activeFile).size;
    await db.query("CREATE TRIGGER fixture_logging_audit BEFORE INSERT ON audit_logs WHEN NEW.action='settings.update' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    assert.equal((await put({ logLevel: 'debug', logToFile: false })).status, 500); await db.query('DROP TRIGGER fixture_logging_audit');
    assert.deepEqual(logger.status, before); assert.equal(fs.statSync(before.activeFile).size, beforeSize); assert.equal((await current()).runtime.logLevel, 'warn');
    const runner = db.createQueryRunner(); const commit = runner.commitTransaction.bind(runner); let fail = true;
    runner.commitTransaction = async () => { if (fail) { fail = false; throw new Error('fixture commit failure'); } return commit(); };
    try { assert.equal((await put({ logLevel: 'debug', logToFile: true })).status, 500); } finally { runner.commitTransaction = commit; }
    assert.deepEqual(logger.status, before); logger.warn('after rollback'); assert.equal(entries().at(-1).message, 'after rollback');
    const occupied = path.join(directory, 'occupied'); fs.writeFileSync(occupied, 'ordinary file');
    const invalid = new RuntimeLogger(occupied); settings.registerLogging(invalid);
    assert.equal((await put({ logLevel: 'debug', logToFile: true })).status, 503); settings.registerLogging(logger);
    assert.equal((await current()).runtime.logLevel, 'warn'); assert.deepEqual(logger.status, before);
    assert.equal((await put({ logLevel: 'debug', logToFile: true })).status, 200);
    logger.debug('debug enabled'); logger.log('fixture-sensitive-key Bearer abc123 Basic Zm9vOmJhcg== apiKey=other-value\nsecond line');
    const raw = fs.readFileSync(logger.status.activeFile, 'utf8');
    for (const secret of ['fixture-sensitive-key', 'abc123', 'Zm9vOmJhcg==', 'other-value']) assert.ok(!raw.includes(secret), secret);
    assert.equal(entries().at(-1).message.includes('\nsecond line'), true); assert.equal(entries().at(-2).message, 'debug enabled');
    const plan = logger.prepare({ logLevel: 'error', logToFile: false }); plan.dispose(); assert.equal(logger.status.level, 'debug');
    fs.closeSync(logger.fd); logger.error('simulated write failure'); assert.equal(logger.status.fileEnabled, false); assert.match((await current()).loggingStatus.lastError, /写入失败/);
    assert.equal((await put({ logLevel: 'error', logToFile: true })).status, 200); logger.error('reopened'); assert.equal(entries().at(-1).message, 'reopened'); assert.equal(logger.status.lastError, null);
    assert.equal((await put({ logLevel: 'info', logToFile: false })).status, 200); const stoppedSize = fs.statSync(path.join(directory, 'logs', 'vulnagent.jsonl')).size; logger.error('console only'); assert.equal(fs.statSync(path.join(directory, 'logs', 'vulnagent.jsonl')).size, stoppedSize);
    // Exercise the actual main.js wiring and persistent DB overrides across a real restart.
    const reservation = http.createServer(); await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
    const cwd = path.join(directory, 'process'); fs.mkdirSync(cwd);
    const logDir = path.join(directory, 'process-logs'); let output = '';
    const env = { ...process.env, PORT: String(port), VA_API_HOST: '127.0.0.1', DB_TYPE: 'sqlite', DB_PATH: path.join(directory, 'process.sqlite'), DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false', MCP_SERVERS: '[]', MCP_GATEWAY_ENABLED: 'false', MODEL_API_KEY: 'fixture-process-key', VA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), PI_RUNTIME_ENABLED: 'false', LOG_LEVEL: 'error', LOG_TO_FILE: 'false', LOG_DIR: logDir };
    const api = `http://127.0.0.1:${port}/api`;
    async function start() { child = spawn(process.execPath, [path.resolve(__dirname, '../apps/api/dist/main.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', (bytes) => { output = (output + bytes).slice(-30000); }); child.stderr.on('data', (bytes) => { output = (output + bytes).slice(-30000); }); await until(async () => { if (child.exitCode !== null) throw new Error(`Production startup failed: ${output}`); try { return (await fetch(`${api}/health`)).ok; } catch { return false; } }); }
    async function stop() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } child = null; }
    await start(); const initial = await (await fetch(`${api}/settings`)).json(); assert.equal(initial.loggingStatus.level, 'error'); assert.equal(initial.loggingStatus.fileEnabled, false);
    const response = await fetch(`${api}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: { logLevel: 'debug', logToFile: true } }) }); assert.equal(response.status, 200);
    const changed = await response.json(); assert.equal(changed.loggingStatus.level, 'debug'); assert.equal(changed.loggingStatus.fileEnabled, true); assert.ok(fs.readFileSync(changed.loggingStatus.activeFile, 'utf8').includes('settings.update'));
    await stop(); output = ''; await start(); const restarted = await (await fetch(`${api}/settings`)).json(); assert.equal(restarted.loggingStatus.level, 'debug'); assert.equal(restarted.loggingStatus.fileEnabled, true);
    assert.ok(fs.readFileSync(restarted.loggingStatus.activeFile, 'utf8').includes('ModelGateway')); assert.ok(!fs.readFileSync(restarted.loggingStatus.activeFile, 'utf8').includes('fixture-process-key'));
    await stop(); console.log('PASS: real settings HTTP and migrated DB logging levels/files, preflight/audit/commit rollback, redaction/JSONL, file write failure status/reopen/disable, actual production main wiring and restart DB overrides; temporary files only');
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    logger.close(); if (app) await app.close(); if (db) await db.destroy();
    const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('vulnagent-logging-')); fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
