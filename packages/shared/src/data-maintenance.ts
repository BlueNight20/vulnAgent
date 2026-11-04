export interface DataRetentionPolicy {
  before: string;
  keepLatest: number;
  includeOrphans: boolean;
  page: number;
}
export interface MaintenanceCandidate {
  taskId: string;
  name: string | null;
  finishedAt: string | null;
  rows: Record<string, number>;
  blockedReason: string | null;
}
export interface DataMaintenancePlan {
  policy: DataRetentionPolicy;
  expiresAt: string;
  digest: string;
  backupAvailable: boolean;
  tasks: MaintenanceCandidate[];
  orphans: MaintenanceCandidate[];
  taskCandidates: number;
  orphanCandidates: number;
  pageSize: number;
  warnings: string[];
}
export interface DataMaintenanceApply extends DataRetentionPolicy {
  expiresAt: string;
  digest: string;
  confirmation: '清理这些数据';
}
export interface DataMaintenanceResult {
  deletedTasks: string[];
  cleanedOrphanTasks: string[];
  backup: { path: string; sha256: string; bytes: number };
  auditId: string;
}
