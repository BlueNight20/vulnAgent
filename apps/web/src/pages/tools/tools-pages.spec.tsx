import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolsPage } from './tools-page';
import { InterceptPage } from '../intercept/intercept-page';
import { toolApi } from '../../api/tools';

vi.mock('../../api/tools', () => ({
  toolApi: {
    registry: vi.fn(),
    rules: vi.fn(),
    createRule: vi.fn(),
    updateRule: vi.fn(),
    toggleRule: vi.fn(),
    removeRule: vi.fn(),
  },
}));

let root: Root; let container: HTMLDivElement; let client: QueryClient;
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };

async function mount(node: React.ReactNode) {
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>,
  ));
  await flush();
}
const button = (text: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)
  // 抽屉在 Portal 中渲染，按钮可能不在 container 内。
  ?? [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(toolApi.registry).mockResolvedValue({
    tools: [
      { name: 'nmap_scan', source: 'mcp', risk: 'safe' },
      { name: 'record_fact', source: 'business', risk: 'safe' },
    ],
  });
  vi.mocked(toolApi.rules).mockResolvedValue({ rules: [] });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.resetAllMocks(); });

describe('工具目录页', () => {
  it('只展示内置能力，外部工具通过 MCP 入口管理，支持详情', async () => {
    await mount(<ToolsPage />);
    expect(container.textContent).not.toContain('nmap_scan');
    expect(container.textContent).toContain('record_fact');
    expect(container.querySelector('a[href="/mcp"]')).not.toBeNull();

    const card = [...container.querySelectorAll('button')]
      .find((node) => node.className.includes('rounded-lg') && node.textContent?.includes('record_fact'))!;
    expect(card).toBeDefined();
    await act(async () => card.click());
    await flush();
    // 抽屉内容在 Portal 中，从 document 读取。
    expect(document.body.textContent).toContain('命中的拦截规则');
    expect(document.body.textContent).toContain('工具的执行行为由代码决定');
  });
});

describe('拦截规则页', () => {
  it('空规则时显式警告，新建规则后提交到后端', async () => {
    vi.mocked(toolApi.createRule).mockResolvedValue({
      id: 'r1', name: '禁止扫描', enabled: true, priority: 10, matchTarget: 'tool_name', matchType: 'string',
      pattern: 'nmap', action: 'deny', message: null, timeoutEnabled: false, timeoutSeconds: null,
      timeoutAction: null, createdAt: '', updatedAt: '',
    });
    await mount(<InterceptPage />);
    expect(container.textContent).toContain('当前没有任何规则');

    await act(async () => button('新建规则')!.click());
    await flush();
    // 抽屉通过 Portal 渲染到 body，需要从 document 查询。
    const nameInput = [...document.querySelectorAll('input')].find((node) => node.closest('aside')) as HTMLInputElement;
    expect(nameInput).toBeDefined();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, '禁止扫描');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await act(async () => button('保存')!.click());
    await flush();
    expect(toolApi.createRule).toHaveBeenCalledTimes(1);
  });

  it('启用中的规则可直接切换与删除', async () => {
    vi.mocked(toolApi.rules).mockResolvedValue({
      rules: [{
        id: 'r1', name: '危险命令', enabled: true, priority: 5, matchTarget: 'tool_input', matchType: 'string',
        pattern: 'rm -rf', action: 'deny', message: '禁止删除', timeoutEnabled: false, timeoutSeconds: null,
        timeoutAction: null, createdAt: '', updatedAt: '',
      }],
    });
    vi.mocked(toolApi.toggleRule).mockResolvedValue({} as never);
    vi.mocked(toolApi.removeRule).mockResolvedValue({ deleted: true });
    await mount(<InterceptPage />);
    expect(container.textContent).toContain('危险命令');
    expect(container.textContent).toContain('rm -rf');

    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    await flush();
    expect(toolApi.toggleRule).toHaveBeenCalledWith('r1', false);

    const remove = container.querySelector('[aria-label="删除规则 危险命令"]') as HTMLButtonElement;
    await act(async () => remove.click());
    await flush();
    expect(toolApi.removeRule).toHaveBeenCalledWith('r1');
  });

  it('保存失败时展示后端原因且不关闭抽屉', async () => {
    vi.mocked(toolApi.createRule).mockRejectedValue(new Error('正则表达式无法编译，请检查语法'));
    await mount(<InterceptPage />);
    await act(async () => button('新建规则')!.click());
    await flush();
    await act(async () => button('保存')!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('正则表达式无法编译');
  });
});
