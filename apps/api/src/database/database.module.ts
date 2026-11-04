import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AppConfig } from '../config/configuration';
import { ENTITIES } from './entities';
import { sqliteOptions } from './sqlite-options';

function resolveSqlitePath(path: string): string {
  if (path === ':memory:') return path;
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const dir = dirname(absolute);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return absolute;
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const cfg = config.get<AppConfig['db']>('db');
        const logger = new Logger('DatabaseModule');
        if (!cfg || cfg.type === 'sqlite') {
          const file = resolveSqlitePath(cfg?.path ?? './storage/vulnagent.sqlite');
          const synchronize = cfg?.synchronize ?? false;
          const options = sqliteOptions(file);
          logger.log(`SQLite 数据库: ${file}（synchronize=${synchronize}）`);
          if (synchronize) logger.warn('DB_SYNCHRONIZE=true：已显式启用开发期自动改表，迁移将不自动执行。建议关闭此设置。');
          return {
            ...options,
            synchronize,
            migrationsRun: !synchronize,
            prepareDatabase: synchronize ? undefined : options.prepareDatabase,
            logging: (cfg?.logging ?? false) ? (['query', 'error'] as const) : false,
          };
        }
        logger.log(`PostgreSQL 数据库: ${cfg.host}:${cfg.port}/${cfg.database}`);
        return {
          type: 'postgres' as const,
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          password: cfg.password,
          database: cfg.database,
          entities: ENTITIES,
          synchronize: cfg.synchronize,
          logging: cfg.logging,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
