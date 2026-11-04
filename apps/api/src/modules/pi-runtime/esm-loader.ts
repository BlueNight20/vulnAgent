/**
 * Pi SDK 是纯 ESM 包，本项目后端编译为 CommonJS。
 * TypeScript 默认会把 `import()` 降级为 `require()`，导致 ERR_PACKAGE_PATH_NOT_EXPORTED。
 * 这里用 Function 构造器保留原生动态 import 语义（不会被 TS 转换）。
 */
type DynamicImporter = (specifier: string) => Promise<unknown>;

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const nativeImport = new Function('specifier', 'return import(specifier);') as DynamicImporter;

const cache = new Map<string, Promise<unknown>>();

export function loadEsm<T>(specifier: string): Promise<T> {
  const cached = cache.get(specifier);
  if (cached) return cached as Promise<T>;
  const promise = nativeImport(specifier).catch((error: unknown) => {
    cache.delete(specifier);
    throw error;
  });
  cache.set(specifier, promise);
  return promise as Promise<T>;
}

export interface PiAiModule {
  createModels: (options?: unknown) => unknown;
  createProvider: (options: unknown) => unknown;
  Type: {
    Object: (props: Record<string, unknown>) => unknown;
    String: (opts?: Record<string, unknown>) => unknown;
    Number: (opts?: Record<string, unknown>) => unknown;
    Boolean: (opts?: Record<string, unknown>) => unknown;
    Array: (item: unknown, opts?: Record<string, unknown>) => unknown;
  };
}

export interface PiAgentCoreModule {
  Agent: new (options: Record<string, unknown>) => unknown;
}

export const PI_AI = '@earendil-works/pi-ai';
export const PI_AI_OPENAI_COMPLETIONS = '@earendil-works/pi-ai/api/openai-completions.lazy';
export const PI_AGENT_CORE = '@earendil-works/pi-agent-core';

export function loadPiAi(): Promise<PiAiModule> {
  return loadEsm<PiAiModule>(PI_AI);
}

export function loadPiAgentCore(): Promise<PiAgentCoreModule> {
  return loadEsm<PiAgentCoreModule>(PI_AGENT_CORE);
}

export function loadOpenAiCompletionsApi(): Promise<{ openAICompletionsApi: () => unknown }> {
  return loadEsm<{ openAICompletionsApi: () => unknown }>(PI_AI_OPENAI_COMPLETIONS);
}
