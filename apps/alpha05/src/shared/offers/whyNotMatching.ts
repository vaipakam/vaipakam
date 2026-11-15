/**
 * #3623 — "why isn't my offer matching?". For an open token-for-token offer
 * the reader posted, the index names the other side's open offers on its
 * pair that sit closest to it (`/offers/:id/nearest`, a cache ranking), and
 * this module reads each one from the chain at one block and asks the
 * protocol's own match preview (`OfferMatchFacet.previewMatch`) whether the
 * two would match. The stated gap is the preview's first refusal, so the
 * reason is the protocol's, never the app's guess; the offers' own terms
 * only supply the figures (the two rates, the two terms) and which
 * lifecycle option differs.
 *
 * Nothing here promises a match: another taker can reach a counterparty
 * first, and a pair the protocol would match now still waits for someone to
 * send the match. The matching switch is read and stated on its own.
 */
import { type Abi, type PublicClient } from 'viem';
import { OfferMatchFacetABI } from '@vaipakam/contracts/abis';
import { readMatchSettings } from '../desk/matchBand';
import { answerOrNull } from '../reads/answer';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import type { StoredOffer } from './acceptTerms';
import { readOffer, readOfferState, type OfferState } from './reads';
import { OFFER_TYPE_LENDER } from '../positions/model';

type Hex = `0x${string}`;

const MATCH = OfferMatchFacetABI as Abi;

/** How many of the closest counterparties are asked for and read. */
export const NEAREST_ASKED = 5;

/** `LibOfferMatch.MatchError` ordinals this module names a gap for. */
export const MATCH_CODE = { ok: 0, duration: 3, rate: 5, terms: 22 } as const;

/** What the index answers for an offer. */
export type NearestIndex =
  /** The index will not rank this offer; the reason is the index's. */
  | { kind: 'ineligible'; reason: string }
  /** The closest counterparties' ids, closest first, and how many open
   *  offers stand on the other side of the pair in all. */
  | { kind: 'ranked'; ids: bigint[]; oppositeOpen: number };

/** Reads the index's ranking for `offerId`. Throws
 *  {@link IndexerUnavailable} when the index does not answer or answers in
 *  a shape this app does not read. */
export async function readNearestIndex(indexer: IndexerClient, chainId: number, offerId: bigint, limit = NEAREST_ASKED): Promise<NearestIndex> {
  const q = new URLSearchParams({ chainId: String(chainId), limit: String(limit) });
  const body = await indexer.getJson<{ eligible?: unknown; reason?: unknown; candidates?: unknown; oppositeOpen?: unknown }>(
    `/offers/${offerId.toString()}/nearest?${q.toString()}`,
  );
  if (body.eligible === false) return { kind: 'ineligible', reason: typeof body.reason === 'string' ? body.reason : 'unknown' };
  if (body.eligible !== true || !Array.isArray(body.candidates) || typeof body.oppositeOpen !== 'number') {
    throw new IndexerUnavailable('shape', 'The index answered without a counterparty list.');
  }
  const ids: bigint[] = [];
  for (const c of body.candidates) {
    const id = (c as { offerId?: unknown }).offerId;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new IndexerUnavailable('shape', 'The index answered a counterparty without an offer number.');
    ids.push(BigInt(id));
  }
  return { kind: 'ranked', ids, oppositeOpen: body.oppositeOpen };
}

/** One counterparty as the chain reads it, with the protocol's verdict. */
export interface Counterparty {
  offer: StoredOffer;
  state: OfferState;
  /** The preview's `MatchError` ordinal; null where the preview was not
   *  asked (the switch is off or unread) or was refused. */
  code: number | null;
  /** The rate a match would lend at, when the preview says it would match. */
  matchRateBps: bigint | null;
}

export interface WhyRead {
  block: bigint;
  /** The matching switch; null when unread. */
  switchOn: boolean | null;
  /** The counterparties read, in the index's order. */
  counterparties: Counterparty[];
  /** Counterparties the chain did not answer for. */
  unread: number;
}

/** Reads every counterparty and asks the preview for each pair, at one
 *  block, as `sender` would send the match. */
export async function readWhy(c: PublicClient, diamond: Hex, mine: StoredOffer, ids: readonly bigint[], sender: Hex): Promise<WhyRead> {
  const block = await c.getBlockNumber();
  const at = { blockNumber: block };
  const settings = await readMatchSettings(c, diamond, block);
  const lend = mine.offerType === OFFER_TYPE_LENDER;
  let unread = 0;
  const read = await Promise.all(
    ids.map(async (id): Promise<Counterparty | null> => {
      try {
        const [offer, state] = await Promise.all([readOffer(c, diamond, id, at), readOfferState(c, diamond, id, at)]);
        if (state !== 'open' || settings.switchOn !== true) return { offer, state, code: null, matchRateBps: null };
        const [lenderId, borrowerId] = lend ? [mine.id, id] : [id, mine.id];
        const v = await answerOrNull(c.readContract({ address: diamond, abi: MATCH, functionName: 'previewMatch', args: [lenderId, borrowerId, sender, sender], ...at }));
        const r = v as { errorCode?: number | bigint; matchRateBps?: bigint } | null;
        const code = r?.errorCode === undefined ? null : Number(r.errorCode);
        return { offer, state, code, matchRateBps: code === MATCH_CODE.ok ? (r?.matchRateBps ?? null) : null };
      } catch {
        unread += 1;
        return null;
      }
    }),
  );
  return { block, switchOn: settings.switchOn, counterparties: read.filter((x): x is Counterparty => x !== null), unread };
}

/** A lifecycle option the two offers name differently. */
export type OptionGap = 'interest-mode' | 'partial' | 'prepay' | 'cadence';

/** The one gap the reader is told about. */
export type Gap =
  /** The two rate ranges do not meet: `theirs` is the counterparty's bound
   *  nearest the reader's range, `mine` the reader's own bound nearest
   *  theirs. `theirsHigh` says the counterparty's range sits above the
   *  reader's (else below). */
  | { kind: 'rate'; theirs: bigint; mine: bigint; theirsHigh: boolean }
  /** Terms do not agree. `upTo` is set when a shorter request would do
   *  (the lender's pro-rata offer, #3615). */
  | { kind: 'term'; theirs: bigint; mine: bigint; upTo: boolean }
  | { kind: 'option'; which: OptionGap }
  /** Any other refusal, by the preview's ordinal. */
  | { kind: 'code'; code: number };

/** What the reader is told. */
export type Why =
  /** No open offer stands on the other side of the pair. */
  | { kind: 'none' }
  /** Matching is off on this network: only a direct take opens a loan. */
  | { kind: 'switch-off' }
  /** The switch could not be read, so no pair was asked. */
  | { kind: 'switch-unread' }
  /** The protocol would match this pair now; nobody has sent it yet. */
  | { kind: 'matchable'; with: Counterparty }
  | { kind: 'gap'; with: Counterparty; gap: Gap }
  /** The index named counterparties, but none could be read open with a
   *  verdict: they were taken or ended since, or the chain did not answer. */
  | { kind: 'unread' };

/** The first lifecycle option the two offers differ on, in the order the
 *  protocol lists them; null when they agree on all four. */
export function optionGap(a: StoredOffer, b: StoredOffer): OptionGap | null {
  if (a.useFullTermInterest !== b.useFullTermInterest) return 'interest-mode';
  if (a.allowsPartialRepay !== b.allowsPartialRepay) return 'partial';
  if (a.allowsPrepayListing !== b.allowsPrepayListing) return 'prepay';
  if (a.periodicInterestCadence !== b.periodicInterestCadence) return 'cadence';
  return null;
}

/** An offer's rate ceiling; a max that reads below the min is taken as the min. */
function maxRate(o: StoredOffer): bigint {
  return o.interestRateBpsMax > o.interestRateBps ? o.interestRateBpsMax : o.interestRateBps;
}

/** The gap a refusal names, with its figures from the two offers. */
export function gapOf(mine: StoredOffer, theirs: StoredOffer, code: number): Gap {
  const lend = mine.offerType === OFFER_TYPE_LENDER;
  if (code === MATCH_CODE.rate) {
    // The protocol refuses a pair whose two rate ranges do not intersect.
    // Name the two bounds that fail to meet, on whichever side they miss;
    // a refusal the ranges do not explain is stated by its code instead.
    const [lender, borrower] = lend ? [mine, theirs] : [theirs, mine];
    const lMin = lender.interestRateBps;
    const lMax = maxRate(lender);
    const bMin = borrower.interestRateBps;
    const bMax = maxRate(borrower);
    if (bMax < lMin) {
      // The request's ceiling sits below the offer's floor.
      return lend ? { kind: 'rate', theirs: bMax, mine: lMin, theirsHigh: false } : { kind: 'rate', theirs: lMin, mine: bMax, theirsHigh: true };
    }
    if (lMax < bMin) {
      // The offer's ceiling sits below the request's floor.
      return lend ? { kind: 'rate', theirs: bMin, mine: lMax, theirsHigh: true } : { kind: 'rate', theirs: lMax, mine: bMin, theirsHigh: false };
    }
    return { kind: 'code', code };
  }
  if (code === MATCH_CODE.duration) {
    // A pro-rata lender's term is the longest it lends for (#3615).
    const lender = lend ? mine : theirs;
    return { kind: 'term', theirs: theirs.durationDays, mine: mine.durationDays, upTo: !lender.useFullTermInterest };
  }
  if (code === MATCH_CODE.terms) {
    const which = optionGap(mine, theirs);
    if (which !== null) return { kind: 'option', which };
  }
  return { kind: 'code', code };
}

/** The verdict: a pair the protocol would match first, else the closest
 *  open counterparty's first refusal. */
export function whyOf(mine: StoredOffer, index: Extract<NearestIndex, { kind: 'ranked' }>, read: WhyRead): Why {
  // The switch is stated first: with matching off, no counterparty, now or
  // later, opens a loan by match.
  if (read.switchOn === false) return { kind: 'switch-off' };
  if (read.switchOn === null) return { kind: 'switch-unread' };
  if (index.oppositeOpen === 0 || index.ids.length === 0) return { kind: 'none' };
  const open = read.counterparties.filter((c) => c.state === 'open' && c.code !== null);
  const ok = open.find((c) => c.code === MATCH_CODE.ok && c.matchRateBps !== null);
  if (ok) return { kind: 'matchable', with: ok };
  const first = open[0];
  if (!first || first.code === null) return { kind: 'unread' };
  return { kind: 'gap', with: first, gap: gapOf(mine, first.offer, first.code) };
}
