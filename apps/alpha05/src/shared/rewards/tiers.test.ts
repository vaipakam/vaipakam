import { describe, expect, it } from 'vitest';
import { ContractFunctionZeroDataError, parseEther, type PublicClient } from 'viem';
import { discountedFee, discountPercent, percentOf, readTierCard, tierRows, tierState } from './tiers';

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

describe('the tier the card states', () => {
  const base = { consent: true, home: true, effective: { tier: 2, bps: 1500n }, counted: 2 };
  it('states the protocol’s effective tier', () => {
    expect(tierState(base)).toEqual({ kind: 'applies', tier: 2, bps: 1500n });
  });
  it('says the holding rules hold it down when the counted VPFI alone gives more', () => {
    expect(tierState({ ...base, counted: 4 })).toEqual({ kind: 'held-down', tier: 2, bps: 1500n, counted: 4 });
  });
  it('says no tier applies while the consent is off, whatever is held', () => {
    expect(tierState({ ...base, consent: false, effective: { tier: 0, bps: 0n } })).toEqual({ kind: 'consent-off' });
  });
  it('away from the home network, states the copy sent from there', () => {
    expect(tierState({ ...base, home: false, counted: null })).toEqual({ kind: 'copy', tier: 2, bps: 1500n });
  });
  it('states nothing when a part did not answer', () => {
    expect(tierState({ ...base, home: null })).toEqual({ kind: 'unread' });
    expect(tierState({ ...base, effective: null })).toEqual({ kind: 'unread' });
  });
});

function client(opts: { home: boolean; eff?: [number, number]; counted?: number; homeFails?: boolean }): PublicClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getBlockNumber: async () => 10n,
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      if (functionName === 'getVPFIDiscountConsent') return true;
      if (functionName === 'isCanonicalVpfiChain') {
        if (opts.homeFails) throw new ContractFunctionZeroDataError({ functionName });
        return opts.home;
      }
      if (functionName === 'getEffectiveDiscount') return opts.eff ?? [1, 1000];
      if (functionName === 'getTrackedVPFIDiscountTier') return [opts.counted ?? 1, 0n, 0n];
      throw new Error(`unexpected ${functionName}`);
    },
  } as unknown as PublicClient & { calls: string[] };
}

describe('reading the tier', () => {
  it('reads the counted tier on the home network only', async () => {
    const home = client({ home: true, eff: [1, 1000], counted: 3 });
    expect(await readTierCard(home, diamond, account)).toMatchObject({ effective: { tier: 1, bps: 1000n }, counted: 3, home: true });
    const away = client({ home: false });
    const card = await readTierCard(away, diamond, account);
    expect(card.counted).toBeNull();
    expect(away.calls).not.toContain('getTrackedVPFIDiscountTier');
  });
  it('an unanswered home-network flag is unread, never "away"', async () => {
    const card = await readTierCard(client({ home: true, homeFails: true }), diamond, account);
    expect(card.home).toBeNull();
    expect(tierState(card)).toEqual({ kind: 'unread' });
  });
});
