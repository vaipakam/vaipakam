/**
 * #2391 — find a loan's refinance request ON CHAIN, wherever it was made.
 *
 * Until now the loan page learned of a request only from a device-local
 * marker, so one posted on another device or through another tool was
 * invisible, and partial repayment, preclose, handover, offset and taking
 * back collateral could strand it. The chain already has what is needed:
 *
 *  - a refinance request is fillable only when its creator is the loan's
 *    CURRENT borrower-position holder (`RefinanceFacet` checks
 *    `offer.creator == ownerOf(borrowerTokenId)`), so the holder's own
 *    offers are the complete search space;
 *  - a request names `refinanceTargetLoanId`, which cannot exist before
 *    the loan does, so every request has an offer id GREATER than the
 *    loan's own `offerId`. Offer ids are assigned in order and each
 *    wallet's offer index is appended in creation order, so paging the
 *    holder's index NEWEST-FIRST and stopping at that boundary is a
 *    complete search — bounded by what the holder has posted SINCE the
 *    loan began, not by their whole history (#2406 r1: the by-state view
 *    walks every offer the wallet ever made, which an RPC call-gas limit
 *    can refuse for a high-volume wallet);
 *  - `MetricsFacet.getUserOffersPaginated` is an O(limit) slice that also
 *    returns the total, and `getOfferDetails` carries each offer's
 *    `refinanceTargetLoanId`, expiry and acceptance.
 *
 * No indexer column and no migration (which would carry the #1149
 * deploy-ordering hazard). An OPEN request wins over an expired one (an
 * expired one is still returned, so it can be cancelled and its approval
 * removed). Hitting the page cap before the boundary, or any failed read,
 * is `unknown` — the surfaces a request would strand then fail closed —
 * and the two are told apart (#2406 r3): a failed read may answer on the
 * next try, a cap overrun will not, so the page must not say "try again".
 *
 * The boundary is the loan's SOURCE offer id, which can be older than the
 * loan itself (an offer may stand open for a while before it is taken).
 * It is the tightest boundary the chain offers: no field records when a
 * loan began that later events do not re-stamp (a handover or an in-place
 * extension rewrites the loan's start), and a re-stamped start could fall
 * after a request still fillable. A dedicated loan-to-request index on
 * chain would remove the scan entirely; that belongs with #2407.
 *
 * #2425 — that index now exists. `RefinanceFacet.getRefinanceRequest(loanId)`
 * reports the loan's RECORDED request and whether it still stands, and the
 * protocol holds the loan back only for that request and lets only that one
 * be taken. So the holder's discovery reads the record FIRST:
 *  - a standing record is the open request — no scan;
 *  - a lapsed record that is still the holder's own uncancelled request is
 *    returned as expired (the protocol refuses a new request until it is
 *    cancelled);
 *  - otherwise the bounded scan above runs only to find LEFTOVERS: a request
 *    posted before the record existed, or one a newer request displaced.
 *    The protocol will never take one, and it holds nothing back, so a
 *    leftover is returned `untakeable` for cleanup only — and a scan that
 *    does not answer is "none", since nothing the app would block depends
 *    on it (the holder's own offer list still shows every offer).
 * On a deployment without the view (`FunctionDoesNotExist`) the scan alone
 * decides, as before. Any other failed read of the record is `unknown`.
 */
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { isFunctionDoesNotExistRevert } from '../contracts/preflights';

/** Offers read per page, and pages read at most, newest first. A holder
 *  who posted more than PAGE × MAX_PAGES offers since the loan began gets
 *  `unknown`, never a partial "none". */
export const DISCOVERY_PAGE = 100;
export const DISCOVERY_MAX_PAGES = 3;

const ZERO = '0x0000000000000000000000000000000000000000';

export type RefinanceDiscovery =
  /** `untakeable` (#2425): not the loan's recorded request, so the protocol
   *  will never take it and it holds nothing back — named for cleanup only. */
  | { kind: 'found'; offerId: string; open: boolean; untakeable?: true }
  /** `leftovers` (#2429 r2): the record answered, but the search for a
   *  request it does not name did not (`failed` / `capped`). Never blocks —
   *  such a request is never accepted — but a leftover and its payoff
   *  approval may exist unseen, so the page says it could not check. */
  | {
      kind: 'none';
      leftovers?: 'failed' | 'capped';
      /** #2429 r3 — the record said no request STANDS, but whether its lapsed
       *  request is the holder's uncancelled one could not be read. Nothing is
       *  held back (the record already proved none stands); only a new POST
       *  is unconfirmed, since the protocol refuses one while that request is
       *  uncancelled. */
      lapsed?: 'unchecked';
    }
  /** `failed`: a read did not answer (may on retry). `capped`: the holder
   *  has posted more offers since the boundary than one scan reads. */
  | { kind: 'unknown'; reason: 'failed' | 'capped' };

export interface OfferFacts {
  id: bigint;
  creator: string;
  accepted: boolean;
  refinanceTargetLoanId: bigint;
  /** Unix seconds; 0 = good until cancelled. */
  expiresAt: bigint;
}

/** Pick the request among `offers`: the newest OPEN one for `loanId` made
 *  by `holder`, else the newest expired one, else none. A cancelled offer
 *  is deleted (zeroed creator) and never matches. */
export function selectRequest(
  loanId: bigint,
  holder: string,
  offers: readonly OfferFacts[],
  nowSec: bigint,
): RefinanceDiscovery {
  const h = holder.toLowerCase();
  let open: bigint | null = null;
  let expired: bigint | null = null;
  for (const o of offers) {
    if (o.accepted) continue;
    if (o.creator === ZERO || o.creator.toLowerCase() !== h) continue;
    if (o.refinanceTargetLoanId !== loanId) continue;
    const isOpen = o.expiresAt === 0n || o.expiresAt > nowSec;
    if (isOpen) {
      if (open === null || o.id > open) open = o.id;
    } else if (expired === null || o.id > expired) {
      expired = o.id;
    }
  }
  if (open !== null) return { kind: 'found', offerId: open.toString(), open: true };
  if (expired !== null) return { kind: 'found', offerId: expired.toString(), open: false };
  return { kind: 'none' };
}

/** The holder's offer ids created after `sinceOfferId`, newest pages
 *  first. `complete` is false when the cap was hit before the boundary —
 *  the ids read are then the NEWEST ones, and only older offers are
 *  unread (#2406 r7: what was read is still evidence). */
export async function candidateIds(
  readTotal: () => Promise<bigint>,
  readPage: (offset: bigint, limit: bigint) => Promise<readonly bigint[]>,
  sinceOfferId: bigint,
): Promise<{ ids: bigint[]; complete: boolean }> {
  const total = await readTotal();
  const page = BigInt(DISCOVERY_PAGE);
  const out: bigint[] = [];
  let end = total;
  for (let i = 0; i < DISCOVERY_MAX_PAGES && end > 0n; i++) {
    const offset = end > page ? end - page : 0n;
    const ids = await readPage(offset, end - offset);
    for (const id of ids) if (id > sinceOfferId) out.push(id);
    // The oldest id on this page at or below the boundary means every
    // older one is too: the search is complete.
    if (ids.length > 0 && ids[0]! <= sinceOfferId) return { ids: out, complete: true };
    end = offset;
  }
  return { ids: out, complete: end === 0n };
}

/** #2406 r7 — the verdict from the offers a scan read. A complete scan's
 *  selection is final. An incomplete one (the page cap was hit) read the
 *  NEWEST offers, so an OPEN request among them is conclusive — any
 *  unread offer is older, and an open request is preferred over every
 *  expired one — and is returned; anything less (only an expired request,
 *  or none) could be outranked by an unread open one, so it is `capped`. */
export function resolveScan(
  loanId: bigint,
  holder: string,
  offers: readonly OfferFacts[],
  nowSec: bigint,
  complete: boolean,
): RefinanceDiscovery {
  const selected = selectRequest(loanId, holder, offers, nowSec);
  if (complete) return selected;
  if (selected.kind === 'found' && selected.open) return selected;
  return { kind: 'unknown', reason: 'capped' };
}

interface DiscoveryOpts {
  client: PublicClient;
  diamond: `0x${string}`;
  loanId: bigint;
  /** The loan's own offer id — every request for it is newer. */
  sinceOfferId: bigint;
  holder: `0x${string}`;
}

/** #2425 — what the protocol's record says, decided from its two reads.
 *  `record` is `getRefinanceRequest`'s answer; `recordedOffer` the recorded
 *  offer's facts (read only for a lapsed record). Returns null when the
 *  record leaves the question to the leftover scan. */
export function fromRecord(
  loanId: bigint,
  holder: string,
  record: { offerId: bigint; live: boolean },
  recordedOffer: Omit<OfferFacts, 'expiresAt' | 'id'> | null,
): RefinanceDiscovery | null {
  if (record.live) return { kind: 'found', offerId: record.offerId.toString(), open: true };
  if (
    record.offerId !== 0n &&
    recordedOffer !== null &&
    !recordedOffer.accepted &&
    recordedOffer.creator !== ZERO &&
    recordedOffer.creator.toLowerCase() === holder.toLowerCase() &&
    recordedOffer.refinanceTargetLoanId === loanId
  ) {
    // The holder's own recorded request that no longer stands: expired, and
    // never cancelled. Shown for cleanup; a new request waits on its cancel.
    return { kind: 'found', offerId: record.offerId.toString(), open: false };
  }
  return null;
}

/** #2425 — whether a named request is NOT the loan's recorded one, given the
 *  recorded id (`getRefinanceRequest`; null on a deployment without the
 *  record, where nothing is untakeable). */
export function isUntakeable(recordedId: bigint | null, offerId: string): boolean {
  return recordedId !== null && recordedId !== BigInt(offerId);
}

/** #2425 — a leftover the scan found is never takeable. A scan that did not
 *  answer blocks nothing (nothing the protocol would refuse depends on it),
 *  but it is not "none": it is carried as `leftovers` so the page can say it
 *  could not check (#2429 r2). */
export function leftoverFrom(scan: RefinanceDiscovery): RefinanceDiscovery {
  if (scan.kind === 'found') return { ...scan, untakeable: true };
  if (scan.kind === 'unknown') return { kind: 'none', leftovers: scan.reason };
  return { kind: 'none' };
}

/** Live discovery of the HOLDER's request — used by the polling hook and
 *  re-run just before any borrower action a request would be stranded by.
 *  Record first (#2425); the scan only where the record cannot answer. */
export async function discoverRefinanceRequest(opts: DiscoveryOpts): Promise<RefinanceDiscovery> {
  const { client, diamond, loanId, holder } = opts;
  let record: { offerId: bigint; live: boolean };
  try {
    const [offerId, live] = (await client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getRefinanceRequest',
      args: [loanId],
    })) as readonly [bigint, boolean];
    record = { offerId, live };
  } catch (e) {
    // A deployment that predates the record: the scan decides, as before.
    if (isFunctionDoesNotExistRevert(e)) return scanHolderOffers(opts);
    return { kind: 'unknown', reason: 'failed' };
  }
  let recordedOffer: Omit<OfferFacts, 'expiresAt' | 'id'> | null = null;
  if (!record.live && record.offerId !== 0n) {
    try {
      recordedOffer = (await client.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getOfferDetails',
        args: [record.offerId],
      })) as Omit<OfferFacts, 'expiresAt' | 'id'>;
    } catch {
      // #2429 r3 — the record already proved no request stands, so this
      // failure holds nothing back; it leaves only the cleanup and the
      // posting question open.
      return { kind: 'none', leftovers: 'failed', lapsed: 'unchecked' };
    }
  }
  return fromRecord(loanId, holder, record, recordedOffer) ?? leftoverFrom(await scanHolderOffers(opts));
}

/** The bounded scan of `holder`'s own offers — the whole answer on a
 *  deployment without the record, the leftover search otherwise, and the
 *  viewer's own-request scan (which never blocks) in every case. */
export async function scanHolderOffers(opts: DiscoveryOpts): Promise<RefinanceDiscovery> {
  const { client, diamond, holder } = opts;
  try {
    const { ids, complete } = await candidateIds(
      async () => {
        const [, total] = (await client.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getUserOffersPaginated',
          args: [holder, 0n, 0n],
        })) as readonly [readonly bigint[], bigint];
        return total;
      },
      async (offset, limit) => {
        const [page] = (await client.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getUserOffersPaginated',
          args: [holder, offset, limit],
        })) as readonly [readonly bigint[], bigint];
        return page;
      },
      opts.sinceOfferId,
    );
    if (ids.length === 0) return complete ? { kind: 'none' } : { kind: 'unknown', reason: 'capped' };
    const [details, block] = await Promise.all([
      client.multicall({
        allowFailure: false,
        contracts: ids.map((id) => ({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getOfferDetails',
          args: [id],
        })) as never,
      }),
      client.getBlock({ blockTag: 'latest' }),
    ]);
    const offers = (details as unknown as {
      creator: string;
      accepted: boolean;
      refinanceTargetLoanId: bigint;
      expiresAt: bigint;
    }[]).map((d, i) => ({
      id: ids[i]!,
      creator: d.creator,
      accepted: d.accepted,
      refinanceTargetLoanId: d.refinanceTargetLoanId,
      expiresAt: d.expiresAt,
    }));
    return resolveScan(opts.loanId, holder, offers, block.timestamp, complete);
  } catch {
    return { kind: 'unknown', reason: 'failed' };
  }
}
