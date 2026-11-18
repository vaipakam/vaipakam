/**
 * The keeper's side of the lender intent slots' calm-price check: the
 * no-checkpoint tracker, the coverage (launch) check, and how the fill passes
 * read the check's refusals.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import {
  CALM_FILL_REFUSALS,
  CALM_INTENT_ERRORS,
  NO_CHECKPOINT_ALERT_AFTER_SEC,
  calmSlotKey,
  trackNoCheckpoint,
  type CalmSlot,
  type NoCheckpointStore,
} from '../src/intentCalm';
import { checkpointCoverageGap, checkpointCoverageHealth, COVERAGE_ALERT_KEY } from '../src/checkpointCoverage';
import { intentRefusalScope } from '../src/matcher';
import { FILL_REFUSALS } from '../src/positionUpkeep';
import type { Env } from '../src/env';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const slot = (owner: number, n = 0): CalmSlot => ({ owner: a(owner), lendingAsset: a(1), collateralAsset: a(2), slot: n });
const NOW = 1_800_000_000;

class FakeStore implements NoCheckpointStore {
  rows = new Map<string, { slot: CalmSlot; since: number }>();
  alerts: { key: string; id: string; detail: string }[][] = [];
  resolved: string[] = [];
  now = NOW;
  async start(items: readonly { item: string; slot: CalmSlot }[]) {
    for (const x of items) if (!this.rows.has(x.item)) this.rows.set(x.item, { slot: x.slot, since: this.now });
  }
  async stop(items: readonly string[]) {
    for (const i of items) this.rows.delete(i);
  }
  async list() {
    return [...this.rows].map(([item, r]) => ({ item, ...r }));
  }
  async alert(entries: readonly { key: string; id: string; detail: string }[]) {
    this.alerts.push([...entries]);
    return 'sent' as const;
  }
  async resolve(keys: readonly string[]) {
    this.resolved.push(...keys);
  }
}

describe('the no-checkpoint tracker', () => {
  it('raises a slot only once it has read NoCheckpoint for three hours, and keeps its first time', async () => {
    const s = new FakeStore();
    expect(await trackNoCheckpoint(84532, [{ slot: slot(0xa0), status: 4 }], true, s, NOW)).toEqual({ overdue: 0, outcome: null });
    s.now = NOW + 1800;
    await trackNoCheckpoint(84532, [{ slot: slot(0xa0), status: 4 }], true, s, NOW + 1800);
    expect(s.rows.get(calmSlotKey(slot(0xa0)))?.since).toBe(NOW);
    expect((await trackNoCheckpoint(84532, [{ slot: slot(0xa0), status: 4 }], true, s, NOW + NO_CHECKPOINT_ALERT_AFTER_SEC - 1)).overdue).toBe(0);
    const r = await trackNoCheckpoint(84532, [{ slot: slot(0xa0), status: 4 }], true, s, NOW + NO_CHECKPOINT_ALERT_AFTER_SEC);
    expect(r).toEqual({ overdue: 1, outcome: 'sent' });
    expect(s.alerts[0][0].key).toBe(`calm-no-checkpoint:84532:${calmSlotKey(slot(0xa0))}`);
    expect(s.alerts[0][0].detail).toBe(`no checkpoint since ${new Date(NOW * 1000).toISOString()}`);
  });

  it('any other status stops the clock and clears the alert; an unread one leaves it as it was', async () => {
    const s = new FakeStore();
    await trackNoCheckpoint(84532, [{ slot: slot(0xa0), status: 4 }, { slot: slot(0xa1), status: 4 }], true, s, NOW);
    await trackNoCheckpoint(84532, [{ slot: slot(0xa0), status: 2 }, { slot: slot(0xa1), status: null }], true, s, NOW + 60);
    expect([...s.rows.keys()]).toEqual([calmSlotKey(slot(0xa1))]);
    expect(s.resolved).toEqual([`calm-no-checkpoint:84532:${calmSlotKey(slot(0xa0))}`]);
  });

  it('a tracked slot gone from the registry is stopped only when the run read the whole registry', async () => {
    const s = new FakeStore();
    await trackNoCheckpoint(84532, [{ slot: slot(0xa0), status: 4 }], true, s, NOW);
    await trackNoCheckpoint(84532, [], false, s, NOW + 60);
    expect(s.rows.size).toBe(1);
    await trackNoCheckpoint(84532, [], true, s, NOW + 120);
    expect(s.rows.size).toBe(0);
  });

  it('never throws: a store failure leaves the tracker for the next run', async () => {
    const s = new FakeStore();
    s.list = async () => Promise.reject(new Error('D1 down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await trackNoCheckpoint(84532, [{ slot: slot(0xa0), status: 4 }], true, s, NOW)).toEqual({ overdue: 0, outcome: null });
    warn.mockRestore();
  });
});

describe('the fill passes', () => {
  it('Auto-lend skips the whole intent on a price-check refusal, which holds for every borrower', () => {
    expect([...CALM_INTENT_ERRORS.keys()]).toEqual([26, 27, 28]);
    for (const e of CALM_INTENT_ERRORS.keys()) expect(intentRefusalScope(e)).toBe('intent');
  });

  it('the backstop fill names the refusal and records no failure for it', () => {
    for (const [name, words] of CALM_FILL_REFUSALS) expect(FILL_REFUSALS.get(name)).toBe(words);
    expect(FILL_REFUSALS.get('IntentPairNoCheckpoint')).toMatch(/checkpoint of one of the last two hours is missing/);
  });
});

describe('the coverage check', () => {
  const KEY = `0x${'11'.repeat(32)}`;
  const env = (over: Partial<Env>) => ({ KEEPER_ENABLED: 'true', KEEPER_PRIVATE_KEY: KEY, ...over }) as Env;

  it('Auto-lend runs wherever the keeper is armed, so the checkpoint pass must be armed too', () => {
    expect(checkpointCoverageGap(env({}))).toMatch(/^Auto-lend fills \(the matcher\) is armed but PRICE_CHECKPOINT_ENABLED is not/);
    expect(checkpointCoverageGap(env({ PRICE_CHECKPOINT_ENABLED: 'true' }))).toBeNull();
    expect(checkpointCoverageGap(env({ PRICE_CHECKPOINT_ENABLED: 'True' })), 'the arming gate does not take True').not.toBeNull();
    expect(checkpointCoverageGap(env({ KEEPER_ENABLED: 'false' }))).toBeNull();
  });

  it('names the backstop fill when it is armed', () => {
    const gap = checkpointCoverageGap(env({ POSITION_UPKEEP_ENABLED: 'true', BACKSTOP_FILL_ENABLED: '1' }));
    expect(gap).toMatch(/^Auto-lend fills \(the matcher\) and the backstop fill are armed/);
    expect(checkpointCoverageGap(env({ KEEPER_PRIVATE_KEY: undefined, POSITION_UPKEEP_ENABLED: 'true', BACKSTOP_FILL_ENABLED: 'true' }))).toMatch(/^the backstop fill is armed/);
  });

  it('alerts while the gap lasts and clears the record once it is gone', async () => {
    const send = vi.fn(async () => 'sent' as const);
    const clear = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await checkpointCoverageHealth(env({}), { send, prior: async () => null, clear })).toBe('alerted');
      expect(send.mock.calls[0][1]).toBe(COVERAGE_ALERT_KEY);
      expect(await checkpointCoverageHealth(env({ PRICE_CHECKPOINT_ENABLED: 'true' }), { send, prior: async () => ({}), clear })).toBe('cleared');
      expect(clear).toHaveBeenCalledWith(expect.anything(), COVERAGE_ALERT_KEY);
      expect(await checkpointCoverageHealth(env({ PRICE_CHECKPOINT_ENABLED: 'true' }), { send, prior: async () => null, clear })).toBe('ok');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
