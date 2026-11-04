import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { router } from './router';
import { mcpApi } from './api/mcp';
import { NAV_ITEMS } from './lib/navigation';

vi.mock('./components/layout/topbar', () => ({ Topbar: () => null }));
vi.mock('./api/mcp', () => ({ mcpApi: { servers: vi.fn(async () => ({ items: [] })), tools: vi.fn(async () => ({ items: [] })), permissions: vi.fn(async () => ({ roles: [], permissions: [], tools: [] })), calls: vi.fn(async () => ({ items: [], total: 0 })) } }));
vi.mock('./api/client', () => ({ api: { get: vi.fn(async (path: string) => {
  // 工具层页面：工具目录、拦截规则、执行记录都走这些端点。
  if (path === '/intercept/tools') return { tools: [] };
  if (path === '/intercept/rules') return { rules: [] };
  if (path.startsWith('/mcp/calls')) return { items: [], total: 0 };
  if (path.startsWith('/dashboard/summary')) return { tasks: {}, findings: {}, usage: { tokens: 0, costUsd: 0 }, services: [], recentTasks: [] };
  if (path.startsWith('/dashboard/usage-trend')) return { points: [] };
  if (path.startsWith('/settings/models')) return { items: [] };
  if (path === '/settings') return { model: { provider: 'fixture', baseUrl: '', modelName: 'fixture', apiKeyMasked: '', apiKeyConfigured: false, temperature: 0.2, maxTokens: 4096 }, runtime: { piRuntimeEnabled: false, workerMaxConcurrency: 2, modelMaxConcurrency: 2, defaultTokenBudget: 200000, defaultTimeBudgetMinutes: 60, defaultWorkerCount: 2, logLevel: 'info', logToFile: false }, updatedAt: null, encryptionKeyEphemeral: false };
  if (path === '/tasks' || path.startsWith('/tasks?')) return { items: [], total: 0, stats: {} };
  throw new Error(`Unexpected navigation query: ${path}`);
} ) } }));

it('实际侧栏导航可进入全部十页，MCP 管理读取服务并打开添加服务，不落入 404', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await router.navigate('/mcp');
    await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(container.querySelector('main h1')?.textContent).toBe('MCP 服务中心'); expect(container.textContent).not.toContain('页面不存在'); expect(mcpApi.servers).toHaveBeenCalledOnce();
    const config = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '添加服务')!;
    await act(async () => config.click()); expect(document.body.textContent).toContain('添加 MCP 服务');
    await act(async () => (document.querySelector('[aria-label="关闭抽屉"]') as HTMLButtonElement).click());
    for (const item of NAV_ITEMS) {
      const link = container.querySelector(`aside a[href="${item.path}"]`) as HTMLAnchorElement;
      expect(link, item.path).not.toBeNull(); await act(async () => link.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      expect(container.querySelector('main h1')?.textContent, item.path).toBe(item.path === '/mcp' ? 'MCP 服务中心' : item.path === '/tools' ? '内置工具' : item.label);
      expect(container.textContent, item.path).not.toContain('页面不存在');
      expect(container.textContent, item.path).not.toContain('Unexpected navigation query');
    }
  } finally { await act(async () => root.unmount()); router.dispose(); client.clear(); container.remove(); }
});
