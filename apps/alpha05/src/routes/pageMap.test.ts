import { describe, expect, it } from 'vitest';
import { PAGES, currentAppHref } from './pageMap';

describe('currentAppHref', () => {
  it('maps a renamed page to the current app\'s own address, not the alpha05 path', () => {
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
