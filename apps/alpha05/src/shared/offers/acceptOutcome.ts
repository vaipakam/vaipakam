/**
 * RB-CONFIDENCE — what an acceptance did, read from its own transaction:
 * the loan it opened (the protocol's `LoanInitiated` for this offer and
 * this borrower), the lending asset the borrower's wallet received, and the
 * collateral that left the wallet for the borrower's vault. Each is measured
 * against the review's figures; a figure the logs do not substantiate is
 * unknown, never assumed.
 */
import { parseAbi, parseEventLogs, type Abi, type Log } from 'viem';
import { LoanFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const LOAN = LoanFacetABI as Abi;

export interface OpenedLoan {
  loanId: bigint;
  principal: bigint;
  collateralAmount: bigint;
}

/** The loan this transaction opened from `offerId` for `borrower`, from the
 *  Diamond's own log; null when the transaction recorded none. */
export function openedLoan(logs: readonly Log[], diamond: Hex, offerId: bigint, borrower: Hex): OpenedLoan | null {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({
    abi: LOAN,
    logs: [...own],
    eventName: 'LoanInitiated',
    strict: false,
  }) as unknown as {
    args: {
      loanId?: bigint;
      offerId?: bigint;
      borrower?: Hex;
      principal?: bigint;
      collateralAmount?: bigint;
    };
  }[];
  const hit = events.find((e) => e.args.offerId === offerId && e.args.borrower?.toLowerCase() === borrower.toLowerCase());
  if (!hit || hit.args.loanId === undefined) return null;
  return {
    loanId: hit.args.loanId,
    principal: hit.args.principal ?? 0n,
    collateralAmount: hit.args.collateralAmount ?? 0n,
  };
}

/** The sum of `token` moved from `from` to `to` in these logs (either side
 *  may be any address when null). */
export function moved(logs: readonly Log[], token: Hex, from: Hex | null, to: Hex | null): bigint {
  return parseEventLogs({
    abi: TRANSFER_ABI,
    logs: [...logs],
    eventName: 'Transfer',
    strict: false,
  })
    .filter(
      (l) =>
        l.address.toLowerCase() === token.toLowerCase() &&
        (from === null || l.args.from?.toLowerCase() === from.toLowerCase()) &&
        (to === null || l.args.to?.toLowerCase() === to.toLowerCase()),
    )
    .reduce((sum, l) => sum + (l.args.value ?? 0n), 0n);
}

/** How an acceptance's principal was split, read from its own logs: what
 *  reached the borrower's wallet, and what left the same source (the
 *  lender's vault) for anyone else in the same token, which is the
 *  initiation fee as charged. Null when nothing reached the wallet. */
export interface DeliverySplit {
  received: bigint;
  fee: bigint;
}

export function deliverySplit(logs: readonly Log[], token: Hex, borrower: Hex): DeliverySplit | null {
  const transfers = parseEventLogs({ abi: TRANSFER_ABI, logs: [...logs], eventName: 'Transfer', strict: false }).filter(
    (l) => l.address.toLowerCase() === token.toLowerCase() && l.args.from !== undefined && l.args.to !== undefined && l.args.value !== undefined,
  );
  const me = borrower.toLowerCase();
  const toMe = transfers.filter((l) => l.args.to!.toLowerCase() === me);
  if (toMe.length === 0) return null;
  const sources = new Set(toMe.map((l) => l.args.from!.toLowerCase()));
  const received = toMe.reduce((sum, l) => sum + l.args.value!, 0n);
  const fee = transfers.filter((l) => sources.has(l.args.from!.toLowerCase()) && l.args.to!.toLowerCase() !== me).reduce((sum, l) => sum + l.args.value!, 0n);
  return { received, fee };
}

/** A leg's verdict: done when the measured figure is the expected one,
 *  unknown when it moved by another amount (the logs show something, not
 *  what was expected), not done when nothing moved. */
export function legVerdict(measured: bigint, expected: bigint): 'done' | 'unknown' | 'not-done' {
  if (measured === expected) return 'done';
  return measured === 0n ? 'not-done' : 'unknown';
}
