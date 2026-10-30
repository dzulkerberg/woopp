import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '../../components/Sidebar';
import {
  buildNavHash,
  resolveNavSection,
  SECTION_META,
  VALID_NAV_SECTIONS,
} from '../navigation';

describe('Navigation & Dashboard Refactor Regression Suite', () => {
  it('removes Production Timeline and ETA Dashboard from sidebar & valid sections while preserving all other pages', () => {
    const navIds = NAV_ITEMS.map((item) => item.id);
    const navLabels = NAV_ITEMS.map((item) => item.label);

    expect(navIds).toEqual([
      'dashboard',
      'projects',
      'planner',
      'queue',
      'machines',
      'inventory',
      'analytics',
      'settings',
    ]);
    expect(VALID_NAV_SECTIONS).toEqual(navIds);

    expect(navIds).not.toContain('eta');
    expect(navIds).not.toContain('timeline');
    expect(navLabels).not.toContain('ETA Dashboard');
    expect(navLabels).not.toContain('Production Timeline');
  });

  it('retains the exact "Dashboard" title on the unified Dashboard page', () => {
    expect(SECTION_META.dashboard.title).toBe('Dashboard');
    expect(NAV_ITEMS[0]).toMatchObject({
      id: 'dashboard',
      label: 'Dashboard',
    });
  });

  it('preserves existing Dashboard bookmarks and redirects legacy ETA Dashboard links to Dashboard', () => {
    // Existing Dashboard routes & bookmarks
    expect(resolveNavSection('')).toBe('dashboard');
    expect(resolveNavSection('/')).toBe('dashboard');
    expect(resolveNavSection('#dashboard')).toBe('dashboard');
    expect(resolveNavSection('#/dashboard')).toBe('dashboard');
    expect(resolveNavSection('/dashboard')).toBe('dashboard');

    // Legacy ETA Dashboard links redirect to main Dashboard
    expect(resolveNavSection('eta')).toBe('dashboard');
    expect(resolveNavSection('#eta')).toBe('dashboard');
    expect(resolveNavSection('#/eta')).toBe('dashboard');
    expect(resolveNavSection('/eta')).toBe('dashboard');
    expect(resolveNavSection('#eta-dashboard')).toBe('dashboard');

    // Removed Production Timeline routes safely fall back to Dashboard
    expect(resolveNavSection('timeline')).toBe('dashboard');
    expect(resolveNavSection('#timeline')).toBe('dashboard');
    expect(resolveNavSection('/timeline')).toBe('dashboard');
  });

  it('preserves direct navigation and clean hashes for all remaining sections', () => {
    expect(resolveNavSection('#projects')).toBe('projects');
    expect(resolveNavSection('#/planner')).toBe('planner');
    expect(resolveNavSection('queue')).toBe('queue');
    expect(resolveNavSection('/machines')).toBe('machines');
    expect(resolveNavSection('#inventory')).toBe('inventory');
    expect(resolveNavSection('#analytics')).toBe('analytics');
    expect(resolveNavSection('#settings')).toBe('settings');

    expect(buildNavHash('dashboard')).toBe('');
    expect(buildNavHash('queue')).toBe('#queue');
    expect(buildNavHash('projects')).toBe('#projects');
  });
});
