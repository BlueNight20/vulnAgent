import { createSqliteBackup, restoreSqliteBackup, verifySqliteBackup } from './sqlite-backup';
import { rotateSqliteBackups } from './backup-rotation';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2); const options = new Map<string, string>();
  for (let i = 0; i < args.length;) {
    const name = args[i];
    if (options.has(name)) throw new Error('重复参数');
    if (name === '--apply') { options.set(name, 'true'); i++; continue; }
    if (!['--source', '--directory', '--backup', '--destination', '--keep'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('无效参数');
    options.set(name, args[i + 1]); i += 2;
  }
  const required = (names: string[]) => { if (options.size !== names.length || names.some((name) => !options.has(name))) throw new Error(`此命令需要 ${names.join(' / ')}`); return names.map((name) => options.get(name)!); };
  if (command === 'backup') { const [source, directory] = required(['--source', '--directory']); console.log(JSON.stringify(await createSqliteBackup(source, directory), null, 2)); }
  else if (command === 'verify') { const [backup] = required(['--backup']); console.log(JSON.stringify(await verifySqliteBackup(backup), null, 2)); }
  else if (command === 'restore') { const [backup, destination] = required(['--backup', '--destination']); console.log(JSON.stringify(await restoreSqliteBackup(backup, destination), null, 2)); }
  else if (command === 'rotate') {
    const apply = options.has('--apply'); const [source, directory, keep] = required(['--source', '--directory', '--keep', ...(apply ? ['--apply'] : [])]);
    if (!/^\d+$/.test(keep)) throw new Error('keep 必须是正整数');
    const result = await rotateSqliteBackups(source, directory, Number(keep), apply); console.log(JSON.stringify(result, null, 2));
    if (result.warnings.length) process.exitCode = 2;
  }
  else throw new Error('用法：backup --source DB --directory DIR | verify --backup BUNDLE | restore --backup BUNDLE --destination NEW_DB | rotate --source DB --directory DIR --keep N [--apply]');
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : '数据库维护失败'); process.exitCode = 1; });
