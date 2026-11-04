const backendRequire = require('./backend-require.cjs');
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { spawnSync } = require('node:child_process'); const { randomBytes } = require('node:crypto');
const { DataSource } = backendRequire('typeorm'); const Database = backendRequire('better-sqlite3');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const { SecretCipher } = require('../apps/api/dist/common/crypto/secret-cipher');
const { createSqliteBackup, verifySqliteBackup, restoreSqliteBackup } = require('../apps/api/dist/database/sqlite-backup');
const { rotateSqliteBackups } = require('../apps/api/dist/database/backup-rotation');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-backups-')); let source;
  try {
    const input = path.join(directory, 'source.sqlite'); const backups = path.join(directory, 'backups');
    const db = await new DataSource(sqliteOptions(input)).initialize();
    try {
      await db.runMigrations();
      await db.getRepository(E.TaskEntity).save({ id: 'retained-task', name: '备份中文任务', modelName: 'fixture', modelProvider: 'fixture', scope: {} });
    } finally { await db.destroy(); }
    source = new Database(input); source.pragma('journal_mode = WAL'); source.pragma('wal_autocheckpoint = 0');
    const cipher = new SecretCipher(randomBytes(32).toString('base64')); const ciphertext = cipher.encrypt('fixture-preserved-secret');
    source.prepare('INSERT INTO system_settings (key,value,encrypted) VALUES (?,?,1)').run('model.apiKey', ciphertext);
    source.exec('CREATE TABLE maintenance_payload (id INTEGER PRIMARY KEY, data BLOB, note TEXT)');
    const bytes = randomBytes(256 * 1024); source.prepare('INSERT INTO maintenance_payload VALUES (1,?,?)').run(bytes, '完整原文🙂');
    assert.ok(fs.statSync(`${input}-wal`).size > 0);
    const backup = await createSqliteBackup(input, backups);
    assert.equal(backup.manifest.tables.tasks, 1); assert.equal(backup.manifest.tables.maintenance_payload, 1);
    assert.deepEqual(fs.readdirSync(backup.path).sort(), ['database.sqlite', 'manifest.json']);
    assert.equal((await verifySqliteBackup(backup.path)).sha256, backup.manifest.sha256);
    source.prepare('INSERT INTO maintenance_payload VALUES (2,?,?)').run(Buffer.from('later'), 'late write');
    const output = path.join(directory, 'restore', 'restored.sqlite'); await restoreSqliteBackup(backup.path, output);
    const restored = new Database(output, { readonly: true });
    try {
      assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM maintenance_payload').get().n, 1);
      assert.deepEqual(restored.prepare('SELECT data FROM maintenance_payload WHERE id=1').get().data, bytes);
      assert.equal(restored.prepare('SELECT note FROM maintenance_payload WHERE id=1').get().note, '完整原文🙂');
      assert.equal(cipher.decrypt(restored.prepare("SELECT value FROM system_settings WHERE key='model.apiKey'").get().value), 'fixture-preserved-secret');
    } finally { restored.close(); }
    await assert.rejects(restoreSqliteBackup(backup.path, input), /拒绝覆盖/);
    await assert.rejects(restoreSqliteBackup(backup.path, output), /拒绝覆盖/);
    await assert.rejects(restoreSqliteBackup(backup.path, path.join(backup.path, 'new.sqlite')), /备份包内/);
    const auxiliary = path.join(directory, 'reserved.sqlite'); fs.writeFileSync(`${auxiliary}-wal`, 'fixture');
    await assert.rejects(restoreSqliteBackup(backup.path, auxiliary), /辅助文件/); assert.equal(fs.existsSync(auxiliary), false);
    const damaged = path.join(directory, 'damaged'); fs.cpSync(backup.path, damaged, { recursive: true });
    fs.appendFileSync(path.join(damaged, 'database.sqlite'), 'tampered');
    await assert.rejects(verifySqliteBackup(damaged), /SHA-256/);
    await assert.rejects(restoreSqliteBackup(damaged, path.join(directory, 'invalid.sqlite')), /SHA-256/);
    assert.equal(fs.existsSync(path.join(directory, 'invalid.sqlite')), false);
    const forged = path.join(directory, 'forged'); fs.cpSync(backup.path, forged, { recursive: true });
    fs.writeFileSync(path.join(forged, 'manifest.json'), JSON.stringify({ ...backup.manifest, tables: { tasks: 99 } }));
    await assert.rejects(verifySqliteBackup(forged), /计数/);
    const cli = path.resolve(__dirname, '../apps/api/dist/database/maintenance-cli.js');
    const invoke = (args) => { const child = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000 }); assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout); };
    const cliBackup = invoke(['backup', '--source', input, '--directory', backups]);
    assert.equal(cliBackup.manifest.tables.maintenance_payload, 2);
    assert.equal(invoke(['verify', '--backup', cliBackup.path]).sha256, cliBackup.manifest.sha256);
    const cliOutput = path.join(directory, 'cli-restored.sqlite'); invoke(['restore', '--backup', cliBackup.path, '--destination', cliOutput]);
    assert.ok(fs.existsSync(cliOutput));
    const invalid = spawnSync(process.execPath, [cli, 'restore', '--backup', backup.path, '--destination', input], { encoding: 'utf8', timeout: 30000 });
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /拒绝覆盖/);
    const malformed = path.join(directory, 'malformed.sqlite'); fs.writeFileSync(malformed, 'not a SQLite database');
    await assert.rejects(createSqliteBackup(malformed, backups));
    await assert.rejects(createSqliteBackup(path.join(directory, 'missing.sqlite'), backups));
    assert.equal(source.prepare('SELECT COUNT(*) AS n FROM maintenance_payload').get().n, 2);
    assert.equal(fs.readdirSync(backups).filter((name) => name.startsWith('.pending-')).length, 0);
    const unrelated = path.join(backups, 'operator-notes'); fs.mkdirSync(unrelated); fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'untouched');
    const brokenBundle = path.join(backups, 'backup-2000-01-01T00-00-00-000Z-00000000-0000-4000-8000-000000000000');
    fs.mkdirSync(brokenBundle); fs.writeFileSync(path.join(brokenBundle, 'database.sqlite'), 'damaged fixture');
    const preview = await rotateSqliteBackups(input, backups, 2);
    assert.equal(preview.mode, 'preview'); assert.ok(preview.candidates.length > 0); assert.equal(preview.removed.length, 0);
    for (const file of preview.candidates) assert.ok(fs.existsSync(file));
    assert.ok(preview.skipped.some((row) => row.path === brokenBundle));
    const applied = await rotateSqliteBackups(input, backups, 2, true);
    assert.ok(applied.removed.length > 0); assert.equal(applied.warnings.length, 0);
    for (const file of applied.removed) assert.equal(fs.existsSync(file), false);
    for (const file of applied.retained) await verifySqliteBackup(file);
    assert.ok(fs.existsSync(brokenBundle)); assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'untouched');
    assert.equal(fs.existsSync(path.join(backups, '.rotation.lock')), false);
    assert.ok(fs.readFileSync(path.join(backups, 'rotation-history.jsonl'), 'utf8').includes('retire_requested'));
    const protectedSource = path.join(applied.created.path, 'database.sqlite');
    await rotateSqliteBackups(protectedSource, backups, 1, true); assert.ok(fs.existsSync(protectedSource));
    const held = rotateSqliteBackups(input, backups, 2);
    await assert.rejects(rotateSqliteBackups(input, backups, 2), /轮换锁/); await held;
    await assert.rejects(rotateSqliteBackups(input, backups, 0, true), /keep/);
    const history = path.join(backups, 'rotation-history.jsonl'); fs.renameSync(history, `${history}.saved`); fs.mkdirSync(history);
    const auditFailure = await rotateSqliteBackups(input, backups, 1, true);
    assert.ok(auditFailure.warnings.length > 0); assert.equal(auditFailure.removed.length, 0);
    for (const file of auditFailure.candidates) assert.ok(fs.existsSync(file));
    fs.rmdirSync(history); fs.renameSync(`${history}.saved`, history);
    const cliPreview = invoke(['rotate', '--source', input, '--directory', backups, '--keep', '2']); assert.equal(cliPreview.mode, 'preview');
    const cliApply = invoke(['rotate', '--source', input, '--directory', backups, '--keep', '2', '--apply']); assert.equal(cliApply.mode, 'apply');
    source.pragma('foreign_keys = OFF'); source.exec('CREATE TABLE orphan_fixture (parent INTEGER REFERENCES maintenance_payload(id)); INSERT INTO orphan_fixture VALUES (999)');
    const orphan = await rotateSqliteBackups(input, backups, 1, true);
    assert.ok(orphan.created.manifest.foreignKeyViolations > 0); assert.equal(orphan.removed.length, 0); assert.ok(orphan.warnings.some((text) => text.includes('外键')));
    assert.equal(fs.existsSync(path.join(backups, '.rotation.lock')), false);
    console.log('PASS: real migrated SQLite/WAL backup and fresh-path restore, complete BLOB/Unicode/encrypted settings, integrity/tamper/overwrite guards, rotation preview/apply/lock/audit/source protection, malformed and unrelated directory preservation, foreign-key failure preservation and real CLI');
  } finally {
    if (source) source.close(); const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('vulnagent-backups-')); fs.rmSync(target, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
