import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { DataSource, In, type EntityManager } from 'typeorm';
import type { DataMaintenanceApply, DataMaintenancePlan, DataMaintenanceResult, DataRetentionPolicy, MaintenanceCandidate } from '@vulnagent/shared';
import { AuditLogEntity, TaskEntity } from '../../database/entities';
import { serialTransaction } from '../../database/serial-transaction';
import { createSqliteBackup } from '../../database/sqlite-backup';
import { TASK_OWNED_TABLES_V3 } from '../../database/migrations/1793577608000-FindingAssessments';
import { TasksService } from '../tasks/tasks.service';
import { AuditService } from '../audit/audit.service';
import { EventsGateway } from '../events/events.gateway';

const SIZE = 100;
const TTL = 10 * 60_000;
const TERMINAL: TaskEntity['status'][] = ['stopped', 'completed', 'failed'];
const OWNED = [...TASK_OWNED_TABLES_V3];
const ORPHAN_IDS = [...OWNED, 'audit_logs'].map((table) => `SELECT taskId FROM "${table}" r WHERE taskId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=r.taskId)`).join(' UNION ');

@Injectable()
export class MaintenanceService {
  private readonly secret = randomUUID();
  private readonly logger = new Logger(MaintenanceService.name);
  constructor(private readonly db: DataSource, private readonly tasks: TasksService, private readonly audit: AuditService, private readonly events: EventsGateway, private readonly config: ConfigService) {}

  async preview(policy: DataRetentionPolicy): Promise<DataMaintenancePlan> {
    return serialTransaction(this.db.manager, (manager) => this.plan(manager, policy, new Date(Date.now() + TTL).toISOString()));
  }

  async apply(input: DataMaintenanceApply): Promise<DataMaintenanceResult> {
    if (input.confirmation !== '清理这些数据') throw new BadRequestException('须输入清理确认文字');
    const expiry = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiry) || expiry < Date.now() || expiry > Date.now() + TTL + 1000) throw new ConflictException('清理预览已过期，请重新预览');
    const recovery: { path?: string } = {};
    const result = await serialTransaction(this.db.manager, async (manager) => {
      if (!this.backupAvailable()) throw new ConflictException('仅支持已迁移的 SQLite 文件库；内存库不能执行清理');
      // Acquire SQLite's reserved writer lock before recertification and the online backup.
      // No source rows change here. Other connections cannot commit new data during the snapshot/delete window.
      await manager.query('UPDATE tasks SET id=id WHERE 0');
      const plan = await this.plan(manager, input, input.expiresAt);
      if (!/^[a-f0-9]{64}$/.test(input.digest) || !timingSafeEqual(Buffer.from(plan.digest, 'hex'), Buffer.from(input.digest, 'hex'))) throw new ConflictException('数据库或清理条件已变化，请重新预览');
      const selected = plan.tasks.filter((row) => !row.blockedReason); const orphans = plan.orphans.filter((row) => !row.blockedReason);
      if (!selected.length && !orphans.length) throw new BadRequestException('当前页没有可清理数据');
      const file = String(this.db.options.database);
      const directory = this.config.get<string>('maintenance.backupDirectory')?.trim() || join(dirname(file), 'maintenance-backups');
      const backup = await createSqliteBackup(file, resolve(directory));
      recovery.path = backup.path;
      // An in-memory tool operation can start while backup I/O yields, even without a database mutation.
      for (const row of selected) await this.tasks.assertRemovable(manager, row.taskId);
      for (const row of orphans) await this.tasks.assertInactiveData(manager, row.taskId);
      const savedAudit = await this.audit.recordInTransaction(manager, { actor: 'local-operator', action: 'maintenance.applied', entityType: 'database',
        detail: { policy: plan.policy, tasks: selected, orphans, backup: { path: backup.path, sha256: backup.manifest.sha256, bytes: backup.manifest.bytes } } });
      for (const row of selected) {
        await manager.save(manager.create(AuditLogEntity, { id: randomUUID(), actor: 'local-operator', action: 'task.delete', entityType: 'task', entityId: row.taskId, taskId: null, detail: { name: row.name, reason: 'retention', maintenanceAuditId: savedAudit.id } }));
        await manager.delete(TaskEntity, { id: row.taskId });
      }
      for (const row of orphans) {
        await manager.query('INSERT OR IGNORE INTO task_deletions (taskId) VALUES (?)', [row.taskId]);
        for (const table of OWNED) await manager.query(`DELETE FROM "${table}" WHERE taskId=?`, [row.taskId]);
        await manager.query('UPDATE audit_logs SET taskId=NULL WHERE taskId=?', [row.taskId]);
      }
      return { result: { deletedTasks: selected.map((row) => row.taskId), cleanedOrphanTasks: orphans.map((row) => row.taskId), backup: { path: backup.path, sha256: backup.manifest.sha256, bytes: backup.manifest.bytes }, auditId: savedAudit.id }, audit: savedAudit };
    }).catch((error) => {
      if (recovery.path) this.logger.warn(`清理事务未提交；安全备份保留于 ${recovery.path}`);
      throw error;
    });
    this.audit.publish(result.audit);
    for (const taskId of result.result.deletedTasks) {
      try { this.events.broadcast('task.deleted', { taskId }); } catch { this.logger.warn('任务清理通知失败；数据库结果已提交，可重新读取'); }
    }
    return result.result;
  }

  private backupAvailable(): boolean { return this.db.options.type === 'better-sqlite3' && this.db.options.database !== ':memory:'; }

  private async plan(manager: EntityManager, input: DataRetentionPolicy, expiresAt: string): Promise<DataMaintenancePlan> {
    const before = Date.parse(input.before);
    if (!Number.isFinite(before) || before > Date.now() || !Number.isInteger(input.keepLatest) || input.keepLatest < 0 || input.keepLatest > 1000 || !Number.isInteger(input.page) || input.page < 1 || input.page > 100000 || typeof input.includeOrphans !== 'boolean') throw new BadRequestException('保留策略无效：截止时间不得在未来，保留数量和页码须为允许范围内的整数');
    await this.tasks.assertDeletionConstraints(manager);
    const policy: DataRetentionPolicy = { before: new Date(before).toISOString(), keepLatest: input.keepLatest, includeOrphans: input.includeOrphans, page: input.page };
    const keep = input.keepLatest ? await manager.getRepository(TaskEntity).createQueryBuilder('task').select(['task.id']).where({ status: In(TERMINAL) })
      .andWhere('julianday(task.finishedAt) IS NOT NULL').orderBy('julianday(task.finishedAt)', 'DESC').addOrderBy('task.createdAt', 'DESC').addOrderBy('task.id', 'DESC').take(input.keepLatest).getMany() : [];
    const query = manager.getRepository(TaskEntity).createQueryBuilder('task').where({ status: In(TERMINAL) }).andWhere('julianday(task.finishedAt) < julianday(:before)', { before: policy.before });
    if (keep.length) query.andWhere('task.id NOT IN (:...keep)', { keep: keep.map((row) => row.id) });
    const [rows, taskCandidates] = await query.orderBy('julianday(task.finishedAt)', 'ASC').addOrderBy('task.id', 'ASC').skip((input.page - 1) * SIZE).take(SIZE).getManyAndCount();
    const tasks: MaintenanceCandidate[] = [];
    for (const task of rows) tasks.push({ taskId: task.id, name: task.name, finishedAt: task.finishedAt?.toISOString() ?? null, rows: await this.rowCounts(manager, task.id), blockedReason: await this.blocked(manager, task.id, false) });
    const orphans: MaintenanceCandidate[] = []; let orphanCandidates = 0;
    if (input.includeOrphans) {
      orphanCandidates = Number((await manager.query(`SELECT COUNT(*) AS n FROM (${ORPHAN_IDS})`))[0].n);
      const ids: { taskId: string }[] = await manager.query(`SELECT taskId FROM (${ORPHAN_IDS}) ORDER BY taskId LIMIT ? OFFSET ?`, [SIZE, (input.page - 1) * SIZE]);
      for (const { taskId } of ids) orphans.push({ taskId, name: null, finishedAt: null, rows: await this.rowCounts(manager, taskId), blockedReason: await this.blocked(manager, taskId, true) });
    }
    const counters = { changes: (await manager.query('SELECT total_changes() AS n'))[0].n, version: (await manager.query('PRAGMA data_version'))[0].data_version, schema: (await manager.query('PRAGMA schema_version'))[0].schema_version };
    const digest = createHmac('sha256', this.secret).update(JSON.stringify({ policy, expiresAt, tasks, orphans, taskCandidates, orphanCandidates, counters })).digest('hex');
    return { policy, expiresAt, digest, backupAvailable: this.backupAvailable(), tasks, orphans, taskCandidates, orphanCandidates, pageSize: SIZE,
      warnings: ['清理会删除整项任务及其证据、附件和报告，保留审计与防重建 ID；不会删除 taskId=null 的全局数据。', '孤立记录仅指父任务不存在的记录；悬空 JSON 引用和其他父子问题不自动修复。有在途工作、未核实审批、未结束会话或跨任务附件的记录保持阻塞。', '预览有效期十分钟；任何数据库写入或服务重启均可能使预览失效。执行前备份包含密文和完整业务数据，主密钥须另行保管。', '仅管理当前 API 进程的数据源；不要让其他 API 实例共用同一 SQLite 文件执行任务。', '保留策略为本次手工操作，不安装定时任务；SQLite 空闲页和旧备份不做安全擦除。'] };
  }
  private async rowCounts(manager: EntityManager, taskId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of [...OWNED, 'audit_logs']) counts[table] = Number((await manager.query(`SELECT COUNT(*) AS n FROM "${table}" WHERE taskId=?`, [taskId]))[0].n);
    return counts;
  }
  private async blocked(manager: EntityManager, taskId: string, orphan: boolean): Promise<string | null> {
    try { if (orphan) await this.tasks.assertInactiveData(manager, taskId); else await this.tasks.assertRemovable(manager, taskId); return null; }
    catch (error) { if (error instanceof ConflictException) return error.message; throw error; }
  }
}
