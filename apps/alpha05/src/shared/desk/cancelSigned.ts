/**
 * OFF-61 — stopping a signed order on the chain, the only way to stop one:
 * - `cancelSignedOffer(order)` marks that order's hash used, so no fill can
 *   bind it (signer only);
 * - `invalidateSignedOfferNonce(nonce)` stops every order the caller signed
 *   with that nonce at once, on every market, listed on this book or not.
 * Taking an order off the offer book alone would not stop it: anyone holding
 * the signature can still fill it until it lapses. Nothing was set aside for
 * a signed order, so a cancel returns nothing and moves nothing; it costs
 * gas. A fill already on its way can still land first: whichever the chain
 * includes first wins.
 *
 * The review is read at one block: each order's standing, the pause, and the
 * protocol's own dry run of the cancel from this wallet. The outcome is
 * measured from the transaction's own logs (`SignedOfferCancelled` /
 * `SignedOfferNonceBurned`), never assumed from its inclusion.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { answerOrNull } from '../reads/answer';
import type { Receipt, ReceiptRow } from '../receipt/types';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { formatBps, formatUtc } from '../ui/format';
import { readSignedStandings, SIGNED_OFFER, type MySignedOrder, type SignedStanding } from './mySignedOrders';
import { lapsesAt, SIGNED_LENDER, signedStake, typedMessage, type SignedOrderWire } from './signedOrder';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

const ADMIN = AdminFacetABI as Abi;

/** One order, or every order under one nonce. */
export type CancelTarget = { kind: 'order'; order: MySignedOrder } | { kind: 'nonce'; nonce: string; orders: readonly MySignedOrder[] };

export function targetKey(t: CancelTarget): string {
  return t.kind === 'order' ? `order:${t.order.orderHash}` : `nonce:${t.nonce}`;
}

/** The orders a target names (for a nonce, the ones this book listed). */
export function targetOrders(t: CancelTarget): readonly MySignedOrder[] {
  return t.kind === 'order' ? [t.order] : t.orders;
}

/** The contract call a target sends. */
export function cancelCall(t: CancelTarget): { functionName: 'cancelSignedOffer' | 'invalidateSignedOfferNonce'; args: readonly unknown[] } {
  return t.kind === 'order'
    ? { functionName: 'cancelSignedOffer', args: [typedMessage(t.order.order)] }
    : { functionName: 'invalidateSignedOfferNonce', args: [BigInt(t.nonce)] };
}

export interface SignedCancelReview {
  identity: string;
  target: CancelTarget;
  /** Each listed order's standing, keyed by its hash. */
  standings: Readonly<Record<Hex, SignedStanding>>;
  paused: boolean | null;
  dryRun: Refusal | null | 'unread';
  readAt: number;
}

/** What stops the cancel, in words (empty when nothing does), most
 *  fundamental first. */
export function signedCancelBlockers(r: Pick<SignedCancelReview, 'target' | 'standings' | 'paused' | 'dryRun'>, viewer: Hex, copy: Copy): string[] {
  const { text, format } = copy;
  const orders = targetOrders(r.target);
  const states = orders.map((o) => r.standings[o.orderHash] ?? 'unread');
  if (orders.some((o) => o.order.signer !== viewer.toLowerCase())) return [text('signedCancel.notSigner')];
  if (states.includes('unread')) return [text('signedCancel.unread')];
  if (!states.includes('open')) {
    if (r.target.kind === 'nonce') return [text('signedCancel.nonceNothingOpen')];
    const s = states[0]!;
    return [text(s === 'used' ? 'signedCancel.used' : s === 'nonce-cancelled' ? 'signedCancel.nonceDone' : 'signedCancel.lapsed')];
  }
  if (r.paused === null) return [text('signedCancel.pauseUnread')];
  if (r.paused) return [text('signedCancel.paused')];
  if (r.dryRun === 'unread') return [text('signedCancel.dryRunUnread')];
  if (r.dryRun !== null) return [format('signedCancel.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

export async function readSignedCancelReview(
  own: OwnStateClient,
  diamond: Hex,
  target: CancelTarget,
  identity: string,
  copy: Copy,
): Promise<SignedCancelReview> {
  const viewer = own.account;
  const { standings, paused } = await own
    .read(async (c: PublicClient) => {
      const read = await readSignedStandings(c, diamond, targetOrders(target));
      const pausedNow = await answerOrNull(c.readContract({ address: diamond, abi: ADMIN, functionName: 'paused', args: [] }) as Promise<boolean>);
      return { standings: Object.fromEntries(read.standings) as Record<Hex, SignedStanding>, paused: pausedNow };
    })
    .then((x) => x.value);
  const base: SignedCancelReview = { identity, target, standings, paused, dryRun: null, readAt: Date.now() };
  if (signedCancelBlockers(base, viewer, copy).length > 0) return base;
  const call = cancelCall(target);
  const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: SIGNED_OFFER, ...call, account: viewer }));
  return { ...base, dryRun: dry.kind === 'answered' ? null : dry.kind === 'reverted' ? refusalFromError(dry.error) : 'unread', readAt: Date.now() };
}

/** What a re-read found changed, in words, or null. */
export function signedCancelChanged(a: SignedCancelReview, b: SignedCancelReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  for (const o of targetOrders(a.target)) if (a.standings[o.orderHash] !== b.standings[o.orderHash]) return text('signedCancel.changedOrder');
  if (a.paused !== b.paused) return text('signedCancel.changedPause');
  if ((a.dryRun === null) !== (b.dryRun === null) || (a.dryRun === 'unread') !== (b.dryRun === 'unread')) return text('signedCancel.changedVerdict');
  return null;
}

/** Amount words, short or exact. */
export type AmountWords = (asset: Hex, v: bigint, exact?: boolean) => string;

/** One order in a sentence: its side, amount, rate, term and collateral. */
export function orderSentence(o: SignedOrderWire, amount: AmountWords, copy: Copy, exact = false): string {
  const lender = o.offerType === SIGNED_LENDER;
  const whole = BigInt(o.amountMax) === 0n ? BigInt(o.amount) : BigInt(o.amountMax);
  const collateral = BigInt(o.collateralAmountMax) === 0n ? BigInt(o.collateralAmount) : BigInt(o.collateralAmountMax);
  return copy.format(lender ? 'signedOrders.lend' : 'signedOrders.borrow', {
    amount: amount(o.lendingAsset as Hex, whole, exact),
    rate: formatBps(BigInt(o.interestRateBps)),
    days: o.durationDays,
    collateral: amount(o.collateralAsset as Hex, collateral, exact),
  });
}

/** When the order lapses, in words. */
export function lapseText(o: SignedOrderWire, copy: Copy): string {
  const at = lapsesAt(o);
  return at === null ? copy.text('signedOrders.noLapse') : copy.format('signedOrders.lapses', { at: formatUtc(at) });
}

export function signedCancelReceipt(r: SignedCancelReview, amount: AmountWords, copy: Copy): Receipt {
  const { text, format } = copy;
  const orders = targetOrders(r.target);
  const rows: ReceiptRow[] = [];
  if (r.target.kind === 'order') {
    const o = r.target.order.order;
    rows.push({
      label: text('signedCancel.rowOrder'),
      value: { kind: 'text', text: orderSentence(o, amount, copy), exact: orderSentence(o, amount, copy, true) },
      binding: true,
    });
    rows.push({ label: text('signedCancel.rowLapses'), value: { kind: 'text', text: lapseText(o, copy) }, binding: false });
    rows.push({ label: text('signedCancel.rowDoes'), value: { kind: 'text', text: text('signedCancel.doesOrder') }, binding: true });
  } else {
    rows.push({ label: text('signedCancel.rowNonce'), value: { kind: 'text', text: r.target.nonce }, binding: true });
    rows.push({
      label: text('signedCancel.rowListed'),
      value: { kind: 'text', text: format('signedCancel.listedCount', { count: String(orders.length) }) },
      binding: false,
    });
    rows.push({ label: text('signedCancel.rowDoes'), value: { kind: 'text', text: text('signedCancel.doesNonce') }, binding: true });
  }
  rows.push({ label: text('signedCancel.rowMoves'), value: { kind: 'text', text: text('signedCancel.movesNothing') }, binding: false });
  const consequences: string[] = [text('signedCancel.onlyWay'), text('signedCancel.race')];
  if (r.target.kind === 'nonce') consequences.push(text('signedCancel.nonceReach'));
  // What a fill would have drawn had it landed: said so the reader knows
  // what the cancel stops, never as something the cancel returns.
  const stakes = orders.map((o) => signedStake(o.order));
  if (stakes.length === 1) consequences.push(format('signedCancel.stake', { amount: amount(stakes[0]!.asset, stakes[0]!.amount) }));
  return {
    title: text(r.target.kind === 'order' ? 'signedCancel.titleOrder' : 'signedCancel.titleNonce'),
    rows,
    consequences,
    prompts: 1,
    readAt: r.readAt,
  };
}

/** The outcome, from the transaction's own logs. */
export function measureSignedCancel(r: SignedCancelReview, logs: readonly Log[], diamond: Hex, viewer: Hex, copy: Copy): LegOutcome[] {
  const { text } = copy;
  const events = parseEventLogs({ abi: SIGNED_OFFER, logs: logs as Log[], strict: false }).filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const me = viewer.toLowerCase();
  if (r.target.kind === 'order') {
    const hash = r.target.order.orderHash.toLowerCase();
    const done = events.some((e) => {
      const a = e.args as { orderHash?: string; signer?: string };
      return e.eventName === 'SignedOfferCancelled' && a.orderHash?.toLowerCase() === hash && a.signer?.toLowerCase() === me;
    });
    return [
      done
        ? { status: 'done', label: text('signedCancel.legOrder') }
        : { status: 'not-done', label: text('signedCancel.legOrder'), reason: text('signedCancel.legMissing') },
    ];
  }
  const nonce = BigInt(r.target.nonce);
  const done = events.some((e) => {
    const a = e.args as { signer?: string; nonce?: bigint };
    return e.eventName === 'SignedOfferNonceBurned' && a.signer?.toLowerCase() === me && a.nonce === nonce;
  });
  return [
    done
      ? { status: 'done', label: text('signedCancel.legNonce') }
      : { status: 'not-done', label: text('signedCancel.legNonce'), reason: text('signedCancel.legMissing') },
  ];
}
