import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsObject, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { AgentRole } from '@vulnagent/shared';

export class QueryToolsDto {
  @IsOptional()
  @IsString()
  keyword?: string;
}

export class QueryCallsDto {
  @IsOptional()
  @IsString()
  taskId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export class UpdatePermissionDto {
  @IsString()
  @IsIn(['bootstrap', 'explore', 'analysis', 'verifier', 'reporter', 'planner', 'orchestrator'])
  agentRole: AgentRole;

  @IsString()
  @MaxLength(140)
  toolPattern: string;

  @IsBoolean()
  allowed: boolean;

  @IsOptional()
  @IsBoolean()
  requireApproval?: boolean;

  @IsOptional()
  @IsString()
  taskId?: string | null;
}

export class CreateMcpServerDto {
  @IsString() @MaxLength(80)
  name: string;
  @IsString() @MaxLength(300)
  endpoint: string;
  @IsOptional() @IsString() @MaxLength(1000)
  command?: string;
  @IsOptional() @IsArray() @IsString({ each: true })
  args?: string[];
  @IsOptional() @IsObject()
  env?: Record<string, string>;
  @IsIn(['streamable-http', 'sse', 'stdio'])
  transport: 'streamable-http' | 'sse' | 'stdio';
  @IsOptional() @IsString() @MaxLength(8192)
  token?: string;
  @IsOptional() @IsObject()
  headers?: Record<string, string>;
}

export class SetMcpEnabledDto {
  @IsBoolean()
  enabled: boolean;
}

export class UpdateMcpServerDto extends CreateMcpServerDto {
  @IsOptional() @IsBoolean()
  preserveCredentials?: boolean;
}
