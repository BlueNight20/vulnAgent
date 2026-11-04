import type {
  ModelTestResult,
  SystemSettingsDto,
  UpdateSystemSettingsInput,
} from '@vulnagent/shared';
import { api } from './client';

export interface SettingsResponse extends SystemSettingsDto {
  encryptionKeyEphemeral: boolean;
}

export interface ModelCatalogItem {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  costPerMTokens: { input: number; output: number };
  reasoning: boolean;
}

export const settingsApi = {
  get: () => api.get<SettingsResponse>('/settings'),
  update: (input: UpdateSystemSettingsInput) => api.put<SystemSettingsDto>('/settings', input),
  testModel: () => api.post<ModelTestResult>('/settings/model/test'),
  models: () => api.get<{ items: ModelCatalogItem[] }>('/settings/models'),
};
