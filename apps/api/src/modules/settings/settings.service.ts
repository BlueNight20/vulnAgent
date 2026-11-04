import { serialTransaction } from '../../database/serial-transaction';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import type { ModelTestResult, SystemSettingsDto } from '@vulnagent/shared';
import type { AppConfig } from '../../config/configuration';
import { SystemSettingEntity, TaskEntity, TaskStateEventEntity } from '../../database/entities';
import { RUNTIME_DISABLED } from '../../database/runtime-control';
import { newId } from '../../common/utils/id';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { PersistentSecretCipher } from '../../common/crypto/persistent-secret-cipher';
import { nowIso, toIso } from '../../common/utils/id';
import { AuditService } from '../audit/audit.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import type { LoggingControl, PreparedLogging } from '../../common/logging/runtime-logger';

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  costPerMTokens: { input: number; output: number };
  reasoning: boolean;
}

const KEYS = {
  apiKey: 'model.apiKey',
  provider: 'model.provider',
  baseUrl: 'model.baseUrl',
  modelName: 'model.modelName',
  temperature: 'model.temperature',
  maxTokens: 'model.maxTokens',
  piRuntimeEnabled: 'runtime.piRuntimeEnabled',
  workerMaxConcurrency: 'runtime.workerMaxConcurrency',
  modelMaxConcurrency: 'runtime.modelMaxConcurrency',
  defaultTokenBudget: 'runtime.defaultTokenBudget',
  defaultTimeBudgetMinutes: 'runtime.defaultTimeBudgetMinutes',
  defaultWorkerCount: 'runtime.defaultWorkerCount',
  logLevel: 'runtime.logLevel',
  logToFile: 'runtime.logToFile',
} as const;

/** 未写入数据库时回落到环境变量 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cipher: PersistentSecretCipher;
  private modelTester: { testModel: () => Promise<ModelTestResult> } | null = null;
  private catalog: { listModels: () => ModelInfo[] } | null = null;
  private runtimeReloader: (() => Promise<void>) | null = null;
  private loggingControl: LoggingControl | null = null;
  registerLogging(control: LoggingControl): void { this.loggingControl = control; }

  constructor(
    @InjectRepository(SystemSettingEntity) private readonly repo: Repository<SystemSettingEntity>,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {
    const security = this.config.get<AppConfig['security']>('security');
    this.cipher = new PersistentSecretCipher(security?.encryptionKey ?? '', security?.encryptionKeyFile);
  }

  get encryptionEphemeral(): boolean {
    return this.cipher.isEphemeral;
  }

  async get(): Promise<SystemSettingsDto> {
    const model = this.config.get<AppConfig['model']>('model')!;
    const runtime = this.config.get<AppConfig['runtime']>('runtime')!;
    const rows = await this.repo.find({ where: { key: In(Object.values(KEYS)) } });
    const map = new Map(rows.map((r) => [r.key, r]));

    const rawKey = this.readSecret(map.get(KEYS.apiKey)) ?? (model.apiKey || null);
    const updatedAt = rows.reduce<Date | null>((acc, r) => {
      const d = r.updatedAt ? new Date(r.updatedAt) : null;
      return d && (!acc || d > acc) ? d : acc;
    }, null);

    return {
      model: {
        provider: this.readText(map.get(KEYS.provider)) ?? model.provider,
        baseUrl: this.readText(map.get(KEYS.baseUrl)) ?? model.baseUrl,
        modelName: this.readText(map.get(KEYS.modelName)) ?? model.name,
        apiKeyMasked: SecretCipher.mask(rawKey),
        apiKeyConfigured: Boolean(rawKey),
        temperature: Number(this.readText(map.get(KEYS.temperature)) ?? model.temperature),
        maxTokens: Number(this.readText(map.get(KEYS.maxTokens)) ?? model.maxTokens),
      },
      runtime: {
        piRuntimeEnabled:
          this.readBool(map.get(KEYS.piRuntimeEnabled)) ?? runtime.piRuntimeEnabled,
        workerMaxConcurrency:
          Number(this.readText(map.get(KEYS.workerMaxConcurrency)) ?? runtime.workerMaxConcurrency),
        modelMaxConcurrency:
          Number(this.readText(map.get(KEYS.modelMaxConcurrency)) ?? runtime.modelMaxConcurrency),
        defaultTokenBudget:
          Number(this.readText(map.get(KEYS.defaultTokenBudget)) ?? runtime.defaultTokenBudget),
        defaultTimeBudgetMinutes:
          Number(
            this.readText(map.get(KEYS.defaultTimeBudgetMinutes)) ?? runtime.defaultTimeBudgetMinutes,
          ),
        defaultWorkerCount:
          Number(this.readText(map.get(KEYS.defaultWorkerCount)) ?? runtime.defaultWorkerCount),
        logLevel: this.readText(map.get(KEYS.logLevel)) ?? this.config.get<AppConfig['logging']>('logging')!.level,
        logToFile: this.readBool(map.get(KEYS.logToFile)) ?? this.config.get<AppConfig['logging']>('logging')!.toFile,
      },
      updatedAt: toIso(updatedAt),
      ...(this.loggingControl ? { loggingStatus: this.loggingControl.status } : {}),
    };
  }

  async update(dto: UpdateSettingsDto): Promise<SystemSettingsDto> {
    const writes: { key: string; value: string; encrypted: boolean }[] = [];

    if (dto.model) {
      const m = dto.model;
      if (m.provider !== undefined) writes.push({ key: KEYS.provider, value: m.provider, encrypted: false });
      if (m.baseUrl !== undefined) writes.push({ key: KEYS.baseUrl, value: m.baseUrl, encrypted: false });
      if (m.modelName !== undefined) writes.push({ key: KEYS.modelName, value: m.modelName, encrypted: false });
      if (m.temperature !== undefined)
        writes.push({ key: KEYS.temperature, value: String(m.temperature), encrypted: false });
      if (m.maxTokens !== undefined)
        writes.push({ key: KEYS.maxTokens, value: String(m.maxTokens), encrypted: false });
      if (m.apiKey !== undefined) {
        const value = m.apiKey.trim();
        // 掩码回传表示"不修改"
        if (value === '' || (value.includes('****') && value.length <= 12)) {
          this.logger.debug('API Key 未修改');
        } else {
          writes.push({ key: KEYS.apiKey, value: this.cipher.encrypt(value), encrypted: true });
        }
      }
    }

    if (dto.runtime) {
      const r = dto.runtime;
      const push = (key: string, value: unknown) => {
        if (value === undefined) return;
        writes.push({ key, value: String(value), encrypted: false });
      };
      push(KEYS.piRuntimeEnabled, r.piRuntimeEnabled);
      push(KEYS.workerMaxConcurrency, r.workerMaxConcurrency);
      push(KEYS.modelMaxConcurrency, r.modelMaxConcurrency);
      push(KEYS.defaultTokenBudget, r.defaultTokenBudget);
      push(KEYS.defaultTimeBudgetMinutes, r.defaultTimeBudgetMinutes);
      push(KEYS.defaultWorkerCount, r.defaultWorkerCount);
      push(KEYS.logLevel, r.logLevel);
      push(KEYS.logToFile, r.logToFile);
    }

    let prepared: PreparedLogging | undefined;
    let event;
    try { event = await serialTransaction(this.repo.manager, async (manager) => {
      const repo = manager.getRepository(SystemSettingEntity);
      for (const write of writes) {
        const existing = await repo.findOne({ where: { key: write.key } });
        await repo.save(repo.create({ ...existing, ...write }));
      }
      if (dto.runtime?.piRuntimeEnabled === false) {
        const tasks = await manager.find(TaskEntity, { where: { status: 'running' } });
        for (const task of tasks) {
          await manager.update(TaskEntity, task.id, { status: 'paused', engineStatus: 'paused', lastError: RUNTIME_DISABLED });
          // Cancel stale controls: enabling later is not permission to replay an older start/resume request.
          await manager.update(TaskStateEventEntity, { taskId: task.id, consumedAt: IsNull(), eventType: In(['task.start_requested', 'task.resume', 'task.resumed', 'task.rerun']) }, { consumedAt: new Date() });
          await manager.insert(TaskStateEventEntity, { id: newId(), taskId: task.id, eventType: 'runtime.disabled', payload: { reason: RUNTIME_DISABLED }, consumedAt: null });
        }
      }
      const audit = await this.audit.recordInTransaction(manager, {
      action: 'settings.update',
      entityType: 'system_settings',
      detail: { keys: writes.map((w) => w.key) },
      });
      const settings = await this.get();
      prepared = this.loggingControl?.prepare(settings.runtime, [await this.readApiKey() ?? '']);
      return { audit, settings };
    }); } catch (error) { prepared?.dispose(); throw error; }
    prepared?.apply();
    if (this.loggingControl) event.settings.loggingStatus = this.loggingControl.status;
    this.audit.publish(event.audit);

    return event.settings;
  }

  /** 候选模型清单（来自本地目录表，不包含密钥） */
  availableModels(): ModelInfo[] {
    return this.catalog ? this.catalog.listModels() : [];
  }

  /**
   * 真实的模型连通性测试：由 ModelGateway 发起一次最小 Chat 调用。
   * 这里只做转发，避免 Settings 直接依赖 Pi SDK。
   */
  async testModel(): Promise<ModelTestResult> {
    if (!this.modelTester) {
      return {
        ok: false,
        latencyMs: 0,
        message: '模型网关未初始化',
        httpStatus: null,
        outputPreview: null,
        modelName: '',
        tokensUsed: 0,
        checkedAt: nowIso(),
      };
    }
    return this.modelTester.testModel();
  }

  /** 由 ModelGatewayModule 注入，避免循环依赖 */
  registerModelTester(tester: {
    testModel: () => Promise<ModelTestResult>;
    listModels: () => ModelInfo[];
  }): void {
    this.modelTester = tester;
    this.catalog = tester;
  }

  /** 配置变更后通知运行时重新加载 */
  async reloadRuntime(): Promise<void> {
    if (this.runtimeReloader) await this.runtimeReloader();
  }

  registerRuntimeReloader(fn: () => Promise<void>): void {
    this.runtimeReloader = fn;
  }

  /** 内部使用：读取明文 API Key（绝不通过 HTTP 返回） */
  async readApiKey(): Promise<string | null> {
    const row = await this.repo.findOne({ where: { key: KEYS.apiKey } });
    const fromDb = this.readSecret(row ?? undefined);
    if (fromDb) return fromDb;
    const envKey = this.config.get<AppConfig['model']>('model')?.apiKey;
    return envKey ? envKey : null;
  }

  private readText(row?: SystemSettingEntity): string | null {
    return row ? row.value : null;
  }

  private readBool(row?: SystemSettingEntity): boolean | null {
    if (!row) return null;
    return !row.encrypted && row.value === 'true';
  }

  private readSecret(row?: SystemSettingEntity): string | null {
    if (!row) return null;
    try {
      return row.encrypted ? this.cipher.decrypt(row.value) : row.value;
    } catch {
      throw new ServiceUnavailableException('已保存的模型密钥无法解密；请恢复原加密主密钥，或在设置中重新填写模型密钥。未回退使用其他凭据。');
    }
  }
}
