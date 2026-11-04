import { Controller, DefaultValuePipe, Get, NotFoundException, Param, ParseBoolPipe, ParseIntPipe, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ModelRequestEntity, TaskEntity } from '../../database/entities';
import { hydrateTaskAccounting } from '../../database/model-accounting';
import { normalizePagination } from '../../common/utils/pagination';

@Controller('tasks/:taskId/model-budget')
export class ModelBudgetController {
  constructor(@InjectRepository(ModelRequestEntity) private readonly requests: Repository<ModelRequestEntity>) {}
  @Get()
  // unknown 保留原始查询值，避免全局转换先把 bad 变成 NaN/false、再被默认值吞掉。
  async detail(@Param('taskId') taskId: string, @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: unknown, @Query('history', new DefaultValuePipe(false), ParseBoolPipe) history: unknown) {
    const task = await this.requests.manager.findOne(TaskEntity, { where: { id: taskId } });
    if (!task) throw new NotFoundException('任务不存在');
    await hydrateTaskAccounting(this.requests.manager, task);
    const { skip, take } = normalizePagination(Number(page), 25);
    const qb = this.requests.createQueryBuilder('r').where('r.taskId = :taskId', { taskId });
    if (!history) qb.andWhere('r.budgetEpoch = :epoch', { epoch: task.budgetEpoch ?? task.id });
    const [rows, total] = await qb.orderBy('r.createdAt', 'DESC').addOrderBy('r.id', 'DESC').skip(skip).take(take).getManyAndCount();
    const usable = Math.floor(task.tokenBudget * 0.9);
    return { tokenBudget: task.tokenBudget, usableTokens: usable, knownTokens: task.tokensUsed, committedTokens: task.tokensCommitted ?? 0, remainingTokens: Math.max(0, usable - task.tokensUsed - (task.tokensCommitted ?? 0)), total,
      note: '输入为预估，用量包含缓存 Token；在途/未确认额度并非已确认花费，仍占用可用额度。供应商忽略上限或输入估算误差可造成在途请求超额，后续自动调用会停止。',
      items: rows.map((r) => ({ id: r.id, sessionId: r.sessionId, currentRun: r.budgetEpoch === task.budgetEpoch, state: r.state, modelName: r.modelName, inputEstimate: r.inputEstimate, maxOutputTokens: r.maxOutputTokens, reservedTokens: r.reservedTokens, committedTokens: r.state === 'reserved' ? r.reservedTokens : r.state === 'uncertain' ? Math.max(0, r.reservedTokens - (r.inputTokens ?? 0) - (r.outputTokens ?? 0)) : 0, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, errorMessage: r.errorMessage, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null })),
    };
  }
}
