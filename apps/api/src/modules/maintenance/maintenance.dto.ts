import { IsBoolean, IsIn, IsInt, IsISO8601, Matches, Max, Min } from 'class-validator';
import type { DataMaintenanceApply, DataRetentionPolicy } from '@vulnagent/shared';
export class RetentionPolicyDto implements DataRetentionPolicy {
  @IsISO8601({ strict: true }) @Matches(/Z$/) before: string;
  @IsInt() @Min(0) @Max(1000) keepLatest: number;
  @IsBoolean() includeOrphans: boolean;
  @IsInt() @Min(1) @Max(100000) page: number;
}
export class ApplyMaintenanceDto extends RetentionPolicyDto implements DataMaintenanceApply {
  @IsISO8601({ strict: true }) @Matches(/Z$/) expiresAt: string;
  @Matches(/^[a-f0-9]{64}$/) digest: string;
  @IsIn(['清理这些数据']) confirmation: '清理这些数据';
}
