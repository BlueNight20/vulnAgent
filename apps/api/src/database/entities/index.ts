import { AgentSessionEntity } from './agent-session.entity';
import { AgentSessionEventEntity } from './agent-session-event.entity';
import { AgentSessionMessageEntity } from './agent-session-message.entity';
import { AgentToolPermissionEntity } from './agent-tool-permission.entity';
import { AuditLogEntity } from './audit-log.entity';
import { EvidenceEntity } from './evidence.entity';
import { EvidenceAttachmentEntity } from './evidence-attachment.entity';
import { ReportAttachmentEntity } from './report-attachment.entity';
import { FactEntity } from './fact.entity';
import { FindingEntity } from './finding.entity';
import { FindingAssessmentEntity } from './finding-assessment.entity';
import { FindingVerificationEntity } from './finding-verification.entity';
import { HintEntity } from './hint.entity';
import { HypothesisEntity } from './hypothesis.entity';
import { HypothesisLinkEntity } from './hypothesis-link.entity';
import { IntentEntity } from './intent.entity';
import { InterceptRuleEntity } from './intercept-rule.entity';
import { McpServerEntity } from './mcp-server.entity';
import { McpToolEntity } from './mcp-tool.entity';
import { ModelUsageEntity } from './model-usage.entity';
import { OrchestratorRunEntity } from './orchestrator-run.entity';
import { ReportEntity } from './report.entity';
import { SystemSettingEntity } from './system-setting.entity';
import { TargetEntity } from './target.entity';
import { TaskEntity } from './task.entity';
import { TaskDeletionEntity } from './task-deletion.entity';
import { ModelRequestEntity } from './model-request.entity';
import { TaskStateEventEntity } from './task-state-event.entity';
import { ToolCallEntity } from './tool-call.entity';
import { WorkerProfileLoadEntity } from './worker-profile-usage.entity';
import { WorkerResultCardEntity } from './worker-result-card.entity';
import { WorkerTaskEntity } from './worker-task.entity';

export const ENTITIES = [
  FindingAssessmentEntity,
  ModelRequestEntity,
  TaskDeletionEntity,
  EvidenceAttachmentEntity,
  ReportAttachmentEntity,
  TaskEntity,
  TargetEntity,
  AgentSessionEntity,
  AgentSessionMessageEntity,
  AgentSessionEventEntity,
  WorkerTaskEntity,
  FactEntity,
  IntentEntity,
  HintEntity,
  HypothesisEntity,
  HypothesisLinkEntity,
  WorkerResultCardEntity,
  WorkerProfileLoadEntity,
  ToolCallEntity,
  EvidenceEntity,
  FindingEntity,
  FindingVerificationEntity,
  ReportEntity,
  ModelUsageEntity,
  AuditLogEntity,
  McpServerEntity,
  McpToolEntity,
  AgentToolPermissionEntity,
  InterceptRuleEntity,
  SystemSettingEntity,
  OrchestratorRunEntity,
  TaskStateEventEntity,
];

export {
  FindingAssessmentEntity,
  ModelRequestEntity,
  TaskDeletionEntity,
  EvidenceAttachmentEntity,
  ReportAttachmentEntity,
  FindingVerificationEntity,
  TaskEntity,
  TargetEntity,
  AgentSessionEntity,
  AgentSessionMessageEntity,
  AgentSessionEventEntity,
  WorkerTaskEntity,
  FactEntity,
  IntentEntity,
  HintEntity,
  HypothesisEntity,
  HypothesisLinkEntity,
  WorkerResultCardEntity,
  WorkerProfileLoadEntity,
  ToolCallEntity,
  EvidenceEntity,
  FindingEntity,
  ReportEntity,
  ModelUsageEntity,
  AuditLogEntity,
  McpServerEntity,
  McpToolEntity,
  AgentToolPermissionEntity,
  InterceptRuleEntity,
  SystemSettingEntity,
  OrchestratorRunEntity,
  TaskStateEventEntity,
};
