/**
 * RB-CONFIDENCE — what a collateral change did to its loan, read from its
 * own transaction, from the Diamond's own logs for this loan:
 * `CollateralAdded` carries the collateral a top-up left and the protocol's
 * health factor and loan-to-value after it, and `LoanCuredFromFallback`
 * whether it returned a loan in fallback to running. Read from the log
 * rather than from the loan at the receipt's block, because a later
 * transaction in the same block can move the loan on while the top-up itself
 * took effect.
 */
import { parseEventLogs, type Abi, type Log } from 'viem';
import { AddCollateralFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

const ADD = AddCollateralFacetABI as Abi;

type Args = Record<string, bigint | number | string | undefined>;

function eventsOf(logs: readonly Log[], diamond: Hex, loanId: bigint, eventName: string): Args[] {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: ADD, logs: [...own], eventName, strict: false }) as unknown as { args: Args }[];
  return events.map((e) => e.args).filter((a) => a.loanId === loanId);
}

export interface Added {
  newCollateralAmount: bigint;
  /** 1e18-scaled; 0 when the protocol could not compute it. */
  newHf: bigint;
  newLtv: bigint;
}

/** The top-up this transaction made to the loan, or null when it recorded
 *  none. */
export function collateralAdded(logs: readonly Log[], diamond: Hex, loanId: bigint): Added | null {
  const last = eventsOf(logs, diamond, loanId, 'CollateralAdded').at(-1);
  if (!last || last.newCollateralAmount === undefined) return null;
  return { newCollateralAmount: BigInt(last.newCollateralAmount), newHf: BigInt(last.newHf ?? 0n), newLtv: BigInt(last.newLtv ?? 0n) };
}

/** Whether this transaction returned the loan from fallback to running. */
export function curedFromFallback(logs: readonly Log[], diamond: Hex, loanId: bigint): boolean {
  return eventsOf(logs, diamond, loanId, 'LoanCuredFromFallback').length > 0;
}
