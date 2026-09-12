/**
 * The aggregate's plan and mapper, tested without a chain.
 *
 * The property that matters is the one the old per-query design existed
 * for: a failed slot is `undefined` for ITS field and nothing else. The
 * expected shape of that failure is an LTV revert on illiquid collateral,
 * which must leave defaultability standing.
 */
import { describe, expect, it } from 'vitest';
import { LIQUIDITY_LIQUID } from '../contracts/preflights';
import {
  forcedCloseFacts,
  forcedCloseReadPlan,
  type ForcedCloseReadEntry,
  type MulticallSlot,
} from './forcedCloseReads';

const DIAMOND = '0x000000000000000000000000000000000000d1a0' as const;
const MC3 = '0xca11bde05977b3631167028862be2a173976ca11' as const;
const ASSET = '0x00000000000000000000000000000000000a55e7' as const;

const planWith = (asset: `0x${string}` | undefined) =>
  forcedCloseReadPlan({ diamond: DIAMOND, multicall3: MC3, loanId: 7n, collateralAsset: asset });

const ok = (result: unknown): MulticallSlot => ({ status: 'success', result });
const fail: MulticallSlot = { status: 'failure', error: new Error('reverted') };

/** An Active ERC-20 loan with ERC-20 collateral and both-party consent,
 *  as `getLoanDetails` decodes it (enums as numbers). */
const LOAN = {
  status: 0,
  assetType: 0,
  collateralAssetType: 0,
  collateralAsset: ASSET,
  riskAndTermsConsentFromBoth: true,
};

/** Every slot answering, in plan order. */
function allGood(plan: readonly ForcedCloseReadEntry[]): MulticallSlot[] {
  return plan.map((e) => {
    switch (e.key) {
      case 'block':
        return ok(46_725_021n);
      case 'loan':
        return ok(LOAN);
      case 'defaultable':
        return ok(true);
      case 'sequencer':
        return ok(true);
      case 'paused':
        return ok(false);
      case 'match':
        return ok([false, 0n]);
      case 'liquidity':
        return ok(BigInt(LIQUIDITY_LIQUID));
      case 'ltv':
        return ok(5_000n);
      case 'risk':
        return ok([11_000n, 0n]);
    }
  });
}

describe('forcedCloseReadPlan', () => {
  it('asks the block of Multicall3 itself, first', () => {
    const plan = planWith(ASSET);
    expect(plan[0].key).toBe('block');
    expect(plan[0].contract.address).toBe(MC3);
    expect(plan[0].contract.functionName).toBe('getBlockNumber');
  });

  it('asks liquidity only when there is an asset to ask about', () => {
    expect(planWith(ASSET).map((e) => e.key)).toContain('liquidity');
    expect(planWith(undefined).map((e) => e.key)).not.toContain('liquidity');
  });

  it('addresses every diamond read at the diamond, with the loan where one is needed', () => {
    for (const e of planWith(ASSET)) {
      if (e.key === 'block') continue;
      expect(e.contract.address).toBe(DIAMOND);
    }
    const byKey = Object.fromEntries(planWith(ASSET).map((e) => [e.key, e.contract]));
    expect(byKey.loan.args).toEqual([7n]);
    expect(byKey.defaultable.args).toEqual([7n]);
    expect(byKey.match.args).toEqual([7n]);
    expect(byKey.ltv.args).toEqual([7n]);
    expect(byKey.liquidity.args).toEqual([ASSET]);
  });
});

describe('forcedCloseFacts', () => {
  it('maps a fully answered aggregate, block included', () => {
    const plan = planWith(ASSET);
    expect(forcedCloseFacts(plan, allGood(plan))).toEqual({
      block: 46_725_021n,
      active: true,
      consentFromBoth: true,
      assetType: 'erc20',
      collateralIsNft: false,
      defaultable: true,
      sequencerHealthy: true,
      paused: false,
      internalMatchCandidate: false,
      collateralIlliquid: false,
      ltvCollapsed: false,
    });
  });

  it('keeps defaultability when the LTV read reverts — the case the batching rule was written for', () => {
    const plan = planWith(ASSET);
    const slots = allGood(plan).map((s, i) => (plan[i].key === 'ltv' ? fail : s));
    const facts = forcedCloseFacts(plan, slots);
    expect(facts.ltvCollapsed).toBeUndefined();
    expect(facts.defaultable).toBe(true);
    expect(facts.block).toBe(46_725_021n);
  });

  it('needs BOTH halves of the LTV comparison', () => {
    const plan = planWith(ASSET);
    const slots = allGood(plan).map((s, i) => (plan[i].key === 'risk' ? fail : s));
    expect(forcedCloseFacts(plan, slots).ltvCollapsed).toBeUndefined();
  });

  it('reports a collapse against the resolved threshold', () => {
    const plan = planWith(ASSET);
    const slots = allGood(plan).map((s, i) => (plan[i].key === 'ltv' ? ok(11_001n) : s));
    expect(forcedCloseFacts(plan, slots).ltvCollapsed).toBe(true);
  });

  it('reads illiquidity as anything but the liquid status', () => {
    const plan = planWith(ASSET);
    const slots = allGood(plan).map((s, i) => (plan[i].key === 'liquidity' ? ok(2n) : s));
    expect(forcedCloseFacts(plan, slots).collateralIlliquid).toBe(true);
  });

  it('leaves liquidity unread for a plan without an asset', () => {
    const plan = planWith(undefined);
    expect(forcedCloseFacts(plan, allGood(plan)).collateralIlliquid).toBeUndefined();
  });

  // #2148 round 4 P2 — the inverse of what this case first asserted. A
  // resolved state must carry the block it was resolved at, so facts the
  // app cannot date are not stated: a failed block call unreads them all.
  it('unreads every fact when the block call failed — a decision it cannot date is not stated', () => {
    const plan = planWith(ASSET);
    const slots = allGood(plan).map((s, i) => (plan[i].key === 'block' ? fail : s));
    const facts = forcedCloseFacts(plan, slots);
    expect(facts.block).toBeUndefined();
    for (const [key, value] of Object.entries(facts)) {
      expect(value, key).toBeUndefined();
    }
  });

  it('treats a block of the wrong shape the same as a failed one', () => {
    const plan = planWith(ASSET);
    const slots = allGood(plan).map((s, i) => (plan[i].key === 'block' ? ok('46725021') : s));
    expect(forcedCloseFacts(plan, slots).defaultable).toBeUndefined();
  });

  // #2148 round 1 P1 — the loan's OWN status, consent and shape come from
  // the same execution as the polled facts, so the published block dates
  // the whole decision rather than part of it.
  it('reads status, consent and shape off the loan struct in the same aggregate', () => {
    const plan = planWith(ASSET);
    const withLoan = (loan: object) =>
      forcedCloseFacts(plan, allGood(plan).map((s, i) => (plan[i].key === 'loan' ? ok(loan) : s)));
    expect(withLoan({ ...LOAN, status: 1 }).active).toBe(false);
    expect(withLoan({ ...LOAN, riskAndTermsConsentFromBoth: false }).consentFromBoth).toBe(false);
    expect(withLoan({ ...LOAN, assetType: 1 }).assetType).toBe('rental');
    expect(withLoan({ ...LOAN, collateralAssetType: 2 }).collateralIsNft).toBe(true);
    // Enums may decode as bigint on some paths; the mapper reads either.
    expect(withLoan({ ...LOAN, status: 0n, assetType: 0n, collateralAssetType: 1n })).toMatchObject({
      active: true,
      assetType: 'erc20',
      collateralIsNft: true,
    });
  });

  it('leaves status, consent and shape unread when the loan slot failed, and the rest standing', () => {
    const plan = planWith(ASSET);
    const facts = forcedCloseFacts(plan, allGood(plan).map((s, i) => (plan[i].key === 'loan' ? fail : s)));
    expect(facts.active).toBeUndefined();
    expect(facts.consentFromBoth).toBeUndefined();
    expect(facts.assetType).toBeUndefined();
    expect(facts.collateralIsNft).toBeUndefined();
    expect(facts.defaultable).toBe(true);
    expect(facts.block).toBe(46_725_021n);
  });

  // #2148 round 2 P2 — the liquidity slot answers about the asset the
  // CALLER named; the aggregate's own loan struct says which asset the loan
  // is actually secured by. They must agree or the answer is not about
  // this loan.
  it('reads liquidity only when the asked asset is the loan struct\'s own collateral', () => {
    const plan = planWith(ASSET);
    const withLoan = (loan: object) =>
      forcedCloseFacts(plan, allGood(plan).map((s, i) => (plan[i].key === 'loan' ? ok(loan) : s)));
    // Same address, different case — still the same asset.
    expect(withLoan({ ...LOAN, collateralAsset: ASSET.toUpperCase().replace('0X', '0x') }).collateralIlliquid).toBe(false);
    // A different token: the slot answered about something else.
    const other = '0x00000000000000000000000000000000000beef0';
    const facts = withLoan({ ...LOAN, collateralAsset: other });
    expect(facts.collateralIlliquid).toBeUndefined();
    // The rest of the decision is untouched by the mismatch.
    expect(facts.defaultable).toBe(true);
    expect(facts.block).toBe(46_725_021n);
    // No struct address to compare against: not an answer either.
    expect(withLoan({ ...LOAN, collateralAsset: undefined }).collateralIlliquid).toBeUndefined();
  });

  it('does not read a struct of an unexpected shape as evidence', () => {
    const plan = planWith(ASSET);
    const facts = forcedCloseFacts(plan, allGood(plan).map((s, i) => (plan[i].key === 'loan' ? ok(['not', 'a', 'struct']) : s)));
    expect(facts.active).toBeUndefined();
    expect(facts.consentFromBoth).toBeUndefined();
  });

  it('reads the match candidate off the tuple', () => {
    const plan = planWith(ASSET);
    const slots = allGood(plan).map((s, i) => (plan[i].key === 'match' ? ok([true, 42n]) : s));
    expect(forcedCloseFacts(plan, slots).internalMatchCandidate).toBe(true);
  });

  it('refuses a slot count that does not match the plan rather than mis-assigning fields', () => {
    const plan = planWith(ASSET);
    expect(() => forcedCloseFacts(plan, allGood(plan).slice(1))).toThrow(/slot/);
  });
});
