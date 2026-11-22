/**
 * #3763 / #3760 — "Get cash from this loan", the lender position's one door
 * for getting lent funds back before the due date, with today's routes:
 *
 *   - Leave it: the loan runs to its due date (always listed first);
 *   - Sell now: the instant market's handover at face value, where a slot
 *     with the takeover consent admits the loan, or a sale into a standing
 *     buy offer;
 *   - Sell at my price: a sale listing at a rate the lender states.
 *
 * Whether each route is open is the protocol's own answer: the sale-exit
 * verdict (`saleExitVerdict`, every refusal with the earliest time it can
 * lift) for the route, and a dry run from the lender's wallet for each
 * candidate counterparty, read through the protocol's preview of that exact
 * step (`previewTakeover`, `previewDirectSale`), which runs the step's own
 * admission. What the lender receives is the preview's figure too: the
 * principal the incoming Auto-lend pays, or the sale's net, the rate
 * shortfall left for the buyer and the funds held for the lender that move
 * with the position. The sale is then bound to the net and held amount the
 * review showed. Nothing here re-derives a rule the contracts hold.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import {
  DIAMOND_ABI_VIEM,
  EarlyWithdrawalDirectFacetABI,
  EarlyWithdrawalFacetABI,
  InstantMarketFacetABI,
  InstantTakeoverFacetABI,
  LoanFacetABI,
  SaleAdmissionFacetABI,
  SaleExitVerdictFacetABI,
} from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import { readInstantSlot } from '../autolend/preset';
import { refusalFromData } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { readLenderIntents, type IntentSummary } from '../offers/intents';
import type { StoredOffer } from '../offers/acceptTerms';
import { readOffer, readPairOfferIds } from '../offers/reads';
import { takeoverRouted } from '../capability/routes';

type Hex = `0x${string}`;

export const SALE_VERDICT = SaleExitVerdictFacetABI as Abi;
export const TAKEOVER = InstantTakeoverFacetABI as Abi;
export const DIRECT_SALE = EarlyWithdrawalDirectFacetABI as Abi;
export const LISTING = EarlyWithdrawalFacetABI as Abi;
const INSTANT = InstantMarketFacetABI as Abi;
const PREVIEW = SaleAdmissionFacetABI as Abi;
const LOAN = LoanFacetABI as Abi;

/** How many of the pair's offers and slots are looked at as counterparties. */
const OFFER_PAGE = 20;
const SLOT_PROBES = 8;

/** The loan facts the door reads from the loan page. */
export interface CashLoan {
  loanId: bigint;
  lending: Hex;
  collateral: Hex;
  principal: bigint;
  rateBps: bigint;
  fullTermInterest: boolean;
  borrower: Hex | null;
}

/** One route's standing for the reader now. */
export type RouteState = { kind: 'open' } | { kind: 'closed'; refusals: Refusal[]; reopensAt: number | null };

/** The verdict's rows for one route, as a state: open when it lists none.
 *  A closed route reopens when its last refusal lifts, so the time is the
 *  latest stated; one refusal with no time makes the whole route wait on
 *  a decision. */
export function routeState(rows: readonly { reason: Hex; reopensAt: bigint }[]): RouteState {
  if (rows.length === 0) return { kind: 'open' };
  const refusals = rows.map((r) => refusalFromData(r.reason, r.reopensAt));
  let reopensAt: number | null = 0;
  for (const r of refusals) {
    if (r.reopensAt === null) {
      reopensAt = null;
      break;
    }
    reopensAt = Math.max(reopensAt, r.reopensAt);
  }
  return { kind: 'closed', refusals, reopensAt };
}

/** Whether this loan may be handed over at all: the instant market's
 *  takeover is deployed, the loan was opened through it, and it takes
 *  interest by time. Also what the loan's statement says about the route. */
export type HandoverReach = 'yes' | 'unrouted' | 'not-instant' | 'full-term';

/** `none` carries whether the search saw every candidate: false when the
 *  network's Auto-lend list or the probe cap was longer than what was read,
 *  so a slot that would take the loan may exist beyond it. */
export type Handover = { kind: 'ready'; owner: Hex; slot: number; receives: bigint } | { kind: 'none'; complete: boolean; refusals: Refusal[] } | { kind: 'out-of-reach'; why: Exclude<HandoverReach, 'yes'> };

/** A sale into a standing buy offer, as the protocol previews it: the net to
 *  the seller's vault, the rate shortfall the seller leaves for the buyer,
 *  and the funds held for the lender that move with the position. As for the
 *  handover, `none` says whether every buy offer on the pair was read. */
export type DirectSale = { kind: 'ready'; offerId: bigint; rateBps: bigint; net: bigint; shortfall: bigint; held: bigint } | { kind: 'none'; complete: boolean };

export interface GetCash {
  direct: RouteState;
  listing: RouteState;
  reach: HandoverReach;
  handover: Handover;
  sale: DirectSale;
  /** The principal outstanding when read (the page's figure can be older). */
  principal: bigint;
  readAt: number;
}

/** The pair's slots that could take the loan over, by their own terms (all
 *  of them: the caller probes the first `SLOT_PROBES` and states the rest). */
export function handoverCandidates(intents: readonly IntentSummary[], loan: CashLoan, me: Hex): IntentSummary[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return intents
    .filter(
      (i) =>
        same(i.lendingAsset, loan.lending) &&
        same(i.collateralAsset, loan.collateral) &&
        !same(i.owner, me) &&
        (loan.borrower === null || !same(i.owner, loan.borrower)) &&
        i.minRateBps <= loan.rateBps &&
        i.availableCapital >= loan.principal,
    );
}

/** The standing buy offers a direct sale could fill: a single-valued
 *  lender offer for exactly the principal, on the loan's pair, by someone
 *  else. The sale itself judges the rest. */
export function buyOfferCandidate(o: StoredOffer, loan: CashLoan, me: Hex): boolean {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (o.accepted || o.offerType !== 0 || o.assetType !== 0) return false;
  if (!same(o.lendingAsset, loan.lending) || !same(o.collateralAsset, loan.collateral)) return false;
  if (same(o.creator, me)) return false;
  if (o.amountMax !== 0n && o.amountMax !== o.amount) return false;
  return o.amount === loan.principal && o.amountFilled === 0n;
}

export function takeoverCall(loanId: bigint, owner: Hex, slot: number, validUntil: bigint) {
  return { abi: TAKEOVER, functionName: 'takeoverInstant', args: [loanId, owner, slot, validUntil] as const };
}

export function directSaleCall(loanId: bigint, offerId: bigint, minNet: bigint, maxHeld: bigint, validUntil: bigint) {
  return { abi: DIRECT_SALE, functionName: 'sellLoanViaBuyOffer', args: [loanId, offerId, minNet, maxHeld, validUntil] as const };
}

export function listingCall(loanId: bigint, rateBps: bigint, consent: boolean, listingSeconds: bigint, minNet: bigint, maxHeld: bigint, validUntil: bigint) {
  return { abi: LISTING, functionName: 'createLoanSaleOffer', args: [loanId, rateBps, consent, listingSeconds, minNet, maxHeld, validUntil] as const };
}

/** Whether the loan is in the handover's reach at all. */
export async function readHandoverReach(c: PublicClient, diamond: Hex, loan: CashLoan): Promise<HandoverReach> {
  if (!(await takeoverRouted(c, diamond))) return 'unrouted';
  const group = (await c.readContract({ address: diamond, abi: INSTANT, functionName: 'getInstantGroup', args: [loan.loanId] })) as bigint;
  if (group === 0n) return 'not-instant';
  return loan.fullTermInterest ? 'full-term' : 'yes';
}

/** The protocol's preview of a takeover into one slot. */
export async function previewTakeover(c: PublicClient, diamond: Hex, loanId: bigint, caller: Hex, incoming: Hex, slot: number) {
  const [accepted, refusal, principalPaid] = (await c.readContract({
    address: diamond,
    abi: TAKEOVER,
    functionName: 'previewTakeover',
    args: [loanId, caller, incoming, slot],
  })) as readonly [boolean, Hex, bigint];
  return { accepted, refusal, principalPaid };
}

/** The protocol's preview of a sale into one standing buy offer. */
export async function previewDirectSale(c: PublicClient, diamond: Hex, loanId: bigint, offerId: bigint, seller: Hex) {
  const [accepted, refusal, net, shortfall, held] = (await c.readContract({
    address: diamond,
    abi: DIRECT_SALE,
    functionName: 'previewDirectSale',
    args: [loanId, offerId, seller],
  })) as readonly [boolean, Hex, bigint, bigint, bigint];
  return { accepted, refusal, net, shortfall, held };
}

/** The first slot the protocol's preview admits for the takeover. A slot it
 *  refuses gives its reason (an Auto-lend short of unlent funds among them),
 *  kept so "none" can say why. */
async function readHandover(own: OwnStateClient, diamond: Hex, loan: CashLoan): Promise<Handover> {
  const intents = (await own.read((c) => readLenderIntents(c, diamond))).value;
  const all = handoverCandidates(intents.intents, loan, own.account);
  const cands = all.slice(0, SLOT_PROBES);
  // The search saw every slot only when the list was read to its end and
  // every candidate was probed.
  const complete = BigInt(intents.scanned) >= intents.total && all.length <= SLOT_PROBES;
  // A candidate that could not be read is not a candidate that refused: with
  // none ready, an unread one makes the answer unknown, never "none".
  let unread: string | null = null;
  const refusals: Refusal[] = [];
  for (const i of cands) {
    const consent = await own
      .read((c) => readInstantSlot(c, diamond, i.owner, loan.lending, loan.collateral, i.slot))
      .then(
        (x) => x.value.takeover,
        (e: unknown) => {
          unread = e instanceof Error ? e.message : String(e);
          return false;
        },
      );
    if (!consent) continue;
    const p = await own.read((c) => previewTakeover(c, diamond, loan.loanId, own.account, i.owner, i.slot)).then(
      (x) => x.value,
      (e: unknown) => {
        unread = e instanceof Error ? e.message : String(e);
        return null;
      },
    );
    if (p === null) continue;
    if (p.accepted) return { kind: 'ready', owner: i.owner, slot: i.slot, receives: p.principalPaid };
    refusals.push(refusalFromData(p.refusal, 0n));
  }
  if (unread !== null) throw new Error(unread);
  return { kind: 'none', complete, refusals };
}

/** The standing buy offer that nets the lender most now, by the protocol's
 *  preview of each sale. */
async function readDirectSale(own: OwnStateClient, diamond: Hex, loan: CashLoan): Promise<DirectSale> {
  const { ids, total } = (await own.read((c) => readPairOfferIds(c, diamond, loan.lending, loan.collateral, OFFER_PAGE))).value;
  const complete = BigInt(ids.length) >= total;
  const offers = await Promise.all(
    ids.map((id) =>
      own
        .read((c) => readOffer(c, diamond, id))
        .then(
          (x) => ({ id, o: x.value }),
          (e: unknown) => ({ id, unread: e instanceof Error ? e.message : String(e) }),
        ),
    ),
  );
  // As for the handover: an unread preview leaves the answer unknown.
  let unread: string | null = null;
  let best: Extract<DirectSale, { kind: 'ready' }> | null = null;
  for (const x of offers) {
    if ('unread' in x) {
      unread = x.unread;
      continue;
    }
    if (!buyOfferCandidate(x.o, loan, own.account)) continue;
    const p = await own.read((c) => previewDirectSale(c, diamond, loan.loanId, x.id, own.account)).then(
      (r) => r.value,
      (e: unknown) => {
        unread = e instanceof Error ? e.message : String(e);
        return null;
      },
    );
    if (p === null || !p.accepted) continue;
    if (best === null || p.net > best.net) best = { kind: 'ready', offerId: x.id, rateBps: x.o.interestRateBps, net: p.net, shortfall: p.shortfall, held: p.held };
  }
  if (best !== null) return best;
  if (unread !== null) throw new Error(unread);
  return { kind: 'none', complete };
}

/** The principal outstanding now. The handover pays exactly this, so it is
 *  read with the routes, never taken from the page: a part repayment since
 *  the page loaded lowers it, and the review key then shows the change. */
export async function readPrincipalNow(c: PublicClient, diamond: Hex, loanId: bigint): Promise<bigint> {
  const d = (await c.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDetails', args: [loanId] })) as { principal: bigint };
  return d.principal;
}

export async function readGetCash(own: OwnStateClient, diamond: Hex, page: CashLoan): Promise<GetCash> {
  const principal = (await own.read((c) => readPrincipalNow(c, diamond, page.loanId))).value;
  const loan: CashLoan = { ...page, principal };
  const [verdict, reach] = await Promise.all([
    own
      .read(
        (c) =>
          c.readContract({ address: diamond, abi: SALE_VERDICT, functionName: 'saleExitVerdict', args: [loan.loanId, own.account] }) as Promise<
            readonly [readonly { reason: Hex; reopensAt: bigint }[], readonly { reason: Hex; reopensAt: bigint }[]]
          >,
      )
      .then((x) => x.value),
    own.read((c) => readHandoverReach(c, diamond, loan)).then((x) => x.value),
  ]);
  const direct = routeState(verdict[0]);
  const listing = routeState(verdict[1]);
  const open = direct.kind === 'open';
  const [handover, sale] = await Promise.all([
    reach !== 'yes' ? Promise.resolve<Handover>({ kind: 'out-of-reach', why: reach }) : open ? readHandover(own, diamond, loan) : Promise.resolve<Handover>({ kind: 'none', complete: true, refusals: [] }),
    open ? readDirectSale(own, diamond, loan) : Promise.resolve<DirectSale>({ kind: 'none', complete: true }),
  ]);
  return { direct, listing, reach, handover, sale, principal, readAt: Date.now() };
}

/** What a listing at this rate and expiry records: the least the lender
 *  nets if it fills before it expires, and the most set aside for the
 *  lender that moves to the buyer. */
export async function quoteListing(c: PublicClient, diamond: Hex, loanId: bigint, rateBps: bigint, expiresAt: bigint): Promise<{ minNet: bigint; maxHeld: bigint }> {
  const [minNet, maxHeld] = (await c.readContract({ address: diamond, abi: PREVIEW, functionName: 'quoteSellerBounds', args: [loanId, rateBps, expiresAt] })) as readonly [
    bigint,
    bigint,
  ];
  return { minNet, maxHeld };
}

/** Whether "no lender is taking a loan like this" is known: both searches
 *  that found nothing saw every candidate. A route out of reach, or one that
 *  found a taker, does not make the answer partial. */
export function searchedAll(g: Pick<GetCash, 'handover' | 'sale'>): boolean {
  return (g.handover.kind !== 'none' || g.handover.complete) && (g.sale.kind !== 'none' || g.sale.complete);
}

/** A key for the read: a re-read that differs is a change. */
export function getCashKey(g: GetCash): string {
  const r = (s: RouteState) => (s.kind === 'open' ? 'open' : `closed:${s.reopensAt}:${s.refusals.map((x) => x.code).join(',')}`);
  const h = g.handover.kind === 'ready' ? `${g.handover.owner}:${g.handover.slot}:${g.handover.receives}` : g.handover.kind === 'none' ? `none:${g.handover.complete}` : g.handover.kind;
  const s = g.sale.kind === 'ready' ? `${g.sale.offerId}:${g.sale.net}:${g.sale.held}` : `none:${g.sale.complete}`;
  return [r(g.direct), r(g.listing), g.reach, h, s, g.principal].join('|');
}

/** What a transaction of this door did, from its own logs: the handover's
 *  payment, the sale, or the listing, for this loan only. */
export interface CashLogs {
  takenOverPaid: bigint | null;
  sold: boolean;
  listed: boolean;
}

export function cashLogs(logs: readonly Log[], diamond: Hex, loanId: bigint): CashLogs {
  const out: CashLogs = { takenOverPaid: null, sold: false, listed: false };
  const mine = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const parsed = parseEventLogs({ abi: DIAMOND_ABI_VIEM, logs: mine as Log[], strict: false }) as unknown as readonly { eventName: string; args: Record<string, unknown> }[];
  for (const e of parsed) {
    if (e.args.loanId !== loanId) continue;
    if (e.eventName === 'InstantTakenOver' && typeof e.args.principalPaid === 'bigint') out.takenOverPaid = e.args.principalPaid;
    if (e.eventName === 'LoanSold') out.sold = true;
    if (e.eventName === 'LoanSaleOfferLinked') out.listed = true;
  }
  return out;
}
