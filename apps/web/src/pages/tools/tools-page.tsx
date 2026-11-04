import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Wrench } from 'lucide-react';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, LoadingBlock, EmptyState, ErrorBlock } from '../../components/ui/panel';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Drawer } from '../../components/ui/drawer';
import { toolApi, type RegistryTool } from '../../api/tools';
import { Link } from 'react-router-dom';

const SOURCE_LABEL: Record<string, string> = {
  mcp: 'MCP',
  business: '内置业务',
  builtin: '内置',
  custom: '自定义',
};

const RISK_LABEL: Record<string, string> = {
  safe: '只读',
  read_only: '只读',
  intrusive: '侵入',
  destructive: '破坏性',
};

/**
 * 工具目录：卡片网格 + 右侧详情抽屉。
 *
 * 与 artex 的工具页同构：单一搜索框做客户端过滤、Tabs 切换来源、点卡片看参数与策略归属。
 * 工具本体不可在页面改写执行行为——只能查看，改动通过拦截规则与 MCP 配置完成。
 */
export function ToolsPage() {
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<RegistryTool | null>(null);

  const tools = useQuery({ queryKey: ['tools', 'registry'], queryFn: () => toolApi.registry(), refetchInterval: 10_000 });
  const rules = useQuery({ queryKey: ['tools', 'rules'], queryFn: () => toolApi.rules() });

  const items = (tools.data?.tools ?? []).filter((tool) => tool.source === 'builtin' || tool.source === 'business');
  const filtered = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    return items
      .filter((tool) => !text || tool.name.toLowerCase().includes(text));
  }, [items, keyword]);

  const related = (name: string) =>
    (rules.data?.rules ?? []).filter((rule) => rule.enabled && name.toLowerCase().includes(rule.pattern.toLowerCase().replace(/\*/g, '')));

  return (
    <>
      <PageHeader
        title="内置工具"
        description="系统内置的事实记录、证据管理与任务协作能力。外部工具按服务归属在 MCP 服务中心管理。"
        actions={
          <Button onClick={() => void tools.refetch()} loading={tools.isFetching}>
            <Wrench className="h-3.5 w-3.5" />
            刷新目录
          </Button>
        }
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link to="/mcp" className="text-sm text-brand-600 hover:underline">管理 MCP 服务与外部工具 →</Link>
        <div className="relative ml-auto w-[260px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
          <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索工具名" className="pl-7" />
        </div>
      </div>

      <div className="mt-3">
        <Panel
          title={`工具目录（${filtered.length}/${items.length}）`}
          description="点开卡片查看来源、风险级别与命中的拦截规则"
          dense
          bodyClassName="p-3"
        >
          {tools.isLoading ? (
            <LoadingBlock />
          ) : tools.isError ? (
            <ErrorBlock message={(tools.error as Error).message} onRetry={() => void tools.refetch()} />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={items.length ? '没有匹配的工具' : '目录为空'}
              description={items.length ? '调整搜索关键字。' : '内置工具尚未注册，请检查后端运行状态。'}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((tool) => {
                const hits = related(tool.name);
                return (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() => setSelected(tool)}
                    className="rounded-lg border border-ink-200 bg-white p-3 text-left transition-colors hover:border-brand-300 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-300"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-[12px] text-ink-900">{tool.name}</span>
                      <Badge tone={tool.source === 'mcp' ? 'brand' : 'neutral'}>{SOURCE_LABEL[tool.source] ?? tool.source}</Badge>
                      <Badge tone={RISK_LABEL[tool.risk] === '只读' ? 'neutral' : 'danger'}>{RISK_LABEL[tool.risk] ?? tool.risk}</Badge>
                    </div>
                    <p className="mt-1.5 text-[11px] text-ink-400">
                      {hits.length ? `命中 ${hits.length} 条已启用规则` : '无已启用拦截规则'}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.name ?? '工具详情'}
        description={selected ? `${SOURCE_LABEL[selected.source] ?? selected.source} · ${RISK_LABEL[selected.risk] ?? selected.risk}` : undefined}
        width="w-[460px]"
      >
        {selected ? (
          <div className="space-y-4 text-[12px]">
            <section>
              <p className="mb-1.5 font-semibold text-ink-900">基本信息</p>
              <dl className="divide-y divide-ink-200/60 rounded border border-ink-200">
                <div className="flex justify-between px-3 py-1.5"><dt className="text-ink-400">名称</dt><dd className="font-mono">{selected.name}</dd></div>
                <div className="flex justify-between px-3 py-1.5"><dt className="text-ink-400">来源</dt><dd>{SOURCE_LABEL[selected.source] ?? selected.source}</dd></div>
                <div className="flex justify-between px-3 py-1.5"><dt className="text-ink-400">风险级别</dt><dd>{RISK_LABEL[selected.risk] ?? selected.risk}</dd></div>
              </dl>
            </section>
            <section>
              <p className="mb-1.5 font-semibold text-ink-900">命中的拦截规则</p>
              {related(selected.name).length ? (
                <ul className="divide-y divide-ink-200/60 rounded border border-ink-200">
                  {related(selected.name).map((rule) => (
                    <li key={rule.id} className="flex items-center justify-between px-3 py-1.5">
                      <span>{rule.name}</span>
                      <Badge tone={rule.action === 'allow' ? 'neutral' : rule.action === 'deny' ? 'danger' : 'warning'}>{rule.action}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded bg-slate-50 px-3 py-2 text-ink-400">没有已启用的规则命中该工具。</p>
              )}
            </section>
            <p className="rounded border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-800">
              工具的执行行为由代码决定，页面不可修改。若要限制某类调用，请在「拦截规则」中配置限制。
            </p>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
