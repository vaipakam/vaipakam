/**
 * The periodic-interest plan, mapper and view, tested without a chain
 * (#2524). The properties that matter: the phase is judged on CHAIN time
 * from the same execution as the preview; a due period's route never
 * claims a settlement the switch or the pause would refuse; and an unread
 * fact is stated as unread, never as a default.
 */
import { describe, expect, it } from 'vitest';
import type { MulticallSlot } from './forcedCloseReads';
import {
  periodicFacts,
  periodicReadPlan,
  periodicView,
  type PeriodicFacts,
} from './periodicInterest';

const DIAMOND = '0x000000000000000000000000000000000000d1a0' as const;
const MC3 = '0xca11bde05977b3631167028862be2a173976ca11' as const;
const plan = periodicReadPlan({ diamond: DIAMOND, multicall3: MC3, loanId: 7n });

const ok = (result: unknown): MulticallSlot => ({ status: 'success', result });
const fail: MulticallSlot = { status: 'failure', error: new Error('reverted') };

const END = 1_800_000_000;
const GRACE = END + 86_400;

/** `previewPeriodicSettle` as viem decodes it. */
const preview = (over: Partial<Record<string, unknown>> = {}) => {
  const p = {
    cadence: 1,
    periodEndAt: BigInt(END),
    graceEndsAt: BigInt(GRACE),
    expected: 1_000n,
    paid: 400n,
    shortfall: 600n,
    canSettleNow: false,
    ...over,
  };
  return [p.cadence, p.periodEndAt, p.graceEndsAt, p.expected, p.paid, p.shortfall, p.canSettleNow];
};

const slots = (o: { time?: number; preview?: unknown[]; enabled?: unknown; paused?: unknown } = {}) =>
  [
    ok(123n),
    ok(BigInt(o.time ?? END - 10)),
    ok(o.preview ?? preview()),
    o.enabled === 'fail' ? fail : ok(o.enabled ?? true),
    o.paused === 'fail' ? fail : ok(o.paused ?? false),
  ] as MulticallSlot[];

const facts = (o: Parameters<typeof slots>[0] = {}): PeriodicFacts => {
  const f = periodicFacts(plan, slots(o));
  if (!f) throw new Error('expected facts');
  return f;
};

describe('periodicReadPlan', () => {
  it('reads the block, its time, the preview, the switch and the pause', () => {
    expect(plan.map((e) => e.key)).toEqual(['block', 'time', 'preview', 'enabled', 'paused']);
    expect(plan[2].contract.args).toEqual([7n]);
    expect(plan[0].contract.address).toBe(MC3);
    expect(plan[1].contract.address).toBe(MC3);
  });
});

describe('periodicFacts', () => {
  it('throws on a slot count that does not match the plan', () => {
    expect(() => periodicFacts(plan, slots().slice(1))).toThrow(/plan of 5/);
  });

  it('states nothing when the block, its time or the preview did not answer', () => {
    for (const i of [0, 1, 2]) {
      const s = slots();
      s[i] = fail;
      expect(periodicFacts(plan, s), `slot ${i}`).toBeUndefined();
    }
  });

  it('refuses a preview of the wrong shape rather than mapping it', () => {
    expect(periodicFacts(plan, slots({ preview: preview().slice(0, 6) }))).toBeUndefined();
    const bad = preview();
    bad[6] = 1n;
    expect(periodicFacts(plan, slots({ preview: bad }))).toBeUndefined();
  });

  it('keeps an unanswered switch or pause unread, not false', () => {
    const f = facts({ enabled: 'fail', paused: 'fail' });
    expect(f.enabled).toBeUndefined();
    expect(f.paused).toBeUndefined();
    expect(f.preview.shortfall).toBe(600n);
    expect(f.block).toBe(123n);
  });
});

describe('periodicView', () => {
  it('shows nothing for a loan with no schedule', () => {
    expect(periodicView(facts({ preview: preview({ cadence: 0 }) }))).toEqual({ kind: 'none' });
  });

  it('judges the phase on the chain time read with the preview', () => {
    const at = (time: number, canSettleNow = false) =>
      periodicView(facts({ time, preview: preview({ canSettleNow }) }));
    expect(at(END - 1)).toMatchObject({ kind: 'period', phase: 'open', route: undefined });
    expect(at(END)).toMatchObject({ kind: 'period', phase: 'grace', route: undefined });
    expect(at(GRACE - 1)).toMatchObject({ kind: 'period', phase: 'grace' });
    expect(at(GRACE, true)).toMatchObject({ kind: 'period', phase: 'due', route: 'sale' });
  });

  it('says nothing about a period past grace the contract will not settle', () => {
    // `canSettleNow` is false past grace only when the loan is not Active.
    expect(periodicView(facts({ time: GRACE + 5 }))).toEqual({ kind: 'inactive' });
  });

  it('offers to record a due period that is fully paid', () => {
    const v = periodicView(
      facts({ time: GRACE, preview: preview({ canSettleNow: true, paid: 1_000n, shortfall: 0n }) }),
    );
    expect(v).toMatchObject({ phase: 'due', route: 'record', shortfall: 0n });
  });

  it('never routes a due period past the switch or the pause', () => {
    const due = { time: GRACE, preview: preview({ canSettleNow: true, shortfall: 0n }) };
    expect(periodicView(facts({ ...due, enabled: false }))).toMatchObject({ route: 'off' });
    // The switch decides first: off is off, paused or not.
    expect(periodicView(facts({ ...due, enabled: false, paused: true }))).toMatchObject({
      route: 'off',
    });
    expect(periodicView(facts({ ...due, paused: true }))).toMatchObject({ route: 'paused' });
    expect(periodicView(facts({ ...due, enabled: 'fail' }))).toMatchObject({ route: 'unknown' });
    expect(periodicView(facts({ ...due, paused: 'fail' }))).toMatchObject({ route: 'unknown' });
  });

  it('states whether settlement runs in every phase, not only once due (Codex #3030 r1)', () => {
    for (const time of [END - 1, END]) {
      expect(periodicView(facts({ time }))).toMatchObject({ settlement: 'live', route: undefined });
      expect(periodicView(facts({ time, enabled: false }))).toMatchObject({
        settlement: 'off',
        route: undefined,
      });
      expect(periodicView(facts({ time, paused: true }))).toMatchObject({ settlement: 'paused' });
      expect(periodicView(facts({ time, enabled: 'fail' }))).toMatchObject({
        settlement: 'unknown',
      });
    }
  });

  it('carries the contract’s figures through unchanged', () => {
    const v = periodicView(facts());
    expect(v).toMatchObject({
      cadence: 1,
      periodEndAt: END,
      graceEndsAt: GRACE,
      expected: 1_000n,
      paid: 400n,
      shortfall: 600n,
      block: 123n,
      chainTime: END - 10,
    });
  });
});
