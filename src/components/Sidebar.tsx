import React from 'react';
import {
  BarChart3,
  Boxes,
  CalendarRange,
  Clock,
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
  isLocalMode: boolean;
  onSignOut: () => void;
  mobileOpen: boolean;
  onSetMobileOpen: (open: boolean) => void;
}

const NAV_ITEMS: { id: NavSection; label: string; icon: React.FC<{ className?: string }> }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'eta', label: 'ETA Dashboard', icon: Clock },
  { id: 'timeline', label: 'Production Timeline', icon: CalendarRange },
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
  isLocalMode,
  onSignOut,
  mobileOpen,
  onSetMobileOpen,
}) => {
  const navContent = (
    <div className="flex flex-col h-full bg-white dark:bg-[#171522] border-r border-neutral-200/80 dark:border-neutral-800 w-64 shrink-0 select-none">
      <div className="px-6 py-5 border-b border-neutral-200/80 dark:border-neutral-800 flex items-center justify-between">
        <div>
          <div className="text-[15px] font-bold tracking-tight text-neutral-900 dark:text-white whitespace-nowrap">
            WOOPP ART &amp; CRAFT
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Production System 5.0
          </div>
        </div>
        <button
          type="button"
          onClick={() => onSetMobileOpen(false)}
          className="lg:hidden p-1.5 rounded-lg text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
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
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors whitespace-nowrap ${
                active
                  ? 'bg-[#f1edfd] text-[#5b3cc4] dark:bg-[#2a2344] dark:text-[#c7b8ff]'
                  : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100/80 dark:hover:bg-neutral-800/60 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-neutral-200/80 dark:border-neutral-800 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
            {syncStatus}
          </span>
          <button
            type="button"
            onClick={onToggleTheme}
            className="p-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors shrink-0"
            aria-label="Toggle color theme"
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>

        <div className="pt-2 border-t border-neutral-100 dark:border-neutral-800/80 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-medium text-neutral-800 dark:text-neutral-200 truncate">
              {isLocalMode ? 'Local Browser Mode' : userEmail || 'Authenticated'}
            </div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
              {isLocalMode ? 'Offline Storage' : 'woopp-tracker'}
            </div>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors whitespace-nowrap shrink-0"
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
          className="fixed inset-0 z-50 lg:hidden flex bg-black/40 no-print"
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
  primaryAction?: {
    label: string;
    onClick: () => void;
  };
}

export const TopHeader: React.FC<TopHeaderProps> = ({
  sectionTitle,
  subtitle,
  onOpenMobileMenu,
  primaryAction,
}) => {
  return (
    <header className="sticky top-0 z-30 bg-[#faf9fd]/90 dark:bg-[#111018]/90 backdrop-blur border-b border-neutral-200/80 dark:border-neutral-800 px-6 py-3.5 flex items-center justify-between gap-8 no-print">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="lg:hidden p-2 rounded-lg border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-200"
          aria-label="Open navigation menu"
        >
          <Menu className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-neutral-400 dark:text-neutral-500 hidden sm:inline whitespace-nowrap">
            WOOPP 5.0
          </span>
          <span className="text-neutral-300 dark:text-neutral-600 hidden sm:inline" aria-hidden="true">
            /
          </span>
          <h1 className="text-base font-semibold text-neutral-900 dark:text-white truncate">
            {sectionTitle}
          </h1>
          {subtitle && (
            <>
              <span className="text-neutral-300 dark:text-neutral-600 hidden md:inline" aria-hidden="true">
                ·
              </span>
              <span className="text-xs text-neutral-500 dark:text-neutral-400 hidden md:inline truncate">
                {subtitle}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {primaryAction && (
          <button
            type="button"
            onClick={primaryAction.onClick}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white transition-colors whitespace-nowrap shrink-0"
          >
            {primaryAction.label}
          </button>
        )}
      </div>
    </header>
  );
};
