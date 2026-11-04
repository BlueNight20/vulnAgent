import * as Joi from 'joi';

/**
 * 环境变量校验。
 * VA_ENCRYPTION_KEY 允许为空（SQLite 使用持久化本地密钥文件），
 * 但若提供则必须是 32 字节的 base64。
 */
export const envValidationSchema = Joi.object({
  PORT: Joi.number().port().default(3001),
  VA_API_HOST: Joi.alternatives().try(Joi.string().ip(), Joi.string().hostname()).default('127.0.0.1'),
  WEB_ORIGIN: Joi.string().uri().default('http://localhost:5173'),

  DB_TYPE: Joi.string().valid('sqlite', 'postgres').default('sqlite'),
  DB_PATH: Joi.string().default('./storage/vulnagent.sqlite'),
  DB_SYNCHRONIZE: Joi.string().valid('true', 'false', '1', '0').default('false'),
  DB_LOGGING: Joi.string().valid('true', 'false', '1', '0').default('false'),

  VA_ENCRYPTION_KEY: Joi.string()
    .allow('')
    .custom((value: string, helpers) => {
      if (!value) return value;
      const buf = Buffer.from(value, 'base64');
      if (buf.length !== 32 || buf.toString('base64') !== value) {
        return helpers.error('any.invalid', {
          message: 'VA_ENCRYPTION_KEY 必须是 32 字节随机值的 base64 编码',
        });
      }
      return value;
    })
    .default(''),
  VA_ENCRYPTION_KEY_FILE: Joi.string().allow('').default(''),

  MCP_GATEWAY_NAME: Joi.string().default('blhackbox-gateway'),
  MCP_GATEWAY_URL: Joi.string().uri().default('http://localhost:8080/mcp'),
  MCP_GATEWAY_ENABLED: Joi.string().valid('true', 'false', '1', '0').default('true'),
  MCP_TRANSPORT: Joi.string().valid('streamable-http', 'sse').default('streamable-http'),
  MCP_GATEWAY_HEADERS: Joi.string().allow('').default(''),
  MCP_HEALTH_TIMEOUT_MS: Joi.number().integer().min(500).default(5000),
  MCP_HEALTH_CACHE_TTL_MS: Joi.number().integer().min(0).default(30000),
  MCP_TOOL_TIMEOUT_MS: Joi.number().integer().min(100).max(3600000).default(300000),
  MCP_CONNECT_TIMEOUT_MS: Joi.number().integer().min(100).max(300000).default(60000),
  MCP_MAX_SCAN_HOSTS: Joi.number().integer().min(1).max(65536).default(256),
  MCP_MAX_SCAN_PORTS: Joi.number().integer().min(1).max(65535).default(1024),
  MCP_MAX_SCAN_PROBES: Joi.number().integer().min(1).max(10000000).default(4096),

  MODEL_PROVIDER: Joi.string().default('openai-compatible'),
  MODEL_BASE_URL: Joi.string().uri().default('https://api.deepseek.com/v1'),
  MODEL_NAME: Joi.string().default('deepseek-chat'),
  MODEL_API_KEY: Joi.string().allow('').default(''),
  MODEL_TEMPERATURE: Joi.number().min(0).max(2).default(0.2),
  MODEL_MAX_TOKENS: Joi.number().integer().min(64).default(4096),

  PI_RUNTIME_ENABLED: Joi.string().valid('true', 'false', '1', '0').default('false'),
  WORKER_MAX_CONCURRENCY: Joi.number().integer().min(1).max(8).default(2),
  MODEL_MAX_CONCURRENCY: Joi.number().integer().min(1).max(16).default(2),
  DEFAULT_TOKEN_BUDGET: Joi.number().integer().min(1000).default(200000),
  DEFAULT_TIME_BUDGET_MINUTES: Joi.number().integer().min(1).default(60),
  DEFAULT_WORKER_COUNT: Joi.number().integer().min(1).max(8).default(2),

  LOG_LEVEL: Joi.string().valid('debug', 'info', 'warn', 'error').default('info'),
  LOG_TO_FILE: Joi.string().valid('true', 'false', '1', '0').default('false'),
  LOG_DIR: Joi.string().default('./storage/logs'),
  VA_MAINTENANCE_BACKUP_DIRECTORY: Joi.string().allow('').default(''),
}).options({ allowUnknown: true, abortEarly: false });
