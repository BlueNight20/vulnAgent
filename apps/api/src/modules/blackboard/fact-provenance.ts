import { BadRequestException } from '@nestjs/common';
import {
  INFERRED_MAX_CONFIDENCE,
  type FactCategory,
  type FactStatus,
} from '@vulnagent/shared';

export interface FactDraft {
  status: FactStatus;
  createdBy: 'tool' | 'agent' | 'user';
  sourceEvidenceIds: string[];
  confidence: number;
  category: FactCategory;
  subject: string;
  predicate: string;
  object: string;
}

/**
 * 事实溯源规则（纯函数，service 层强制调用）。
 *
 * 核心约束：
 * - 模型推断只能落为 inferred，且置信度不得高于 0.5
 * - observed / verified 必须至少有一条证据
 * - 事实的状态迁移不允许跳过证据校验
 */
export const FACT_TRANSITIONS: Record<FactStatus, FactStatus[]> = {
  inferred: ['observed', 'refuted'],
  observed: ['verified', 'refuted'],
  verified: ['refuted'],
  refuted: [],
};

export function validateFactDraft(draft: FactDraft): void {
  if (!draft.subject.trim()) throw new BadRequestException('事实缺少 subject');
  if (!draft.predicate.trim()) throw new BadRequestException('事实缺少 predicate');
  if (!draft.object.trim()) throw new BadRequestException('事实缺少 object');

  if (draft.status === 'inferred') {
    if (draft.createdBy === 'tool') {
      throw new BadRequestException('工具证据产出的事实不能标记为 inferred');
    }
    if (draft.confidence > INFERRED_MAX_CONFIDENCE) {
      throw new BadRequestException(
        `模型推断事实的置信度不得超过 ${INFERRED_MAX_CONFIDENCE}`,
      );
    }
    return;
  }

  if (draft.status === 'observed' || draft.status === 'verified') {
    if (draft.sourceEvidenceIds.length === 0) {
      throw new BadRequestException(
        `事实状态 ${draft.status} 必须至少关联一条证据，模型推断请使用 inferred`,
      );
    }
    if (draft.createdBy === 'agent') {
      throw new BadRequestException(
        'Agent 直接产出的结论不能标记为 observed/verified，必须由工具证据支撑',
      );
    }
  }

  if (draft.status === 'refuted' && draft.sourceEvidenceIds.length === 0) {
    throw new BadRequestException('标记为 refuted 必须提供推翻依据（证据）');
  }
}

export function canTransition(from: FactStatus, to: FactStatus): boolean {
  if (from === to) return true;
  return FACT_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: FactStatus,
  to: FactStatus,
  evidenceIds: string[],
): void {
  if (!canTransition(from, to)) {
    throw new BadRequestException(`事实状态不允许从 ${from} 变更为 ${to}`);
  }
  if ((to === 'observed' || to === 'verified') && evidenceIds.length === 0) {
    throw new BadRequestException(`变更为 ${to} 必须提供证据`);
  }
}

/** 事实是否可作为漏洞结论的支撑 */
export function isEvidenceBacked(status: FactStatus): boolean {
  return status === 'observed' || status === 'verified';
}
