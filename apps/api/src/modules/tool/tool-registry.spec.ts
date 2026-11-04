import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './tool-registry';
import { buildTool, textResult } from './core-tool';

describe('工具允许列表边界', () => {
  it('显式空列表不下发工具，不传过滤条件仍可列出目录', () => {
    const registry = new ToolRegistry();
    registry.register(buildTool({ name: 'echo', description: 'fixture', run: async () => textResult('ok') }));
    expect(registry.schemas()).toHaveLength(1);
    expect(registry.schemas({ allowed: [] })).toEqual([]);
    expect(registry.schemas({ allowed: ['echo'] })).toHaveLength(1);
  });
  it('空允许列表也不暴露延迟工具名称', () => {
    const registry = new ToolRegistry();
    registry.register(buildTool({ name: 'deferred', description: 'fixture', run: async () => textResult('ok') }), { deferred: true });
    expect(registry.deferredNames()).toEqual(['deferred']);
    expect(registry.deferredNames([])).toEqual([]);
  });
});
