import React from 'react';
import {
  BarChart3,
  Boxes,
  FolderKanban,
  Grid,
  LayoutDashboard,
  ListTodo,
  Menu,
  Moon,
  Printer,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import { NavSection } from '../types';

interface SidebarProps {
  activeNav: NavSection;
  onSelectNav: (nav: NavSection) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  syncStatus: string;
  userEmail: string;
  onSignOut: () => void;
  mobileOpen: boolean;
  onSetMobileOpen: (open: boolean) => void;
}

export const NAV_ITEMS: {
  id: NavSection;
  label: string;
  icon: React.FC<{ className?: string }>;
}[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'planner', label: 'Auto Plate Planner', icon: Grid },
  { id: 'queue', label: 'Print Queue', icon: ListTodo },
  { id: 'machines', label: 'Machines', icon: Printer },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activeNav,
  onSelectNav,
  theme,
  onToggleTheme,
  syncStatus,
  userEmail,
  onSignOut,
  mobileOpen,
  onSetMobileOpen,
}) => {
  const navContent = (
    <div className="flex flex-col h-full bg-surface border-r border-line w-64 shrink-0 select-none">
      <div className="px-5 py-5 border-b border-line flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-1.5 h-8 rounded-xs bg-brand shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-[14px] font-bold tracking-tight text-ink whitespace-nowrap">
              WOOPP ART &amp; CRAFT
            </div>
            <div className="text-[11px] font-medium tracking-wide uppercase text-muted mt-0.5">
              Production System 5.0
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onSetMobileOpen(false)}
          className="lg:hidden p-1.5 rounded-lg text-muted hover:text-ink hover:bg-elevated transition-colors"
          aria-label="Close navigation"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Main Navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeNav === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectNav(item.id);
                onSetMobileOpen(false);
              }}
              aria-current={active ? 'page' : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap border ${
                active
                  ? 'bg-brand-soft border-brand-border text-brand-text dark:text-white font-semibold'
                  : 'border-transparent text-ink-secondary hover:bg-elevated hover:text-ink'
              }`}
            >
              <Icon
                className={`w-4 h-4 shrink-0 ${
                  active ? 'text-brand' : 'text-muted'
                }`}
              />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-line space-y-3 bg-surface">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`w-2 h-2 rounded-xs shrink-0 ${
                syncStatus.toLowerCase().includes('fail') ||
                syncStatus.toLowerCase().includes('error') ||
                syncStatus.toLowerCase().includes('unavailable')
                  ? 'bg-status-error'
                  : syncStatus.toLowerCase().includes('saving') ||
                    syncStatus.toLowerCase().includes('loading')
                  ? 'bg-status-warning'
                  : 'bg-status-success'
              }`}
              aria-hidden="true"
            />
            <span className="text-xs text-muted truncate">
              {syncStatus}
            </span>
          </div>
          <button
            type="button"
            onClick={onToggleTheme}
            className="p-2 rounded-lg border border-line bg-elevated text-ink-secondary hover:text-ink hover:border-brand-border transition-colors shrink-0"
            aria-label="Toggle color theme"
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>

        <div className="pt-2.5 border-t border-line flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-ink truncate">
              {userEmail || 'Authenticated'}
            </div>
            <div className="text-[11px] font-mono-data text-muted truncate">
              woopp-tracker · Cloud
            </div>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-line bg-elevated text-ink-secondary hover:text-ink hover:border-muted transition-colors whitespace-nowrap shrink-0"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block h-screen sticky top-0 no-print">{navContent}</aside>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden flex bg-black/60 no-print"
          onClick={() => onSetMobileOpen(false)}
        >
          <div className="h-full" onClick={(e) => e.stopPropagation()}>
            {navContent}
          </div>
        </div>
      )}
    </>
  );
};

interface TopHeaderProps {
  sectionTitle: string;
  subtitle?: string;
  onOpenMobileMenu: () => void;
}

export const TopHeader: React.FC<TopHeaderProps> = ({
  sectionTitle,
  subtitle,
  onOpenMobileMenu,
}) => {
  return (
    <header className="sticky top-0 z-30 min-h-[61px] bg-surface/95 backdrop-blur border-b border-line px-6 py-3.5 flex items-center justify-between gap-8 no-print">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="lg:hidden p-2 rounded-lg border border-line bg-elevated text-ink-secondary hover:text-ink transition-colors"
          aria-label="Open navigation menu"
        >
          <Menu className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-xs font-mono-data uppercase tracking-wider text-muted hidden sm:inline whitespace-nowrap">
            WOOPP 5.0
          </span>
          <span className="text-line hidden sm:inline" aria-hidden="true">
            /
          </span>
          <h1 className="text-base font-semibold text-ink truncate">
            {sectionTitle}
          </h1>
          {subtitle && (
            <>
              <span className="text-line hidden md:inline" aria-hidden="true">
                ·
              </span>
              <span className="text-xs text-muted hidden md:inline truncate">
                {subtitle}
              </span>
            </>
          )}
        </div>
      </div>
    </header>
  );
};
