import { ConflictException, Injectable } from '@nestjs/common';
import type { SessionDto } from '@vulnagent/shared';
import { PiRuntimeService } from '../pi-runtime/pi-runtime.service';
import { TaskEntity, ToolCallEntity, WorkerTaskEntity } from '../../database/entities';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

@Injectable()
export class AgentsService {
  constructor(
    private readonly runtime: PiRuntimeService,
    @InjectRepository(ToolCallEntity) private readonly toolCalls: Repository<ToolCallEntity>,
  ) {}

  async listSessions(taskId?: string): Promise<{ items: SessionDto[] }> {
    if (!taskId) return { items: [] };
    return { items: await this.runtime.sessions.listByTask(taskId) };
  }

  async sessionDetail(id: string) {
    const session = await this.runtime.sessions.findOne(id);
    const calls = await this.toolCalls.find({
      where: { agentSessionId: id },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return {
      session,
      toolCalls: calls.map((c) => ({
        id: c.id,
        toolName: c.toolName,
        targetIp: c.targetIp,
        decision: c.decision,
        status: c.status,
        latencyMs: c.latencyMs,
        errorMessage: c.errorMessage,
        createdAt: c.createdAt,
      })),
    };
  }

  async messages(id: string, afterSeq: number) {
    await this.runtime.sessions.findOne(id);
    return this.runtime.sessions.store.listMessages(id, afterSeq, 300);
  }

  events(id: string, limit: number) {
    return this.runtime.sessions.store.listEvents(id, limit);
  }

  pause(id: string) {
    return this.runtime.sessions.pause(id);
  }

  async resume(id: string) {
    const session = await this.runtime.sessions.findOne(id);
    const task = await this.toolCalls.manager.findOneBy(TaskEntity, { id: session.taskId });
    if (!task || task.status !== 'running' || task.engineStatus !== 'running') throw new ConflictException('请先通过任务控制恢复执行引擎，再恢复会话');
    if (session.role !== 'planner' && !await this.toolCalls.manager.existsBy(WorkerTaskEntity, { taskId: session.taskId, sessionId: id, status: 'running' })) throw new ConflictException('原 Worker 已收尾，不能单独恢复旧会话；请重新安排任务');
    return this.runtime.sessions.resume(id);
  }

  terminate(id: string) {
    return this.runtime.sessions.terminate(id, '用户手动终止');
  }

  runtimeStatus() {
    return this.runtime.status;
  }
}
