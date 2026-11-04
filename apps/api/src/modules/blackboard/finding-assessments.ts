import type { EntityManager } from 'typeorm';
import type { FindingAssessmentDto, FindingDto, FindingMetadata } from '@vulnagent/shared';
import { FindingAssessmentEntity, FindingEntity } from '../../database/entities';

export function metadataFields(row: FindingMetadata): FindingMetadata {
  return { title: row.title, description: row.description, severity: row.severity, cve: row.cve, cwe: row.cwe, cvss: row.cvss, remediation: row.remediation };
}

/**
 * 漏洞展示 DTO。
 *
 * 全自动模式已取消人工维护评级/CVE/CWE 的入口；这里仅保留对历史维护版本的
 * 只读回放：旧数据仍按原有校验逻辑展示，失效时回退为未评级，不被静默采信。
 */
export async function assessedFindingDto(manager: EntityManager, finding: FindingEntity): Promise<FindingDto & { source: FindingEntity['source']; cvss: number | null }> {
  const row = finding.metadataRevision
    ? await manager.findOne(FindingAssessmentEntity, { where: { taskId: finding.taskId, findingId: finding.id, revision: finding.metadataRevision } })
    : null;
  let assessment: FindingAssessmentDto | null = null;
  if (row) {
    assessment = { ...row, metadata: metadataFields(row.metadata), previousMetadata: row.metadata.before, createdAt: row.createdAt.toISOString(), valid: true, issues: [] };
  } else if (finding.metadataRevision) {
    assessment = { id: '', taskId: finding.taskId, findingId: finding.id, revision: finding.metadataRevision, metadata: metadataFields(finding), note: '', evidenceQuotes: [], createdAt: finding.updatedAt.toISOString(), valid: false, issues: ['维护版本记录缺失'] };
  }
  if (assessment && JSON.stringify(metadataFields(finding)) !== JSON.stringify(assessment.metadata)) {
    assessment.valid = false;
    assessment.issues.push('当前字段与维护版本不一致');
  }
  return {
    ...finding,
    source: assessment ? 'manual' : finding.source,
    ...(assessment && !assessment.valid ? { severity: 'info' as const, cve: null, cwe: null, cvss: null, remediation: null } : {}),
    assessment,
    createdAt: finding.createdAt.toISOString(),
    updatedAt: finding.updatedAt.toISOString(),
  };
}
