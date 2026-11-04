import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSqliteBackup, verifySqliteBackup, type BackupManifest } from './sqlite-backup';

const BACKUP_NAME = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface RotationResult {
  created: { path: string; manifest: BackupManifest }; keep: number; mode: 'preview' | 'apply';
  retained: string[]; candidates: string[]; removed: string[]; skipped: { path: string; reason: string }[]; warnings: string[];
}
function childDirectory(root: string, path: string): void {
  if (dirname(resolve(path)) !== root || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error('备份目录越界或被替换为链接');
}
function record(root: string, event: Record<string, unknown>): void {
  const path = join(root, 'rotation-history.jsonl');
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('轮换日志不是普通文件');
  const fd = openSync(path, 'a', 0o600);
  try { writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Always create/verify a fresh backup first. Only --apply removes older independently verified bundles. */
export async function rotateSqliteBackups(source: string, directory: string, keep: number, apply = false): Promise<RotationResult> {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 10000) throw new Error('keep 必须是 1 到 10000 的整数');
  if (!lstatSync(resolve(source)).isFile() || lstatSync(resolve(source)).isSymbolicLink()) throw new Error('源库必须是普通文件，不能是链接');
  const input = realpathSync(resolve(source));
  mkdirSync(resolve(directory), { recursive: true, mode: 0o700 }); const root = realpathSync(resolve(directory));
  const lock = join(root, '.rotation.lock'); const nonce = randomUUID();
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new Error('不能取得备份轮换锁；可能已有轮换运行，请核查锁和目录权限'); }
  try {
    writeFileSync(fd, JSON.stringify({ nonce, pid: process.pid, startedAt: new Date().toISOString() })); fsyncSync(fd);
    const created = await createSqliteBackup(input, root); await verifySqliteBackup(created.path);
    const result: RotationResult = { created, keep, mode: apply ? 'apply' : 'preview', retained: [], candidates: [], removed: [], skipped: [], warnings: [] };
    const valid: { path: string; manifest: BackupManifest }[] = [];
    for (const name of readdirSync(root).filter((name) => BACKUP_NAME.test(name))) {
      const path = join(root, name);
      try {
        childDirectory(root, path); const manifest = await verifySqliteBackup(path);
        if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('备份创建时间无效');
        valid.push({ path, manifest });
      } catch (error) { result.skipped.push({ path, reason: error instanceof Error ? error.message : '不能校验' }); }
    }
    valid.sort((a, b) => Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt) || b.path.localeCompare(a.path));
    const retained = new Set(valid.slice(0, keep).map((entry) => entry.path));
    retained.add(created.path);
    // A database inside an older bundle may itself be the explicitly selected source.
    for (const entry of valid) if (dirname(input) === entry.path) retained.add(entry.path);
    result.retained = [...retained]; result.candidates = valid.filter((entry) => !retained.has(entry.path)).map((entry) => entry.path);
    if (!apply) return result;
    if (created.manifest.foreignKeyViolations > 0) {
      result.retained = valid.map((entry) => entry.path);
      result.warnings.push('新备份存在外键约束问题，未清理任何旧备份'); return result;
    }
    for (const entry of valid.filter((entry) => !retained.has(entry.path))) {
      let retired: string | undefined;
      try {
        childDirectory(root, entry.path);
        const current = await verifySqliteBackup(entry.path);
        if (JSON.stringify(current) !== JSON.stringify(entry.manifest)) throw new Error('备份在计划后已变化，跳过');
        record(root, { action: 'retire_requested', backup: basename(entry.path), sha256: current.sha256 });
        retired = join(root, `.retired-${nonce}-${basename(entry.path)}`);
        if (existsSync(retired)) throw new Error('轮换临时目录已存在');
        renameSync(entry.path, retired);
        childDirectory(root, retired);
        if (!basename(retired).startsWith(`.retired-${nonce}-backup-`)) throw new Error('轮换删除目标不匹配');
        rmSync(retired, { recursive: true }); result.removed.push(entry.path);
        record(root, { action: 'retired', backup: basename(entry.path), sha256: current.sha256 });
      } catch (error) {
        result.warnings.push(`${entry.path}：${error instanceof Error ? error.message : '清理失败'}${retired && existsSync(retired) ? `；待人工核查 ${retired}` : ''}`);
      }
    }
    return result;
  } finally {
    closeSync(fd);
    if (!lstatSync(lock).isFile() || lstatSync(lock).isSymbolicLink() || JSON.parse(readFileSync(lock, 'utf8')).nonce !== nonce) throw new Error('轮换锁已改变，未自动删除');
    unlinkSync(lock);
  }
}
