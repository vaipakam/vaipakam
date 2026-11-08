/**
 * OFF-48 / OFF-49 — cancelling an offer, or cleaning up an expired one:
 * `OfferCancelFacet.cancelOffer(offerId)`.
 *
 * The protocol's rule, which the review states before anything is signed:
 * - the creator may cancel its own open offer at any time; anyone may cancel
 *   an offer whose expiry has passed (the clean-up), and the refund still
 *   goes to the creator, never to whoever sent it;
 * - an offer with nothing filled cannot be cancelled in its first five
 *   minutes unless it has expired (the cool-down that keeps a cancel from
 *   racing a counterparty's accept);
 * - an offer already taken whole, already cancelled or consumed by a sale is
 *   refused; cancelling is refused during a pause;
 * - what it releases is what the offer still locks in the creator's vault:
 *   a lending offer's unlent principal (or a rental's NFT), a request's
 *   unused collateral (or a rental request's prepay and buffer). It leaves
 *   the vault for the creator's wallet, which protected account mode routes
 *   like any other payout. The offer's position token is retired.
 * - an offer tied to a running loan (a position sale, an offset or a
 *   refinance request that carries its collateral) releases what that loan
 *   allows; the review says it cannot size that, and the finish card states
 *   what moved.
 * Past the cool-down a cancel and an accept are an ordinary race: whichever
 * lands first wins, and the other is refused.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI, MetricsDashboardFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { answerOrNull } from '../reads/answer';
import { nftArrived } from '../claims/claimLog';
import { payoutOutcomes, payoutRoute, readProtection, type PayoutOutcome, type PayoutRoute, type Protection } from '../protection/payout';
import { payoutLegs, routeChanged, routedDestination, routedLeg, routeNotes } from '../protection/payoutCopy';
import type { Receipt, ReceiptRow } from '../receipt/types';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { formatSpan, formatUtc, shortAddress } from '../ui/format';
import { moved } from './acceptOutcome';
import { offerState } from './myOffers';
import { OFFER_CANCEL, type OfferState } from './reads';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

const ADMIN = AdminFacetABI as Abi;
const DASHBOARD = MetricsDashboardFacetABI as Abi;

const MEASURED_WHY = {
  linked: 'offerCancel.measuredLinked',
  linkUnread: 'offerCancel.measuredLinkUnread',
  carryOver: 'offerCancel.measuredCarryOver',
  buffer: 'offerCancel.measuredBuffer',
} as const;

/** `LibVaipakam.MIN_OFFER_CANCEL_DELAY`. */
export const CANCEL_COOLDOWN_SECONDS = 300;
const OFFER_LENDER = 0;
const ERC20 = 0;
const ERC721 = 1;

/** The fields of `getOffer` the cancel rule and its refund read. */
export interface CancelOffer {
  id: bigint;
  creator: Hex;
  offerType: number;
  accepted: boolean;
  assetType: number;
  collateralAssetType: number;
  lendingAsset: Hex;
  amount: bigint;
  amountMax: bigint;
  amountFilled: bigint;
  tokenId: bigint;
  quantity: bigint;
  durationDays: bigint;
  prepayAsset: Hex;
  collateralAsset: Hex;
  collateralAmount: bigint;
  collateralAmountMax: bigint;
  collateralAmountFilled: bigint;
  collateralTokenId: bigint;
  collateralQuantity: bigint;
  createdAt: bigint;
  expiresAt: bigint;
  refinanceCarryOver: boolean;
  rentalBufferBpsAtCreate: number;
}

export interface CancelFacts {
  /** Null when the protocol no longer holds the offer's record. */
  offer: CancelOffer | null;
  state: OfferState | 'unknown';
  /** The running loan a sale or offset listing is tied to; null unread. */
  linkedLoanId: bigint | null;
  paused: boolean | null;
  /** The creator's mode: where the refund goes. */
  protection: Protection | null;
  chainNow: number | null;
}

/** What the cancel returns to the creator. */
export type Refund =
  | { kind: 'erc20'; asset: Hex; amount: bigint }
  | { kind: 'nft'; asset: Hex; assetType: number; tokenId: bigint; quantity: bigint }
  | { kind: 'none' }
  /** Not sized before signing: `why` says why; the finish card measures. */
  | { kind: 'measured'; why: 'linked' | 'linkUnread' | 'carryOver' | 'buffer' };

export interface CancelReview {
  identity: string;
  offerId: bigint;
  facts: CancelFacts;
  refund: Refund | null;
  route: PayoutRoute;
  dryRun: Refusal | null | 'unread';
  readAt: number;
}

const BPS = 10_000n;

/** What the cancel releases, per `cancelOffer`'s own branches. */
export function cancelRefund(o: CancelOffer, linkedLoanId: bigint | null): Refund {
  // An unread link is not taken as no link: a sale listing's request returns
  // nothing the offer's terms say, so the figure waits for the finish card.
  if (linkedLoanId === null) return { kind: 'measured', why: 'linkUnread' };
  if (linkedLoanId !== 0n) return { kind: 'measured', why: 'linked' };
  if (o.offerType === OFFER_LENDER) {
    if (o.assetType === ERC20) {
      const left = (o.amountMax === 0n ? o.amount : o.amountMax) - o.amountFilled;
      return left > 0n ? { kind: 'erc20', asset: o.lendingAsset, amount: left } : { kind: 'none' };
    }
    return { kind: 'nft', asset: o.lendingAsset, assetType: o.assetType, tokenId: o.tokenId, quantity: o.assetType === ERC721 ? 1n : o.quantity };
  }
  if (o.refinanceCarryOver) return { kind: 'measured', why: 'carryOver' };
  if (o.assetType === ERC20) {
    if (o.collateralAssetType === ERC20) {
      const left = (o.collateralAmountMax === 0n ? o.collateralAmount : o.collateralAmountMax) - o.collateralAmountFilled;
      return left > 0n ? { kind: 'erc20', asset: o.collateralAsset, amount: left } : { kind: 'none' };
    }
    return {
      kind: 'nft',
      asset: o.collateralAsset,
      assetType: o.collateralAssetType,
      tokenId: o.collateralTokenId,
      quantity: o.collateralAssetType === ERC721 ? 1n : o.collateralQuantity,
    };
  }
  // A rental request: the prepay and its buffer, at the rate stamped when it
  // was posted. An offer posted before the stamp falls back to the
  // protocol's current rate, which this page does not read.
  if (o.rentalBufferBpsAtCreate === 0) return { kind: 'measured', why: 'buffer' };
  // A fee total (daily fee times days), not a deadline: the clock rule does
  // not apply.
  // eslint-disable-next-line no-restricted-syntax
  const prepay = o.amount * o.durationDays;
  return { kind: 'erc20', asset: o.prepayAsset, amount: prepay + (prepay * BigInt(o.rentalBufferBpsAtCreate)) / BPS };
}

export function isExpired(o: Pick<CancelOffer, 'expiresAt'>, now: number): boolean {
  return o.expiresAt !== 0n && BigInt(now) >= o.expiresAt;
}

/** When the cool-down ends, or null when it does not bind. */
export function cooldownEnds(o: CancelOffer, now: number): number | null {
  if (o.amountFilled !== 0n || o.createdAt === 0n || isExpired(o, now)) return null;
  const ends = Number(o.createdAt) + CANCEL_COOLDOWN_SECONDS;
  return now < ends ? ends : null;
}

/** Everything the review states, read at one block: the offer, the
 *  protocol's state for it, the loan it is tied to, the pause and the
 *  creator's mode (where the refund goes). */
export async function readCancelFacts(c: PublicClient, diamond: Hex, offerId: bigint): Promise<CancelFacts> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const at = { blockNumber: block.number };
  const [offer, views, linked, paused] = await Promise.all([
    answerOrNull(c.readContract({ address: diamond, abi: OFFER_CANCEL, functionName: 'getOffer', args: [offerId], ...at }) as Promise<CancelOffer>),
    answerOrNull(c.readContract({ address: diamond, abi: DASHBOARD, functionName: 'getOffersWithState', args: [[offerId]], ...at }) as Promise<readonly { state: number }[]>),
    answerOrNull(c.readContract({ address: diamond, abi: OFFER_CANCEL, functionName: 'getOfferLinkedLoanId', args: [offerId], ...at }) as Promise<bigint>),
    answerOrNull(c.readContract({ address: diamond, abi: ADMIN, functionName: 'paused', args: [], ...at }) as Promise<boolean>),
  ]);
  const state = views === null || views.length !== 1 ? 'unknown' : offerState(Number(views[0]!.state));
  // A cleared record reports id 0: the protocol no longer holds the offer.
  const live = offer !== null && offer.id === offerId ? { ...offer, rentalBufferBpsAtCreate: Number(offer.rentalBufferBpsAtCreate) } : null;
  const protection = live === null ? null : await readProtection(c, diamond, live.creator, block.number);
  return { offer: live, state, linkedLoanId: linked, paused, protection, chainNow: Number(block.timestamp) };
}

/** What stops the review, in words (empty when nothing does), most
 *  fundamental first. `viewer` is the connected wallet. */
export function cancelBlockers(r: Pick<CancelReview, 'facts' | 'dryRun'>, viewer: Hex, copy: Copy): string[] {
  const { text, format } = copy;
  const f = r.facts;
  if (f.state === 'unknown' || f.chainNow === null) return [text('offerCancel.unread')];
  if (f.state === 'accepted' || f.state === 'sale-consumed') return [text('offerCancel.filled')];
  if (f.state === 'cancelled') return [text('offerCancel.cancelled')];
  if (f.offer === null) return [text('offerCancel.unread')];
  if (f.paused === null) return [text('offerCancel.pauseUnread')];
  if (f.paused) return [text('offerCancel.paused')];
  const expired = isExpired(f.offer, f.chainNow);
  if (!expired && f.offer.creator.toLowerCase() !== viewer.toLowerCase()) return [text('offerCancel.notCreator')];
  const ends = cooldownEnds(f.offer, f.chainNow);
  if (ends !== null) return [format('offerCancel.cooldown', { at: formatUtc(ends) })];
  if (r.dryRun === 'unread') return [text('offerCancel.dryRunUnread')];
  if (r.dryRun !== null) return [format('offerCancel.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

export async function readCancelReview(own: OwnStateClient, diamond: Hex, offerId: bigint, identity: string, copy: Copy): Promise<CancelReview> {
  const viewer = own.account;
  const facts = await own.read((c: PublicClient) => readCancelFacts(c, diamond, offerId)).then((x) => x.value);
  const base: CancelReview = {
    identity,
    offerId,
    facts,
    refund: facts.offer === null ? null : cancelRefund(facts.offer, facts.linkedLoanId),
    route: facts.offer === null ? 'unknown' : payoutRoute(facts.protection, facts.offer.creator, facts.offer.creator),
    dryRun: null,
    readAt: Date.now(),
  };
  if (cancelBlockers(base, viewer, copy).length > 0) return base;
  const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: OFFER_CANCEL, functionName: 'cancelOffer', args: [offerId], account: viewer }));
  return { ...base, dryRun: dry.kind === 'answered' ? null : dry.kind === 'reverted' ? refusalFromError(dry.error) : 'unread', readAt: Date.now() };
}

const refundKey = (r: Refund | null) =>
  r === null
    ? 'unread'
    : r.kind === 'erc20'
      ? `e:${r.asset.toLowerCase()}:${r.amount}`
      : r.kind === 'nft'
        ? `n:${r.asset.toLowerCase()}:${r.tokenId}:${r.quantity}`
        : r.kind === 'measured'
          ? `m:${r.why}`
          : 'none';

/** What a re-read found changed, in words, or null. */
export function cancelChanged(a: CancelReview, b: CancelReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if (a.facts.state !== b.facts.state || refundKey(a.refund) !== refundKey(b.refund)) return text('offerCancel.changedOffer');
  if (routeChanged({ route: a.route, protection: a.facts.protection }, { route: b.route, protection: b.facts.protection })) return text('queue.changedAccount');
  if (a.facts.paused !== b.facts.paused) return text('offerCancel.changedPause');
  if ((a.dryRun === null) !== (b.dryRun === null) || (a.dryRun === 'unread') !== (b.dryRun === 'unread')) return text('offerCancel.changedVerdict');
  return null;
}

/** Words for amounts and NFTs, short or exact. */
export interface CancelWords {
  amount: (asset: Hex, v: bigint, exact: boolean) => string;
  nft: (asset: Hex, assetType: number, tokenId: bigint, quantity: bigint) => string;
}

export function refundText(r: Refund, w: CancelWords, copy: Copy, exact = false): string {
  if (r.kind === 'erc20') return w.amount(r.asset, r.amount, exact);
  if (r.kind === 'nft') return w.nft(r.asset, r.assetType, r.tokenId, r.quantity);
  if (r.kind === 'none') return copy.text('offerCancel.refundNone');
  return copy.text('receipt.unknown');
}

export function cancelReceipt(r: CancelReview, viewer: Hex, w: CancelWords, copy: Copy): Receipt {
  const { text, format } = copy;
  const unknown = (why: string) => ({ kind: 'unknown' as const, why });
  const o = r.facts.offer;
  const rows: ReceiptRow[] = [];
  const consequences: string[] = [];
  const mine = o !== null && o.creator.toLowerCase() === viewer.toLowerCase();
  const expired = o !== null && r.facts.chainNow !== null && isExpired(o, r.facts.chainNow);
  rows.push({
    label: text('offerCancel.rowOffer'),
    value: {
      kind: 'text',
      text: format(o === null ? 'offerCancel.offerId' : o.offerType === OFFER_LENDER ? 'offerCancel.offerLend' : 'offerCancel.offerBorrow', { id: r.offerId.toString() }),
    },
    binding: true,
  });
  const refund = r.refund;
  rows.push({
    label: text('offerCancel.rowReturns'),
    value:
      refund === null
        ? unknown(text('receipt.unknown'))
        : refund.kind === 'measured'
          ? unknown(text(MEASURED_WHY[refund.why]))
          : { kind: 'text', text: refundText(refund, w, copy) },
    binding: true,
  });
  if (refund !== null && refund.kind !== 'none' && o !== null) {
    rows.push({
      label: text('offerCancel.rowTo'),
      value: r.route === 'unknown' ? unknown(text('payout.protectionUnread')) : { kind: 'text', text: destinationText(r, mine, o.creator, copy) },
      binding: true,
    });
  }
  if (!mine && o !== null) consequences.push(format('offerCancel.cleanupNotYours', { address: shortAddress(o.creator) }));
  else if (expired) consequences.push(text('offerCancel.cleanupExpired'));
  if (o !== null && o.amountFilled > 0n) consequences.push(text('offerCancel.partFilled'));
  consequences.push(text('offerCancel.fromVault'), text('offerCancel.positionRetired'), text('offerCancel.race'));
  // The payee's own route notes speak to the payee; a clean-up of someone
  // else's offer states only where it goes (the row above).
  if (refund !== null && refund.kind !== 'none')
    consequences.push(...(o === null || mine || r.route === 'unknown' ? routeNotes(r.route, r.facts.protection, copy) : creatorRouteNotes(r, o.creator, copy)));
  if (r.dryRun === 'unread') consequences.push(text('offerCancel.dryRunUnread'));
  consequences.push(text('offerCancel.noApproval'));
  return { title: text(mine ? 'offerCancel.title' : 'offerCancel.titleCleanup'), rows, consequences, prompts: 1, readAt: r.readAt };
}

/** Where the return lands, in the reader's terms: the payee's own route
 *  wording for the creator, the creator's route named for anyone else. */
function destinationText(r: CancelReview, mine: boolean, creator: Hex, copy: Copy): string {
  const { text, format } = copy;
  if (mine) return routedDestination(r.route, r.facts.protection, copy) ?? text('offerCancel.toYourWallet');
  const address = shortAddress(creator);
  if (r.route === 'queued')
    return format(r.facts.protection?.requireCosign ? 'offerCancel.toCreatorQueuedCosign' : 'offerCancel.toCreatorQueued', {
      wallet: creatorWallet(r.facts.protection, creator, copy),
      delay: formatSpan(r.facts.protection?.delaySeconds ?? 0),
    });
  if (r.route === 'held') return format('offerCancel.toCreatorHeld', { address });
  return format('offerCancel.toCreator', { address });
}

/** The consequences the creator's route adds when the reader is not the
 *  creator: the payee's own notes, in the creator's terms. */
function creatorRouteNotes(r: CancelReview, creator: Hex, copy: Copy): string[] {
  if (r.route === 'queued')
    return [
      copy.format(r.facts.protection?.requireCosign ? 'offerCancel.creatorQueuedCosignNote' : 'offerCancel.creatorQueuedNote', {
        wallet: creatorWallet(r.facts.protection, creator, copy),
      }),
    ];
  if (r.route === 'held') return [copy.text('offerCancel.creatorHeldNote')];
  return [];
}

/** The wallet the creator's queued return is released to: theirs, or, once
 *  a replacement retired their account, the wallet that now manages it
 *  (`LibProtectedAccount.gate`). `to` is the measured recipient. */
function creatorWallet(protection: Protection | null, creator: Hex, copy: Copy, to?: Hex): string {
  if (protection?.retired === true) return copy.format('offerCancel.creatorControllerWallet', { address: shortAddress(to ?? protection.controller) });
  return copy.format('offerCancel.creatorWallet', { address: shortAddress(to ?? creator) });
}

/** A routed return's finish-card line when the reader is not the creator. */
function creatorRoutedLeg(o: PayoutOutcome, what: string, protection: Protection | null, creator: Hex, copy: Copy): string {
  if (o.kind === 'queued')
    return copy.format(protection?.requireCosign ? 'offerCancel.legCreatorQueuedCosign' : 'offerCancel.legCreatorQueued', {
      what,
      wallet: creatorWallet(protection, creator, copy, o.recipient),
      time: formatUtc(Number(o.releaseAt)),
    });
  return copy.format('offerCancel.legCreatorHeld', { what });
}

type Args = Record<string, unknown>;

/** The cancel's outcome, from the Diamond's own logs and the token's. */
export function measureCancel(r: CancelReview, logs: readonly Log[], diamond: Hex, viewer: Hex, w: CancelWords, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: OFFER_CANCEL, logs: [...own], strict: false }) as unknown as { eventName: string; args: Args }[];
  const done = events.some((e) => e.eventName === 'OfferCanceled' && BigInt(e.args.offerId as bigint) === r.offerId);
  const label = format('offerCancel.legCancelled', { id: r.offerId.toString() });
  if (!done) return [{ status: 'not-done', label, reason: text('offerCancel.notCancelled') }];
  const legs: LegOutcome[] = [{ status: 'done', label }];
  const o = r.facts.offer;
  const refund = r.refund;
  if (o === null || refund === null || refund.kind === 'none') return legs;
  const creator = o.creator;
  const mine = creator.toLowerCase() === viewer.toLowerCase();
  const routedLabel = (x: PayoutOutcome, what: string) => (mine ? routedLeg(x, what, r.facts.protection, copy) : creatorRoutedLeg(x, what, r.facts.protection, creator, copy));
  const arrivedLabel = (what: string) => format(mine ? 'offerCancel.legArrived' : 'offerCancel.legArrivedCreator', { what });
  const leg = refundLeg(o, refund);
  if (leg.kind === 'nft') {
    const routed = payoutOutcomes(logs, diamond, creator, leg.asset, leg.tokenId);
    const arrived = nftArrived(logs, leg.asset, leg.assetType, leg.tokenId, creator);
    // A measured return names what the logs show; a sized one, what it said.
    const quantity = refund.kind === 'nft' ? refund.quantity : routed.reduce((t, x) => t + x.amount, arrived);
    if (refund.kind === 'measured' && quantity === 0n) return [...legs, nothingLeg(mine, copy)];
    const what = w.nft(leg.asset, leg.assetType, leg.tokenId, quantity);
    if (routed.length > 0) legs.push(...routed.map((x) => ({ status: 'done' as const, label: routedLabel(x, what) })));
    else if (arrived > 0n) legs.push({ status: 'done', label: arrivedLabel(what) });
    else legs.push({ status: 'not-done', label: arrivedLabel(what), reason: text('offerCancel.notReturned') });
    return legs;
  }
  // An ERC-20 refund, sized before signing or measured now.
  const asset = leg.asset;
  const outcomes = payoutOutcomes(logs, diamond, creator, asset);
  const wallet = moved(logs, asset, null, creator);
  if (refund.kind === 'measured' && outcomes.length === 0 && wallet === 0n) return [...legs, nothingLeg(mine, copy)];
  const expected = refund.kind === 'erc20' ? refund.amount : outcomes.reduce((t, x) => t + x.amount, wallet);
  legs.push(
    ...payoutLegs(
      {
        outcomes,
        wallet,
        expected,
        protection: r.facts.protection,
        what: (v) => w.amount(asset, v, false),
        exact: (v) => w.amount(asset, v, true),
        walletLeg: arrivedLabel,
        walletOther: (got, want) => format('loanClaim.arrivedOther', { amount: got, expected: want }),
        routed: routedLabel,
      },
      copy,
    ),
  );
  return legs;
}

/** A measured return that moved nothing to the creator: said as measured. */
function nothingLeg(mine: boolean, copy: Copy): LegOutcome {
  return { status: 'done', label: copy.text(mine ? 'offerCancel.legNothingMine' : 'offerCancel.legNothingCreator') };
}

type RefundLeg = { kind: 'erc20'; asset: Hex } | { kind: 'nft'; asset: Hex; assetType: number; tokenId: bigint };

/** What the finish card measures: the sized refund's asset, or, for one
 *  measured after the fact, the asset the offer itself can return: a
 *  lender's lending asset (an ERC-20 or its NFT), a rental request's
 *  prepay, or a borrowing request's collateral (an ERC-20 or its NFT). */
export function refundLeg(o: CancelOffer, refund: Exclude<Refund, { kind: 'none' }>): RefundLeg {
  if (refund.kind === 'erc20') return { kind: 'erc20', asset: refund.asset };
  if (refund.kind === 'nft') return { kind: 'nft', asset: refund.asset, assetType: refund.assetType, tokenId: refund.tokenId };
  if (o.offerType === OFFER_LENDER)
    return o.assetType === ERC20 ? { kind: 'erc20', asset: o.lendingAsset } : { kind: 'nft', asset: o.lendingAsset, assetType: o.assetType, tokenId: o.tokenId };
  if (o.assetType !== ERC20) return { kind: 'erc20', asset: o.prepayAsset };
  return o.collateralAssetType === ERC20
    ? { kind: 'erc20', asset: o.collateralAsset }
    : { kind: 'nft', asset: o.collateralAsset, assetType: o.collateralAssetType, tokenId: o.collateralTokenId };
}
