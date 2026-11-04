import { FindingClueLevel1793577613000 } from './migrations/1793577613000-FindingClueLevel';
import { FindingIdentity1793577612000 } from './migrations/1793577612000-FindingIdentity';
import { McpStdio1793577611000 } from './migrations/1793577611000-McpStdio';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { BetterSqlite3ConnectionOptions } from 'typeorm/driver/better-sqlite3/BetterSqlite3ConnectionOptions';
import { ENTITIES } from './entities';
import { SqliteBaseline1793577600000 } from './migrations/1793577600000-SqliteBaseline';
import { FindingVerification1793577601000 } from './migrations/1793577601000-FindingVerification';
import { TaskGoal1793577602000 } from './migrations/1793577602000-TaskGoal';
import { EvidenceAttachments1793577603000 } from './migrations/1793577603000-EvidenceAttachments';
import { TaskOwnership1793577604000 } from './migrations/1793577604000-TaskOwnership';
import { HypothesisQuotes1793577605000 } from './migrations/1793577605000-HypothesisQuotes';
import { ModelTokenBudget1793577606000 } from './migrations/1793577606000-ModelTokenBudget';
import { McpHeaderSecrets1793577607000 } from './migrations/1793577607000-McpHeaderSecrets';
import { FindingAssessments1793577608000 } from './migrations/1793577608000-FindingAssessments';
import { GlobalPermissionUnique1793577609000 } from './migrations/1793577609000-GlobalPermissionUnique';
import { InterceptRules1793577610000 } from './migrations/1793577610000-InterceptRules';

export const SQLITE_MIGRATIONS = [SqliteBaseline1793577600000, FindingVerification1793577601000, TaskGoal1793577602000, EvidenceAttachments1793577603000, TaskOwnership1793577604000, HypothesisQuotes1793577605000, ModelTokenBudget1793577606000, McpHeaderSecrets1793577607000, FindingAssessments1793577608000, GlobalPermissionUnique1793577609000, InterceptRules1793577610000, McpStdio1793577611000, FindingIdentity1793577612000, FindingClueLevel1793577613000];

export function sqliteOptions(path: string): BetterSqlite3ConnectionOptions {
  const file = path === ':memory:' ? path : resolve(path);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const existed = file !== ':memory:' && existsSync(file);
  return {
    type: 'better-sqlite3', database: file, driver: Database, entities: ENTITIES,
    synchronize: false, migrations: SQLITE_MIGRATIONS, migrationsRun: false,
    migrationsTransactionMode: 'all',
    prepareDatabase: (database: Database.Database) => {
      if (!existed || !database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()) return;
      const hasVersions = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'").get();
      const applied = hasVersions ? (database.prepare('SELECT name FROM migrations').all() as { name: string }[]).map((r) => r.name) : [];
      if (SQLITE_MIGRATIONS.every((migration) => applied.includes(new migration().name))) return;
      const backup = `${file}.before-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
      // TypeORM 0.3.20 未等待此回调的 Promise；同步 VACUUM INTO 确保备份先于迁移完成。
      database.prepare('VACUUM INTO ?').run(backup);
    },
  };
}
