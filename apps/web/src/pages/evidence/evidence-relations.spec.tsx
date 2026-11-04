import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidenceRelations } from './evidence-relations';
import { api } from '../../api/client';
vi.mock('../../api/client', () => ({ api: { get: vi.fn() } }));
let container: HTMLDivElement; let root: Root; let client: QueryClient;
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); }
async function mount(taskId = 't') { await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><EvidenceRelations taskId={taskId} evidenceId="e" /></MemoryRouter></QueryClientProvider>)); await flush(); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.resetAllMocks(); });
describe('证据反向关联', () => {
  it('展示事实、假设和漏洞记录，跳转均保留任务；关系不冒充验证结论', async () => {
    vi.mocked(api.get).mockResolvedValue({ facts: [{ id: 'f', subject: 'host:80', predicate: 'runs', object: 'http', status: 'inferred', targetIp: 'host' }], hypotheses: [{ hypothesis: { id: 'h', title: '访问假设', conflicted: true }, links: [] }], findings: [{ id: 'v', title: '候选漏洞', status: 'candidate', verificationIds: [] }] });
    await mount(); expect(api.get).toHaveBeenCalledWith('/tasks/t/evidence/e/relations');
    expect(container.textContent).toContain('[inferred]'); expect(container.textContent).toContain('不代表漏洞已确认'); expect(container.textContent).toContain('依据冲突');
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/workflow?task=t&hypothesis=h', '/findings?task=t&id=v']);
    vi.mocked(api.get).mockRejectedValue(new Error('证据不存在'));
    await mount('other'); expect(container.textContent).not.toContain('访问假设'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('证据不存在');
  });
  it('证据不存在或无关联时给出明确结果', async () => {
    vi.mocked(api.get).mockResolvedValue({ facts: [], hypotheses: [], findings: [] });
    await mount(); expect(container.textContent).toContain('关联事实（0）'); expect(container.textContent).toContain('关联漏洞记录（0）');
  });
});
