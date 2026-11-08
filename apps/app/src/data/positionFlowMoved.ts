/**
 * #3205 — has the position a flow is bound to moved since the flow opened?
 *
 * A position NFT's transfer never blocks. Instead every flow bound to a
 * position — the lender's sale listing, the borrower's offset offer, swap
 * order, collateral listing and refinance request — completes only if that
 * position's token has not moved (any transfer, even away and back) since the
 * flow opened. A moved flow can never complete; it stays on chain until it is
 * cancelled.
 *
 * The chain has no view yet that says whether a flow's position moved since
 * it opened (#3323), so the app reads the indexer's verdict, which it derives
 * from the position-NFT transfers it scans. THREE answers, and an unknown is
 * never rounded to either: `'yes'` (moved: the flow can never complete),
 * `'no'` (no move since it opened), `'unknown'` (the indexer did not answer,
 * is an older build, or cannot tell). A surface states `'unknown'` where it
 * matters rather than presenting the flow as certainly live.
 */
import {
  fetchLoanFlows,
  type IndexedLoanFlows,
  type IndexedPositionFlow,
} from './indexer';

export type FlowMoved = 'yes' | 'no' | 'unknown';

/** The indexer's three-valued field as a {@link FlowMoved}. */
export function flowMovedOf(v: boolean | null | undefined): FlowMoved {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return 'unknown';
}

/** Read the loan's flow verdicts; null when the indexer did not answer.
 *  Never throws: the callers' chain reads must not fail with it. */
export async function readLoanFlows(chainId: number, loanId: number): Promise<IndexedLoanFlows | null> {
  try {
    return await fetchLoanFlows(chainId, loanId);
  } catch {
    return null;
  }
}

/**
 * The verdict for one of the loan's offer-bound flows, and the offer id the
 * indexer names for it.
 *
 * With `knownOfferId`, the verdict is that offer's (unknown when the indexer
 * does not list it, which ingest lag allows). Without it, the one open offer
 * of `kind` the indexer lists names the flow; none, or more than one that do
 * not all agree, reads unknown.
 */
export function boundOfferMoved(
  flows: IndexedLoanFlows | null,
  kind: IndexedPositionFlow['kind'],
  knownOfferId: string | null,
): { moved: FlowMoved; offerId: string | null } {
  const list = flows?.positionFlows;
  if (!list) return { moved: 'unknown', offerId: null };
  const ofKind = list.filter((f) => f.kind === kind);
  if (knownOfferId !== null) {
    const hit = ofKind.find((f) => String(f.offerId) === knownOfferId);
    return { moved: hit ? flowMovedOf(hit.movedSinceOpened) : 'unknown', offerId: hit ? knownOfferId : null };
  }
  if (ofKind.length === 1) {
    return { moved: flowMovedOf(ofKind[0].movedSinceOpened), offerId: String(ofKind[0].offerId) };
  }
  if (ofKind.length > 1 && ofKind.every((f) => f.movedSinceOpened === true)) {
    return { moved: 'yes', offerId: null };
  }
  return { moved: 'unknown', offerId: null };
}
