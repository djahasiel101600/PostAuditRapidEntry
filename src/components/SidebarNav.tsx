import React from 'react';
import {
  AlertCircle,
  BarChart3,
  BookOpen,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  Keyboard,
  LogOut,
  Settings,
} from 'lucide-react';
import type { ViewModule, WorkspaceRole } from '../types/rci';

interface SidebarNavProps {
  activeView: ViewModule;
  onSelectView: (view: ViewModule) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  draftCount: number;
  lackingCount: number;
  todayCount: number;
  userEmail: string;
  userRole: WorkspaceRole;
  onLogout: () => void;
}

export const SidebarNav: React.FC<SidebarNavProps> = ({
  activeView,
  onSelectView,
  collapsed,
  onToggleCollapse,
  draftCount,
  lackingCount,
  todayCount,
  userEmail,
  userRole,
  onLogout,
}) => {
  const navItems: Array<{
    id: ViewModule;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count?: number;
    countTone?: 'crimson' | 'amber' | 'neutral';
  }> = [
    { id: 'entry', label: 'Rapid Entry', icon: Keyboard, count: todayCount > 0 ? todayCount : undefined, countTone: 'neutral' },
    { id: 'ledger', label: 'Monthly Ledger', icon: BookOpen },
    { id: 'drafts', label: 'Drafts', icon: FilePenLine, count: draftCount > 0 ? draftCount : undefined, countTone: 'amber' },
    { id: 'lacking', label: 'Lacking Queue', icon: AlertCircle, count: lackingCount > 0 ? lackingCount : undefined, countTone: 'crimson' },
    { id: 'schedule', label: 'COA Schedule', icon: CalendarClock },
    { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
    { id: 'settings', label: 'Templates & Team', icon: Settings },
  ];

  return (
    <aside
      className={`bg-white border-r border-slate-200 flex flex-col justify-between shrink-0 transition-[width] duration-150 ${
        collapsed ? 'w-16' : 'w-60'
      }`}
    >
      <div>
        <div className="h-14 px-4 border-b border-slate-200 flex items-center justify-between gap-2">
          {!collapsed && (
            <span className="font-display font-bold text-sm tracking-tight text-slate-900 whitespace-nowrap truncate">
              RCI Rapid Ledger
            </span>
          )}
          <button
            type="button"
            onClick={onToggleCollapse}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar for wider grid'}
            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors cursor-pointer shrink-0"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        <nav className="p-2 space-y-0.5" aria-label="Workspace modules">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            const countColor =
              item.countTone === 'crimson'
                ? 'text-red-600 font-semibold'
                : item.countTone === 'amber'
                  ? 'text-amber-600 font-semibold'
                  : 'text-slate-500';

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectView(item.id)}
                title={collapsed ? item.label : undefined}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  isActive
                    ? 'bg-slate-900 text-white font-medium'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-white' : 'text-slate-500'}`} />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </span>
                {!collapsed && item.count !== undefined && (
                  <span
                    className={`text-xs font-mono tabular-nums shrink-0 ${
                      isActive ? 'text-slate-200' : countColor
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="p-3 border-t border-slate-200 space-y-2">
        {!collapsed && (
          <div className="px-1">
            <p className="text-xs font-medium text-slate-900 truncate">{userEmail}</p>
            <p className="text-xs text-slate-500 capitalize">{userRole} access</p>
          </div>
        )}
        <button
          type="button"
          onClick={onLogout}
          title="Sign out"
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors cursor-pointer whitespace-nowrap"
        >
          <LogOut className="w-3.5 h-3.5 shrink-0" />
          {!collapsed && <span>Sign out</span>}
        </button>
      </div>
    </aside>
  );
};
