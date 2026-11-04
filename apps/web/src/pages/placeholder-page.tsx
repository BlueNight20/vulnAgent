import { Construction, CircleDashed } from 'lucide-react';
import { PageHeader } from '../components/layout/page-header';
import { Panel } from '../components/ui/panel';

export interface PlaceholderPageProps {
  title: string;
  description: string;
  stage: string;
  planned: string[];
}

export function PlaceholderPage({ title, description, stage, planned }: PlaceholderPageProps) {
  return (
    <>
      <PageHeader
        title={title}
        description={description}
        meta={
          <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
            待实现
          </span>
        }
      />
      <Panel className="min-h-[420px]">
        <div className="flex flex-col items-start gap-5 px-2 py-4 md:flex-row md:items-start md:gap-10">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-lg bg-slate-100 text-ink-400">
              <Construction className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink-900">页面建设中</p>
              <p className="text-[12px] text-ink-400">计划在{stage}实现，当前不提供任何数据</p>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <p className="mb-2 text-[12px] font-medium text-ink-600">规划功能</p>
            <ul className="grid gap-1.5 md:grid-cols-2">
              {planned.map((item) => (
                <li key={item} className="flex items-start gap-2 text-[12px] text-ink-600">
                  <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>
    </>
  );
}
