/**
 * #3205 — has the loan position an offer is bound to moved since it opened?
 *
 * A position NFT's transfer never blocks. Instead an offer bound to a loan
 * position — a lender-sale listing, a preclose offset, a refinance request —
 * completes only if that position's token has not moved (any transfer, even
 * away and back) since the offer opened. A moved one can never complete; it
 * stays until it is cancelled.
 *
 * The chain has no view of it yet (#3323), so this reads the indexer's
 * verdict (`positionFlow` on `/offers/:id`). Four answers, and an unknown is
 * never rounded to either side: `moved`, `not-moved`, `not-bound` (the offer
 * is tied to no position) and `unknown` (no indexer, no answer, an older
 * build, or the indexer cannot tell).
 */
import type { IndexerClient } from '../reads/world/indexerClient';

export type PositionFlowVerdict = 'moved' | 'not-moved' | 'not-bound' | 'unknown';

/** Reads one offer's verdict. Never throws. */
export type PositionFlowReader = (offerId: bigint) => Promise<PositionFlowVerdict>;

interface OfferPositionFlowJson {
  positionFlow?: { movedSinceOpened: boolean | null } | null;
}

/** The verdict from the indexer's offer row. Absent field = an older build. */
export function verdictOf(row: OfferPositionFlowJson | null): PositionFlowVerdict {
  if (row === null || row.positionFlow === undefined) return 'unknown';
  if (row.positionFlow === null) return 'not-bound';
  if (row.positionFlow.movedSinceOpened === true) return 'moved';
  if (row.positionFlow.movedSinceOpened === false) return 'not-moved';
  return 'unknown';
}

/** A reader over the indexer for `chainId`. */
export function indexerPositionFlowReader(indexer: IndexerClient, chainId: number): PositionFlowReader {
  return async (offerId) => {
    try {
      return verdictOf(await indexer.getJson<OfferPositionFlowJson>(`/offers/${offerId.toString()}?chainId=${chainId}`));
    } catch {
      return 'unknown';
    }
  };
}
