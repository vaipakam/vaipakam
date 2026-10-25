// apps/keeper/src/discountedLiquidation.ts
//
// #2697 — how the flash-loan discount path decides whether, and how, to send
// one discounted liquidation through the chain's FlashLoanLiquidator.
//
// Every figure the decision uses is a measurement, never a placeholder:
//
//   - The DEBT and the SEIZURE come from the Diamond's own preview
//     (`ForcedSaleFacet.previewDiscountedLiquidation`), which reads the rule
//     the liquidation itself charges and seizes by. The FlashLoanLiquidator
//     reads that preview again inside the liquidating transaction and
//     flash-borrows exactly its debt, so the keeper never sizes the flash
//     loan; it uses the preview to size the SWAP, which is quoted for exactly
//     the previewed seizure.
//   - The GAS is the transaction's whole fee (txFee.ts), estimated on the
//     exact call the keeper would send, and converted into the principal
//     token's own base units by the Diamond (`getAmountForNumeraireValue`),
//     so a 6-decimal and an 18-decimal principal are each priced in their own
//     units. Before #2697 it was a fixed 1e18 base units, one token only for
//     an 18-decimal principal.
//   - The PROFIT the run must keep is that fee (`minProfit`), enforced by the
//     FlashLoanLiquidator on-chain. The keeper simulates the run with no
//     floor to measure the fee, then with the floor that fee implies, and
//     re-sizes the floor if the floored call measures dearer, so the call it
//     sends never nets less than its own measured fee. A trade that would not
//     net its gas reverts in the simulation, is skipped with its reason, and
//     is never sent. Each simulation runs the whole trade, the real
//     flash-loan fee and the real swap included.
//
// The decision is a pure function of injected reads (`planFlashLoanLiquidation`)
// so it can be tested without a chain; keeper.ts supplies the reads.

import { ForcedSaleFacetABI, NumeraireValueFacetABI } from '@vaipakam/contracts/abis';
import { summarizeFailure } from '@vaipakam/lib/errorDescription';
import type { Abi, Address, Hex, PublicClient } from 'viem';
import type { DexDirectQuote } from './dexDirectQuotes';
import { feeNumeraireValue, txFeeUnpricedReason } from './txFee';

/** `LibDiscountedLiquidation.Status`, by value. Append-only on the contract. */
export const DISCOUNTED_LIQUIDATION_STATUS = [
  'Paused',
  'Disabled',
  'NotActive',
  'SequencerUnhealthy',
  'Healthy',
  'Untiered',
  'Unpriced',
  'Ready',
] as const;
export const DISCOUNTED_LIQUIDATION_READY = DISCOUNTED_LIQUIDATION_STATUS.indexOf('Ready');

/** Why the preview says the liquidation cannot run, in words for the log. */
const STATUS_REASON: Readonly<Record<string, string>> = {
  Paused: 'the protocol is paused',
  Disabled: "the Diamond's discount-path switch is off",
  NotActive: 'the loan is not Active',
  SequencerUnhealthy: 'the sequencer circuit breaker is tripped',
  Healthy: 'the loan is healthy',
  Untiered: 'the collateral has no liquidity tier',
  Unpriced: 'an oracle price is unavailable',
};

export function discountedStatusReason(status: number): string {
  const name = DISCOUNTED_LIQUIDATION_STATUS[status];
  return name === undefined ? `unknown status ${status}` : (STATUS_REASON[name] ?? name);
}

/** `ForcedSaleFacet.previewDiscountedLiquidation`. */
export interface DiscountedLiquidationPreview {
  status: number;
  principalAsset: Address;
  collateralAsset: Address;
  tier: number;
  discountBps: number;
  debt: bigint;
  seized: bigint;
  surplus: bigint;
}

/** Read the preview. Throws what the read throws (a distrusted price, an RPC
 *  failure): a caller that cannot read it cannot size the swap. */
export async function readDiscountedLiquidation(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
  loanId: bigint,
): Promise<DiscountedLiquidationPreview> {
  return (await client.readContract({
    address: diamond,
    abi: ForcedSaleFacetABI as Abi,
    functionName: 'previewDiscountedLiquidation',
    args: [loanId],
  })) as DiscountedLiquidationPreview;
}

/** The least net profit a run must keep: its fee, in the principal token's
 *  base units. Both conversions round UP, so a borderline trade is refused
 *  rather than run at a loss. */
export type MinProfit = { kind: 'priced'; minProfit: bigint } | { kind: 'unpriced'; reason: string };

export async function minProfitForFee(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
  chainId: number,
  principalAsset: Address,
  feeWei: bigint,
): Promise<MinProfit> {
  const fee = await feeNumeraireValue(client, diamond, chainId, feeWei);
  if (fee.kind === 'unpriced') return fee;
  try {
    const minProfit = (await client.readContract({
      address: diamond,
      abi: NumeraireValueFacetABI as Abi,
      functionName: 'getAmountForNumeraireValue',
      args: [principalAsset, fee.value, true],
    })) as bigint;
    return { kind: 'priced', minProfit };
  } catch (err) {
    return {
      kind: 'unpriced',
      reason: `the Diamond could not express the fee in ${principalAsset}: ${summarizeFailure(err, 120)}`,
    };
  }
}

/** The FlashLoanLiquidator entry for a provider. */
export type FlashLoanVia = 'aave-v3' | 'balancer-v2';
export function liquidatorFunction(via: FlashLoanVia): 'liquidateViaAaveV3' | 'liquidateViaBalancerV2' {
  return via === 'aave-v3' ? 'liquidateViaAaveV3' : 'liquidateViaBalancerV2';
}

/** `liquidateVia*(loanId, sellAmount, minProfit, swapTarget, swapAllowanceTarget, swapCalldata)`. */
export type LiquidatorArgs = readonly [bigint, bigint, bigint, Address, Address, Hex];

export interface FlashLoanPlanDeps {
  chainId: number;
  loanId: bigint;
  readPreview: () => Promise<DiscountedLiquidationPreview>;
  /** Best-first DEX-direct quotes for selling `sellAmount` of collateral for
   *  principal, with the FlashLoanLiquidator as taker. */
  quote: (sellAmount: bigint, preview: DiscountedLiquidationPreview) => Promise<DexDirectQuote[]>;
  /** The whole fee of sending these arguments; throws the call's revert. */
  estimateFee: (args: LiquidatorArgs) => Promise<bigint>;
  minProfit: (principalAsset: Address, feeWei: bigint) => Promise<MinProfit>;
}

export type FlashLoanPlan =
  | { kind: 'skip'; reason: string }
  | {
      kind: 'send';
      args: LiquidatorArgs;
      preview: DiscountedLiquidationPreview;
      quote: DexDirectQuote;
      feeWei: bigint;
      minProfit: bigint;
    };

/** Decide one loan. Every skip names its reason; nothing throws except a
 *  caller's own dependency throwing outside the reads handled here. */
export async function planFlashLoanLiquidation(deps: FlashLoanPlanDeps): Promise<FlashLoanPlan> {
  const unpricedChain = txFeeUnpricedReason(deps.chainId);
  if (unpricedChain) return { kind: 'skip', reason: `gas cannot be valued: ${unpricedChain}` };

  let preview: DiscountedLiquidationPreview;
  try {
    preview = await deps.readPreview();
  } catch (err) {
    return { kind: 'skip', reason: `preview unread: ${summarizeFailure(err, 160)}` };
  }
  if (preview.status !== DISCOUNTED_LIQUIDATION_READY) {
    return { kind: 'skip', reason: `not liquidatable: ${discountedStatusReason(preview.status)}` };
  }
  if (preview.seized === 0n) return { kind: 'skip', reason: 'the liquidation seizes no collateral' };

  const quotes = await deps.quote(preview.seized, preview);
  const best = quotes[0];
  if (!best) return { kind: 'skip', reason: 'no DEX-direct quote for the seizure' };
  // A pre-filter only: proceeds that do not even repay the debt cannot net a
  // profit whatever the fees. The authoritative check is the simulation below.
  if (best.expectedOutput <= preview.debt) {
    return {
      kind: 'skip',
      reason: `unprofitable: quoted proceeds ${best.expectedOutput} do not exceed the debt ${preview.debt}`,
    };
  }

  const args = (minProfit: bigint): LiquidatorArgs =>
    [deps.loanId, preview.seized, minProfit, best.swapTarget, best.swapAllowanceTarget, best.swapCalldata] as const;
  // Estimated first with no profit floor: what it costs to send at all.
  let feeWei: bigint;
  try {
    feeWei = await deps.estimateFee(args(0n));
  } catch (err) {
    return { kind: 'skip', reason: `simulation reverted: ${summarizeFailure(err, 200)}` };
  }
  // Then simulate WITH the floor that fee implies. A run that nets something,
  // but less than its fee, reverts here and is skipped with its reason rather
  // than failing at submission. Carrying the floor changes the call itself
  // (non-zero calldata, and any L1 data fee priced on it), so the floored
  // call can cost more than the call the floor was sized from: the floor is
  // re-sized from each floored measurement until the measured fee no longer
  // exceeds the fee it was sized from, so the call sent never nets less than
  // its own measured fee.
  for (let round = 0; round < FLOOR_ROUNDS; round++) {
    const floor = await deps.minProfit(preview.principalAsset, feeWei);
    if (floor.kind === 'unpriced') return { kind: 'skip', reason: `gas cannot be valued: ${floor.reason}` };
    let flooredFee: bigint;
    try {
      flooredFee = await deps.estimateFee(args(floor.minProfit));
    } catch (err) {
      return {
        kind: 'skip',
        reason: `does not net its fee of ${floor.minProfit}: ${summarizeFailure(err, 200)}`,
      };
    }
    if (flooredFee <= feeWei) {
      return { kind: 'send', args: args(floor.minProfit), preview, quote: best, feeWei, minProfit: floor.minProfit };
    }
    feeWei = flooredFee;
  }
  return { kind: 'skip', reason: `the fee kept rising with its own profit floor after ${FLOOR_ROUNDS} simulations` };
}

/** Re-sizings of the profit floor before giving up. Each one only changes the
 *  floor's calldata bytes, so a second round settles any real call. */
const FLOOR_ROUNDS = 3;
