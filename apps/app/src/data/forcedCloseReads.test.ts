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

/** Every slot answering, in plan order. */
function allGood(plan: readonly ForcedCloseReadEntry[]): MulticallSlot[] {
  return plan.map((e) => {
    switch (e.key) {
      case 'block':
        return ok(46_725_021n);
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

  it('keeps the facts when only the block call failed, and names no block', () => {
    const plan = planWith(ASSET);
    const slots = allGood(plan).map((s, i) => (plan[i].key === 'block' ? fail : s));
    const facts = forcedCloseFacts(plan, slots);
    expect(facts.block).toBeUndefined();
    expect(facts.defaultable).toBe(true);
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
