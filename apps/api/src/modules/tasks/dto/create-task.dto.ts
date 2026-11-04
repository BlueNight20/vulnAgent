import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { TASK_WORKER_COUNT_MAX, TASK_WORKER_COUNT_MIN, TaskStatus } from '@vulnagent/shared';

export class CreateTargetDto {
  @IsString()
  @IsNotEmpty({ message: '目标不能为空' })
  @MaxLength(200)
  ip: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;
}

export class TaskScopeDto {
  /** 允许传入数组或逗号/空格分隔的字符串，统一规范为数组 */
  @Transform(({ value }) => {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
    return String(value)
      .split(/[\s,;]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  })
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  cidrs: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  ports?: string | null;
}

export class TaskGoalDto {
  @IsIn(['recon', 'assessment', 'evidence']) mode: 'recon' | 'assessment' | 'evidence';
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(64) @IsString({ each: true }) targets: string[];
  @IsOptional() @IsString() @MaxLength(200) ports: string | null;
  @IsIn(['tcp', 'udp']) protocol: 'tcp' | 'udp';
  @IsOptional() @IsString() @MaxLength(2000) evidenceText: string | null;
}

export class CreateTaskDto {
  @IsOptional() @ValidateNested() @Type(() => TaskGoalDto) goal?: TaskGoalDto;
  @IsString()
  @MinLength(2, { message: '任务名称至少 2 个字符' })
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsArray()
  @ArrayMinSize(1, { message: '至少需要一个授权目标' })
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => CreateTargetDto)
  targets: CreateTargetDto[];

  @IsDefined()
  @ValidateNested()
  @Type(() => TaskScopeDto)
  scope: TaskScopeDto;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  authorizationRef?: string | null;

  @IsBoolean()
  @IsIn([true], { message: '必须确认已获得目标授权' })
  authorized: boolean;

  @IsString()
  @MaxLength(40)
  modelProvider: string;

  @IsString()
  @MaxLength(80)
  modelName: string;

  @IsInt()
  @Min(1000, { message: 'Token 预算不得少于 1000' })
  @Max(10_000_000)
  tokenBudget: number;

  @IsInt()
  @Min(1)
  @Max(1440)
  timeBudgetMinutes: number;

  @IsInt()
  @Min(TASK_WORKER_COUNT_MIN)
  @Max(TASK_WORKER_COUNT_MAX)
  workerCount: number;

  /** 创建后通过持久化事件请求启动引擎。 */
  @IsOptional()
  @IsBoolean()
  autoStart?: boolean;
}

export class QueryTaskDto {
  @IsOptional()
  @IsIn(Object.values(TaskStatus))
  status?: TaskStatus;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  keyword?: string;

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
