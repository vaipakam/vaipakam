import { describe, expect, it } from 'vitest';
import { ContractFunctionZeroDataError, parseEther, type PublicClient } from 'viem';
import { discountedFee, discountPercent, explanationOf, percentOf, readTierCard, tierRows, tierState, type TierExplanation } from './tiers';

const diamond = '0x00000000000000000000000000000000000000d1' as const;
const account = '0x00000000000000000000000000000000000000a1' as const;

const tiers = (bps: readonly bigint[]) =>
  [parseEther('100'), parseEther('1000'), parseEther('5000'), parseEther('20000')].map((threshold, i) => ({ threshold, bps: bps[i]! }));
const table = { tiers: tiers([1000n, 1500n, 2000n, 2400n]), lifBps: 20n, yieldFeeBps: 200n };

describe('the tier table', () => {
  it('computes each fee with its discount exactly, from the live figures', () => {
    const rows = tierRows(table);
    expect(rows.map((r) => [r.tier, r.discount, r.lif, r.yieldFee])).toEqual([
      [0, '0', '0.2', '2'],
      [1, '10', '0.18', '1.8'],
      [2, '15', '0.17', '1.7'],
      [3, '20', '0.16', '1.6'],
      [4, '24', '0.152', '1.52'],
    ]);
  });
  it('keeps the protocol’s boundaries: tiers 1 to 3 start at their figure, tier 4 above its own', () => {
    const rows = tierRows(table);
    expect(rows[0]).toMatchObject({ from: 0n, to: parseEther('100'), toIncluded: false });
    expect(rows[3]).toMatchObject({ from: parseEther('5000'), to: parseEther('20000'), toIncluded: true });
    expect(rows[4]).toMatchObject({ from: parseEther('20000'), fromAbove: true, to: null });
  });
  it('caps any discount at half a fee', () => {
    const rows = tierRows({ ...table, tiers: tiers([1000n, 3000n, 5000n, 9000n]) });
    expect(rows[4]).toMatchObject({ discount: '50', capped: true, lif: '0.1', yieldFee: '1' });
    expect(rows[3]).toMatchObject({ discount: '50', capped: false });
  });
  it('writes a percent exactly, without rounding', () => {
    expect(percentOf(152n * 10_000n)).toBe('1.52');
    expect(discountPercent(2450n)).toBe('24.5');
    expect(discountedFee(7n, 3333n)).toBe('0.046669');
  });
});

const explained = (over: Partial<TierExplanation> = {}): TierExplanation => ({
  canonical: true,
  counted: parseEther('2000'),
  countedTier: 2,
  holdingSince: 1_000,
  minHoldingEnds: 1_000 + 3 * 86_400,
  average: parseEther('2000'),
  averageTier: 2,
  lookbackTier: 2,
  effective: { tier: 2, bps: 1500n },
  heldBy: 'none',
  ...over,
});

describe('the tier the card states', () => {
  const base = { consent: true, home: true, effective: { tier: 2, bps: 1500n }, explain: explained() };
  it('states the protocol’s effective tier', () => {
    expect(tierState(base)).toEqual({ kind: 'applies', tier: 2, bps: 1500n, explained: true });
  });
  it('names the holding rule the protocol says holds the tier down', () => {
    const young = explained({ countedTier: 4, effective: { tier: 0, bps: 0n }, heldBy: 'too-young' });
    expect(tierState({ ...base, effective: { tier: 0, bps: 0n }, explain: young })).toEqual({
      kind: 'held-down',
      tier: 0,
      bps: 0n,
      counted: 4,
      held: { by: 'too-young', since: 1_000, ends: 1_000 + 3 * 86_400 },
    });
    const avg = explained({ countedTier: 4, averageTier: 2, lookbackTier: 3, heldBy: 'average' });
    expect(tierState({ ...base, explain: avg })).toMatchObject({ kind: 'held-down', counted: 4, held: { by: 'average', averageTier: 2 } });
    const dip = explained({ countedTier: 4, averageTier: 3, lookbackTier: 2, heldBy: 'lookback-dip' });
    expect(tierState({ ...base, explain: dip })).toMatchObject({ kind: 'held-down', held: { by: 'lookback-dip', lookbackTier: 2 } });
    const none = explained({ countedTier: 4, holdingSince: 0, effective: { tier: 0, bps: 0n }, heldBy: 'no-holding' });
    expect(tierState({ ...base, effective: { tier: 0, bps: 0n }, explain: none })).toMatchObject({ held: { by: 'no-holding' } });
  });
  it('names no rule for a reason this app does not know', () => {
    expect(tierState({ ...base, explain: explained({ countedTier: 4, heldBy: null }) })).toMatchObject({ kind: 'held-down', held: { by: 'unnamed' } });
  });
  it('uses no explanation that resolves another tier than the fee path applies', () => {
    expect(tierState({ ...base, explain: explained({ countedTier: 4, effective: { tier: 1, bps: 1000n }, heldBy: 'average' }) })).toEqual({
      kind: 'applies',
      tier: 2,
      bps: 1500n,
      explained: false,
    });
  });
  it('without the explanation, states the tier and that why could not be read', () => {
    expect(tierState({ ...base, explain: null })).toEqual({ kind: 'applies', tier: 2, bps: 1500n, explained: false });
  });
  it('says no tier applies while the consent is off, with the tier that would apply with it on, or that it is unread', () => {
    expect(tierState({ ...base, consent: false, effective: { tier: 0, bps: 0n } })).toEqual({ kind: 'consent-off', would: { tier: 2, bps: 1500n } });
    expect(tierState({ ...base, consent: false, explain: explained({ effective: { tier: 0, bps: 0n } }) })).toEqual({
      kind: 'consent-off',
      would: { tier: 0, bps: 0n },
    });
    // Unread is kept apart from a known tier 0, so the card can say so.
    expect(tierState({ ...base, consent: false, explain: null })).toEqual({ kind: 'consent-off', would: null });
  });
  it('away from the home network, states the copy sent from there', () => {
    expect(tierState({ ...base, home: false, explain: explained({ canonical: false, heldBy: 'mirror' }) })).toEqual({ kind: 'copy', tier: 2, bps: 1500n });
  });
  it('states nothing when a part did not answer', () => {
    expect(tierState({ ...base, home: null })).toEqual({ kind: 'unread' });
    expect(tierState({ ...base, effective: null })).toEqual({ kind: 'unread' });
  });
});

describe('the protocol’s explanation', () => {
  it('maps every rule the protocol names, in its order', () => {
    const raw = {
      canonical: true,
      countedBalance: 5n,
      balanceTier: 1,
      stakeStartSec: 7,
      minHoldingEndsSec: 9,
      twa: 4n,
      rawTier: 0,
      lookbackTier: 0,
      effTier: 0,
      effBps: 0,
    };
    const names = [0, 1, 2, 3, 4, 5, 6].map((heldBy) => explanationOf({ ...raw, heldBy }).heldBy);
    expect(names).toEqual(['none', 'no-holding', 'too-young', 'average', 'lookback-dip', 'mirror', null]);
    expect(explanationOf({ ...raw, heldBy: 2 })).toMatchObject({
      counted: 5n,
      countedTier: 1,
      holdingSince: 7,
      minHoldingEnds: 9,
      average: 4n,
      averageTier: 0,
    });
  });
});

const RAW_EXPLAIN = {
  canonical: true,
  countedBalance: 0n,
  balanceTier: 3,
  stakeStartSec: 1,
  minHoldingEndsSec: 2,
  twa: 0n,
  rawTier: 1,
  lookbackTier: 1,
  effTier: 1,
  effBps: 1000,
  heldBy: 3,
};
const RAW_RULES = { minStakedDays: 3, windowDays: 30, recentDays: 7, recentWeight: 3, lookbackCapDays: 30 };

function client(opts: { home: boolean; eff?: [number, number]; homeFails?: boolean; explainFails?: boolean }): PublicClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getBlockNumber: async () => 10n,
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      calls.push(`${functionName}@${String(blockNumber)}`);
      if (functionName === 'getVPFIDiscountConsent') return true;
      if (functionName === 'isCanonicalVpfiChain') {
        if (opts.homeFails) throw new ContractFunctionZeroDataError({ functionName });
        return opts.home;
      }
      if (functionName === 'getEffectiveDiscount') return opts.eff ?? [1, 1000];
      if (functionName === 'explainTier') {
        if (opts.explainFails) throw new ContractFunctionZeroDataError({ functionName });
        return RAW_EXPLAIN;
      }
      if (functionName === 'getTwaConfig') return RAW_RULES;
      throw new Error(`unexpected ${functionName}`);
    },
  } as unknown as PublicClient & { calls: string[] };
}

describe('reading the tier', () => {
  it('reads the tier, the explanation and the rules at one block', async () => {
    const home = client({ home: true, eff: [1, 1000] });
    const card = await readTierCard(home, diamond, account);
    expect(card).toMatchObject({
      effective: { tier: 1, bps: 1000n },
      home: true,
      explain: { countedTier: 3, heldBy: 'average' },
      rules: { minHoldingDays: 3, windowDays: 30, recentDays: 7, recentWeight: 3, lookbackCapDays: 30 },
    });
    expect(home.calls.every((c) => c.endsWith('@10'))).toBe(true);
    expect(tierState(card)).toMatchObject({ kind: 'held-down', counted: 3, held: { by: 'average', averageTier: 1 } });
  });
  it('an unanswered explanation names no rule and is said', async () => {
    const card = await readTierCard(client({ home: true, explainFails: true }), diamond, account);
    expect(card.explain).toBeNull();
    expect(tierState(card)).toEqual({ kind: 'applies', tier: 1, bps: 1000n, explained: false });
  });
  it('an unanswered home-network flag is unread, never "away"', async () => {
    const card = await readTierCard(client({ home: true, homeFails: true }), diamond, account);
    expect(card.home).toBeNull();
    expect(tierState(card)).toEqual({ kind: 'unread' });
  });
});
