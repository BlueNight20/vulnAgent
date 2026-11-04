import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { DataSource } from 'typeorm';
import { sqliteOptions } from './sqlite-options';

for (const file of ['.env', '../../.env']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) loadEnvFile(path);
}
if (process.env.DB_TYPE === 'postgres') throw new Error('当前 CLI 迁移仅支持 SQLite，PostgreSQL 需独立迁移集');
export default new DataSource(sqliteOptions(process.env.DB_PATH ?? './storage/vulnagent.sqlite'));
