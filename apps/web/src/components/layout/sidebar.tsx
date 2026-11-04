import { NavLink } from 'react-router-dom';
import { ChevronsLeft, ChevronsRight, ShieldHalf } from 'lucide-react';
import { NAV_GROUPS } from '../../lib/navigation';
import { useUiStore } from '../../stores/ui-store';
import { cn } from '../../lib/utils';

export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-30 flex flex-col bg-gradient-to-b from-navy-800 via-navy-800 to-navy-900 text-slate-200 transition-[width] duration-200',
        collapsed ? 'w-[72px]' : 'w-[232px]',
      )}
    >
      <div className="flex h-14 items-center gap-2.5 border-b border-white/10 px-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-500/90 shadow-[0_0_0_1px_rgba(255,255,255,0.12)]">
          <ShieldHalf className="h-4.5 w-4.5 text-white" strokeWidth={2.2} />
        </span>
        {!collapsed ? (
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold tracking-tight text-white">VulnAgent</p>
            <p className="truncate text-[10px] uppercase tracking-[0.16em] text-slate-400">
              SecOps Console
            </p>
          </div>
        ) : null}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.key} className="mb-3">
            {!collapsed ? (
              <p className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">
                {group.label}
              </p>
            ) : (
              <div className="mx-2 mb-2 border-t border-white/10" />
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.key}>
                  <NavLink
                    to={item.path}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex h-10 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors',
                        isActive
                          ? 'bg-brand-500/20 font-medium text-white'
                          : 'text-slate-300 hover:bg-white/5 hover:text-white',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          className={cn(
                            'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-brand-300 transition-opacity',
                            isActive ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                        <item.icon
                          className={cn('h-4 w-4 shrink-0', isActive ? 'text-brand-300' : 'text-slate-400 group-hover:text-slate-200')}
                          strokeWidth={1.9}
                        />
                        {!collapsed ? (
                          <span className="flex-1 truncate">{item.label}</span>
                        ) : null}
                        {!collapsed && !item.implemented ? (
                          <span className="rounded border border-white/15 px-1 text-[9px] uppercase tracking-wide text-slate-400">
                            待实现
                          </span>
                        ) : null}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/10 p-2">
        <button
          type="button"
          onClick={toggle}
          className="flex h-8 w-full items-center justify-center gap-2 rounded-md text-[12px] text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4" />
              收起导航
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
