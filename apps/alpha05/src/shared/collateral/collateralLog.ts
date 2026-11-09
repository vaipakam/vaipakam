/**
 * RB-CONFIDENCE — what a collateral change did to its loan, read from its
 * own transaction, from the Diamond's own logs for this loan:
 * `CollateralAdded` carries the collateral a top-up left and the protocol's
 * health factor and loan-to-value after it, `LoanCuredFromFallback`
 * whether it returned a loan in fallback to running, and
 * `PartialCollateralWithdrawn` the collateral a withdrawal left and the
 * figures after it. Read from the log
 * rather than from the loan at the receipt's block, because a later
 * transaction in the same block can move the loan on while the top-up itself
 * took effect.
 */
import { parseEventLogs, type Abi, type Log } from 'viem';
import { AddCollateralFacetABI, PartialWithdrawalFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

const ADD = AddCollateralFacetABI as Abi;
const WITHDRAW = PartialWithdrawalFacetABI as Abi;

type Args = Record<string, bigint | number | string | undefined>;

function eventsOf(logs: readonly Log[], diamond: Hex, loanId: bigint, eventName: string, abi: Abi = ADD): Args[] {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi, logs: [...own], eventName, strict: false }) as unknown as { args: Args }[];
  return events.map((e) => e.args).filter((a) => a.loanId === loanId);
}

export interface Added {
  newCollateralAmount: bigint;
  /** 1e18-scaled; 0 when the protocol could not compute it. */
  newHf: bigint;
  newLtv: bigint;
}

function figures(last: Args | undefined): Added | null {
  if (!last || last.newCollateralAmount === undefined) return null;
  return { newCollateralAmount: BigInt(last.newCollateralAmount), newHf: BigInt(last.newHf ?? 0n), newLtv: BigInt(last.newLtv ?? 0n) };
}

/** The top-up this transaction made to the loan, or null when it recorded
 *  none. */
export function collateralAdded(logs: readonly Log[], diamond: Hex, loanId: bigint): Added | null {
  return figures(eventsOf(logs, diamond, loanId, 'CollateralAdded').at(-1));
}

/** The withdrawal this transaction made from the loan's collateral, or null
 *  when it recorded none. Same figures as a top-up: the collateral it left
 *  and the protocol's health factor and loan-to-value after it. */
export function collateralWithdrawn(logs: readonly Log[], diamond: Hex, loanId: bigint): Added | null {
  return figures(eventsOf(logs, diamond, loanId, 'PartialCollateralWithdrawn', WITHDRAW).at(-1));
}

/** Whether this transaction returned the loan from fallback to running. */
export function curedFromFallback(logs: readonly Log[], diamond: Hex, loanId: bigint): boolean {
  return eventsOf(logs, diamond, loanId, 'LoanCuredFromFallback').length > 0;
}
