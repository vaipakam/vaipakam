/**
 * Who opened a loan (#3769), read from the indexer's record of the loan and
 * shown only as history. The indexer keeps the borrower the loan was opened
 * with, and the incoming borrower after an obligation handover (that
 * borrower opened the term the loan now runs on). Who may act or benefit is
 * never taken from here: that is the current holder of the borrower
 * position, read from the chain (`ownerOf`).
 */
import type { IndexerClient } from '../reads/world/indexerClient';

type Hex = `0x${string}`;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The opener in the indexer's answer for one loan; throws when the answer
 *  does not carry one, so a caller states it as unread, never as "none". */
export function parseLoanOpener(body: unknown): Hex {
  const borrower = (body as { borrower?: unknown } | null)?.borrower;
  if (typeof borrower !== 'string' || !ADDRESS.test(borrower)) throw new Error('The indexer answer names no borrower for this loan.');
  return borrower as Hex;
}

export async function readLoanOpener(indexer: IndexerClient, chainId: number, loanId: bigint): Promise<Hex> {
  return parseLoanOpener(await indexer.getJson<unknown>(`/loans/${loanId.toString()}?chainId=${chainId}`));
}

/** Whether the borrower position has moved from the address that opened the
 *  loan: `null` when either side is unknown, which the page treats as a move
 *  the payer must confirm, never as "not moved". */
export function positionMoved(opener: Hex | null, holder: Hex | null): boolean | null {
  if (opener === null || holder === null) return null;
  return opener.toLowerCase() !== holder.toLowerCase();
}
