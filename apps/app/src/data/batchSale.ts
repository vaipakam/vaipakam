/**
 * "List all for sale" on a lender's offer-grouped loans (#126 slice 2) —
 * the outcome half.
 *
 * Each loan is planned through the shared listing plan
 * (`saleListingPlan.ts`) and the listings go to the Diamond's multicall
 * with `allowFailure` set, so a loan whose listing fails is skipped while
 * the others list. Which loans the transaction listed is read from the
 * chain afterwards, never assumed from the receipt's status.
 */
import { parseEventLogs, type Log } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../content/copy';
import { submitErrorText } from '../lib/errors';
import { LOAN_STATUS_ACTIVE, readLoanLive } from '../contracts/loanLive';
import type { Mined } from './batchCloseOut';
import {
  boundListingArgs,
  type ListingBounds,
  type SaleListingCtx,
  type SaleListingTerms,
} from './saleListingPlan';

/** A loan's outcome after the batch. */
export type SaleBatchOutcome =
  /** This batch's transaction listed it. `offerId` is the listing's offer. */
  | { loanId: number; kind: 'listed'; offerId: string }
  /** The loan left Active before its listing ran. */
  | { loanId: number; kind: 'changed' }
  /** Sent, and neither confirmed nor refused yet: it may still list. */
  | { loanId: number; kind: 'pending' }
  | { loanId: number; kind: 'open'; reason: string }
  | { loanId: number; kind: 'left-out'; reason: string }
  | { loanId: number; kind: 'unknown' };

/**
 * The listings a mined transaction made, by loan id, from its own logs.
 * Each listing emits `LoanSaleOfferLinked(loanId, saleOfferId)`, and a
 * multicall item that reverted had its logs rolled back with it, so the
 * logs say exactly which items listed — where a later read of the position
 * lock could not tell this batch's listing from one made elsewhere.
 * Only the Diamond's own logs count.
 */
export function listingsInLogs(
  logs: readonly Log[],
  diamond: `0x${string}`,
): Map<number, string> {
  const ours = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const linked = parseEventLogs({
    abi: DIAMOND_ABI_VIEM,
    logs: ours as Log[],
    eventName: 'LoanSaleOfferLinked',
  }) as unknown as Array<{ args: { loanId: bigint; saleOfferId: bigint } }>;
  return new Map(linked.map((e) => [Number(e.args.loanId), e.args.saleOfferId.toString()]));
}

/**
 * Read each loan back after its transaction. Listed only when the
 * transaction's own logs say so. A loan it did not list is read at the
 * transaction's block: one that left Active is `changed`; one still Active
 * is asked, at that block, why its bound listing would fail — the multicall
 * skips a failing item without saying why. After a failed send the read is
 * at the latest block; after a pending one a loan still Active is
 * `pending`, never open, since that transaction may still list it.
 */
export async function readBackListings(
  ctx: SaleListingCtx,
  planned: readonly { loanId: number; bounds: ListingBounds }[],
  terms: SaleListingTerms,
  mined: Mined,
): Promise<SaleBatchOutcome[]> {
  const listed = 'block' in mined ? listingsInLogs(mined.logs, ctx.diamond) : new Map();
  const block = 'block' in mined ? mined.block : undefined;
  return Promise.all(
    planned.map(async ({ loanId, bounds }): Promise<SaleBatchOutcome> => {
      const offerId = listed.get(loanId);
      if (offerId !== undefined) return { loanId, kind: 'listed', offerId };
      try {
        const live = await readLoanLive(ctx.publicClient, ctx.diamond, loanId, block);
        if (live.status !== LOAN_STATUS_ACTIVE) return { loanId, kind: 'changed' };
        if ('pending' in mined) return { loanId, kind: 'pending' };
        if ('failure' in mined) return { loanId, kind: 'open', reason: mined.failure };
        try {
          await ctx.publicClient.simulateContract({
            account: ctx.holder,
            address: ctx.diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'createLoanSaleOfferBound',
            args: boundListingArgs(loanId, terms, bounds),
            blockNumber: block,
          });
          return { loanId, kind: 'open', reason: copy.batchSale.skippedRetry };
        } catch (err) {
          return { loanId, kind: 'open', reason: submitErrorText(err) };
        }
      } catch {
        return { loanId, kind: 'unknown' };
      }
    }),
  );
}
