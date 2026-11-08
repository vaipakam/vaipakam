/**
 * RB-CONFIDENCE — what a repayment did to its loan, read from its own
 * transaction, from the Diamond's own logs for this loan: `LoanRepaid`
 * carries the status a full repayment left the loan in, and `PartialRepaid`
 * the principal a part payment left. Read from the log rather than from the
 * loan at the receipt's block, because a later transaction in the same block
 * (both sides claiming, which settles the loan; a liquidation lowering the
 * principal) can move the loan on while the repayment itself took effect.
 */
import { parseEventLogs, type Abi, type Log } from 'viem';
import { RepayFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

const REPAY = RepayFacetABI as Abi;

/** The last value of `field` in this loan's `eventName` logs from the
 *  Diamond, or null when the transaction recorded none. */
function lastOf(logs: readonly Log[], diamond: Hex, loanId: bigint, eventName: 'LoanRepaid' | 'PartialRepaid', field: string): bigint | number | null {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: REPAY, logs: [...own], eventName, strict: false }) as unknown as {
    args: Record<string, bigint | number | undefined>;
  }[];
  const mine = events.filter((e) => e.args.loanId === loanId && e.args[field] !== undefined);
  const last = mine[mine.length - 1];
  return last ? (last.args[field] as bigint | number) : null;
}

/** The loan's status as this transaction's repayment of it left it, or null
 *  when the transaction recorded no repayment of this loan. */
export function repaidStatus(logs: readonly Log[], diamond: Hex, loanId: bigint): number | null {
  const v = lastOf(logs, diamond, loanId, 'LoanRepaid', 'newStatus');
  return v === null ? null : Number(v);
}

/** The principal this transaction's part payment left the loan with, or null
 *  when the transaction recorded no part payment of this loan. */
export function partialPrincipalAfter(logs: readonly Log[], diamond: Hex, loanId: bigint): bigint | null {
  const v = lastOf(logs, diamond, loanId, 'PartialRepaid', 'newPrincipal');
  return v === null ? null : BigInt(v);
}
