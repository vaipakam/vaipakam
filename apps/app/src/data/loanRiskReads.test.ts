/**
 * The loan-risk aggregate's plan and mapper, and the liquidation price
 * derived from it (#2531), tested without a chain.
 */
import { describe, expect, it } from 'vitest';
import {
  liquidationPriceOf,
  loanRiskFromSlots,
  loanRiskReadPlan,
  type LoanRiskReadEntry,
  type MulticallSlot,
} from './loanRiskReads';

const DIAMOND = '0x000000000000000000000000000000000000d1a0' as const;
const ASSET = '0x00000000000000000000000000000000000a55e7' as const;
const WAD = 10n ** 18n;
const MAX = 2n ** 256n - 1n;
const USD = `0x${'0'.repeat(64)}`;
const EUR = `0x455552${'0'.repeat(58)}`;

const ok = (result: unknown): MulticallSlot => ({ status: 'success', result });
const fail: MulticallSlot = { status: 'failure', error: new Error('reverted') };

const withCollateral = () =>
  loanRiskReadPlan({ diamond: DIAMOND, loanId: 9n, collateral: { asset: ASSET, decimals: 8 } });

function answers(plan: readonly LoanRiskReadEntry[], over: Partial<Record<string, MulticallSlot>> = {}) {
  const base: Record<string, MulticallSlot> = {
    hf: ok(2n * WAD),
    ltv: ok(4n * 10n ** 17n),
    unitValue: ok(60_000n * WAD),
    numeraire: ok(USD),
  };
  return plan.map((e) => over[e.key] ?? base[e.key]);
}

describe('loanRiskReadPlan', () => {
  it('reads the health factor and LTV alone unless a collateral is named', () => {
    const plan = loanRiskReadPlan({ diamond: DIAMOND, loanId: 9n });
    expect(plan.map((e) => e.key)).toEqual(['hf', 'ltv']);
    expect(plan[0].contract.functionName).toBe('calculateHealthFactor');
    expect(plan[1].contract.functionName).toBe('calculateLTV');
    expect(plan[0].contract.args).toEqual([9n]);
  });

  it('values ONE WHOLE collateral unit on the collateral leg’s rule, beside the numeraire symbol', () => {
    const plan = withCollateral();
    expect(plan.map((e) => e.key)).toEqual(['hf', 'ltv', 'unitValue', 'numeraire']);
    const byKey = Object.fromEntries(plan.map((e) => [e.key, e.contract]));
    expect(byKey.unitValue.functionName).toBe('getNumeraireValue');
    // 10^decimals, and `false`: the collateral leg rounds down.
    expect(byKey.unitValue.args).toEqual([ASSET, 10n ** 8n, false]);
    expect(byKey.numeraire.functionName).toBe('getNumeraireSymbol');
  });
});

describe('loanRiskFromSlots', () => {
  it('maps a priced loan and derives the liquidation price from the same aggregate', () => {
    const plan = withCollateral();
    expect(loanRiskFromSlots(plan, answers(plan))).toEqual({
      priced: true,
      healthFactor: 2n * WAD,
      ltv: 4n * 10n ** 17n,
      // HF 2.00 at 60,000 → the line is at 30,000.
      liquidationPrice: {
        kind: 'priced',
        perUnitWad: 30_000n * WAD,
        numeraire: { symbol: 'USD', isDefault: true },
      },
    });
  });

  it('reads either risk revert as unpriced, whatever the collateral pair says', () => {
    const plan = withCollateral();
    for (const key of ['hf', 'ltv']) {
      expect(loanRiskFromSlots(plan, answers(plan, { [key]: fail }))).toEqual({
        priced: false,
        healthFactor: 0n,
        ltv: 0n,
      });
    }
  });

  it('keeps the loan priced when only the collateral price failed — the price is unknown, not zero', () => {
    const plan = withCollateral();
    const risk = loanRiskFromSlots(plan, answers(plan, { unitValue: fail }));
    expect(risk.priced).toBe(true);
    expect(risk.healthFactor).toBe(2n * WAD);
    expect(risk.liquidationPrice).toEqual({ kind: 'unknown' });
  });

  it('names no unit it cannot read, and keeps the price', () => {
    const plan = withCollateral();
    const risk = loanRiskFromSlots(plan, answers(plan, { numeraire: fail }));
    expect(risk.liquidationPrice).toMatchObject({ kind: 'priced', numeraire: null });
  });

  it('carries no liquidation price when none was asked for', () => {
    const plan = loanRiskReadPlan({ diamond: DIAMOND, loanId: 9n });
    expect(loanRiskFromSlots(plan, answers(plan)).liquidationPrice).toBeUndefined();
  });

  it('refuses a slot count that does not match the plan', () => {
    const plan = withCollateral();
    expect(() => loanRiskFromSlots(plan, answers(plan).slice(1))).toThrow(/slot/);
  });
});

describe('liquidationPriceOf', () => {
  it('rounds UP, so the line shown is never below the real one', () => {
    // 100 / 3 = 33.33… → the last wei rounds up.
    const lp = liquidationPriceOf(3n * WAD, 100n * WAD, EUR);
    expect(lp).toEqual({
      kind: 'priced',
      perUnitWad: (100n * WAD * WAD + 3n * WAD - 1n) / (3n * WAD),
      numeraire: { symbol: 'EUR', isDefault: false },
    });
    expect((lp as { perUnitWad: bigint }).perUnitWad * 3n).toBeGreaterThanOrEqual(100n * WAD);
  });

  it('is above the current price once the health factor is below 1.00', () => {
    const lp = liquidationPriceOf(WAD / 2n, 10n * WAD, USD);
    expect(lp).toMatchObject({ kind: 'priced', perUnitWad: 20n * WAD });
  });

  it('has no line when the health factor saturated', () => {
    expect(liquidationPriceOf(MAX, 10n * WAD, USD)).toEqual({ kind: 'none' });
  });

  it('says unknown rather than zero for a zero or unread price, or a zero health factor', () => {
    expect(liquidationPriceOf(2n * WAD, 0n, USD)).toEqual({ kind: 'unknown' });
    expect(liquidationPriceOf(2n * WAD, undefined, USD)).toEqual({ kind: 'unknown' });
    expect(liquidationPriceOf(0n, 10n * WAD, USD)).toEqual({ kind: 'unknown' });
  });
});
