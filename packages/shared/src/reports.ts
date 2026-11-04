import type { FindingDto, FindingVerificationDto, TaskAcceptance, TaskDetail, AttackSurfaceDto } from './types';
import type { FindingStatus } from './enums';
import type { EvidenceAttachmentDto } from './attachments';
import type { HypothesisDto, HypothesisLinkDto } from './phase2-types';

export interface ReportEvidence {
  id: string; title: string; kind: string; toolCallId: string | null; sessionId: string | null;
  targetIp: string | null; tool: string | null; createdAt: string;
  sha256: string | null; computedSha256: string | null; sizeBytes: number | null; computedSizeBytes: number | null;
  integrity: 'match' | 'mismatch' | 'missing'; provenanceValid: boolean; content: string | null;
  references?: { uri: string; name: string }[];
}
export interface ReportFinding {
  finding: FindingDto & { source: 'tool' | 'agent' | 'manual'; cvss: number | null }; effectiveStatus: FindingStatus; validationNote: string | null;
  verifications: FindingVerificationDto[];
}
export interface ReportSnapshot {
  version: 1; capturedAt: string; task: TaskDetail; engineStatus: string; stopReason: string | null;
  acceptance: TaskAcceptance; surface: AttackSurfaceDto; findings: ReportFinding[];
  evidence: ReportEvidence[];
  attachments?: EvidenceAttachmentDto[];
  hypotheses?: { hypothesis: HypothesisDto; links: HypothesisLinkDto[] }[];
  analysis: { id: string; workerId: string; sessionId: string | null; profileId: string | null; workerCreatedAt: string | null; workerStatus: string; summary: string; synthetic: boolean; evidenceIds: string[] }[];
  timeline: { id: string; at: string; kind: 'tool' | 'worker' | 'event'; label: string; status: string; detail: string | null; evidenceIds: string[] }[];
  warnings: string[];
}
export interface ReportStats {
  kind: 'final' | 'progress'; findingCounts: Record<FindingStatus, number>; evidenceCount: number;
  invalidEvidenceCount: number; unmetChecks: number; contentSha256: string; snapshotSha256: string;
  attachmentCount?: number; attachmentBytes?: number; invalidAttachmentCount?: number;
}
export interface ReportSummaryDto {
  id: string; taskId: string; title: string; status: string; generatedAt: string | null; createdAt: string;
  stats: ReportStats | null;
}
export interface ReportDetailDto extends ReportSummaryDto {
  content: string; integrity: 'match' | 'mismatch' | 'missing';
  evidence: Omit<ReportEvidence, 'content'>[];
  attachments?: EvidenceAttachmentDto[];
}
