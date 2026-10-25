/**
 * #2760 item 3 — the value floor for an auto-roll the keeper pays gas for.
 *
 * Anyone may delegate AUTO_ROLL to this keeper, and a roll earns the keeper
 * nothing back (no matcher share), so the keeper wallet pays every roll's gas.
 * Owner decision 2026-10-25 ("Gas ratio"): the keeper rolls a loan only when
 * the amount it re-lends is worth at least {@link ROLL_MIN_VALUE_TO_GAS} times
 * the roll's gas cost. Both sides are valued by the Diamond's own pricing rule
 * (`NumeraireValueFacet.getNumeraireValue`), the same figure every other value
 * comparison in the protocol uses. A loan the keeper declines is not stuck: its
 * owner can still roll it, or claim it, themselves.
 *
 * The roll's fee is measured and valued by the shared rule in txFee.ts: the
 * whole fee as the chain charges it, through the chain's wrapped native token.
 * Where the keeper cannot value a chain's fee, or the Diamond cannot price the
 * token, no roll is worth its gas as far as the keeper can tell, and the pass
 * says so instead of rolling unpriced.
 */
import { NumeraireValueFacetABI } from '@vaipakam/contracts/abis';
import { summarizeFailure } from '@vaipakam/lib/errorDescription';
import { type Abi, type Address, type PublicClient } from 'viem';
import { feeNumeraireValue } from './txFee';

/** The rolled amount must be worth at least this many times the roll's gas. */
export const ROLL_MIN_VALUE_TO_GAS = 100n;

/** Pure rule: is a roll worth `rolledValue` worth its `gasValue`? Both are
 *  1e18 numeraire. */
export function rollWorthItsGas(rolledValue: bigint, gasValue: bigint): boolean {
  return rolledValue >= gasValue * ROLL_MIN_VALUE_TO_GAS;
}

export type RollValueVerdict =
  | { kind: 'worth'; rolledValue: bigint; gasValue: bigint }
  | { kind: 'dust'; rolledValue: bigint; gasValue: bigint }
  /** The keeper cannot value this chain's gas, so it can value no roll here. */
  | { kind: 'gasUnpriced'; reason: string }
  /** The keeper cannot value this loan's lending asset; other loans may differ. */
  | { kind: 'assetUnpriced'; reason: string };

/** Value a roll of `amount` of `lendingAsset` against its whole fee, `feeWei`
 *  (from `estimateTxFeeWei`, txFee.ts). The rolled amount rounds DOWN and the fee
 *  UP, so a borderline roll is declined rather than paid for. */
export async function judgeRollValue(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
  chainId: number,
  lendingAsset: Address,
  amount: bigint,
  feeWei: bigint,
): Promise<RollValueVerdict> {
  const fee = await feeNumeraireValue(client, diamond, chainId, feeWei);
  if (fee.kind === 'unpriced') return { kind: 'gasUnpriced', reason: fee.reason };
  const gasValue = fee.value;
  let rolledValue: bigint;
  try {
    rolledValue = (await client.readContract({
      address: diamond,
      abi: NumeraireValueFacetABI as Abi,
      functionName: 'getNumeraireValue',
      args: [lendingAsset, amount, false],
    })) as bigint;
  } catch (err) {
    return { kind: 'assetUnpriced', reason: `the Diamond could not value ${lendingAsset}: ${summarizeFailure(err, 120)}` };
  }
  return rollWorthItsGas(rolledValue, gasValue)
    ? { kind: 'worth', rolledValue, gasValue }
    : { kind: 'dust', rolledValue, gasValue };
}
