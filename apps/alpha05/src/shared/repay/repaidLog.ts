/**
 * RB-CONFIDENCE — what a repayment did to its loan, read from its own
 * transaction: the protocol's `LoanRepaid` for this loan, emitted by the
 * Diamond, carries the status the repayment left the loan in. Read from the
 * log rather than from the loan's status at the receipt's block, because a
 * later transaction in the same block (both sides claiming, which settles
 * the loan) can move that status on while the repayment itself took effect.
 */
import { parseEventLogs, type Abi, type Log } from 'viem';
import { RepayFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

const REPAY = RepayFacetABI as Abi;

/** The loan's status as this transaction's repayment of it left it, or null
 *  when the transaction recorded no repayment of this loan. */
export function repaidStatus(logs: readonly Log[], diamond: Hex, loanId: bigint): number | null {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: REPAY, logs: [...own], eventName: 'LoanRepaid', strict: false }) as unknown as {
    args: { loanId?: bigint; newStatus?: number | bigint };
  }[];
  const mine = events.filter((e) => e.args.loanId === loanId && e.args.newStatus !== undefined);
  const last = mine[mine.length - 1];
  return last ? Number(last.args.newStatus) : null;
}
