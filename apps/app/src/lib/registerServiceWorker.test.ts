import { describe, expect, it, vi } from 'vitest';
import { isOwnRegistration, removeForeignRegistrations, type RegistrationFacts } from './registerServiceWorker';

const ORIGIN = 'https://app.vaipakam.com';
const OWN = `${ORIGIN}/sw.js`;

function reg(scripts: { installing?: string; waiting?: string; active?: string }, unregister = vi.fn(async () => true)): RegistrationFacts {
  const w = (u?: string) => (u === undefined ? null : { scriptURL: u });
  return { installing: w(scripts.installing), waiting: w(scripts.waiting), active: w(scripts.active), unregister };
}

describe('isOwnRegistration (#3236)', () => {
  it('accepts the app worker in any state', () => {
    expect(isOwnRegistration(reg({ active: OWN }), ORIGIN)).toBe(true);
    expect(isOwnRegistration(reg({ installing: OWN, active: OWN }), ORIGIN)).toBe(true);
  });

  it('treats a registration with no worker as harmless', () => {
    expect(isOwnRegistration(reg({}), ORIGIN)).toBe(true);
  });

  it('rejects any other script, a query string, or the same path on another origin', () => {
    expect(isOwnRegistration(reg({ active: `${ORIGIN}/evil.js` }), ORIGIN)).toBe(false);
    expect(isOwnRegistration(reg({ active: `${OWN}?v=2` }), ORIGIN)).toBe(false);
    expect(isOwnRegistration(reg({ active: 'https://app.vaipakam.co/sw.js' }), ORIGIN)).toBe(false);
  });

  it('rejects a foreign worker waiting behind the app worker', () => {
    expect(isOwnRegistration(reg({ active: OWN, waiting: `${ORIGIN}/sw2.js` }), ORIGIN)).toBe(false);
  });
});

describe('removeForeignRegistrations (#3236)', () => {
  it('unregisters only the foreign registrations', async () => {
    const own = reg({ active: OWN });
    const foreign = reg({ active: `${ORIGIN}/x.js` });
    const removed = await removeForeignRegistrations({ getRegistrations: async () => [own, foreign] }, ORIGIN);
    expect(removed).toBe(1);
    expect(foreign.unregister).toHaveBeenCalledOnce();
    expect(own.unregister).not.toHaveBeenCalled();
  });

  it('keeps going when one registration refuses to go', async () => {
    const stuck = reg(
      { active: `${ORIGIN}/a.js` },
      vi.fn(async () => Promise.reject(new Error('no'))),
    );
    const other = reg({ active: `${ORIGIN}/b.js` });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const removed = await removeForeignRegistrations({ getRegistrations: async () => [stuck, other] }, ORIGIN);
    expect(removed).toBe(1);
    expect(other.unregister).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed 1 of 2'));
    warn.mockRestore();
  });

  it('removes nothing and says nothing when only the app worker is there', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const removed = await removeForeignRegistrations({ getRegistrations: async () => [reg({ active: OWN })] }, ORIGIN);
    expect(removed).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
