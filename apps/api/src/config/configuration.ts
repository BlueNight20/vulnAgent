export interface AppConfig {
  maintenance?: { backupDirectory: string };
  app: {
    port: number;
    host: string;
    webOrigin: string;
    version: string;
  };
  db: {
    type: 'sqlite' | 'postgres';
    path: string;
    synchronize: boolean;
    logging: boolean;
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  };
  security: {
    encryptionKey: string;
    encryptionKeyFile?: string;
  };
  mcp: {
    gatewayName: string;
    gatewayUrl: string;
    gatewayEnabled: boolean;
    transport: 'streamable-http' | 'sse';
    gatewayHeaders: string;
    healthTimeoutMs: number;
    /** 健康检查超时上限（工具数多时自动放宽） */
    healthTimeoutMaxMs: number;
    /** 单次工具执行的最长等待时间（nmap 等长任务需要分钟级） */
    toolCallTimeoutMs: number;
    /** MCP 握手超时，并发调用时可调大 */
    connectTimeoutMs: number;
    maxScanHosts: number;
    maxScanPorts: number;
    maxScanProbes: number;
    healthCacheTtlMs: number;
  };
  model: {
    provider: string;
    baseUrl: string;
    name: string;
    apiKey: string;
    temperature: number;
    maxTokens: number;
  };
  runtime: {
    piRuntimeEnabled: boolean;
    workerMaxConcurrency: number;
    modelMaxConcurrency: number;
    defaultTokenBudget: number;
    defaultTimeBudgetMinutes: number;
    defaultWorkerCount: number;
  };
  logging: {
    level: string;
    toFile: boolean;
    dir: string;
  };
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export const APP_VERSION = '0.1.0';

export default (): AppConfig => {
  const dbType = (process.env.DB_TYPE ?? 'sqlite') === 'postgres' ? 'postgres' : 'sqlite';
  return {
    app: {
      port: toInt(process.env.PORT, 3001),
      host: process.env.VA_API_HOST ?? '127.0.0.1',
      webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
      version: APP_VERSION,
    },
    db: {
      type: dbType,
      path: process.env.DB_PATH ?? './storage/vulnagent.sqlite',
      synchronize: toBool(process.env.DB_SYNCHRONIZE, false),
      logging: toBool(process.env.DB_LOGGING, false),
      host: process.env.DB_HOST ?? 'localhost',
      port: toInt(process.env.DB_PORT, 5432),
      username: process.env.DB_USERNAME ?? 'vulnagent',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_DATABASE ?? 'vulnagent',
    },
    security: {
      encryptionKey: process.env.VA_ENCRYPTION_KEY ?? '',
      encryptionKeyFile: process.env.VA_ENCRYPTION_KEY_FILE || (dbType === 'sqlite' && process.env.DB_PATH !== ':memory:' ? `${process.env.DB_PATH ?? './storage/vulnagent.sqlite'}.key` : undefined),
    },
    mcp: {
      gatewayName: process.env.MCP_GATEWAY_NAME ?? 'blhackbox-gateway',
      gatewayUrl: process.env.MCP_GATEWAY_URL ?? 'http://localhost:8080/mcp',
      gatewayEnabled: toBool(process.env.MCP_GATEWAY_ENABLED, true),
      transport: process.env.MCP_TRANSPORT === 'sse' ? 'sse' : 'streamable-http',
      gatewayHeaders: process.env.MCP_GATEWAY_HEADERS ?? '',
      healthTimeoutMs: toInt(process.env.MCP_HEALTH_TIMEOUT_MS, 5000),
      healthTimeoutMaxMs: toInt(process.env.MCP_HEALTH_TIMEOUT_MAX_MS, 60000),
      toolCallTimeoutMs: toInt(process.env.MCP_TOOL_TIMEOUT_MS, 300000),
      connectTimeoutMs: toInt(process.env.MCP_CONNECT_TIMEOUT_MS, 60000),
      maxScanHosts: toInt(process.env.MCP_MAX_SCAN_HOSTS, 256),
      maxScanPorts: toInt(process.env.MCP_MAX_SCAN_PORTS, 1024),
      maxScanProbes: toInt(process.env.MCP_MAX_SCAN_PROBES, 4096),
      healthCacheTtlMs: toInt(process.env.MCP_HEALTH_CACHE_TTL_MS, 30000),
    },
    model: {
      provider: process.env.MODEL_PROVIDER ?? 'openai-compatible',
      baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.deepseek.com/v1',
      name: process.env.MODEL_NAME ?? 'deepseek-chat',
      apiKey: process.env.MODEL_API_KEY ?? '',
      temperature: Number(process.env.MODEL_TEMPERATURE ?? 0.2),
      maxTokens: toInt(process.env.MODEL_MAX_TOKENS, 4096),
    },
    runtime: {
      piRuntimeEnabled: toBool(process.env.PI_RUNTIME_ENABLED, false),
      workerMaxConcurrency: toInt(process.env.WORKER_MAX_CONCURRENCY, 2),
      modelMaxConcurrency: toInt(process.env.MODEL_MAX_CONCURRENCY, 2),
      defaultTokenBudget: toInt(process.env.DEFAULT_TOKEN_BUDGET, 200000),
      defaultTimeBudgetMinutes: toInt(process.env.DEFAULT_TIME_BUDGET_MINUTES, 60),
      defaultWorkerCount: toInt(process.env.DEFAULT_WORKER_COUNT, 2),
    },
    logging: {
      level: process.env.LOG_LEVEL ?? 'info',
      toFile: toBool(process.env.LOG_TO_FILE, false),
      dir: process.env.LOG_DIR ?? './storage/logs',
    },
    maintenance: { backupDirectory: process.env.VA_MAINTENANCE_BACKUP_DIRECTORY ?? '' },
  };
};
