/**
 * #1208 — "what happens if" on a loan review: three plain illustrations for
 * the loan being opened, each labelled as an illustration and not a
 * forecast. The collateral price falls 30%, the loan is repaid late, the
 * loan is repaid early. Every figure comes from the review's own reads (the
 * protocol's preview, its loan-to-value rule, the liquidation ratio the loan
 * would be stamped with, the grace period for its term); nothing here is a
 * new promise, and a figure that could not be read is said to be unread.
 *
 * Not yet covered: the late fee's amount (the protocol has no view of its
 * schedule, so the line names the fee without a figure), floating-rate loans
 * and instant-market groups (#3637, #3656), which arrive with their reviews.
 */
import type { PublicClient } from 'viem';
import type { CopyAccess } from '../copy/useCopy';
import type { AssetClass } from '../offers/assets';
import { CONFIG, ORACLE } from '../offers/reads';
import type { ReceiptSection } from '../receipt/types';
import { formatBps, formatSpan } from '../ui/format';

type Hex = `0x${string}`;

const BPS = 10_000n;
/** The price fall the review illustrates, in basis points (owner, 2026-11-15). */
export const PRICE_FALL_BPS = 3_000n;

/** What a price fall does to this loan: a ratio against the liquidation
 *  ratio, no price-based liquidation at all, or unread. */
export type PriceRisk = { kind: 'ratio'; ltvBps: bigint; liqLtvBps: bigint } | { kind: 'illiquid' } | { kind: 'unread' };

/**
 * The loan-to-value the protocol puts on these amounts now (OracleFacet
 * `calculateLTV`) and the liquidation ratio the loan would be stamped with:
 * the collateral's effective liquidity tier's threshold, where an untiered
 * asset takes tier 1's, as the loan's own snapshot does.
 */
export async function readPriceRisk(
  c: PublicClient,
  diamond: Hex,
  lending: Hex,
  principal: bigint,
  collateral: Hex,
  collateralAmount: bigint,
  classes: readonly [AssetClass, AssetClass],
): Promise<PriceRisk> {
  if (classes.includes('illiquid')) return { kind: 'illiquid' };
  try {
    const [ltvBps, tier, tiers] = await Promise.all([
      c.readContract({ address: diamond, abi: ORACLE, functionName: 'calculateLTV', args: [lending, principal, collateral, collateralAmount] }) as Promise<bigint>,
      c.readContract({ address: diamond, abi: ORACLE, functionName: 'getEffectiveLiquidityTier', args: [collateral] }) as Promise<number | bigint>,
      c.readContract({ address: diamond, abi: CONFIG, functionName: 'getTierLiquidationLtvBps' }) as Promise<readonly [bigint, bigint, bigint]>,
    ]);
    return { kind: 'ratio', ltvBps, liqLtvBps: liquidationRatio(Number(tier), tiers) };
  } catch {
    return { kind: 'unread' };
  }
}

/** The liquidation ratio for a tier: tier 0 (untiered) takes tier 1's, the
 *  most conservative, as the protocol's own rule does. */
export function liquidationRatio(tier: number, tiers: readonly [bigint, bigint, bigint]): bigint {
  if (tier === 2) return tiers[1];
  if (tier === 3) return tiers[2];
  return tiers[0];
}

/** The loan-to-value after the collateral price falls by `fallBps`, the
 *  borrowed asset's price unchanged. */
export function ratioAfterFall(ltvBps: bigint, fallBps: bigint): bigint {
  return (ltvBps * BPS) / (BPS - fallBps);
}

/** The price fall at which the ratio reaches the liquidation ratio, in
 *  basis points; 0 when it already has. */
export function fallToLiquidation(ltvBps: bigint, liqLtvBps: bigint): bigint {
  if (liqLtvBps === 0n || ltvBps >= liqLtvBps) return 0n;
  return BPS - (ltvBps * BPS) / liqLtvBps;
}

export interface WhatIfInput {
  side: 'borrower' | 'lender';
  price: PriceRisk;
  /** Interest owed at the due date, and its token amount in words. */
  interest: bigint;
  interestText: (amount: bigint) => string;
  fullTermInterest: boolean;
  graceSeconds: bigint;
}

/** The section's lines, in order: price fall, late, early. */
export function whatIfLines(w: WhatIfInput, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const { text, format } = copy;
  const lines: string[] = [];
  if (w.price.kind === 'illiquid') lines.push(text('whatIf.priceIlliquid'));
  else if (w.price.kind === 'unread') lines.push(text('whatIf.priceUnread'));
  else {
    const after = ratioAfterFall(w.price.ltvBps, PRICE_FALL_BPS);
    const vars = { fall: formatBps(PRICE_FALL_BPS), now: formatBps(w.price.ltvBps), after: formatBps(after), liq: formatBps(w.price.liqLtvBps) };
    lines.push(format(after > w.price.liqLtvBps ? 'whatIf.priceLiquidated' : 'whatIf.priceHolds', vars));
    const room = fallToLiquidation(w.price.ltvBps, w.price.liqLtvBps);
    if (room > 0n) lines.push(format('whatIf.priceRoom', { fall: formatBps(room) }));
  }
  const span = formatSpan(Number(w.graceSeconds));
  lines.push(format(w.side === 'borrower' ? 'whatIf.lateBorrower' : 'whatIf.lateLender', { span }));
  const full = w.interestText(w.interest);
  if (w.fullTermInterest) lines.push(format(w.side === 'borrower' ? 'whatIf.earlyFullBorrower' : 'whatIf.earlyFullLender', { full }));
  else {
    const half = w.interestText(w.interest / 2n);
    lines.push(format(w.side === 'borrower' ? 'whatIf.earlyProRataBorrower' : 'whatIf.earlyProRataLender', { half, full }));
  }
  return lines;
}

/** The review's "what happens if" section, under its own heading. */
export function whatIfSection(w: WhatIfInput, copy: Pick<CopyAccess, 'text' | 'format'>): ReceiptSection {
  return { title: copy.text('whatIf.title'), body: whatIfLines(w, copy) };
}
