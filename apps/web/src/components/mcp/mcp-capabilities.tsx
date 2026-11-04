import { useQuery } from '@tanstack/react-query';
import { mcpApi } from '../../api/mcp';
import { LoadingBlock, ErrorBlock, EmptyState } from '../ui/panel';
export function McpCapabilities({ serverId, kind }: { serverId: string; kind: 'resources' | 'prompts' }) {
  const query = useQuery({ queryKey: ['mcp', 'capabilities', serverId], queryFn: () => mcpApi.capabilities(serverId), staleTime: 30000 });
  if (query.isPending) return <LoadingBlock />;
  if (query.error) return <ErrorBlock message={query.error.message} onRetry={() => void query.refetch()} />;
  const items = query.data[kind];
  if (!items.length) return <EmptyState title={kind === 'resources' ? '该服务未提供资源' : '该服务未提供提示模板'} />;
  return <div className="divide-y divide-ink-200 p-4">{items.map((item, index) => <article className="py-3" key={`${item.name}-${index}`}><h4 className="text-sm font-semibold">{item.name}</h4><p className="mt-1 text-xs text-ink-600">{item.description}</p>{'uri' in item && <code className="mt-2 block break-all text-xs text-brand-600">{String(item.uri)}</code>}</article>)}</div>;
}
