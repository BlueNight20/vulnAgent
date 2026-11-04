import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { RuntimeLogger } from './common/logging/runtime-logger';
import { SettingsService } from './modules/settings/settings.service';

/**
 * 托管已构建的前端（apps/web/dist）。
 *
 * 目的是让浏览器直接访问 API 端口，省掉 Vite 开发代理这一层：
 * 该代理在 Windows 多网卡环境下会间歇性出现 EADDRINUSE / 空 500，
 * 而生产形态本就不需要它。未构建前端时静默跳过，仅提供 API。
 */
function serveWebApp(server: import('express').Express, logger: Logger): void {
  const distDir = resolve(process.env.WEB_DIST_DIR ?? join(__dirname, '../../web/dist'));
  const indexHtml = join(distDir, 'index.html');
  if (!existsSync(indexHtml)) {
    logger.warn(`未找到前端构建产物（${indexHtml}），仅提供 API。执行 npm run build --workspace @vulnagent/web 后可启用页面托管。`);
    return;
  }
  server.use(express.static(distDir, { index: false, maxAge: '1h' }));
  // SPA 回退：非 /api、/ws 的 GET 一律返回 index.html，交给前端路由处理。
  server.get(/^\/(?!api\/|ws\/).*/, (_req, res) => {
    res.sendFile(indexHtml);
  });
  logger.log(`已托管前端页面: ${distDir}`);
}

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

  // 静态托管必须在 listen 之前注册，否则 Express 路由表已固化。
  serveWebApp(app.getHttpAdapter().getInstance() as import('express').Express, logger);

  await app.listen(appCfg.port, appCfg.host);
  // Node 默认 keepAliveTimeout 仅 5 秒：连接空闲后被服务端关闭，
  // 若中间有代理仍持有该 socket 并尝试复用，会表现为 ECONNREFUSED 或空 500。
  // 拉长到 65 秒（大于常见代理的 60 秒空闲上限），让由代理侧发起关闭。
  const httpServer = app.getHttpServer() as { keepAliveTimeout?: number; headersTimeout?: number };
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  const host = appCfg.host.includes(':') ? `[${appCfg.host}]` : appCfg.host;
  logger.log(`VulnAgent 控制台: http://${host}:${appCfg.port}/`);
  logger.log(`VulnAgent API: http://${host}:${appCfg.port}/api`);
  logger.log(`WebSocket: ws://${host}:${appCfg.port}/ws`);
  logger.log(`允许的前端来源: ${appCfg.webOrigin}`);
}

void bootstrap();
