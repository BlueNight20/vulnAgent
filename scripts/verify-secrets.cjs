const backendRequire = require('./backend-require.cjs');
// Real SQLite/settings services and real process restarts; fixture credentials only, no network.
backendRequire('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DataSource } = backendRequire('typeorm');
const E = require('../apps/api/dist/database/entities');
const { sqliteOptions } = require('../apps/api/dist/database/sqlite-options');
const { PersistentSecretCipher } = require('../apps/api/dist/common/crypto/persistent-secret-cipher');
const { SettingsService } = require('../apps/api/dist/modules/settings/settings.service');
const configuration = require('../apps/api/dist/config/configuration').default;
const fixture = 'fixture-model-key-not-a-real-credential';

function settings(db, keyFile) {
  const cfg = configuration();
  cfg.security = { encryptionKey: '', encryptionKeyFile: keyFile };
  cfg.model.apiKey = 'fixture-env-fallback-must-not-be-used';
  const AuditService = require('../apps/api/dist/modules/audit/audit.service').AuditService;
  const audit = new AuditService(db.getRepository(E.AuditLogEntity), { broadcast() {} });
  audit.publish = () => {}; // Keep this credential-process fixture's stdout strictly JSON.
  return new SettingsService(db.getRepository(E.SystemSettingEntity), { get: (key) => cfg[key] }, audit);
}
async function main() {
  const [mode, file, keyFile] = process.argv.slice(2);
  if (mode === '--race') {
    process.stdout.write(JSON.stringify(new PersistentSecretCipher('', file).encrypt(fixture))); return;
  }
  if (mode === '--write') {
    const db = await new DataSource(sqliteOptions(file)).initialize();
    try { await db.runMigrations(); await settings(db, keyFile).update({ model: { apiKey: fixture } }); }
    finally { await db.destroy(); } return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vulnagent-secrets-'));
  let db;
  try {
    const database = path.join(directory, 'settings.sqlite'); const master = `${database}.key`;
    const child = spawnSync(process.execPath, [__filename, '--write', database, master], { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    db = await new DataSource(sqliteOptions(database)).initialize();
    const stored = await db.getRepository(E.SystemSettingEntity).findOneByOrFail({ key: 'model.apiKey' });
    assert.equal(stored.encrypted, true); assert.ok(!stored.value.includes(fixture));
    const service = settings(db, master);
    assert.equal(await service.readApiKey(), fixture);
    const dto = await service.get(); assert.ok(!JSON.stringify(dto).includes(fixture)); assert.equal(service.encryptionEphemeral, false);
    const original = fs.readFileSync(master);
    fs.writeFileSync(master, 'invalid fixture master');
    await assert.rejects(settings(db, master).readApiKey(), /无法解密/);
    await assert.rejects(settings(db, master).get(), /无法解密/);
    fs.unlinkSync(master);
    await assert.rejects(settings(db, master).readApiKey(), /无法解密/);
    assert.equal(fs.existsSync(master), false, 'decryption must not replace a lost master key');
    fs.writeFileSync(master, original, { mode: 0o600 }); assert.equal(await settings(db, master).readApiKey(), fixture);

    const concurrentFile = path.join(directory, 'concurrent.key');
    const results = await Promise.all(Array.from({ length: 6 }, () => promisify(execFile)(process.execPath, [__filename, '--race', concurrentFile], { timeout: 30000 })));
    for (const result of results) assert.equal(new PersistentSecretCipher('', concurrentFile).decrypt(JSON.parse(result.stdout)), fixture);
    assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')).length, 0);
    console.log('PASS: real settings SQLite encryption, independent process restart, masked DTO, lost/corrupt master refusal without credential fallback, original-key recovery and six-process atomic key creation');
  } finally {
    if (db) await db.destroy();
    const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('vulnagent-secrets-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
