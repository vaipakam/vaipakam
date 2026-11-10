import { encodeAbiParameters, encodeEventTopics, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  bpsPercent,
  guardBlockers,
  guardReceipt,
  guardRefuses,
  guardStatusLine,
  measureGuard,
  parsePercent,
  PRICE_GUARD,
  type GuardFacts,
  type GuardReview,
  type PriceGuard,
} from './priceGuard';

type Hex = `0x${string}`;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const OTHER = '0x00000000000000000000000000000000000000a6' as Hex;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}:${JSON.stringify(v)}`,
};

const OFF: PriceGuard = { maxMoveBps: 0, setAt: 0, status: 'off', moveBps: 0, calmMoveBps: 300 };
const ON: PriceGuard = { maxMoveBps: 500, setAt: 1_800_000_000, status: 'clear', moveBps: 120, calmMoveBps: 300 };

function facts(over: Partial<GuardFacts> = {}): GuardFacts {
  return { offerId: 7n, creator: ME, open: true, erc20Pair: true, guard: OFF, paused: false, chainNow: 1_800_000_000, readAt: 0, ...over };
}
function review(bps: number, over: Partial<GuardFacts> = {}, dryRun: GuardReview['dryRun'] = null): GuardReview {
  return { identity: 'me', account: ME, bps, facts: facts(over), dryRun, readAt: 0 };
}
const first = (r: GuardReview) => guardBlockers(r, copy)[0] ?? null;

describe('percent words', () => {
  it('reads a typed percent in bps, with at most two decimals', () => {
    expect(parsePercent('5')).toBe(500);
    expect(parsePercent('2.5%')).toBe(250);
    expect(parsePercent(' 0.75 ')).toBe(75);
    expect(parsePercent('1.234')).toBeNull();
    expect(parsePercent('abc')).toBeNull();
    expect(parsePercent('')).toBeNull();
  });

  it('writes a limit without trailing zeros', () => {
    expect(bpsPercent(500)).toBe('5%');
    expect(bpsPercent(250)).toBe('2.5%');
    expect(bpsPercent(75)).toBe('0.75%');
  });
});

describe('guardBlockers', () => {
  it('lets the creator of an open token offer set, change or clear it', () => {
    expect(first(review(500))).toBeNull();
    expect(first(review(800, { guard: ON }))).toBeNull();
    expect(first(review(0, { guard: ON }))).toBeNull();
  });

  it('refuses another wallet, an ended or NFT offer, a pause, a limit out of range and clearing nothing', () => {
    expect(first(review(500, { creator: OTHER }))).toBe('priceGuard.notCreator');
    expect(first(review(500, { open: false }))).toBe('priceGuard.notOpen');
    expect(first(review(500, { erc20Pair: false }))).toBe('priceGuard.notErc20');
    expect(first(review(500, { paused: true }))).toBe('priceGuard.paused');
    expect(first(review(49))).toMatch(/^priceGuard.outOfRange/);
    expect(first(review(5001))).toMatch(/^priceGuard.outOfRange/);
    expect(first(review(0))).toBe('priceGuard.alreadyOff');
    expect(first(review(500, { guard: 'absent' }))).toBe('priceGuard.absent');
  });

  it('names an unpriced pair, and passes any other dry-run refusal through', () => {
    expect(first(review(500, {}, { code: 'OfferPriceGuardUnpriced', reason: 'x', reopensAt: null, remedy: null }))).toBe('priceGuard.refusedUnpriced');
    expect(first(review(500, {}, { code: 'Other', reason: 'why', reopensAt: null, remedy: null }))).toMatch(/^safety.dryRunRefused/);
  });
});

describe('status and receipt', () => {
  it('says whether a fill is refused now, and why', () => {
    expect(guardRefuses(ON)).toBe(false);
    expect(guardRefuses({ ...ON, status: 'no-checkpoint' })).toBe(true);
    expect(guardStatusLine({ ...ON, status: 'moved', moveBps: 650 }, copy)).toBe('priceGuard.statusMoved:{"move":"6.5%","limit":"5%"}');
    expect(guardStatusLine({ ...ON, status: 'not-calm' }, copy)).toBe('priceGuard.statusNotCalm:{"calm":"3%"}');
  });

  it('states no guard now on a first guard, the replacement on a change, and an unread guard as unread', () => {
    expect(guardReceipt(review(500), copy).consequences).toContain('priceGuard.setGap');
    expect(guardReceipt(review(800, { guard: ON }), copy).consequences).toContain('priceGuard.setReplaces');
    const unread = guardReceipt(review(500, { guard: null }), copy).consequences;
    expect(unread).toContain('priceGuard.setUnknownNow');
    expect(unread).not.toContain('priceGuard.setGap');
    expect(unread).not.toContain('priceGuard.setReplaces');
    expect(guardReceipt(review(0, { guard: ON }), copy).title).toBe('priceGuard.titleClear');
  });
});

describe('measureGuard', () => {
  const log = (offerId: bigint, bps: number): Log =>
    ({
      address: DIAMOND,
      topics: encodeEventTopics({ abi: PRICE_GUARD, eventName: 'OfferPriceGuardSet', args: { offerId, creator: ME } } as never),
      data: encodeAbiParameters([{ type: 'uint16' }, { type: 'uint256' }, { type: 'uint256' }], [bps, 1n, 1n]),
    }) as unknown as Log;

  it('reads the change this offer recorded', () => {
    expect(measureGuard(review(500), [log(7n, 500)], DIAMOND, copy)[0]).toMatchObject({ status: 'done' });
    expect(measureGuard(review(500), [log(8n, 500)], DIAMOND, copy)[0]).toMatchObject({ status: 'not-done' });
    expect(measureGuard(review(0, { guard: ON }), [log(7n, 0)], DIAMOND, copy)[0]).toMatchObject({ status: 'done', label: 'priceGuard.legCleared' });
  });
});
