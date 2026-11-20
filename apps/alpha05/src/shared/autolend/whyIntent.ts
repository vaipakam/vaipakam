/**
 * #3660 — "why is my Auto-lend not lending?". For an active Auto-lend slot
 * with money waiting, the index names the open borrow requests on its pair
 * that sit closest to its terms (`/intents/nearest`, the same cache ranking
 * the offer panel uses), and this module reads each one from the chain at
 * one block and asks the protocol's own preview of a fill from the slot
 * (`RiskPreviewFacet.previewIntent`). The stated gap is the preview's first
 * refusal, so the reason is the protocol's, never the app's guess; the
 * slot's and the request's own terms only supply the figures.
 *
 * The preview is asked as the platform's matching service would send the
 * fill (its keeper address), sized as a fill would be: the request's open
 * remainder, capped by the money waiting and the room left under the most
 * lent at once. Nothing here promises a fill: another lender can reach a
 * request first, and a fill the protocol would take still waits for a
 * service to send it.
 */
import type { PublicClient } from 'viem';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { answerOrNull } from '../reads/answer';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import type { StoredOffer } from '../offers/acceptTerms';
import type { IntentSummary } from '../offers/intents';
import { readOffer, readOfferState, RISK_PREVIEW, type OfferState } from '../offers/reads';

type Hex = `0x${string}`;

/** How many of the closest requests are asked for and read. */
export const INTENT_NEAREST_ASKED = 5;

/** `LibOfferMatch.IntentError`, every member in declaration order (a test
 *  reads the enum from the contract source and holds this list to it). The
 *  contract appends members, so a code this list does not reach is newer
 *  than this build and is stated by its number. */
export const INTENT_ERRORS = [
  'Ok',
  'Paused',
  'Sanctioned',
  'MatcherDisabled',
  'IntentDisabled',
  'AggregatorPaused',
  'Inactive',
  'RetiredVpfiLending',
  'KeeperUnauthorized',
  'BelowMinFill',
  'ExposureExceeded',
  'DurationTooLong',
  'FullTermRequired',
  'PartialRepayNotAllowed',
  'CollateralUnresolvable',
  'CapitalInsufficient',
  'SliceDurationAboveCap',
  'SlicePausedAsset',
  'SliceCollateralBelowFloor',
  'SliceMultiYearTerm',
  'AcceptGateBlocked',
  'SaleVehicleTagged',
  'CapacityExhausted',
  'SliceBelowMinOfferValue',
  'TermsTooFresh',
  'PastLendUntil',
  'PairNoCheckpoint',
  'PairNotCalm',
  'PairUnpriced',
  'TakeoverOffer',
] as const;
export type IntentErrorName = (typeof INTENT_ERRORS)[number];

/** `LibOfferMatch.IntentError` ordinals this module names a figure for. */
export const INTENT_CODE = { ok: INTENT_ERRORS.indexOf('Ok'), durationTooLong: INTENT_ERRORS.indexOf('DurationTooLong') } as const;
/** `LibOfferMatch.MatchError` ordinals this module names a figure for. */
export const INTENT_MATCH_CODE = { ok: 0, rate: 5 } as const;

/** What the index answers for a slot: the closest requests' ids, closest
 *  first, and how many open requests stand on the pair in all. */
export interface IntentNearest {
  ids: bigint[];
  oppositeOpen: number;
}

/** The slot terms the index ranks by. */
export type SlotTerms = Pick<IntentSummary, 'owner' | 'lendingAsset' | 'collateralAsset' | 'minRateBps' | 'maxDurationDays'>;

/** Reads the index's ranking for a slot. Throws {@link IndexerUnavailable}
 *  when the index does not answer or answers in a shape this app does not
 *  read. */
export async function readIntentNearest(indexer: IndexerClient, chainId: number, slot: SlotTerms, limit = INTENT_NEAREST_ASKED): Promise<IntentNearest> {
  const q = new URLSearchParams({
    chainId: String(chainId),
    owner: slot.owner,
    lending: slot.lendingAsset,
    collateral: slot.collateralAsset,
    minRateBps: slot.minRateBps.toString(),
    maxDurationDays: String(slot.maxDurationDays),
    limit: String(limit),
  });
  const body = await indexer.getJson<{ candidates?: unknown; oppositeOpen?: unknown }>(`/intents/nearest?${q.toString()}`);
  if (!Array.isArray(body.candidates) || typeof body.oppositeOpen !== 'number') {
    throw new IndexerUnavailable('shape', 'The index answered without a request list.');
  }
  const ids: bigint[] = [];
  for (const c of body.candidates) {
    const id = (c as { offerId?: unknown }).offerId;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new IndexerUnavailable('shape', 'The index answered a request without an offer number.');
    ids.push(BigInt(id));
  }
  return { ids, oppositeOpen: body.oppositeOpen };
}

/** The preview's answer for one request. */
export interface IntentVerdict {
  intentError: number;
  matchError: number;
  /** The risk-access gate's block (`previewOfferAcceptBlock` codes); 0 = none. */
  riskBlock: number;
  matchRateBps: bigint;
  matchAmount: bigint;
}

/** One request as the chain reads it, with the protocol's verdict. */
export interface SlotRequest {
  /** Its place in the index's ranking, 0 = closest. */
  rank: number;
  offer: StoredOffer;
  state: OfferState;
  /** The amount the preview was asked for. */
  fill: bigint;
  /** null where the preview gave no answer. */
  verdict: IntentVerdict | null;
}

export interface WhyIntentRead {
  block: bigint;
  requests: SlotRequest[];
  /** Requests the chain did not answer for. */
  unread: number;
}

/** The fill a service would size for `offer` from the slot: the request's
 *  open remainder, capped by the money waiting and the room left under the
 *  most lent at once. Where the slot has no room the remainder is asked, so
 *  the protocol names the shortfall. */
export function fillFor(
  offer: Pick<StoredOffer, 'amount' | 'amountMax' | 'amountFilled'>,
  slot: Pick<IntentSummary, 'availableCapital' | 'maxExposure' | 'livePrincipal'>,
): bigint {
  const top = offer.amountMax > offer.amount ? offer.amountMax : offer.amount;
  const remainder = top > offer.amountFilled ? top - offer.amountFilled : 0n;
  const room = slot.maxExposure > slot.livePrincipal ? slot.maxExposure - slot.livePrincipal : 0n;
  let fill = remainder;
  if (slot.availableCapital < fill) fill = slot.availableCapital;
  if (room < fill) fill = room;
  return fill > 0n ? fill : remainder;
}

/** Reads every request and asks the preview for a fill from the slot, at
 *  one block, as `solver` would send it. */
export async function readWhyIntent(c: PublicClient, diamond: Hex, slot: IntentSummary, ids: readonly bigint[], solver: Hex): Promise<WhyIntentRead> {
  const block = await c.getBlockNumber();
  const at = { blockNumber: block };
  let unread = 0;
  const read = await Promise.all(
    ids.map(async (id, rank): Promise<SlotRequest | null> => {
      try {
        const [offer, state] = await Promise.all([readOffer(c, diamond, id, at), readOfferState(c, diamond, id, at)]);
        const fill = fillFor(offer, slot);
        if (state !== 'open') return { rank, offer, state, fill, verdict: null };
        const r = (await answerOrNull(
          c.readContract({
            address: diamond,
            abi: RISK_PREVIEW,
            functionName: 'previewIntent',
            args: [solver, solver, slot.owner, slot.lendingAsset, slot.collateralAsset, slot.slot, id, fill],
            ...at,
          }),
        )) as { intentError?: number; matchError?: number; riskBlock?: number; matchRateBps?: bigint; matchAmount?: bigint } | null;
        const verdict =
          r === null || r.intentError === undefined
            ? null
            : {
                intentError: Number(r.intentError),
                matchError: Number(r.matchError ?? 0),
                riskBlock: Number(r.riskBlock ?? 0),
                matchRateBps: r.matchRateBps ?? 0n,
                matchAmount: r.matchAmount ?? 0n,
              };
        return { rank, offer, state, fill, verdict };
      } catch {
        unread += 1;
        return null;
      }
    }),
  );
  return { block, requests: read.filter((x): x is SlotRequest => x !== null), unread };
}

/** Whether the preview would take the fill. */
export function verdictOk(v: IntentVerdict): boolean {
  return v.intentError === INTENT_CODE.ok && v.matchError === INTENT_MATCH_CODE.ok && v.riskBlock === 0;
}

/** The one gap the reader is told about. */
export type IntentGap =
  /** The request pays at most `theirs`; the slot lends from `mine`. */
  | { kind: 'rate'; theirs: bigint; mine: bigint }
  /** The request runs `theirs` days; the slot lends for up to `mine`. */
  | { kind: 'term'; theirs: bigint; mine: number }
  /** A slot-level refusal, by `IntentError` ordinal. */
  | { kind: 'intent'; code: number }
  /** A match refusal, by `MatchError` ordinal. */
  | { kind: 'match'; code: number }
  /** The risk-access gate, by its block code. */
  | { kind: 'risk'; code: number };

/** What the reader is told. */
export type WhyIntent =
  /** No open request stands on the pair. */
  | { kind: 'none' }
  /** The protocol would take a fill from the slot now; nobody has sent it. */
  | { kind: 'fillable'; with: SlotRequest }
  /** The closest request the protocol answered for is refused. `closerUnknown`
   *  counts requests ranked closer that are still open, or could not be read,
   *  and got no answer. */
  | { kind: 'gap'; with: SlotRequest; gap: IntentGap; closerUnknown: number }
  /** The index named requests, but none could be read open with a verdict. */
  | { kind: 'unread' };

/** The gap a verdict names, with its figures from the slot and the request. */
export function intentGapOf(slot: Pick<IntentSummary, 'minRateBps' | 'maxDurationDays'>, request: StoredOffer, v: IntentVerdict): IntentGap {
  if (v.intentError !== INTENT_CODE.ok) {
    if (v.intentError === INTENT_CODE.durationTooLong) return { kind: 'term', theirs: request.durationDays, mine: slot.maxDurationDays };
    return { kind: 'intent', code: v.intentError };
  }
  if (v.matchError !== INTENT_MATCH_CODE.ok) {
    const theirsMax = request.interestRateBpsMax > request.interestRateBps ? request.interestRateBpsMax : request.interestRateBps;
    if (v.matchError === INTENT_MATCH_CODE.rate && theirsMax < slot.minRateBps) return { kind: 'rate', theirs: theirsMax, mine: slot.minRateBps };
    return { kind: 'match', code: v.matchError };
  }
  return { kind: 'risk', code: v.riskBlock };
}

/** The verdict: a fill the protocol would take first, else the closest open
 *  request's first refusal. */
export function whyIntentOf(slot: Pick<IntentSummary, 'minRateBps' | 'maxDurationDays'>, index: IntentNearest, read: WhyIntentRead): WhyIntent {
  if (index.oppositeOpen === 0 || index.ids.length === 0) return { kind: 'none' };
  const open = read.requests.filter((r) => r.state === 'open' && r.verdict !== null);
  const ok = open.find((r) => verdictOk(r.verdict!));
  if (ok) return { kind: 'fillable', with: ok };
  const first = open[0];
  if (!first) return { kind: 'unread' };
  const ended = new Set(read.requests.filter((r) => r.state !== 'open').map((r) => r.rank));
  let closerUnknown = 0;
  for (let rank = 0; rank < first.rank; rank += 1) if (!ended.has(rank)) closerUnknown += 1;
  return { kind: 'gap', with: first, gap: intentGapOf(slot, first.offer, first.verdict!), closerUnknown };
}


/** Each refusal's words, by name. `Ok` has none; `RetiredVpfiLending` is
 *  never returned; `DurationTooLong` is stated with its figures. */
const INTENT_REFUSAL: Record<IntentErrorName, CopyKey | null> = {
  Ok: null,
  Paused: 'whyIntent.intentPaused',
  Sanctioned: 'whyIntent.intentScreened',
  MatcherDisabled: 'whyIntent.intentMatchOff',
  IntentDisabled: 'whyIntent.intentAutoLendOff',
  AggregatorPaused: 'whyIntent.intentHeld',
  Inactive: 'whyIntent.intentStopped',
  RetiredVpfiLending: null,
  KeeperUnauthorized: 'whyIntent.intentKeeperOnly',
  BelowMinFill: 'whyIntent.intentBelowMin',
  ExposureExceeded: 'whyIntent.intentExposure',
  DurationTooLong: null,
  FullTermRequired: 'whyIntent.intentFullTerm',
  PartialRepayNotAllowed: 'whyIntent.intentPartial',
  CollateralUnresolvable: 'whyIntent.intentCollateral',
  CapitalInsufficient: 'whyIntent.intentCapital',
  SliceDurationAboveCap: 'whyIntent.intentTermCap',
  SlicePausedAsset: 'whyIntent.intentAssetPaused',
  SliceCollateralBelowFloor: 'whyIntent.intentCollFloor',
  SliceMultiYearTerm: 'whyIntent.intentMultiYear',
  AcceptGateBlocked: 'whyIntent.intentBorrowerBlocked',
  SaleVehicleTagged: 'whyIntent.intentSale',
  CapacityExhausted: 'whyIntent.intentCapacity',
  SliceBelowMinOfferValue: 'whyIntent.intentBelowValue',
  TermsTooFresh: 'whyIntent.intentFresh',
  PastLendUntil: 'whyIntent.intentPastUntil',
  PairNoCheckpoint: 'whyIntent.intentNoCheckpoint',
  PairNotCalm: 'whyIntent.intentNotCalm',
  PairUnpriced: 'whyIntent.intentUnpriced',
  TakeoverOffer: 'whyIntent.intentTakeover',
};

/** A slot-level refusal in words; an ordinal this build cannot name is
 *  stated by its number. */
export function intentRefusalText(code: number, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  const name = INTENT_ERRORS[code];
  const key = name === undefined ? null : INTENT_REFUSAL[name];
  return key !== null ? copy.text(key) : copy.format('whyIntent.intentOther', { code: String(code) });
}

/** The risk-access gate's block in words (`previewOfferAcceptBlock` codes). */
export function riskBlockText(code: number, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  if (code === 1) return copy.text('whyIntent.riskTier');
  if (code === 2 || code === 4) return copy.text('whyIntent.riskConsent');
  if (code === 3) return copy.text('whyIntent.riskAck');
  return copy.format('whyIntent.riskOther', { code: String(code) });
}
