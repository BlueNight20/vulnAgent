/**
 * 已知模型的上下文窗口与价格（USD / 1M tokens）。
 * 未收录的模型使用保守默认值，成本按默认单价估算并在 UI 标注为「估算」。
 */

export interface ModelMeta {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  costPerMTokens: { input: number; output: number };
  reasoning: boolean;
}

const DEFAULT_META: Omit<ModelMeta, 'id' | 'name'> = {
  contextWindow: 128_000,
  maxTokens: 8_192,
  costPerMTokens: { input: 0.5, output: 1.5 },
  reasoning: false,
};

const KNOWN: Record<string, Partial<ModelMeta>> = {
  'deepseek-chat': { contextWindow: 64_000, maxTokens: 8_192, costPerMTokens: { input: 0.27, output: 1.1 } },
  'deepseek-reasoner': {
    contextWindow: 64_000,
    maxTokens: 8_192,
    costPerMTokens: { input: 0.55, output: 2.19 },
    reasoning: true,
  },
  'gpt-4o': { contextWindow: 128_000, maxTokens: 16_384, costPerMTokens: { input: 2.5, output: 10 } },
  'gpt-4o-mini': { contextWindow: 128_000, maxTokens: 16_384, costPerMTokens: { input: 0.15, output: 0.6 } },
  'gpt-4.1': { contextWindow: 1_000_000, maxTokens: 32_768, costPerMTokens: { input: 2, output: 8 } },
  'qwen-plus': { contextWindow: 128_000, maxTokens: 8_192, costPerMTokens: { input: 0.4, output: 1.2 } },
  'qwen-max': { contextWindow: 32_000, maxTokens: 8_192, costPerMTokens: { input: 1.6, output: 6.4 } },
};

export function resolveModelMeta(modelId: string): ModelMeta {
  const known = KNOWN[modelId] ?? {};
  return {
    id: modelId,
    name: modelId,
    contextWindow: known.contextWindow ?? DEFAULT_META.contextWindow,
    maxTokens: known.maxTokens ?? DEFAULT_META.maxTokens,
    costPerMTokens: known.costPerMTokens ?? DEFAULT_META.costPerMTokens,
    reasoning: known.reasoning ?? DEFAULT_META.reasoning,
  };
}

/** 供设置页展示的候选模型清单（用户可以输入自定义模型名） */
export function listKnownModels(): ModelMeta[] {
  return Object.keys(KNOWN).map((id) => resolveModelMeta(id));
}
