import { describe, expect, it } from 'vitest';
import { NAV_ADVANCED, NAV_BASIC, PAGES, currentAppHref, pageHandoff } from './pageMap';

describe('currentAppHref', () => {
  it("maps a renamed page to the current app's own address, not the alpha05 path", () => {
    const byName = (n: string) => PAGES.find((p) => p.name === n)!;
    expect(currentAppHref(byName('Rewards'), {})).toBe('https://app.vaipakam.com/vpfi');
    expect(currentAppHref(byName('Protection'), {})).toBe('https://app.vaipakam.com/vault/protection');
    expect(currentAppHref(byName('Console'), {})).toBe('https://app.vaipakam.com/protocol-console');
    expect(currentAppHref(byName('Alerts'), {})).toBe('https://app.vaipakam.com/settings');
  });
  it('fills route params and refuses an unfilled one', () => {
    const position = PAGES.find((p) => p.name === 'Position')!;
    expect(currentAppHref(position, { id: '42' })).toBe('https://app.vaipakam.com/positions/42');
    expect(currentAppHref(position, {})).toBeNull();
  });
  it('gives every page an explicit decision', () => {
    for (const p of PAGES) expect(p.currentApp === null || p.currentApp.startsWith('/')).toBe(true);
  });
});

describe('navigation by mode', () => {
  it('shows in Basic every primary page that holds a Basic capability, and only those', () => {
    const basicPaths = NAV_BASIC.map((p) => p.path);
    for (const p of PAGES) {
      expect(basicPaths.includes(p.path)).toBe(p.nav && p.tier === 'basic');
    }
    expect(basicPaths).toContain('/offers');
  });
  it('shows in Advanced every primary page, Basic ones included, with no duplicates', () => {
    const advancedPaths = NAV_ADVANCED.map((p) => p.path);
    for (const p of PAGES) expect(advancedPaths.includes(p.path)).toBe(p.nav);
    for (const p of NAV_BASIC) expect(advancedPaths).toContain(p.path);
    expect(new Set(advancedPaths).size).toBe(advancedPaths.length);
  });
  it('keeps a parametrised route out of the primary navigation', () => {
    for (const p of PAGES) if (p.path.includes(':')) expect(p.nav).toBe(false);
  });
});

describe('built pages', () => {
  it('renders a page exactly for the routes the page map marks built', async () => {
    const { BUILT_PAGES } = await import('./builtPages');
    for (const p of PAGES) expect(p.path in BUILT_PAGES).toBe(p.built);
    for (const path of Object.keys(BUILT_PAGES)) expect(PAGES.some((p) => p.path === path)).toBe(true);
    // The import pulls in the wallet stack, which is slow to transform cold.
  }, 60_000);
});

describe('pageHandoff', () => {
  it('keeps a built page in this app', () => {
    expect(pageHandoff('/borrow')).toEqual({ kind: 'here', to: '/borrow' });
  });
  it("hands an unbuilt page on to the current app's page for the same job", () => {
    const offers = PAGES.find((p) => p.path === '/offers')!;
    expect(pageHandoff('/offers')).toEqual(offers.built ? { kind: 'here', to: '/offers' } : { kind: 'currentApp', href: 'https://app.vaipakam.com/offers' });
  });
  it('names no page for a path the map does not hold', () => {
    expect(pageHandoff('/nowhere')).toEqual({ kind: 'none' });
  });
});
