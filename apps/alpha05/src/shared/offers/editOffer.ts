/**
 * #3659 — changing an open offer the reader posted, in place:
 * `OfferMutateFacet.modifyOffer(offerId, terms, validUntil)`.
 *
 * The protocol's rule, which the review states before anything is signed:
 * - only the creator may change an open offer, and only its rate range, its
 *   amount range and its collateral; the term and the lifecycle options
 *   stay as posted (to change those, cancel and post again);
 * - an offer already taken whole, cancelled or consumed by a sale is
 *   refused, and so are an offer tied to a running loan (a position sale or
 *   an offset), an offer locked by a standing sale order, and any change
 *   during a pause. A refinance request keeps its amount and collateral
 *   fixed to the loan it refinances, so only its rate can change;
 * - the ranges obey the same shape as a new offer: a floor above zero and
 *   not above its ceiling, a rate no higher than 100% a year, a single
 *   amount for an all-or-nothing offer, a single collateral figure for a
 *   lending offer, and never below what has already been filled;
 * - what the offer locks follows the change: a lending offer's ceiling and
 *   a borrowing request's collateral ceiling are held in the creator's
 *   vault, so raising one pulls the difference from the wallet (through an
 *   approval of exactly that much) and lowering one releases it in the
 *   vault of the offer token's holder as free balance (the payout rule:
 *   only the owner's own withdrawal reaches a wallet). The rate moves
 *   nothing;
 * - the change restarts the clock takers wait on before the new terms can
 *   be filled, and it ends any backstop eligibility the offer carried.
 */
import { erc20Abi, parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI, MetricsDashboardFacetABI, OfferMutateFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { MAX_RATE_BPS } from '../post/postModel';
import { freedInVault, OFFER_HOLDER, readProtection, type PayoutRoute, type Protection } from '../protection/payout';
import { freedLeg, routeChanged, routedDestination, routeNotes } from '../protection/payoutCopy';
import { answerOrNull } from '../reads/answer';
import type { Receipt, ReceiptRow } from '../receipt/types';
import { allowanceSteps } from '../tx/approval';
import { chainValidUntil } from '../tx/deadline';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { formatBps, formatSpan } from '../ui/format';
import { moved } from './acceptOutcome';
import { offerState } from './myOffers';
import { CONFIG, OFFER_CANCEL, tokenAcceptsApproval, type OfferState } from './reads';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export const OFFER_MUTATE = OfferMutateFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const DASHBOARD = MetricsDashboardFacetABI as Abi;

const OFFER_LENDER = 0;
const ERC20 = 0;
/** `LibVaipakam.FillMode.Aon`: an all-or-nothing offer has one amount. */
const FILL_AON = 1;

/** The fields of `getOffer` the edit rule reads, as stored (no ceiling of
 *  zero is read as its floor here: the protocol sizes a change from the
 *  stored ceiling, and so does this module). */
export interface EditOfferRecord {
  id: bigint;
  creator: Hex;
  offerType: number;
  assetType: number;
  collateralAssetType: number;
  fillMode: number;
  lendingAsset: Hex;
  collateralAsset: Hex;
  amount: bigint;
  amountMax: bigint;
  amountFilled: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  collateralAmount: bigint;
  collateralAmountMax: bigint;
  collateralAmountFilled: bigint;
  durationDays: bigint;
  expiresAt: bigint;
  parallelSaleOrderHash: Hex;
  refinanceTargetLoanId: bigint;
  backstopEligibleAfter: bigint;
  /** #3635 A — the offer's market link on its rate limit (0 = none) and its
   *  margin. An edit carries them unchanged: this app sets no link. */
  linkKind: number;
  linkMarginBps: number;
}

/** The figures `modifyOffer` takes, with the offer's rate link carried
 *  unchanged (#3635 A). */
export interface EditTerms {
  amount: bigint;
  amountMax: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  collateralAmount: bigint;
  collateralAmountMax: bigint;
  linkKind: number;
  linkMarginBps: number;
}

export function currentTerms(o: EditOfferRecord): EditTerms {
  return {
    amount: o.amount,
    amountMax: o.amountMax,
    interestRateBps: o.interestRateBps,
    interestRateBpsMax: o.interestRateBpsMax,
    collateralAmount: o.collateralAmount,
    collateralAmountMax: o.collateralAmountMax,
    linkKind: o.linkKind,
    linkMarginBps: o.linkMarginBps,
  };
}

/** Which figures the reader may change on this offer. */
export interface EditShape {
  amount: boolean;
  /** A separate ceiling: not for an all-or-nothing offer. */
  amountRange: boolean;
  collateral: boolean;
  /** A separate collateral ceiling: a borrowing request's only. */
  collateralRange: boolean;
}

export function isLender(o: Pick<EditOfferRecord, 'offerType'>): boolean {
  return o.offerType === OFFER_LENDER;
}

/** What may change, by the protocol's rule: a loan of a token only (this
 *  app changes no rental yet), the rate always, the amount and collateral
 *  except on a refinance request, collateral only when it is a token. */
export function editShape(o: EditOfferRecord): EditShape {
  const refinance = o.refinanceTargetLoanId !== 0n;
  const amount = !refinance;
  const collateral = !refinance && o.collateralAssetType === ERC20;
  return { amount, amountRange: amount && o.fillMode !== FILL_AON, collateral, collateralRange: collateral && !isLender(o) };
}

export const editable = (o: Pick<EditOfferRecord, 'assetType'>): boolean => o.assetType === ERC20;

/** What a change moves between the wallet and the vault. */
export type EditMove = { kind: 'none' } | { kind: 'pull' | 'release'; asset: Hex; amount: bigint };

/** The protocol's settlement: a lending offer's ceiling, or a borrowing
 *  request's token collateral ceiling, as stored before and after. */
export function editMove(o: EditOfferRecord, next: EditTerms): EditMove {
  const [asset, before, after] = isLender(o)
    ? [o.lendingAsset, o.amountMax, next.amountMax]
    : o.collateralAssetType === ERC20
      ? [o.collateralAsset, o.collateralAmountMax, next.collateralAmountMax]
      : [o.collateralAsset, 0n, 0n];
  if (after > before) return { kind: 'pull', asset, amount: after - before };
  if (after < before) return { kind: 'release', asset, amount: before - after };
  return { kind: 'none' };
}

export type TermsProblem =
  | 'unchanged'
  | 'amount-zero'
  | 'amount-range'
  | 'amount-single'
  | 'amount-filled'
  | 'rate-range'
  | 'rate-high'
  | 'collateral-zero'
  | 'collateral-range'
  | 'collateral-single'
  | 'collateral-filled'
  | 'frozen';

/** The shape checks the protocol applies to the clusters that change, in
 *  its own order; empty when the figures can be sent. */
export function termsProblems(o: EditOfferRecord, next: EditTerms): TermsProblem[] {
  const shape = editShape(o);
  const out: TermsProblem[] = [];
  const amountChanged = next.amount !== o.amount || next.amountMax !== o.amountMax;
  const rateChanged = next.interestRateBps !== o.interestRateBps || next.interestRateBpsMax !== o.interestRateBpsMax;
  const collateralChanged = next.collateralAmount !== o.collateralAmount || next.collateralAmountMax !== o.collateralAmountMax;
  if (!amountChanged && !rateChanged && !collateralChanged) return ['unchanged'];
  if ((amountChanged && !shape.amount) || (collateralChanged && !shape.collateral)) out.push('frozen');
  if (amountChanged && shape.amount) {
    if (next.amount === 0n || next.amountMax === 0n) out.push('amount-zero');
    else if (next.amountMax < next.amount) out.push('amount-range');
    else if (!shape.amountRange && next.amountMax !== next.amount) out.push('amount-single');
    if (next.amountMax !== 0n && next.amountMax < o.amountFilled) out.push('amount-filled');
  }
  if (rateChanged) {
    if (next.interestRateBpsMax < next.interestRateBps) out.push('rate-range');
    if (next.interestRateBpsMax > MAX_RATE_BPS) out.push('rate-high');
  }
  if (collateralChanged && shape.collateral) {
    if (next.collateralAmount === 0n || next.collateralAmountMax === 0n) out.push('collateral-zero');
    else if (next.collateralAmountMax < next.collateralAmount) out.push('collateral-range');
    else if (!shape.collateralRange && next.collateralAmountMax !== next.collateralAmount) out.push('collateral-single');
    if (!isLender(o) && next.collateralAmountMax !== 0n && next.collateralAmountMax < o.collateralAmountFilled) out.push('collateral-filled');
  }
  return out;
}

export interface EditFacts {
  /** Null when the protocol no longer holds the offer's record. */
  offer: EditOfferRecord | null;
  state: OfferState | 'unknown';
  /** The running loan a sale or offset listing is tied to; null unread. */
  linkedLoanId: bigint | null;
  paused: boolean | null;
  /** The creator's mode: where a released amount goes. */
  protection: Protection | null;
  /** How long takers wait after a change before the new terms can be
   *  filled; null unread. */
  minTermsAgeSec: bigint | null;
  chainNow: number | null;
  block: bigint;
}

export interface EditReview {
  identity: string;
  offerId: bigint;
  terms: EditTerms;
  facts: EditFacts;
  move: EditMove | null;
  /** The wallet's balance and allowance of a pulled asset; null otherwise
   *  or unread. */
  balance: bigint | null;
  allowance: bigint | null;
  approvalSteps: number;
  route: PayoutRoute;
  /** The protocol's dry run: null when it passes, `after-approval` when the
   *  change pulls more than the approval covers (the dry run then runs after
   *  the approval, before the change is sent). */
  dryRun: Refusal | null | 'unread' | 'after-approval';
  readAt: number;
}

type Raw = Record<string, unknown>;

export function recordFrom(raw: Raw): EditOfferRecord {
  return {
    id: raw.id as bigint,
    creator: raw.creator as Hex,
    offerType: Number(raw.offerType),
    assetType: Number(raw.assetType),
    collateralAssetType: Number(raw.collateralAssetType),
    fillMode: Number(raw.fillMode),
    lendingAsset: raw.lendingAsset as Hex,
    collateralAsset: raw.collateralAsset as Hex,
    amount: raw.amount as bigint,
    amountMax: raw.amountMax as bigint,
    amountFilled: raw.amountFilled as bigint,
    interestRateBps: raw.interestRateBps as bigint,
    interestRateBpsMax: raw.interestRateBpsMax as bigint,
    collateralAmount: raw.collateralAmount as bigint,
    collateralAmountMax: raw.collateralAmountMax as bigint,
    collateralAmountFilled: raw.collateralAmountFilled as bigint,
    durationDays: raw.durationDays as bigint,
    expiresAt: BigInt(raw.expiresAt as bigint | number),
    parallelSaleOrderHash: raw.parallelSaleOrderHash as Hex,
    refinanceTargetLoanId: raw.refinanceTargetLoanId as bigint,
    backstopEligibleAfter: BigInt(raw.backstopEligibleAfter as bigint | number),
    linkKind: Number(raw.linkKind ?? 0),
    linkMarginBps: Number(raw.linkMarginBps ?? 0),
  };
}

/** Everything the review stands on, read at one block. */
export async function readEditFacts(c: PublicClient, diamond: Hex, offerId: bigint): Promise<EditFacts> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const at = { blockNumber: block.number };
  const [raw, views, linked, paused, minAge] = await Promise.all([
    answerOrNull(c.readContract({ address: diamond, abi: OFFER_CANCEL, functionName: 'getOffer', args: [offerId], ...at }) as Promise<Raw>),
    answerOrNull(c.readContract({ address: diamond, abi: DASHBOARD, functionName: 'getOffersWithState', args: [[offerId]], ...at }) as Promise<readonly { state: number }[]>),
    answerOrNull(c.readContract({ address: diamond, abi: OFFER_CANCEL, functionName: 'getOfferLinkedLoanId', args: [offerId], ...at }) as Promise<bigint>),
    answerOrNull(c.readContract({ address: diamond, abi: ADMIN, functionName: 'paused', args: [], ...at }) as Promise<boolean>),
    answerOrNull(c.readContract({ address: diamond, abi: CONFIG, functionName: 'getMinTermsAgeSec', args: [], ...at }) as Promise<bigint>),
  ]);
  const state = views === null || views.length !== 1 ? 'unknown' : offerState(Number(views[0]!.state));
  const record = raw === null ? null : recordFrom(raw);
  const offer = record !== null && record.id === offerId ? record : null;
  const protection = offer === null ? null : await readProtection(c, diamond, offer.creator, block.number);
  return { offer, state, linkedLoanId: linked, paused, protection, minTermsAgeSec: minAge, chainNow: Number(block.timestamp), block: block.number };
}

export function isExpired(o: Pick<EditOfferRecord, 'expiresAt'>, now: number): boolean {
  return o.expiresAt !== 0n && BigInt(now) >= o.expiresAt;
}

const PROBLEM_KEY = {
  unchanged: 'offerEdit.unchanged',
  'amount-zero': 'offerEdit.amountZero',
  'amount-range': 'offerEdit.amountRange',
  'amount-single': 'offerEdit.amountSingle',
  'amount-filled': 'offerEdit.amountFilled',
  'rate-range': 'offerEdit.rateRange',
  'rate-high': 'offerEdit.rateHigh',
  'collateral-zero': 'offerEdit.collateralZero',
  'collateral-range': 'offerEdit.collateralRange',
  'collateral-single': 'offerEdit.collateralSingle',
  'collateral-filled': 'offerEdit.collateralFilled',
  frozen: 'offerEdit.frozen',
} as const;

export function problemText(p: TermsProblem, copy: Pick<CopyAccess, 'text'>): string {
  return copy.text(PROBLEM_KEY[p]);
}

/** What stops the change, in words (empty when nothing does), most
 *  fundamental first. `short` words a wallet shortfall. */
export function editBlockers(r: Pick<EditReview, 'facts' | 'terms' | 'move' | 'balance' | 'dryRun'>, viewer: Hex, copy: Copy, short: (v: bigint) => string): string[] {
  const { text, format } = copy;
  const f = r.facts;
  if (f.state === 'unknown' || f.chainNow === null) return [text('offerEdit.unread')];
  if (f.state === 'accepted') return [text('offerEdit.filled')];
  if (f.state === 'sale-consumed') return [text('offerEdit.sold')];
  if (f.state === 'cancelled') return [text('offerEdit.cancelled')];
  if (f.offer === null) return [text('offerEdit.unread')];
  if (f.state === 'expired' || isExpired(f.offer, f.chainNow)) return [text('offerEdit.expired')];
  if (f.offer.creator.toLowerCase() !== viewer.toLowerCase()) return [text('offerEdit.notCreator')];
  if (!editable(f.offer)) return [text('offerEdit.rental')];
  if (f.paused === null) return [text('offerEdit.pauseUnread')];
  if (f.paused) return [text('offerEdit.paused')];
  if (f.linkedLoanId === null) return [text('offerEdit.unread')];
  if (f.linkedLoanId !== 0n) return [text('offerEdit.linked')];
  if (/^0x0*$/.test(f.offer.parallelSaleOrderHash) === false) return [text('offerEdit.saleLocked')];
  const problems = termsProblems(f.offer, r.terms);
  if (problems.length > 0) return problems.map((p) => problemText(p, copy));
  if (r.move?.kind === 'pull') {
    if (r.balance === null) return [text('offerEdit.balanceUnread')];
    if (r.balance < r.move.amount) return [short(r.move.amount - r.balance)];
  }
  if (r.dryRun === 'unread') return [text('offerEdit.dryRunUnread')];
  if (r.dryRun !== null && r.dryRun !== 'after-approval') return [format('offerEdit.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

/** The call's arguments, with a deadline read from the chain now. */
export async function modifyArgs(c: PublicClient, offerId: bigint, t: EditTerms) {
  // #3713 — this app does not ask for the far-from-average confirmation yet,
  // so an edit that moves the checked rate outside the band is refused by
  // name (`RateFarFromTermAverage`); an edit that leaves it needs none.
  return [offerId, { ...t, rateFarFromAverageAcknowledged: false }, await chainValidUntil(c)] as const;
}

export async function readEditReview(own: OwnStateClient, diamond: Hex, offerId: bigint, terms: EditTerms, identity: string, copy: Copy): Promise<EditReview> {
  const viewer = own.account;
  const facts = (await own.read((c: PublicClient) => readEditFacts(c, diamond, offerId))).value;
  const o = facts.offer;
  const move = o === null ? null : editMove(o, terms);
  let balance: bigint | null = null;
  let allowance: bigint | null = null;
  let approvalSteps = 0;
  if (move?.kind === 'pull') {
    const at = { blockNumber: facts.block };
    const funds = await own
      .read((c) =>
        Promise.all([
          c.readContract({ address: move.asset, abi: erc20Abi, functionName: 'balanceOf', args: [viewer], ...at }),
          c.readContract({ address: move.asset, abi: erc20Abi, functionName: 'allowance', args: [viewer, diamond], ...at }),
        ]),
      )
      .then((x) => x.value)
      .catch(() => null);
    if (funds !== null) {
      [balance, allowance] = funds;
      approvalSteps =
        allowance >= move.amount
          ? 0
          : (await allowanceSteps({ accepts: (v) => own.read((c) => tokenAcceptsApproval(c, move.asset, viewer, diamond, v)).then((x) => x.value) }, allowance, move.amount))
              .length;
    }
  }
  const base: EditReview = {
    identity,
    offerId,
    terms,
    facts,
    move,
    balance,
    allowance,
    approvalSteps,
    // A lowered amount is released in the vault as free balance, whatever
    // the account's protected mode (the payout rule, owner decision
    // 2026-11-19).
    route: o === null ? 'unknown' : 'credit',
    dryRun: null,
    readAt: Date.now(),
  };
  const short = () => '';
  if (editBlockers(base, viewer, copy, short).length > 0) return base;
  // A pull the approval does not cover cannot be dry-run yet: the protocol's
  // check then runs after the approval, before the change is sent.
  if (move?.kind === 'pull' && (allowance ?? 0n) < move.amount) return { ...base, dryRun: 'after-approval' };
  const dry = await askThrough(own, async (c) =>
    c.simulateContract({ address: diamond, abi: OFFER_MUTATE, functionName: 'modifyOffer', args: await modifyArgs(c, offerId, terms), account: viewer }),
  );
  return { ...base, dryRun: dry.kind === 'answered' ? null : dry.kind === 'reverted' ? refusalFromError(dry.error) : 'unread', readAt: Date.now() };
}

const termsKey = (t: EditTerms) => [t.amount, t.amountMax, t.interestRateBps, t.interestRateBpsMax, t.collateralAmount, t.collateralAmountMax].join(',');
// Every field of the offer, so any change the receipt could state (its terms,
// what is filled, its backstop opt-in, its expiry) reopens the review.
const recordKey = (o: EditOfferRecord) =>
  (Object.keys(o) as (keyof EditOfferRecord)[])
    .sort()
    .map((k) => `${k}=${String(o[k]).toLowerCase()}`)
    .join(',');
const verdict = (d: EditReview['dryRun']) => (d === null ? 'ok' : typeof d === 'string' ? d : 'refused');

/** What a re-read found changed, in words, or null. */
export function editChanged(a: EditReview, b: EditReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  const ao = a.facts.offer;
  const bo = b.facts.offer;
  if (a.facts.state !== b.facts.state || (ao === null) !== (bo === null) || (ao && bo && recordKey(ao) !== recordKey(bo))) return text('offerEdit.changedOffer');
  // The receipt states the fill wait the change restarts; a link blocks it.
  if (a.facts.minTermsAgeSec !== b.facts.minTermsAgeSec || a.facts.linkedLoanId !== b.facts.linkedLoanId) return text('offerEdit.changedOffer');
  if (routeChanged({ route: a.route, protection: a.facts.protection }, { route: b.route, protection: b.facts.protection })) return text('queue.changedAccount');
  if (a.facts.paused !== b.facts.paused) return text('offerEdit.changedPause');
  if (a.balance !== b.balance || a.allowance !== b.allowance || a.approvalSteps !== b.approvalSteps) return text('repay.changedFunds');
  if (verdict(a.dryRun) !== verdict(b.dryRun)) return text('offerEdit.changedVerdict');
  return null;
}

export const editPromptCount = (r: Pick<EditReview, 'approvalSteps'>): number => r.approvalSteps + 1;

/** Words for amounts, short or exact. */
export type AmountWords = (asset: Hex, v: bigint, exact: boolean) => string;

function rangeText(min: bigint, max: bigint, one: (v: bigint) => string, copy: Copy): string {
  return max > min ? copy.format('home.rateRange', { min: one(min), max: one(max) }) : one(min);
}

const rateText = (min: bigint, max: bigint, copy: Copy) => rangeText(min, max, (v) => `${formatBps(v)}%`, copy);

export function editReceipt(r: EditReview, w: AmountWords, copy: Copy): Receipt {
  const { text, format } = copy;
  const unknown = (why: string) => ({ kind: 'unknown' as const, why });
  const o = r.facts.offer;
  const rows: ReceiptRow[] = [];
  const consequences: string[] = [];
  const t = r.terms;
  // Whether a row changed is read from the raw figures, never from the
  // shortened words: two figures can shorten alike. Each row also carries its
  // exact words for "Show exact figures".
  const change = (label: string, changed: boolean, words: (exact: boolean) => [string, string]) => {
    const say = (exact: boolean) => {
      const [before, after] = words(exact);
      return changed ? format('offerEdit.fromTo', { before, after }) : format('offerEdit.same', { now: before });
    };
    rows.push({ label, value: { kind: 'text', text: say(false), exact: say(true) }, binding: changed });
  };
  rows.push({
    label: text('offerCancel.rowOffer'),
    value: { kind: 'text', text: format(o === null ? 'offerCancel.offerId' : isLender(o) ? 'offerCancel.offerLend' : 'offerCancel.offerBorrow', { id: r.offerId.toString() }) },
    binding: true,
  });
  if (o !== null) {
    const shape = editShape(o);
    const rate = (): [string, string] => [rateText(o.interestRateBps, o.interestRateBpsMax, copy), rateText(t.interestRateBps, t.interestRateBpsMax, copy)];
    change(text('offerEdit.rowRate'), o.interestRateBps !== t.interestRateBps || o.interestRateBpsMax !== t.interestRateBpsMax, rate);
    if (shape.amount)
      change(text('offerEdit.rowAmount'), o.amount !== t.amount || o.amountMax !== t.amountMax, (exact) => {
        const lend = (v: bigint) => w(o.lendingAsset, v, exact);
        return [rangeText(o.amount, o.amountMax, lend, copy), rangeText(t.amount, t.amountMax, lend, copy)];
      });
    if (shape.collateral)
      change(
        text(isLender(o) ? 'offerEdit.rowCollateralAsked' : 'offerEdit.rowCollateral'),
        o.collateralAmount !== t.collateralAmount || o.collateralAmountMax !== t.collateralAmountMax,
        (exact) => {
          const coll = (v: bigint) => w(o.collateralAsset, v, exact);
          return [rangeText(o.collateralAmount, o.collateralAmountMax, coll, copy), rangeText(t.collateralAmount, t.collateralAmountMax, coll, copy)];
        },
      );
    rows.push({ label: text('offerEdit.rowTerm'), value: { kind: 'text', text: format('offerEdit.termSame', { days: o.durationDays.toString() }) }, binding: false });
  }
  const m = r.move;
  if (m === null) rows.push({ label: text('offerEdit.rowMoves'), value: unknown(text('receipt.unknown')), binding: true });
  else if (m.kind === 'none') rows.push({ label: text('offerEdit.rowMoves'), value: { kind: 'text', text: text('offerEdit.movesNothing') }, binding: true });
  else if (m.kind === 'pull') {
    rows.push({ label: text('offerEdit.rowPull'), value: { kind: 'amount', asset: m.asset, amount: m.amount }, binding: true, movesOut: true });
    rows.push({
      label: text('repay.rowBalance'),
      value: r.balance === null ? unknown(text('receipt.unknown')) : { kind: 'amount', asset: m.asset, amount: r.balance },
      binding: false,
    });
    rows.push({
      label: text('repay.rowApproval'),
      value: {
        kind: 'text',
        text: format(r.approvalSteps === 0 ? 'offerEdit.approvalCovers' : 'offerEdit.approvalNeeded', { amount: w(m.asset, m.amount, false) }),
        exact: format(r.approvalSteps === 0 ? 'offerEdit.approvalCovers' : 'offerEdit.approvalNeeded', { amount: w(m.asset, m.amount, true) }),
      },
      binding: false,
      movesOut: r.approvalSteps > 0,
    });
  } else {
    rows.push({ label: text('offerEdit.rowRelease'), value: { kind: 'amount', asset: m.asset, amount: m.amount }, binding: true });
    rows.push({
      label: text('offerCancel.rowTo'),
      value:
        r.route === 'unknown'
          ? unknown(text('payout.protectionUnread'))
          : { kind: 'text', text: routedDestination(r.route, r.facts.protection, copy) ?? text('payout.toCredit') },
      binding: true,
    });
  }
  if (m?.kind === 'pull') consequences.push(text('offerEdit.pullHeld'));
  if (m?.kind === 'release') consequences.push(...routeNotes(r.route, r.facts.protection, copy));
  consequences.push(r.facts.minTermsAgeSec === null ? text('offerEdit.termsAgeUnread') : format('offerEdit.termsAge', { span: formatSpan(Number(r.facts.minTermsAgeSec)) }));
  if (o !== null && o.backstopEligibleAfter !== 0n) consequences.push(text('offerEdit.backstopEnds'));
  if (o !== null && o.amountFilled > 0n) consequences.push(text('offerEdit.partFilled'));
  consequences.push(text('offerEdit.termFixed'), text('offerEdit.race'));
  if (r.dryRun === 'after-approval') consequences.push(text('offerEdit.dryRunAfterApproval'));
  if (r.approvalSteps > 0) consequences.push(text('offerEdit.approvalBack'));
  return { title: format('offerEdit.title', { id: r.offerId.toString() }), rows, consequences, prompts: editPromptCount(r), readAt: r.readAt };
}

type Args = Record<string, unknown>;

/** The change's outcome, from the Diamond's own logs and the token's. */
export function measureEdit(r: EditReview, logs: readonly Log[], diamond: Hex, viewer: Hex, w: AmountWords, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: OFFER_MUTATE, logs: [...own], strict: false }) as unknown as { eventName: string; args: Args }[];
  const ev = events.find((e) => e.eventName === 'OfferModified' && BigInt(e.args.offerId as bigint) === r.offerId);
  const label = format('offerEdit.legChanged', { id: r.offerId.toString() });
  if (!ev) return [{ status: 'not-done', label, reason: text('offerEdit.notChanged') }];
  const a = ev.args;
  const recorded: EditTerms = {
    amount: a.amount as bigint,
    amountMax: a.amountMax as bigint,
    interestRateBps: a.interestRateBps as bigint,
    interestRateBpsMax: a.interestRateBpsMax as bigint,
    collateralAmount: a.collateralAmount as bigint,
    collateralAmountMax: a.collateralAmountMax as bigint,
    linkKind: Number(a.linkKind ?? 0),
    linkMarginBps: Number(a.linkMarginBps ?? 0),
  };
  const legs: LegOutcome[] = [termsKey(recorded) === termsKey(r.terms) ? { status: 'done', label } : { status: 'not-done', label, reason: text('offerEdit.recordedOther') }];
  const m = r.move;
  if (m === null || m.kind === 'none') return legs;
  if (m.kind === 'pull') {
    const paid = moved(logs, m.asset, viewer, null);
    const paidLabel = format('offerEdit.legPulled', { amount: w(m.asset, paid, false) });
    legs.push(
      paid === m.amount
        ? { status: 'done', label: paidLabel }
        : {
            status: paid === 0n ? 'not-done' : 'unknown',
            label: paidLabel,
            reason: format('offerEdit.pulledOther', { amount: w(m.asset, paid, true), expected: w(m.asset, m.amount, true) }),
          },
    );
    return legs;
  }
  const asset = m.asset;
  legs.push(
    freedLeg(
      {
        freed: freedInVault(logs, diamond, r.facts.offer?.creator ?? viewer, asset, [OFFER_HOLDER], { ref: r.offerId }),
        expected: m.amount,
        what: (v) => w(asset, v, false),
        exact: (v) => w(asset, v, true),
        label: (what, ownVault) => format(ownVault ? 'offerEdit.legReleased' : 'offerEdit.legReleasedHolder', { what }),
      },
      copy,
    ),
  );
  return legs;
}
