import { NavSection } from '../types';

export const VALID_NAV_SECTIONS: readonly NavSection[] = [
  'dashboard',
  'projects',
  'planner',
  'queue',
  'machines',
  'inventory',
  'analytics',
  'settings',
];

const VALID_NAV_SET: ReadonlySet<string> = new Set<string>(VALID_NAV_SECTIONS);

export const SECTION_META: Record<NavSection, { title: string; subtitle: string }> = {
  dashboard: {
    title: 'Dashboard',
    subtitle: 'Live countdowns, next free Bambu printer, and parallel project completion ETAs',
  },
  projects: {
    title: 'Projects',
    subtitle: 'Multi-channel production plans, priorities, and deadlines',
  },
  planner: {
    title: 'Auto Plate Planner',
    subtitle: 'Custom A–Z alphabet & charm keycap grid with exact-capacity plate distribution',
  },
  queue: {
    title: 'Print Queue',
    subtitle: 'Visual Kanban workflow, Bambu Studio durations, and live print timers',
  },
  machines: {
    title: 'Machines',
    subtitle: 'Bambu fleet status, overlap guard, maintenance windows, and speed profiles',
  },
  inventory: {
    title: 'Inventory',
    subtitle: 'Produced, reserved, and available keycap stock with audit ledger',
  },
  analytics: {
    title: 'Analytics',
    subtitle: 'Filtered yield reports, machine runtime, and CSV export',
  },
  settings: {
    title: 'Settings',
    subtitle: 'Timezone, turnaround buffers, filament colors, and cloud/JSON backups',
  },
};

/**
 * Resolves a section identifier, URL hash, or pathname into a valid `NavSection`.
 * - Preserves `/` and `#dashboard` / `/dashboard` bookmarks -> `'dashboard'`.
 * - Redirects legacy ETA Dashboard links (`eta`, `#eta`, `/eta`, `eta-dashboard`)
 *   and removed routes (`timeline`) -> `'dashboard'`.
 */
export function resolveNavSection(rawTarget?: string | null): NavSection {
  if (!rawTarget) return 'dashboard';

  const trimmed = rawTarget.trim();
  if (!trimmed || trimmed === '/' || trimmed === '#') {
    return 'dashboard';
  }

  // Strip leading '#', '/', query string, and trailing '/'
  const cleaned = trimmed
    .replace(/^[#/]+/, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .toLowerCase();

  if (
    !cleaned ||
    cleaned === 'dashboard' ||
    cleaned === 'eta' ||
    cleaned === 'eta-dashboard' ||
    cleaned === 'smart-eta' ||
    cleaned === 'timeline' ||
    cleaned === 'production-timeline'
  ) {
    return 'dashboard';
  }

  if (VALID_NAV_SET.has(cleaned)) {
    return cleaned as NavSection;
  }

  return 'dashboard';
}

/**
 * Returns the clean hash fragment for a given section.
 * Keeps the root URL hash-free for the main Dashboard so `/` bookmarks remain clean.
 */
export function buildNavHash(section: NavSection): string {
  return section === 'dashboard' ? '' : `#${section}`;
}
