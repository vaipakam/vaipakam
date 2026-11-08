/**
 * LN-51 — Claim everything (RB-CLAIM): every payout the wallet can collect
 * now, gathered into ONE transaction through the protocol's batch entry
 * (`multicall`), which runs each payout as its own call with the caller kept
 * as the wallet, so every payout checks its own rules exactly as it would on
 * its own. Each call is sent with `allowFailure`, so a payout the protocol
 * refuses when the transaction runs (another party finalized it, a pause
 * landed) is skipped, moves nothing, and stays listed; the rest still pay.
 *
 * The inclusion list is the rulebook's, and only it: loan payouts (each side
 * the wallet holds, on an ended loan), interaction rewards whose preview
 * completes (or, when it cannot, a held reward the screen releases), the
 * un-lent capital of the wallet's standing offers, free vault VPFI and a
 * payee's withdrawable payroll. Seller claims are collected on their own and
 * never batched; anything whose preview cannot complete is left out, and a
 * source that could not be read is named as left out, never silently
 * dropped. Free vault VPFI is opt-in (off by default), because it is the
 * balance the fee-discount tier is worked out from; so is the capital of a
 * standing offer that is still running, because taking it out leaves the
 * offer less to lend. A loan in fallback is collected on its own: its claim
 * runs the protocol's match first, which decides what it pays.
 *
 * The protocol takes at most {@link CLAIM_ALL_MAX_CALLS} calls in one batch;
 * beyond that the rest wait for a second transaction rather than one that
 * would fail.
 *
 * Everything here is pure, so the rules are tested once.
 */
import { decodeErrorResult, encodeFunctionData, parseAbi, parseEventLogs, type Abi, type Log } from 'viem';
import { ClaimFacetABI, DIAMOND_ABI_VIEM, LenderIntentFacetABI, PayrollFacetABI, VPFIDiscountFacetABI } from '@vaipakam/contracts/abis';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import { claimVerdict } from '../eligibility/claim';
import type { Refusal } from '../eligibility/types';
import { moved } from '../offers/acceptOutcome';
import { payoutOutcomes, payoutRoute, type PayoutRoute, type Protection } from '../protection/payout';
import { payoutLegs, routedDestination, routeChanged, routeNotes } from '../protection/payoutCopy';
import type { Receipt, ReceiptRow, ReceiptText } from '../receipt/types';
import { frozenRefusal, type FrozenState } from '../sanctions/posture';
import type { LegOutcome } from '../tx/outcome';
import { claimRecorded, surplusPaid } from './claimLog';
import { nftLegs } from './claimOutcome';
import { ASSET_ERC20, isFallback, type ClaimLane, type ClaimSide } from './loanClaim';
import { laneLabel } from './loanClaimReceipt';
import type { LoanClaimRows } from './loanClaimRows';
import { claimRecord, REWARD_CLAIM_ABI, VENUE_VAULT, type HeldRewards, type PendingRewards } from './rewards';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

const CLAIM = ClaimFacetABI as Abi;
const INTENT = LenderIntentFacetABI as Abi;
const DISCOUNT = VPFIDiscountFacetABI as Abi;
const PAYROLL = PayrollFacetABI as Abi;

/** `MulticallFacet.MAX_MULTICALL_CALLS`: the most calls one batch takes. */
export const CLAIM_ALL_MAX_CALLS = 30;

export type LegKind = 'loan' | 'rewards' | 'held' | 'intent' | 'vpfi' | 'payroll';

/** One payout a leg makes, as the list and the receipt state it. */
export interface LegPayout {
  asset: Hex;
  assetType: number;
  tokenId: bigint;
  /** A token amount, an ERC-1155 quantity, or 1 for an ERC-721. */
  amount: bigint;
  /** A loan payout's kind (named as the loan's own claim names it); null for
   *  the other legs, which make one payout each. */
  lane: ClaimLane['kind'] | null;
}

/** What a leg is, beyond its kind. */
export type LegSubject =
  | { kind: 'loan'; loanId: bigint; side: ClaimSide }
  /** `fromDay`/`toDay`: the days this bounded claim walks (0 when it pays
   *  from its reward entries only). */
  | { kind: 'rewards'; fromDay: bigint; toDay: bigint }
  | { kind: 'held' }
  /** `tier`: the offer lends VPFI, and its capital counts toward the
   *  fee-discount tier (`LibVPFIDiscount.tierVpfiBalance`); null when the
   *  VPFI token could not be read, so that is not known. */
  | { kind: 'intent'; lendingAsset: Hex; collateralAsset: Hex; active: boolean; tier: boolean | null }
  | { kind: 'vpfi' }
  | { kind: 'payroll'; streamId: bigint };

/** One payout of Claim everything: its call, what it pays, where it lands. */
export interface ClaimAllLeg {
  key: string;
  subject: LegSubject;
  payouts: LegPayout[];
  /** Where the payment lands: the wallet, or where protected account mode
   *  routes it. Rewards are credited to the vault ('reward-vault'). */
  route: PayoutRoute | 'reward-vault';
  /** Off by default; the reader turns it on (free vault VPFI, a running
   *  standing offer's capital). */
  optIn: boolean;
}

/** A payout source that could not be read, or read only in part: named as
 *  left out, never dropped. */
export interface ClaimAllGap {
  kind: LegKind;
  /** 'unread': the read failed; 'partial': more exists than one read covers;
   *  'own': this one is collected on its own (a loan in fallback). */
  why: 'unread' | 'partial' | 'own';
  /** The loan, for a loan gap. */
  loanId?: bigint;
  side?: ClaimSide;
}

/** Every source Claim everything reads, as read (null: the read failed). */
export interface ClaimAllInputs {
  account: Hex;
  paused: boolean | null;
  frozen: FrozenState;
  protection: Protection | null;
  loans: LoanClaimRows | null;
  rewards: PendingRewards | null;
  held: HeldRewards | null;
  /** The protocol's VPFI token (null: unread; the zero address: none set). */
  vpfiToken: Hex | null;
  intents: { rows: { lendingAsset: Hex; collateralAsset: Hex; available: bigint; active: boolean }[]; complete: boolean } | null;
  /** Free VPFI in the wallet's vault (null: unread). */
  vpfiFree: bigint | null;
  payroll: { rows: { streamId: bigint; asset: Hex; withdrawable: bigint }[]; complete: boolean } | null;
}

export interface ClaimAllList {
  paused: boolean | null;
  frozen: FrozenState;
  protection: Protection | null;
  legs: ClaimAllLeg[];
  gaps: ClaimAllGap[];
}

const ZERO = '0x0000000000000000000000000000000000000000';

const lower = (a: Hex) => a.toLowerCase();

/** The leg's key: one per loan side, intent pair and stream. */
export function legKey(s: LegSubject): string {
  switch (s.kind) {
    case 'loan':
      return `loan:${s.side}:${s.loanId.toString()}`;
    case 'intent':
      return `intent:${lower(s.lendingAsset)}:${lower(s.collateralAsset)}`;
    case 'payroll':
      return `payroll:${s.streamId.toString()}`;
    default:
      return s.kind;
  }
}

function leg(subject: LegSubject, payouts: LegPayout[], route: ClaimAllLeg['route'], optIn = false): ClaimAllLeg {
  return { key: legKey(subject), subject, payouts, route, optIn };
}

const erc20 = (asset: Hex, amount: bigint): LegPayout => ({ asset, assetType: ASSET_ERC20, tokenId: 0n, amount, lane: null });

/**
 * The list, from what was read. A loan side enters when the claim's own rule
 * is open for this wallet and it pays something; a side the rule refuses is
 * not a payout of the wallet's now (Claims says why beside it) and is not
 * listed here. The pause and the sanctions screen do not remove anything:
 * they stop the whole batch, said once.
 */
export function claimAllList(i: ClaimAllInputs, copy: Pick<CopyAccess, 'text'>, readAt: number): ClaimAllList {
  const legs: ClaimAllLeg[] = [];
  const gaps: ClaimAllGap[] = [];
  const self = (): PayoutRoute => payoutRoute(i.protection, i.account, i.account);

  if (i.loans === null) gaps.push({ kind: 'loan', why: 'unread' });
  else {
    if (!i.loans.complete) gaps.push({ kind: 'loan', why: 'partial' });
    for (const r of i.loans.rows) {
      if (r.loan === null || r.claim === null) {
        gaps.push({ kind: 'loan', why: 'unread', loanId: r.loanId, side: r.side });
        continue;
      }
      // The rule as if neither paused nor flagged: those stop the batch as a
      // whole and are said once, not per loan.
      const v = claimVerdict(
        { side: r.side, status: Number(r.loan.status), loanAssetType: Number(r.loan.assetType), paused: false, holder: r.holder, claim: r.claim },
        i.account,
        copy,
        readAt,
      );
      if (v.state === 'unknown') {
        gaps.push({ kind: 'loan', why: 'unread', loanId: r.loanId, side: r.side });
        continue;
      }
      if (v.state !== 'open' || r.lanes.length === 0) continue;
      if (r.side === 'lender' && isFallback(Number(r.loan.status))) {
        gaps.push({ kind: 'loan', why: 'own', loanId: r.loanId, side: r.side });
        continue;
      }
      const source = r.side === 'lender' ? r.loan.lender : r.loan.borrower;
      legs.push(
        leg(
          { kind: 'loan', loanId: r.loanId, side: r.side },
          r.lanes.map((l) => ({ asset: l.asset, assetType: l.assetType, tokenId: l.tokenId, amount: l.amount, lane: l.kind })),
          payoutRoute(i.protection, i.account, source),
        ),
      );
    }
  }

  // Rewards: the claim run as a preview pays any held reward with it, so a
  // separate held leg is offered only when that preview cannot complete.
  const vpfi = i.vpfiToken !== null && lower(i.vpfiToken) !== ZERO ? i.vpfiToken : null;
  if (i.rewards !== null && i.rewards.kind === 'exact') {
    // A preview that completes is a claim the protocol takes, even one that
    // pays nothing: it walks days that paid nothing so the later paying days
    // can be reached (the protocol refuses a claim that would do nothing).
    if (vpfi === null) gaps.push({ kind: 'rewards', why: 'unread' });
    else legs.push(leg({ kind: 'rewards', fromDay: i.rewards.fromDay, toDay: i.rewards.toDay }, [erc20(vpfi, i.rewards.amount)], 'reward-vault'));
  } else {
    // The preview unread is said; a held reward the screen releases is read
    // on its own and still offered.
    if (i.rewards === null) gaps.push({ kind: 'rewards', why: 'unread' });
    if (i.held === null) gaps.push({ kind: 'held', why: 'unread' });
    else if (i.held.decision === 'deliver' && i.held.held > 0n) {
      if (vpfi === null) gaps.push({ kind: 'held', why: 'unread' });
      else legs.push(leg({ kind: 'held' }, [erc20(vpfi, i.held.held)], 'reward-vault'));
    }
  }

  if (i.intents === null) gaps.push({ kind: 'intent', why: 'unread' });
  else {
    if (!i.intents.complete) gaps.push({ kind: 'intent', why: 'partial' });
    for (const r of i.intents.rows) {
      if (r.available === 0n) continue;
      // An unread token leaves the tier effect unknown: kept off and said.
      const tier = i.vpfiToken === null ? null : vpfi !== null && lower(r.lendingAsset) === lower(vpfi);
      legs.push(
        leg(
          { kind: 'intent', lendingAsset: r.lendingAsset, collateralAsset: r.collateralAsset, active: r.active, tier },
          [erc20(r.lendingAsset, r.available)],
          self(),
          r.active || tier !== false,
        ),
      );
    }
  }

  if (i.vpfiFree === null) gaps.push({ kind: 'vpfi', why: 'unread' });
  else if (i.vpfiFree > 0n && vpfi !== null) legs.push(leg({ kind: 'vpfi' }, [erc20(vpfi, i.vpfiFree)], self(), true));

  if (i.payroll === null) gaps.push({ kind: 'payroll', why: 'unread' });
  else {
    if (!i.payroll.complete) gaps.push({ kind: 'payroll', why: 'partial' });
    // The protocol pays a protected payee into its vault instead
    // (`LibDelivery.pushOut`), as any payment from outside the payee's own vault.
    for (const r of i.payroll.rows)
      if (r.withdrawable > 0n) legs.push(leg({ kind: 'payroll', streamId: r.streamId }, [erc20(r.asset, r.withdrawable)], payoutRoute(i.protection, i.account, ZERO)));
  }

  return { paused: i.paused, frozen: i.frozen, protection: i.protection, legs, gaps };
}

/** The legs on by default: everything but the opt-ins. */
export function defaultPicked(legs: readonly ClaimAllLeg[]): Set<string> {
  return new Set(legs.filter((l) => !l.optIn).map((l) => l.key));
}

/** The legs the reader picked, in list order, split into this transaction
 *  and the remainder a second one collects. */
export function batchOf(legs: readonly ClaimAllLeg[], picked: ReadonlySet<string>, max = CLAIM_ALL_MAX_CALLS): { now: ClaimAllLeg[]; later: ClaimAllLeg[] } {
  const chosen = legs.filter((l) => picked.has(l.key));
  return { now: chosen.slice(0, max), later: chosen.slice(max) };
}

/** The call one leg makes inside the batch. */
export function legCall(l: ClaimAllLeg, account: Hex): { abi: Abi; functionName: string; args: readonly unknown[] } {
  const s = l.subject;
  switch (s.kind) {
    case 'loan':
      return { abi: CLAIM, functionName: s.side === 'lender' ? 'claimAsLender' : 'claimAsBorrower', args: [s.loanId] };
    case 'rewards':
      return { abi: REWARD_CLAIM_ABI, functionName: 'claimInteractionRewardsTo', args: [VENUE_VAULT] };
    case 'held':
      return { abi: REWARD_CLAIM_ABI, functionName: 'claimHeldInteractionRewards', args: [VENUE_VAULT] };
    case 'intent':
      return { abi: INTENT, functionName: 'withdrawLenderIntentCapital', args: [account, s.lendingAsset, s.collateralAsset, l.payouts[0]!.amount] };
    case 'vpfi':
      return { abi: DISCOUNT, functionName: 'withdrawVPFIFromVault', args: [l.payouts[0]!.amount] };
    case 'payroll':
      return { abi: PAYROLL, functionName: 'withdrawSalary', args: [s.streamId] };
  }
}

/** The batch's argument: every leg allowed to fail on its own. */
export function batchCalls(legs: readonly ClaimAllLeg[], account: Hex, allowFailure = true): { callData: Hex; allowFailure: boolean }[] {
  return legs.map((l) => {
    const c = legCall(l, account);
    return { callData: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args }), allowFailure };
  });
}

/**
 * The gas limit for a batch whose calls may each fail on their own. A gas
 * estimate of that batch finds the least gas at which the transaction does
 * not revert, and a call allowed to fail never reverts it, so the estimate
 * can land where a payout runs out of gas and is skipped. The limit is
 * therefore taken from the same calls with every one required to succeed
 * (`batchCalls(legs, account, false)`), with the usual margin on top.
 */
export const CLAIM_ALL_GAS_MARGIN_PCT = 130n;
export function claimAllGasLimit(requiredEstimate: bigint): bigint {
  return (requiredEstimate * CLAIM_ALL_GAS_MARGIN_PCT + 99n) / 100n;
}

/** A skipped call's refusal, from the revert bytes the batch returned. */
export function refusalFromRevertData(data: Hex): Refusal {
  if (data.length < 10) return refusalFromError(new Error('the call reverted without a reason'));
  try {
    const d = decodeErrorResult({ abi: DIAMOND_ABI_VIEM as Abi, data });
    return refusalFromError({ raw: data, data: { errorName: d.errorName } });
  } catch {
    return refusalFromError({ raw: data });
  }
}

/** The batch's dry run, leg by leg: null where the call passes, its refusal
 *  where the protocol refuses it. */
export function legResults(legs: readonly ClaimAllLeg[], results: readonly { success: boolean; returnData: Hex }[]): Map<string, Refusal | null> {
  const out = new Map<string, Refusal | null>();
  legs.forEach((l, n) => {
    const r = results[n];
    out.set(l.key, r === undefined ? refusalFromError(new Error('the batch returned no answer for this payout')) : r.success ? null : refusalFromRevertData(r.returnData));
  });
  return out;
}

// ─── In words ─────────────────────────────────────────────────────────────

/** A leg's name, the same on the list, the receipt and the finish card. */
export function legTitle(l: Pick<ClaimAllLeg, 'subject'>, copy: Copy, symbol: (asset: Hex) => string): string {
  const { text, format } = copy;
  const s = l.subject;
  switch (s.kind) {
    case 'loan':
      return format(s.side === 'lender' ? 'claimAll.loanLender' : 'claimAll.loanBorrower', { id: s.loanId.toString() });
    case 'rewards':
      return text('claimAll.rewards');
    case 'held':
      return text('claimAll.held');
    case 'intent':
      return format('claimAll.intent', { lend: symbol(s.lendingAsset), collateral: symbol(s.collateralAsset) });
    case 'vpfi':
      return text('claimAll.vpfi');
    case 'payroll':
      return format('claimAll.payroll', { id: s.streamId.toString() });
  }
}

/** One payout's label within its leg. */
export function payoutLabel(l: ClaimAllLeg, p: LegPayout, copy: Copy): string | null {
  // A payroll withdrawal pays everything accrued when it runs, so the
  // figure read is a floor that keeps rising while the stream runs.
  if (l.subject.kind === 'payroll') return copy.text('claimAll.payrollAtLeast');
  if (l.subject.kind === 'rewards' && p.amount === 0n)
    return l.subject.toDay === 0n
      ? copy.text('rewards.pendingZeroEntries')
      : copy.format('rewards.pendingZero', { from: l.subject.fromDay.toString(), to: l.subject.toDay.toString() });
  return l.subject.kind === 'loan' && p.lane !== null ? laneLabel(p.lane, l.subject.side, copy) : null;
}

/** Why a gap is left out, in words. */
export function gapText(g: ClaimAllGap, copy: Copy): string {
  const { text, format } = copy;
  if (g.kind === 'loan' && g.loanId !== undefined) {
    const which = format(g.side === 'lender' ? 'claimAll.loanLender' : 'claimAll.loanBorrower', { id: g.loanId.toString() });
    return format(g.why === 'own' ? 'claimAll.gapFallback' : 'claimAll.gapLoanUnread', { what: which });
  }
  return text(GAP_KEYS[g.kind][g.why === 'partial' ? 'partial' : 'unread']);
}

const GAP_KEYS = {
  loan: { unread: 'claimAll.gap.loan.unread', partial: 'claimAll.gap.loan.partial' },
  rewards: { unread: 'claimAll.gap.rewards.unread', partial: 'claimAll.gap.rewards.partial' },
  held: { unread: 'claimAll.gap.held.unread', partial: 'claimAll.gap.held.partial' },
  intent: { unread: 'claimAll.gap.intent.unread', partial: 'claimAll.gap.intent.partial' },
  vpfi: { unread: 'claimAll.gap.vpfi.unread', partial: 'claimAll.gap.vpfi.partial' },
  payroll: { unread: 'claimAll.gap.payroll.unread', partial: 'claimAll.gap.payroll.partial' },
} as const satisfies Record<LegKind, Record<'unread' | 'partial', CopyKey>>;

/** Why an opt-in is off by default, in words. */
export function optInText(l: ClaimAllLeg, copy: Copy): string | null {
  if (l.subject.kind === 'vpfi') return copy.text('claimAll.vpfiOptIn');
  if (l.subject.kind === 'intent' && l.subject.active) return copy.text('claimAll.intentOptIn');
  if (l.subject.kind === 'intent' && l.subject.tier === true) return copy.text('claimAll.vpfiOptIn');
  if (l.subject.kind === 'intent' && l.subject.tier === null) return copy.text('claimAll.tierUnknownOptIn');
  return null;
}

/** What stops the whole batch before any leg is asked: the pause, then a
 *  flagged wallet (RB-FROZEN); null when nothing does. Unread is said. */
export function batchStop(list: Pick<ClaimAllList, 'paused' | 'frozen'>, copy: Pick<CopyAccess, 'text'>): Refusal | null {
  if (list.paused === null) return { code: 'Unread', reason: copy.text('claimAll.unread'), reopensAt: null, remedy: null };
  if (list.paused) return { code: 'EnforcedPause', reason: copy.text('claimAll.paused'), reopensAt: null, remedy: null };
  if (list.frozen === 'flagged') return frozenRefusal('flagged', copy);
  return null;
}

// ─── The review ───────────────────────────────────────────────────────────

export interface ClaimAllReview {
  identity: string;
  list: ClaimAllList;
  /** The keys the reader picked. */
  picked: string[];
  /** The legs this transaction sends: picked, within the bound, and passed
   *  by the protocol's dry run. */
  send: ClaimAllLeg[];
  /** Picked legs within the bound that the dry run refused: left out of
   *  this transaction, each with the protocol's reason. */
  refused: { leg: ClaimAllLeg; refusal: Refusal }[];
  /** Picked legs past the bound: a second transaction collects them. */
  later: ClaimAllLeg[];
  /** The dry run of the whole batch: null when it ran, its refusal when the
   *  batch itself was refused, 'unread' when it could not be run, 'skipped'
   *  when something stopped the batch first. */
  dryRun: Refusal | null | 'unread' | 'skipped';
  readAt: number;
}

const payoutKey = (p: LegPayout) => `${lower(p.asset)}:${p.assetType}:${p.tokenId}:${p.amount}`;
// The whole subject (an offer's running state, a rewards claim's days) and
// the opt-in are part of what the review states, not only the payouts.
const subjectSig = (s: LegSubject) => JSON.stringify(s, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v.toLowerCase() : v));
// A payroll figure is a floor (see `payoutLabel`): its rise is the stream
// accruing, not a change to confirm, so it is compared on its own below.
const legSig = (l: ClaimAllLeg) =>
  `${l.key}=${subjectSig(l.subject)}=${l.optIn}=${l.route}=${l.subject.kind === 'payroll' ? l.payouts.map((p) => lower(p.asset)).join(',') : l.payouts.map(payoutKey).join(',')}`;

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. */
export function claimAllChanged(a: ClaimAllReview, b: ClaimAllReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if (a.list.paused !== b.list.paused || a.list.frozen !== b.list.frozen) return text('repay.changedVerdict');
  if (a.send.map(legSig).join('|') !== b.send.map(legSig).join('|')) return text('claimAll.changed');
  // A payroll floor that went down (the stream paid elsewhere, or was cut) is a change.
  if (a.send.some((l, n) => l.subject.kind === 'payroll' && b.send[n]!.payouts[0]!.amount < l.payouts[0]!.amount)) return text('claimAll.changed');
  // The same route can bind differently: a queued payout's delay and its
  // secondary signer are stated in the review.
  if (
    a.send.some(
      (l, n) =>
        l.route !== 'reward-vault' && routeChanged({ route: l.route, protection: a.list.protection }, { route: b.send[n]!.route as PayoutRoute, protection: b.list.protection }),
    )
  )
    return text('claimAll.changed');
  if (a.refused.map((r) => `${r.leg.key}:${r.refusal.code}`).join('|') !== b.refused.map((r) => `${r.leg.key}:${r.refusal.code}`).join('|')) return text('claimAll.changed');
  if (a.later.length !== b.later.length) return text('claimAll.changed');
  if ((a.dryRun === null) !== (b.dryRun === null)) return text('repay.changedVerdict');
  return null;
}

/** What stops the review here, in words (empty when nothing does). */
export function claimAllBlockers(r: ClaimAllReview, copy: Copy): string[] {
  const stop = batchStop(r.list, copy);
  if (stop) return [stop.reason];
  if (r.picked.length === 0) return [copy.text('claimAll.noneChosen')];
  if (r.dryRun === 'unread') return [copy.text('claimAll.dryRunUnread')];
  if (r.dryRun !== null && r.dryRun !== 'skipped') return [copy.format('repay.dryRunRefused', { reason: r.dryRun.reason })];
  if (r.send.length === 0) return [copy.text('claimAll.allRefused')];
  return [];
}

/** Where a group of sent legs lands, as a receipt value: rewards to the
 *  vault, or the route's own destination (a queued route names its delay). */
function destinationOf(route: ClaimAllLeg['route'], r: ClaimAllReview, copy: Copy): ReceiptRow['value'] {
  if (route === 'reward-vault') return { kind: 'text', text: copy.text('claimAll.toVaultOnly') };
  if (route === 'unknown') return { kind: 'unknown', why: copy.text('receipt.unknown') };
  const to = route === 'wallet' ? copy.text('loanClaim.toWallet') : routedDestination(route, r.list.protection, copy);
  return to === null ? { kind: 'unknown', why: copy.text('receipt.unknown') } : { kind: 'text', text: to };
}

/** Where the sent legs land: one row when they all land in one place, else
 *  one row per destination naming the payouts that go there, so each
 *  destination (a queued one's delay included) is stated in full. */
function destinationRows(r: ClaimAllReview, copy: Copy, symbol: (asset: Hex) => string): ReceiptRow[] {
  const groups = new Map<ClaimAllLeg['route'], ClaimAllLeg[]>();
  for (const l of r.send) groups.set(l.route, [...(groups.get(l.route) ?? []), l]);
  if (groups.size <= 1) {
    const only = [...groups.keys()][0] ?? 'reward-vault';
    return [{ label: copy.text('takeBack.rowTo'), value: destinationOf(only, r, copy), binding: true }];
  }
  return [...groups.entries()].map(([route, legs]) => ({
    label: copy.format('claimAll.rowToFor', { what: legs.map((l) => legTitle(l, copy, symbol)).join(', ') }),
    value: destinationOf(route, r, copy),
    binding: true,
  }));
}

export function claimAllReceipt(r: ClaimAllReview, copy: Copy, describe: { symbol: (asset: Hex) => string; nft: (p: LegPayout) => string }): Receipt {
  const { text, format } = copy;
  const rows: ReceiptRow[] = [];
  for (const l of r.send) {
    const title = legTitle(l, copy, describe.symbol);
    for (const p of l.payouts) {
      const sub = payoutLabel(l, p, copy);
      rows.push({
        label: sub === null ? title : `${title}: ${sub}`,
        value: p.assetType === ASSET_ERC20 ? { kind: 'amount', asset: p.asset, amount: p.amount } : { kind: 'text', text: describe.nft(p) },
        binding: true,
      });
    }
  }
  rows.push(...destinationRows(r, copy, describe.symbol));

  const has = (k: LegKind) => r.send.some((l) => l.subject.kind === k);
  const consequences: ReceiptText[] = [text('claimAll.bestEffort')];
  if (has('loan')) consequences.push(text('claimAll.loansClose'));
  if (has('rewards') || has('held')) consequences.push(text('claimAll.rewardsVault'));
  if (has('rewards')) consequences.push(text('claimAll.rewardsBounded'));
  if (has('vpfi') || r.send.some((l) => l.subject.kind === 'intent' && l.subject.tier === true)) consequences.push(text('claimAll.vpfiTier'));
  if (r.send.some((l) => l.subject.kind === 'intent' && l.subject.tier === null)) consequences.push(text('claimAll.tierUnknown'));
  if (r.send.some((l) => l.subject.kind === 'intent' && l.subject.active)) consequences.push(text('claimAll.intentStops'));
  for (const x of r.refused) consequences.push(format('claimAll.leftOut', { what: legTitle(x.leg, copy, describe.symbol), reason: x.refusal.reason }));
  if (r.later.length > 0) consequences.push(format('claimAll.remainder', { n: String(r.later.length), max: String(CLAIM_ALL_MAX_CALLS) }));
  const routes = new Set(r.send.map((l) => l.route).filter((x): x is PayoutRoute => x !== 'reward-vault'));
  for (const route of routes) consequences.push(...routeNotes(route, r.list.protection, copy));
  consequences.push(text('claimAll.pauseHolds'));
  return { title: format(r.send.length === 1 ? 'claimAll.titleOne' : 'claimAll.title', { n: String(r.send.length) }), rows, consequences, prompts: 1, readAt: r.readAt };
}

// ─── The transaction's own record ─────────────────────────────────────────

const LEG_EVENTS = parseAbi([
  'event LenderIntentCapitalWithdrawn(address indexed owner, address indexed lendingAsset, address indexed collateralAsset, uint256 amount, uint256 remainingCapital)',
  'event VPFIWithdrawnFromVault(address indexed user, uint256 amount, uint256 newVaultBalance)',
  'event SalaryWithdrawn(uint256 indexed streamId, address indexed beneficiary, uint256 amount)',
]);

type LegArgs = Record<string, unknown>;

function legEvents(logs: readonly Log[], diamond: Hex): { eventName: string; args: LegArgs }[] {
  const own = logs.filter((l) => lower(l.address as Hex) === lower(diamond));
  return parseEventLogs({ abi: LEG_EVENTS, logs: [...own], strict: false }) as unknown as { eventName: string; args: LegArgs }[];
}

const same = (a: unknown, b: Hex) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** What the transaction recorded paying for one leg (a token and amount for
 *  each ERC-20 payout it measured), or null when it records nothing: the
 *  leg was skipped. Rewards are recorded as paid; `toVault` says how much of
 *  that the vault was credited. */
export function legRecord(l: ClaimAllLeg, logs: readonly Log[], diamond: Hex, account: Hex): { paid: { asset: Hex; amount: bigint }[]; toVault?: bigint } | null {
  const s = l.subject;
  if (s.kind === 'loan') {
    const rec = claimRecorded(logs, diamond, s.loanId, s.side);
    if (rec === null) return null;
    // The claim row as the protocol recorded paying it; the rest as listed.
    const paid = l.payouts
      .filter((p) => p.assetType === ASSET_ERC20 && p.amount > 0n)
      .map((p) => (p.lane === 'row' ? { asset: rec.asset, amount: rec.amount } : { asset: p.asset, amount: p.amount }));
    const rowListed = l.payouts.some((p) => p.lane === 'row');
    if (!rowListed && rec.amount > 0n) paid.unshift({ asset: rec.asset, amount: rec.amount });
    return { paid };
  }
  if (s.kind === 'rewards' || s.kind === 'held') {
    const r = claimRecord(logs, diamond, account);
    return r.paid === null ? null : { paid: [{ asset: l.payouts[0]!.asset, amount: r.paid }], toVault: r.toVault };
  }
  const events = legEvents(logs, diamond);
  if (s.kind === 'intent') {
    const hit = events.find(
      (e) =>
        e.eventName === 'LenderIntentCapitalWithdrawn' &&
        same(e.args.owner, account) &&
        same(e.args.lendingAsset, s.lendingAsset) &&
        same(e.args.collateralAsset, s.collateralAsset),
    );
    return hit ? { paid: [{ asset: s.lendingAsset, amount: BigInt(String(hit.args.amount)) }] } : null;
  }
  if (s.kind === 'vpfi') {
    const hit = events.find((e) => e.eventName === 'VPFIWithdrawnFromVault' && same(e.args.user, account));
    return hit ? { paid: [{ asset: l.payouts[0]!.asset, amount: BigInt(String(hit.args.amount)) }] } : null;
  }
  const hit = events.find((e) => e.eventName === 'SalaryWithdrawn' && BigInt(String(e.args.streamId)) === s.streamId && same(e.args.beneficiary, account));
  return hit ? { paid: [{ asset: l.payouts[0]!.asset, amount: BigInt(String(hit.args.amount)) }] } : null;
}

/** Amounts in words, short and exact; an NFT payout in words. */
export interface ClaimAllWords {
  amount: (asset: Hex, v: bigint) => string;
  exact: (asset: Hex, v: bigint) => string;
  symbol: (asset: Hex) => string;
  nft: (p: LegPayout) => string;
}

/**
 * RB-CONFIDENCE — the finish card: each sent leg's own record (collected, or
 * skipped and still listed), each NFT where it landed, then each token
 * measured where it landed, summed across the legs that paid it (the
 * wallet, or protected account mode's queue or vault), against what those
 * legs recorded paying. A rewards claim that leaves more is said
 * (`moreRewards`), so the remainder is offered again.
 */
export function measureClaimAll(r: ClaimAllReview, logs: readonly Log[], diamond: Hex, account: Hex, w: ClaimAllWords, copy: Copy, moreRewards: boolean | null): LegOutcome[] {
  const { text, format } = copy;
  const legs: LegOutcome[] = [];
  const expected = new Map<string, { asset: Hex; amount: bigint }>();
  const add = (asset: Hex, amount: bigint) => {
    const k = lower(asset);
    expected.set(k, { asset: expected.get(k)?.asset ?? asset, amount: (expected.get(k)?.amount ?? 0n) + amount });
  };
  const nfts = new Map<string, LegPayout>();
  const addNft = (p: LegPayout) => {
    const k = `${lower(p.asset)}:${p.tokenId}`;
    const had = nfts.get(k);
    nfts.set(k, had ? { ...had, amount: had.amount + p.amount } : { ...p, lane: null });
  };
  for (const l of r.send) {
    const title = legTitle(l, copy, w.symbol);
    const rec = legRecord(l, logs, diamond, account);
    if (rec === null) {
      legs.push({ status: 'not-done', label: title, reason: text('claimAll.skipped') });
      continue;
    }
    if (l.subject.kind === 'rewards' || l.subject.kind === 'held') {
      const paid = rec.paid[0]!;
      const toVault = rec.toVault ?? 0n;
      legs.push({ status: 'done', label: format('claimAll.legRewards', { what: title, amount: w.amount(paid.asset, toVault) }) });
      // Any part the vault could not take is paid to the wallet.
      if (paid.amount > toVault) add(paid.asset, paid.amount - toVault);
      if (l.subject.kind === 'rewards' && moreRewards === true) legs.push({ status: 'done', label: text('claimAll.legRewardsMore') });
      // Whether days remain could not be confirmed after the claim: said, never read as none.
      if (l.subject.kind === 'rewards' && moreRewards === null)
        legs.push({ status: 'unknown', label: text('claimAll.legRewardsRest'), reason: text('claimAll.legRewardsRestUnread') });
      continue;
    }
    legs.push({ status: 'done', label: format('claimAll.legCollected', { what: title }) });
    for (const p of rec.paid) add(p.asset, p.amount);
    if (l.subject.kind !== 'loan') continue;
    const loanId = l.subject.loanId;
    if (l.payouts.some((p) => p.lane === 'surplus') && surplusPaid(logs, diamond, loanId) === null)
      legs.push({ status: 'not-done', label: `${title}: ${laneLabel('surplus', l.subject.side, copy)}`, reason: text('loanClaim.surplusNotPaid') });
    for (const p of l.payouts) if (p.assetType !== ASSET_ERC20) addNft(p);
  }
  // Each NFT (collection and token id) measured once, against what every
  // collected payout of it promised, each destination with its own quantity.
  for (const p of nfts.values()) legs.push(...nftLegs(logs, diamond, account, p, (n) => w.nft({ ...p, amount: n }), r.list.protection, copy));
  for (const { asset, amount } of expected.values()) {
    if (amount === 0n) continue;
    const outcomes = payoutOutcomes(logs, diamond, account, asset);
    const wallet = moved(logs, asset, null, account);
    legs.push(
      ...payoutLegs(
        {
          outcomes,
          wallet,
          expected: amount,
          protection: r.list.protection,
          what: (v) => w.amount(asset, v),
          exact: (v) => w.exact(asset, v),
          walletLeg: (what) => format('loanClaim.legArrived', { amount: what }),
          walletOther: (got, want) => format('loanClaim.arrivedOther', { amount: got, expected: want }),
        },
        copy,
      ),
    );
  }
  return legs;
}
