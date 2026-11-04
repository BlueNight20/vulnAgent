import { Injectable, Logger } from '@nestjs/common';
import type { PiAgentEvent } from './pi-types';
import { SessionManagerService } from './session-manager.service';
import { ModelGatewayService } from '../model-gateway/model-gateway.service';

/**
 * PiRuntimeService：Pi Agent 运行时的统一门面。
 * - 启动时校正遗留会话
 * - 暴露模型并发情况
 * - 转发底层事件给编排层（由 Orchestrator 订阅）
 */
@Injectable()
export class PiRuntimeService {
  private readonly logger = new Logger(PiRuntimeService.name);
  private readonly listeners: Array<(event: PiAgentEvent, sessionId: string, taskId: string) => void> = [];

  constructor(
    readonly sessions: SessionManagerService,
    readonly models: ModelGatewayService,
  ) {}

  // Startup reconciliation belongs to OrchestratorService before its durable event consumer starts.
  // A second delayed pass could misclassify newly started sessions as leftovers.

  /** 订阅全部 Session 的原始 Agent 事件 */
  onAgentEvent(listener: (event: PiAgentEvent, sessionId: string, taskId: string) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  get status() {
    return {
      activeSessions: this.sessions.activeCount,
      modelConcurrency: this.models.concurrency.running,
      modelConcurrencyLimit: this.models.concurrency.max,
    };
  }

  async reloadModelConfig(): Promise<void> {
    this.models.invalidate();
    await this.models.refreshLimits();
    this.logger.log('模型配置已重新加载');
  }
}
