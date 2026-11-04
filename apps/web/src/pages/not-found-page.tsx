import { Link } from 'react-router-dom';
import { EmptyState, Panel } from '../components/ui/panel';

export function NotFoundPage() {
  return (
    <Panel>
      <EmptyState
        title="页面不存在"
        description="请从左侧导航进入需要查看的模块。"
        action={
          <Link
            to="/dashboard"
            className="inline-flex h-8 items-center rounded-md bg-brand-500 px-3 text-[13px] font-medium text-white hover:bg-brand-600"
          >
            返回仪表盘
          </Link>
        }
      />
    </Panel>
  );
}
