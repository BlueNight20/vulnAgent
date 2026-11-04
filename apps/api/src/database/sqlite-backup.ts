import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, chmodSync, closeSync, copyFileSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface BackupManifest {
  format: 'vulnagent-sqlite-backup'; version: 1; createdAt: string; bytes: number; sha256: string;
  tables: Record<string, number>; foreignKeyViolations: number;
}
async function digest(file: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
function regular(file: string): void { if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('备份文件必须是普通文件，不能是链接'); }
function inspect(file: string): Pick<BackupManifest, 'tables' | 'foreignKeyViolations'> {
  const header = Buffer.alloc(100); const fd = openSync(file, 'r');
  try { readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  if (header.toString('ascii', 0, 16) !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1) throw new Error('备份必须是独立 SQLite 快照，不能依赖 WAL 辅助文件');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity_check 未通过');
    const tables: Record<string, number> = Object.create(null);
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
      tables[row.name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${row.name.replaceAll('"', '""')}"`).get() as { n: number }).n;
    }
    return { tables, foreignKeyViolations: (db.pragma('foreign_key_check') as unknown[]).length };
  } finally { db.close(); }
}
function tableSignature(tables: Record<string, number>): string { return JSON.stringify(Object.entries(tables).sort(([a], [b]) => a.localeCompare(b))); }

/** Online Backup API includes committed WAL data; metadata is read from the completed snapshot. */
export async function createSqliteBackup(source: string, directory: string): Promise<{ path: string; manifest: BackupManifest }> {
  if (source === ':memory:') throw new Error('备份命令需要现存 SQLite 文件');
  const input = resolve(source); regular(input);
  mkdirSync(resolve(directory), { recursive: true, mode: 0o700 }); const root = realpathSync(resolve(directory));
  const id = randomUUID(); const pending = join(root, `.pending-${id}`);
  const output = join(root, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${id}`);
  mkdirSync(pending, { mode: 0o700 });
  try {
    const snapshot = join(pending, 'database.sqlite'); const db = new Database(input, { readonly: true, fileMustExist: true });
    try { await db.backup(snapshot); } finally { db.close(); }
    // Backup inherits the source WAL header. Seal only the new snapshot as a standalone database.
    const sealed = new Database(snapshot, { fileMustExist: true });
    try { sealed.pragma('journal_mode = DELETE'); } finally { sealed.close(); }
    chmodSync(snapshot, 0o600);
    const manifest: BackupManifest = { format: 'vulnagent-sqlite-backup', version: 1, createdAt: new Date().toISOString(), bytes: statSync(snapshot).size, sha256: await digest(snapshot), ...inspect(snapshot) };
    writeFileSync(join(pending, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    for (const name of ['database.sqlite', 'manifest.json']) { const fd = openSync(join(pending, name), 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } }
    renameSync(pending, output); return { path: output, manifest };
  } finally {
    if (existsSync(pending)) {
      if (dirname(resolve(pending)) !== root || basename(pending) !== `.pending-${id}`) throw new Error('临时备份目录越界');
      rmSync(pending, { recursive: true, force: true });
    }
  }
}

export async function verifySqliteBackup(directory: string): Promise<BackupManifest> {
  const root = resolve(directory); const metadata = join(root, 'manifest.json'); const snapshot = join(root, 'database.sqlite');
  if (readdirSync(root).some((name) => !['database.sqlite', 'manifest.json'].includes(name))) throw new Error('备份包包含额外文件或 WAL 辅助文件，拒绝读取');
  regular(metadata); regular(snapshot);
  if (statSync(metadata).size > 1024 * 1024) throw new Error('备份清单过大');
  const manifest = JSON.parse(readFileSync(metadata, 'utf8')) as BackupManifest;
  if (manifest.format !== 'vulnagent-sqlite-backup' || manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || !manifest.tables || typeof manifest.tables !== 'object' || Array.isArray(manifest.tables) || Object.values(manifest.tables).some((n) => !Number.isSafeInteger(n) || n < 0) || !Number.isSafeInteger(manifest.foreignKeyViolations) || manifest.foreignKeyViolations < 0) throw new Error('备份清单格式不受支持');
  if (statSync(snapshot).size !== manifest.bytes || await digest(snapshot) !== manifest.sha256) throw new Error('备份大小或 SHA-256 校验失败');
  const actual = inspect(snapshot);
  if (tableSignature(actual.tables) !== tableSignature(manifest.tables) || actual.foreignKeyViolations !== manifest.foreignKeyViolations) throw new Error('备份表计数或约束检查与清单不一致');
  return manifest;
}

/** Restore to a fresh path, so the operator can switch DB_PATH with the old database retained for rollback. */
export async function restoreSqliteBackup(directory: string, destination: string): Promise<{ path: string; manifest: BackupManifest }> {
  if (destination === ':memory:') throw new Error('恢复目标必须是新文件路径');
  const root = realpathSync(resolve(directory)); let output = resolve(destination); const relation = relative(root, output);
  if (relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))) throw new Error('恢复目标不能位于备份包内');
  const manifest = await verifySqliteBackup(root);
  const assertFresh = () => { if (['', '-wal', '-shm', '-journal'].some((suffix) => existsSync(`${output}${suffix}`))) throw new Error('恢复目标或其 SQLite 辅助文件已存在，拒绝覆盖'); };
  assertFresh(); mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  output = join(realpathSync(dirname(output)), basename(output));
  const canonicalRelation = relative(root, output);
  if (canonicalRelation === '' || (!isAbsolute(canonicalRelation) && canonicalRelation !== '..' && !canonicalRelation.startsWith(`..${sep}`))) throw new Error('恢复目标不能通过目录链接指向备份包内');
  const temporary = `${output}.restore-${randomUUID()}.pending`; let created = false;
  try {
    copyFileSync(join(root, 'database.sqlite'), temporary, constants.COPYFILE_EXCL); created = true; chmodSync(temporary, 0o600);
    if (await digest(temporary) !== manifest.sha256) throw new Error('复制期间备份发生变化，恢复未发布');
    const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    assertFresh(); linkSync(temporary, output); return { path: output, manifest };
  } finally { if (created) unlinkSync(temporary); }
}
