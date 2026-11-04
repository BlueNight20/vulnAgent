import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ModelSettingsInput {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  provider?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true }, { message: 'baseUrl 必须是合法 URL' })
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  modelName?: string;

  /** 传空字符串表示清除；传掩码（含 ****）表示不修改 */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  apiKey?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(200000)
  maxTokens?: number;
}

export class RuntimeSettingsInput {
  @IsOptional()
  @IsBoolean()
  piRuntimeEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  workerMaxConcurrency?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(16)
  modelMaxConcurrency?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(10000000)
  defaultTokenBudget?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  defaultTimeBudgetMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  defaultWorkerCount?: number;

  @IsOptional()
  @IsIn(['debug', 'info', 'warn', 'error'])
  logLevel?: string;

  @IsOptional()
  @IsBoolean()
  logToFile?: boolean;
}

export class UpdateSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ModelSettingsInput)
  model?: ModelSettingsInput;

  @IsOptional()
  @ValidateNested()
  @Type(() => RuntimeSettingsInput)
  runtime?: RuntimeSettingsInput;
}
