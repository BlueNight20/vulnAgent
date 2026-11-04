import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { findNavByPath } from '../../lib/navigation';
import { useUiStore } from '../../stores/ui-store';
import { cn } from '../../lib/utils';

export function AppLayout() {
  const location = useLocation();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const current = findNavByPath(location.pathname);

  return (
    <div className="min-h-screen bg-canvas">
      <Sidebar />
      <Topbar title={current?.label ?? 'VulnAgent'} breadcrumb="VulnAgent" />
      <main
        className={cn(
          'min-h-screen pt-14 transition-[padding] duration-200',
          collapsed ? 'pl-[72px]' : 'pl-[232px]',
        )}
      >
        <div className="mx-auto max-w-[1680px] px-6 py-5 animate-fade-in">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
