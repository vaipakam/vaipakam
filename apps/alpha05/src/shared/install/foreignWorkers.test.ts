import { describe, expect, it } from 'vitest';
import { isOwnRegistration, removeForeignWorkers, type WorkerRegistrationFacts } from './foreignWorkers';

const origin = 'https://app.example';
const w = (path: string) => ({ scriptURL: `${origin}${path}` });

function reg(active: { scriptURL: string } | null, opts: { waiting?: { scriptURL: string }; refuses?: boolean } = {}) {
  const r = {
    installing: null,
    waiting: opts.waiting ?? null,
    active,
    gone: false,
    unregister: async () => {
      if (opts.refuses) throw new Error('refused');
      r.gone = true;
      return true;
    },
  };
  return r;
}

describe('foreign service workers', () => {
  it("knows the app's own worker, and a registration running anything else", () => {
    expect(isOwnRegistration(reg(w('/sw.js')), origin)).toBe(true);
    expect(isOwnRegistration(reg(null), origin)).toBe(true);
    expect(isOwnRegistration(reg(w('/evil.js')), origin)).toBe(false);
    expect(isOwnRegistration(reg(w('/sw.js'), { waiting: w('/settings/sw.js') }), origin)).toBe(false);
    expect(isOwnRegistration(reg({ scriptURL: 'https://other.example/sw.js' }), origin)).toBe(false);
  });
  it('removes every foreign registration, even when one refuses, and keeps its own', async () => {
    const own = reg(w('/sw.js'));
    const a = reg(w('/settings/sw.js'));
    const stuck = reg(w('/x.js'), { refuses: true });
    const b = reg(w('/y.js'));
    const regs: WorkerRegistrationFacts[] = [own, a, stuck, b];
    expect(await removeForeignWorkers({ getRegistrations: async () => regs }, origin)).toEqual({ found: 3, removed: 2 });
    expect([own.gone, a.gone, stuck.gone, b.gone]).toEqual([false, true, false, true]);
  });
});
