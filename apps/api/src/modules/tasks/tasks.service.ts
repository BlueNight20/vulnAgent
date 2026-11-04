import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, In, IsNull, Repository } from 'typeorm';
import {
  ENGINE_PHASE_NOTICE,
  TASK_ACTION_LABEL,
  isValidCidr,
  isValidIPv4,
  isValidPortSpec,
  isMissingUrlScheme,
  isValidTarget,
  targetHost,
  type TaskAction,
  type TaskDetail,
  type TaskListResult,
  type TaskSummary,
} from '@vulnagent/shared';
import { AgentSessionEntity, AuditLogEntity, FindingEntity, FindingVerificationEntity, HintEntity, IntentEntity, ModelRequestEntity, OrchestratorRunEntity, TargetEntity, TaskEntity, TaskStateEventEntity, ToolCallEntity, WorkerTaskEntity } from '../../database/entities';
import { hydrateTaskAccounting } from '../../database/model-accounting';
import { newId } from '../../common/utils/id';
import { normalizePagination } from '../../common/utils/pagination';
import { AuditService } from '../audit/audit.service';
import { EventsGateway } from '../events/events.gateway';
import { CreateTaskDto, QueryTaskDto } from './dto/create-task.dto';
import { nextStatus } from './task-state-machine';
import { toTaskDetail, toTaskSummary } from './task-mapper';
import { configureGoal } from '../blackboard/task-goal-rules';
import { serialTransaction } from '../../database/serial-transaction';
import { hasTaskActivity } from '../../database/task-activity';
import { requireRuntime } from '../../database/runtime-control';

const TERMINAL_TASK_STATUS = ['stopped', 'completed', 'failed'];

/** 同一任务只允许一个未收尾的控制请求；启动、暂停、恢复、停止、重跑共用该队列。 */
const CONTROL_EVENT_TYPES = ['task.start_requested', 'task.pause', 'task.resume', 'task.stop', 'task.rerun', 'task.paused', 'task.resumed', 'task.stopped', 'runtime.disabled'];

const PHASE_BY_STATUS: Record<string, string> = {
  pending: '等待启动',
  running: '已进入执行队列',
  paused: '已暂停',
  stopped: '已停止',
  completed: '已完成',
  failed: '执行失败',
};

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(TaskEntity) private readonly tasks: Repository<TaskEntity>,
    @InjectRepository(TargetEntity) private readonly targets: Repository<TargetEntity>,
    @InjectRepository(TaskStateEventEntity)
    private readonly stateEvents: Repository<TaskStateEventEntity>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: EventsGateway,
  ) {}

  async list(query: QueryTaskDto): Promise<TaskListResult> {
    const { skip, take } = normalizePagination(query.page, query.pageSize);
    const qb = this.tasks.createQueryBuilder('t').orderBy('t.createdAt', 'DESC').skip(skip).take(take);
    if (query.status) qb.andWhere('t.status = :status', { status: query.status });
    if (query.keyword) {
      qb.andWhere('(t.name LIKE :kw OR t.description LIKE :kw)', { kw: `%${query.keyword}%` });
    }
    const [rows, total] = await qb.getManyAndCount();
    const items = await this.attachTargets(rows);
    const stats = await this.statusStats();
    return { items, total, stats };
  }

  async detail(id: string): Promise<TaskDetail> {
    const task = await this.findTask(id);
    const targets = await this.targets.find({ where: { taskId: id }, order: { ip: 'ASC' } });
    return toTaskDetail(task, targets);
  }

  async create(dto: CreateTaskDto): Promise<TaskDetail> {
    this.validateScope(dto);
    const taskId = newId();
    const goal = configureGoal(dto.goal ?? { mode: 'assessment', targets: dto.targets.map((t) => t.ip), ports: dto.scope.ports?.trim() || '1-1000', protocol: 'tcp', evidenceText: null }, dto.targets.map((t) => t.ip), { cidrs: dto.scope.cidrs, ports: dto.scope.ports ?? null });

    const created = await serialTransaction(this.dataSource.manager, async (manager) => {
      if (dto.autoStart) await requireRuntime(manager);
      const task = manager.create(TaskEntity, {
        id: taskId,
        budgetEpoch: newId(), tokenBaseline: 0, costBaseline: 0,
        goal,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        status: dto.autoStart ? 'running' : 'pending',
        scope: { cidrs: dto.scope.cidrs, ports: dto.scope.ports?.trim() || null },
        authorizationRef: dto.authorizationRef?.trim() || null,
        modelProvider: dto.modelProvider,
        modelName: dto.modelName,
        tokenBudget: dto.tokenBudget,
        timeBudgetMinutes: dto.timeBudgetMinutes,
        workerCount: dto.workerCount,
        progress: 0,
        currentPhase: PHASE_BY_STATUS[dto.autoStart ? 'running' : 'pending'],
        startedAt: dto.autoStart ? new Date() : null,
        lastError: null,
      });
      await manager.save(task);

      const unique = new Map<string, string | null>();
      for (const target of dto.targets) {
        const ip = target.ip.trim();
        if (!unique.has(ip)) unique.set(ip, target.note?.trim() || null);
      }
      const rows = Array.from(unique.entries()).map(([ip, note]) =>
        manager.create(TargetEntity, {
          id: newId(),
          taskId,
          ip,
          hostname: isValidIPv4(ip) || isValidCidr(ip) ? null : targetHost(ip).toLowerCase(),
          kind: isValidCidr(ip) ? 'cidr' : 'host',
          inScope: true,
          note,
        }),
      );
      await manager.save(rows);
      if (dto.autoStart) await manager.insert(TaskStateEventEntity, { id: newId(), taskId, eventType: 'task.start_requested', payload: null, consumedAt: null });
      const audit = await this.audit.recordInTransaction(manager, {
        action: 'task.create',
        entityType: 'task',
        entityId: taskId,
        taskId,
        detail: {
          name: task.name,
          status: task.status,
          targets: dto.targets.map((t) => t.ip.trim()),
          scope: task.scope,
          workerCount: dto.workerCount,
          tokenBudget: dto.tokenBudget,
        },
      });
      return { detail: toTaskDetail(task, rows), audit };
    });
    this.audit.publish(created.audit);
    return created.detail;
  }

  async applyAction(id: string, action: TaskAction): Promise<TaskSummary> {
    const saved = await serialTransaction(this.dataSource.manager, async (manager) => {
      const task = await manager.findOne(TaskEntity, { where: { id } });
      if (!task) throw new NotFoundException('任务不存在');
      if (await manager.count(TaskStateEventEntity, { where: { taskId: id, consumedAt: IsNull(), eventType: In(['task.start_requested', 'task.pause', 'task.resume', 'task.stop', 'task.rerun', 'task.paused', 'task.resumed', 'task.stopped', 'runtime.disabled']) } })) {
        throw new ConflictException('上一项任务操作仍在处理，请等待引擎状态更新');
      }
      const previous = task.status;
      const target = action === 'resume' && previous === 'running' && ['needs_input', 'stalled'].includes(task.engineStatus) ? 'running' : nextStatus(previous, action);
      if (target === 'running') await requireRuntime(manager);
      const previousRun = action === 'rerun' ? await manager.findOne(OrchestratorRunEntity, { where: { taskId: id }, order: { startedAt: 'DESC' } }) : null;

      task.status = target;
      task.currentPhase = PHASE_BY_STATUS[target] ?? null;
      if (action === 'rerun') {
        await this.requireQuiescent(manager, id);
        if (await manager.count(TaskStateEventEntity, { where: { taskId: id, consumedAt: IsNull() } })) throw new ConflictException('任务结果事件仍待回写，请等待处理后再重新运行');
        task.progress = 0;
        task.lastError = null;
        task.tokensUsed = 0;
        task.budgetEpoch = newId(); task.tokenBaseline = 0; task.costBaseline = 0; task.tokensCommitted = 0;
        task.costUsd = 0;
        task.startedAt = null;
        task.finishedAt = null;
        task.engineStatus = 'idle';
        task.stopReason = null;
        // 即使尚未启动，也不能用上一轮证据满足新一轮验收。
        if (task.goal) task.goal = { ...task.goal, configuredAt: new Date(Math.max(Date.now() + 1, new Date(task.goal.configuredAt).getTime() + 1)).toISOString() };
        const oldIntents = await manager.find(IntentEntity, { where: { taskId: id } });
        for (const intent of oldIntents) {
          intent.dedupeKey = `archived:${intent.id}`;
          if (['proposed', 'dispatched'].includes(intent.status)) { intent.status = 'rejected'; intent.rejectedReason = 'manual'; }
        }
        if (oldIntents.length) await manager.save(oldIntents);
        await manager.update(HintEntity, { taskId: id, status: 'pending' }, { status: 'dismissed', consumedAt: new Date() });
        await manager.update(WorkerTaskEntity, { taskId: id, status: 'queued' }, { status: 'cancelled', endedAt: new Date(), errorMessage: '任务重新运行，旧排队工作已取消' });
        await manager.update(FindingVerificationEntity, { taskId: id, outcome: 'pending' }, { outcome: 'inconclusive', summary: '任务重新运行，旧验证未完成；保留历史，可在新一轮重新安排' });
        await manager.update(FindingEntity, { taskId: id, status: 'verifying' }, { status: 'unconfirmed' });
      }
      if (action === 'resume') {
        task.startedAt = task.startedAt ?? new Date();
      }
      if (action === 'stop') {
        task.finishedAt = new Date();
      }
      const saved = await manager.save(task);

      await manager.save(manager.create(AuditLogEntity, {
        id: newId(), actor: 'local-operator', result: 'success',
        action: `task.${action}`,
        entityType: 'task',
        entityId: id,
        taskId: id,
        detail: { from: previous, to: target, label: TASK_ACTION_LABEL[action], notice: ENGINE_PHASE_NOTICE },
      }));

      // 持久化任务状态事件：Orchestrator 轮询消费，避免双向依赖
      await manager.save(
        manager.create(TaskStateEventEntity, {
          id: newId(),
          taskId: id,
          eventType: `task.${action}`,
          payload: { from: previous, to: target, ...(action === 'rerun' ? { retiredRunId: previousRun?.id ?? null } : {}) },
          consumedAt: null,
        }),
      );
      return saved;
    });

    const targets = await this.targets.find({ where: { taskId: id } });
    const summary = toTaskSummary(await hydrateTaskAccounting(this.dataSource.manager, saved), targets);
    try { this.events.broadcast('task.updated', summary); } catch { /* Delivery failure does not undo the committed action. */ }
    return summary;
  }

  /** All HTTP start controls use the same durable queue as task lifecycle actions. */
  async requestStart(id: string): Promise<TaskSummary> {
    const saved = await serialTransaction(this.dataSource.manager, async (manager) => {
      const task = await manager.findOneBy(TaskEntity, { id });
      if (!task) throw new NotFoundException('任务不存在');
      await requireRuntime(manager);
      if (TERMINAL_TASK_STATUS.includes(task.status)) throw new ConflictException('终态任务请先重新运行，不能直接启动');
      if (await manager.count(TaskStateEventEntity, { where: { taskId: id, eventType: 'runtime.disabled', consumedAt: IsNull() } })) throw new ConflictException('关闭引擎的暂停操作仍在收尾，请稍后手动启动');
      // 与 OrchestratorService.startUnlocked 的可启动条件保持一致，避免排队后才被拒绝。
      const startable = (task.status === 'pending' || task.status === 'running') && ['idle', 'needs_input', 'stalled'].includes(task.engineStatus);
      const alreadyRunning = task.status === 'running' && task.engineStatus === 'running';
      if (!startable && !alreadyRunning) throw new ConflictException('当前任务不能启动；暂停的任务请使用恢复');
      if (!alreadyRunning) {
        if (await manager.count(TaskStateEventEntity, { where: { taskId: id, consumedAt: IsNull(), eventType: In([...CONTROL_EVENT_TYPES]) } })) throw new ConflictException('上一项任务操作仍在处理，请等待引擎状态更新');
        await manager.update(TaskEntity, id, { status: 'running', currentPhase: PHASE_BY_STATUS.running, startedAt: task.startedAt ?? new Date(), finishedAt: null });
      }
      await manager.insert(TaskStateEventEntity, { id: newId(), taskId: id, eventType: 'task.start_requested', payload: null, consumedAt: null });
      await manager.insert(AuditLogEntity, { id: newId(), actor: 'local-operator', action: 'task.start_requested', entityType: 'task', entityId: id, taskId: id, detail: { from: task.status, to: 'running' } });
      return manager.findOneByOrFail(TaskEntity, { id });
    });
    const summary = toTaskSummary(await hydrateTaskAccounting(this.dataSource.manager, saved), await this.targets.find({ where: { taskId: id } }));
    try { this.events.broadcast('task.updated', summary); } catch { /* Committed controls remain accepted when a socket disconnects. */ }
    return summary;
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    await serialTransaction(this.dataSource.manager, async (manager) => {
      const task = await this.assertRemovable(manager, id);
      await manager.save(manager.create(AuditLogEntity, {
        id: newId(), actor: 'local-operator', result: 'success',
        action: 'task.delete',
        entityType: 'task',
        entityId: id,
        taskId: null,
        detail: { name: task.name },
      }));
      // 数据库删除触发器原子清理所属记录，并保存防止旧回调重建的 ID。
      await manager.delete(TaskEntity, { id });
    });
    this.events.broadcast('task.deleted', { taskId: id });
    return { deleted: true };
  }

  async assertDeletionConstraints(manager: EntityManager): Promise<void> {
    if (this.dataSource.options.type !== 'better-sqlite3') throw new ConflictException('当前数据库尚未配置任务关联清理迁移');
    const installed = new Set((await manager.query("SELECT name FROM sqlite_master WHERE type = 'trigger'") as { name: string }[]).map((row) => row.name));
    const ownedTables = this.dataSource.entityMetadatas.filter((m) => m.columns.some((c) => c.propertyName === 'taskId') && !['audit_logs', 'task_deletions'].includes(m.tableName));
    const required = ['task_delete_owned_rows', 'task_prevent_resurrection', ...ownedTables.flatMap((m) => [`task_owner_${m.tableName}_insert`, `task_owner_${m.tableName}_update`])];
    if (required.some((name) => !installed.has(name))) throw new ConflictException('任务关联清理约束尚未安装；请关闭 DB_SYNCHRONIZE 并完成显式迁移后再删除');
    if (!(await manager.query('PRAGMA foreign_keys'))[0]?.foreign_keys) throw new ConflictException('SQLite 外键约束未启用，拒绝清理');
  }

  async assertRemovable(manager: EntityManager, taskId: string): Promise<TaskEntity> {
    await this.assertDeletionConstraints(manager);
    const task = await manager.findOne(TaskEntity, { where: { id: taskId } });
    if (!task) throw new NotFoundException('任务不存在');
    if (task.status === 'running') throw new ConflictException('请先停止任务，再删除任务及关联数据');
    if (task.engineStatus === 'running') throw new ConflictException('任务执行引擎尚未收尾，请先停止并等待对账');
    await this.assertInactiveData(manager, taskId);
    return task;
  }

  /** Also applies to legacy rows whose parent task is missing. */
  async assertInactiveData(manager: EntityManager, taskId: string): Promise<void> {
    await this.requireQuiescent(manager, taskId);
    if (await manager.count(TaskStateEventEntity, { where: { taskId, consumedAt: IsNull() } })) throw new ConflictException('任务事件仍待处理，请等待引擎收尾后删除');
    for (const [child, parent, key] of [['evidence_attachments', 'evidence', 'evidenceId'], ['report_attachments', 'reports', 'reportId']]) {
      const [row] = await manager.query(`SELECT COUNT(*) AS n FROM "${child}" c JOIN "${parent}" p ON c."${key}"=p.id WHERE c.taskId IS NOT p.taskId AND (c.taskId=? OR p.taskId=?)`, [taskId, taskId]);
      if (row.n) throw new ConflictException('存在跨任务附件关联，须先核查，不能级联清理其他任务数据');
    }
  }

  private async requireQuiescent(manager: EntityManager, taskId: string): Promise<void> {
    if (await manager.count(ModelRequestEntity, { where: { taskId, state: 'reserved' } })) throw new ConflictException('仍有在途模型请求，请停止并等待本地收尾');
    if (hasTaskActivity(manager, taskId)) throw new ConflictException('本进程仍在执行任务工作，请停止并等待收尾后再操作');
    // 全自动模式不再产生新的待审批记录；此处仅拦截历史遗留数据，避免带着未知结果删除任务。
    if (await manager.count(ToolCallEntity, { where: { taskId, status: 'pending_approval' } })) throw new ConflictException('仍有结果未确认的历史调用记录，请先清理后再操作');
    if (await manager.count(AgentSessionEntity, { where: { taskId, state: In(['created', 'running', 'paused']) } }) ||
        await manager.count(WorkerTaskEntity, { where: { taskId, status: 'running' } })) {
      throw new ConflictException('仍有未结束会话或 Worker，请先停止任务并等待收尾');
    }
  }

  async recent(limit = 5): Promise<TaskSummary[]> {
    const rows = await this.tasks.find({ order: { updatedAt: 'DESC' }, take: limit });
    return this.attachTargets(rows);
  }

  /** 所有已授权目标 IP（供 Policy Proxy 白名单使用，第一阶段只读展示） */
  async authorizedIps(): Promise<string[]> {
    const rows = await this.targets.find({ where: { inScope: true } });
    return Array.from(new Set(rows.map((r) => r.ip)));
  }

  private async findTask(id: string): Promise<TaskEntity> {
    const task = await this.tasks.findOne({ where: { id } });
    if (!task) throw new NotFoundException('任务不存在');
    return hydrateTaskAccounting(this.dataSource.manager, task);
  }

  private async attachTargets(rows: TaskEntity[]): Promise<TaskSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const targets = await this.targets.find({ where: { taskId: In(ids) } });
    const grouped = new Map<string, TargetEntity[]>();
    for (const t of targets) {
      const list = grouped.get(t.taskId) ?? [];
      list.push(t);
      grouped.set(t.taskId, list);
    }
    return Promise.all(rows.map(async (r) => toTaskSummary(await hydrateTaskAccounting(this.dataSource.manager, r), grouped.get(r.id) ?? [])));
  }

  private async statusStats(): Promise<Record<string, number>> {
    const rows = await this.tasks
      .createQueryBuilder('t')
      .select('t.status', 'status')
      .addSelect('COUNT(1)', 'count')
      .groupBy('t.status')
      .getRawMany<{ status: string; count: string | number }>();
    const stats: Record<string, number> = {};
    for (const row of rows) stats[row.status] = Number(row.count);
    return stats;
  }

  private validateScope(dto: CreateTaskDto): void {
    for (const target of dto.targets) {
      const ip = target.ip.trim();
      if (isValidTarget(ip)) continue;
      // 只校验格式，不硬编码任何具体目标；实际解析与可达性交给执行引擎在运行期确认。
      if (isMissingUrlScheme(ip)) throw new BadRequestException(`目标「${ip}」缺少协议：请补全为 http://${ip} 或 https://${ip}`);
      throw new BadRequestException(`目标「${ip}」格式不合法：应为完整 http(s) URL、域名、IPv4 或 CIDR（例如 https://host:port/path、example.com、192.168.56.0/24）`);
    }
    for (const cidr of dto.scope?.cidrs ?? []) {
      if (cidr.trim() && !isValidCidr(cidr.trim())) {
        throw new BadRequestException(`授权范围「${cidr}」不是合法的 CIDR（例如 192.168.56.0/24）`);
      }
    }
    if (dto.scope?.ports && !isValidPortSpec(dto.scope.ports)) {
      throw new BadRequestException('端口范围格式不合法，示例：1-1000 或 80,443,8000-8080');
    }
    if (dto.authorized !== true) {
      throw new BadRequestException('必须确认已获得目标系统的测试授权');
    }
  }
}
