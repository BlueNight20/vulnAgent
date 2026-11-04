import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { RuntimeLogger } from './common/logging/runtime-logger';
import { SettingsService } from './modules/settings/settings.service';

async function bootstrap(): Promise<void> {
  const runtimeLogger = new RuntimeLogger(process.env.LOG_DIR ?? './storage/logs', process.env.LOG_LEVEL ?? 'info');
  const app = await NestFactory.create(AppModule, new ExpressAdapter(), { bufferLogs: false, logger: runtimeLogger });
  const logger = new Logger('Bootstrap');
  const config = app.get(ConfigService);
  const appCfg = config.get<AppConfig['app']>('app')!;
  const settings = app.get(SettingsService);
  const initial = await settings.get();
  runtimeLogger.prepare(initial.runtime, [await settings.readApiKey() ?? '']).apply();
  settings.registerLogging(runtimeLogger);
  app.enableShutdownHooks();
  process.once('exit', () => runtimeLogger.close());

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: [appCfg.webOrigin, 'http://127.0.0.1:5173'],
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useWebSocketAdapter(new WsAdapter(app));

  // 兜底：原生断言之外的异常不应让整个服务静默退出。
  // 记录后继续运行，避免一次工具/连接异常导致所有在跑任务中断。
  process.on('uncaughtException', (error) => {
    logger.error(`未捕获异常（进程继续运行）：${error.message}`);
    logger.error(error);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`未处理的 Promise 拒绝：${reason instanceof Error ? reason.message : String(reason)}`);
  });

  await app.listen(appCfg.port, appCfg.host);
  // Node 默认 keepAliveTimeout 仅 5 秒：连接空闲后被服务端关闭，
  // 但反向代理 / 开发代理仍持有该 socket 并尝试复用，表现为 ECONNREFUSED 或空 500。
  // 拉长到 65 秒（大于常见代理的 60 秒空闲上限），让由代理侧发起关闭。
  const httpServer = app.getHttpServer() as { keepAliveTimeout?: number; headersTimeout?: number };
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  const host = appCfg.host.includes(':') ? `[${appCfg.host}]` : appCfg.host;
  logger.log(`VulnAgent API 已启动: http://${host}:${appCfg.port}/api`);
  logger.log(`WebSocket: ws://${host}:${appCfg.port}/ws`);
  logger.log(`允许的前端来源: ${appCfg.webOrigin}`);
}

void bootstrap();
