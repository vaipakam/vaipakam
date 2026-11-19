/**
 * #3761 — "Borrow now" (`DefaultPathsDesign.md` §4, `InstantMarketDesign.md`).
 *
 * The borrower states the amount, the collateral, the term and the highest
 * rate. The app lists the standing sources that could fill it on the pair,
 * cheapest first (Auto-lend slots whose owners gave the instant market's
 * fills consent, and lender offers that charge interest by time), and asks
 * the protocol itself what `borrowInstant` would do with them in this block:
 * a simulation from the borrower's wallet. What is shown is what that call
 * does, labelled as what this block gives; the form simulates again right
 * before signing, and the transaction carries the figure shown as the least
 * it accepts (`minTotal`), so it cannot deliver less.
 *
 * The protocol's own preview for the borrower's entry is not built yet
 * (`InstantMarketDesign.md` §11); when it is, the read moves to it.
 *
 * Collateral comes from the borrower's free vault balance first, then from
 * the wallet, which needs an approval of exactly the wallet's part. Until that
 * approval exists a plain simulation would see every source refuse for want
 * of it, so the simulation is asked with the approval in place as a state
 * override (`allowanceOverride`); where the token's allowance cannot be
 * located that way, the figure is stated as not known until the approval is
 * given, never guessed.
 */
import { decodeEventLog, formatUnits, type Abi, type Log, type PublicClient } from 'viem';
import { InstantMarketFacetABI } from '@vaipakam/contracts/abis';
import type { StoredOffer } from '../offers/acceptTerms';
import type { RiskNeed } from '../risk/riskAccess';
import type { LifTerms } from '../offers/initiationFee';
import { intentTermDays, type IntentSummary } from '../offers/intents';
import { DEFAULT_INPUT, parseAmount, parseDays, parseRateBps, type ParseError, type PostInput } from '../post/postModel';

type Hex = `0x${string}`;

export const INSTANT_MARKET = InstantMarketFacetABI as Abi;

/** The protocol reads at most this many sources per call. */
export const MAX_SOURCES = 16;

/** `InstantMarketFacet.KIND_FIXED`: the only kind the market fills today. */
export const KIND_FIXED = 0;

export interface InstantSource {
  /** 0 = an Auto-lend slot (`owner`, `slot`); 1 = a lender offer (`offerId`). */
  kind: 0 | 1;
  owner: Hex;
  slot: number;
  offerId: bigint;
}

/** A source with what the app read about it, to order the list. */
export interface Candidate {
  source: InstantSource;
  rateBps: bigint;
  /** What it could lend now, as read (the protocol decides). */
  room: bigint;
}

const ZERO: Hex = '0x0000000000000000000000000000000000000000';
const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

/**
 * The Auto-lend slots on the pair that could take this borrow, before their
 * instant-market consent is read: not the borrower's own, open to any
 * filler, taking interest by time, at or under the rate limit, with a term
 * long enough and room at or above their smallest fill.
 */
export function slotCandidates(intents: readonly IntentSummary[], lending: Hex, collateral: Hex, at: bigint, borrower: Hex, termDays: number, maxRateBps: bigint): Candidate[] {
  const out: Candidate[] = [];
  for (const i of intents) {
    if (!same(i.lendingAsset, lending) || !same(i.collateralAsset, collateral)) continue;
    if (same(i.owner, borrower) || i.requiresKeeperAuth || !i.acceptsProRata) continue;
    if (i.minRateBps > maxRateBps) continue;
    if (intentTermDays(i, at) < termDays || termDays > i.maxDurationDays) continue;
    const exposureRoom = i.maxExposure > i.livePrincipal ? i.maxExposure - i.livePrincipal : 0n;
    const room = exposureRoom < i.availableCapital ? exposureRoom : i.availableCapital;
    if (room === 0n || room < i.minFillAmount) continue;
    out.push({ source: { kind: 0, owner: i.owner, slot: i.slot, offerId: 0n }, rateBps: i.minRateBps, room });
  }
  return out;
}

/** The protocol's lifecycle "either" bits on a lender offer (#3621). */
const FLEX_PARTIAL_REPAY = 1;
const FLEX_PREPAY_LISTING = 2;

/** What the instant borrow's own request asks of a lender offer's terms. */
export interface RequestedTerms {
  termDays: number;
  allowsPartialRepay: boolean;
}

/**
 * A lender offer as a source: an open ERC-20 lender offer on the pair that
 * charges interest by time, not the borrower's own, at or under the limit,
 * and whose terms the protocol's match rule accepts for this request: a term
 * at least as long, the same partial-repayment choice (or "either"), no
 * collateral-sale listing (or "either") and no interest schedule, since the
 * instant request carries neither. An offer the match would refuse is left
 * out before the list is cut to the protocol's limit, so it cannot crowd
 * out one that can fill.
 */
export function offerCandidate(offerId: bigint, o: StoredOffer, lending: Hex, collateral: Hex, borrower: Hex, maxRateBps: bigint, want: RequestedTerms): Candidate | null {
  if (o.accepted || o.offerType !== 0 || o.assetType !== 0) return null;
  if (!same(o.lendingAsset as Hex, lending) || !same(o.collateralAsset as Hex, collateral)) return null;
  if (same(o.creator, borrower) || o.useFullTermInterest) return null;
  if (o.interestRateBps > maxRateBps) return null;
  if (BigInt(want.termDays) > o.durationDays) return null;
  if (o.allowsPartialRepay !== want.allowsPartialRepay && (o.lifecycleFlex & FLEX_PARTIAL_REPAY) === 0) return null;
  if (o.allowsPrepayListing && (o.lifecycleFlex & FLEX_PREPAY_LISTING) === 0) return null;
  if (o.periodicInterestCadence !== 0) return null;
  const cap = o.amountMax === 0n ? o.amount : o.amountMax;
  const room = cap > o.amountFilled ? cap - o.amountFilled : 0n;
  if (room === 0n) return null;
  return { source: { kind: 1, owner: ZERO, slot: 0, offerId }, rateBps: o.interestRateBps, room };
}

/** Cheapest first; among equal rates, the most room first; at most the
 *  number the protocol reads. Each fill is priced at its own source's rate. */
export function orderSources(cands: readonly Candidate[]): Candidate[] {
  return [...cands].sort((a, b) => (a.rateBps !== b.rateBps ? (a.rateBps < b.rateBps ? -1 : 1) : a.room > b.room ? -1 : a.room < b.room ? 1 : 0)).slice(0, MAX_SOURCES);
}

/** What the borrower states, parsed. */
export interface BorrowNowTerms {
  lending: Hex;
  collateral: Hex;
  amount: bigint;
  collateralOffered: bigint;
  termDays: number;
  maxRateBps: bigint;
  allowsPartialRepay: boolean;
}

export interface InstantBorrowRequest {
  lendingAsset: Hex;
  collateralAsset: Hex;
  amountWanted: bigint;
  collateralOffered: bigint;
  kind: number;
  termDays: number;
  maxRateBps: bigint;
  allowsPartialRepay: boolean;
  minTotal: bigint;
  validUntil: bigint;
  riskAndTermsConsent: boolean;
  rateFarFromAverageAcknowledged: boolean;
}

/** The request as the call carries it. `minTotal` is the least the
 *  borrower accepts: 0 for the question "what would fill", the figure shown
 *  for the transaction. */
export function instantRequest(t: BorrowNowTerms, minTotal: bigint, validUntil: bigint): InstantBorrowRequest {
  return {
    lendingAsset: t.lending,
    collateralAsset: t.collateral,
    amountWanted: t.amount,
    collateralOffered: t.collateralOffered,
    kind: KIND_FIXED,
    termDays: t.termDays,
    maxRateBps: t.maxRateBps,
    allowsPartialRepay: t.allowsPartialRepay,
    minTotal,
    validUntil,
    riskAndTermsConsent: true,
    rateFarFromAverageAcknowledged: false,
  };
}

export function borrowNowCall(req: InstantBorrowRequest, sources: readonly InstantSource[]) {
  return { abi: INSTANT_MARKET, functionName: 'borrowInstant' as const, args: [req, sources] as const };
}

/** One fill the call would open, as its result states it. */
export interface PlannedFill {
  source: InstantSource;
  amount: bigint;
  rateBps: bigint;
  collateral: bigint;
}

/** What this block gives. */
export interface BorrowNowPlan {
  fills: PlannedFill[];
  total: bigint;
  collateralLocked: bigint;
}

/** The plan from `borrowInstant`'s result. */
export function planFrom(result: unknown, sources: readonly InstantSource[]): BorrowNowPlan {
  const [, fills] = result as readonly [bigint, readonly { sourceIndex: bigint; loanId: bigint; amount: bigint; rateBps: bigint; collateral: bigint }[]];
  const out: PlannedFill[] = fills.map((f) => ({ source: sources[Number(f.sourceIndex)]!, amount: f.amount, rateBps: f.rateBps, collateral: f.collateral }));
  return { fills: out, total: out.reduce((s, f) => s + f.amount, 0n), collateralLocked: out.reduce((s, f) => s + f.collateral, 0n) };
}

/** The protocol's preview of an instant borrow (`previewBorrowInstant`),
 *  read before any approval: what each source would lend, the sources it
 *  would skip with their reasons, and where the collateral would come from.
 *  It sizes each source by the fill's own rule but does not run the loan
 *  checks a fill runs when it opens its loan, so it is shown as a preview
 *  and the borrow is simulated again before it is signed. */
export interface BorrowPreview {
  plan: BorrowNowPlan;
  skipped: { source: InstantSource; reason: Hex }[];
  fromVault: bigint;
  fromWallet: bigint;
}

export function previewBorrowCall(req: InstantBorrowRequest, sources: readonly InstantSource[], borrower: Hex) {
  return { abi: INSTANT_MARKET, functionName: 'previewBorrowInstant' as const, args: [req, sources, borrower] as const };
}

/** The preview from `previewBorrowInstant`'s result. */
export function previewFrom(result: unknown, sources: readonly InstantSource[]): BorrowPreview {
  const [fills, skipped, , fromVault, fromWallet] = result as readonly [
    readonly { sourceIndex: bigint; amount: bigint; rateBps: bigint; collateral: bigint }[],
    readonly { sourceIndex: bigint; reason: Hex }[],
    bigint,
    bigint,
    bigint,
  ];
  const planned: PlannedFill[] = fills.map((f) => ({ source: sources[Number(f.sourceIndex)]!, amount: f.amount, rateBps: f.rateBps, collateral: f.collateral }));
  return {
    plan: { fills: planned, total: planned.reduce((x, f) => x + f.amount, 0n), collateralLocked: planned.reduce((x, f) => x + f.collateral, 0n) },
    skipped: skipped.map((k) => ({ source: sources[Number(k.sourceIndex)]!, reason: k.reason })),
    fromVault,
    fromWallet,
  };
}

/** How the stated amount is covered now. */
export type Coverage = 'all' | 'part' | 'none';

export function coverage(plan: BorrowNowPlan | null, amount: bigint): Coverage {
  if (plan === null || plan.total === 0n) return 'none';
  return plan.total >= amount ? 'all' : 'part';
}

/** What a request for the rest asks for: exactly the amount not filled, and
 *  the collateral the fills did not lock. */
export function restOf(t: BorrowNowTerms, plan: BorrowNowPlan): { amount: bigint; collateral: bigint } {
  return {
    amount: t.amount > plan.total ? t.amount - plan.total : 0n,
    collateral: t.collateralOffered > plan.collateralLocked ? t.collateralOffered - plan.collateralLocked : 0n,
  };
}

/** The outcome as the transaction's own logs record it. */
export interface BorrowNowLogs {
  total: bigint;
  collateralLocked: bigint;
  fromWallet: bigint;
  loans: bigint[];
  skipped: number;
}

export function borrowNowLogs(logs: readonly Log[], diamond: Hex, borrower: Hex): BorrowNowLogs | null {
  let found: BorrowNowLogs | null = null;
  const loans: bigint[] = [];
  for (const l of logs) {
    if (!same(l.address as Hex, diamond)) continue;
    try {
      const d = decodeEventLog({ abi: INSTANT_MARKET, data: l.data, topics: l.topics });
      if (d.eventName === 'InstantLoanOpened') loans.push((d.args as unknown as { loanId: bigint }).loanId);
      if (d.eventName === 'InstantBorrowed') {
        const a = d.args as unknown as { borrower: Hex; totalBorrowed: bigint; collateralLocked: bigint; fromWallet: bigint; skipped: readonly unknown[] };
        if (!same(a.borrower, borrower)) continue;
        found = { total: a.totalBorrowed, collateralLocked: a.collateralLocked, fromWallet: a.fromWallet, loans: [], skipped: a.skipped.length };
      }
    } catch {
      // Not one of the instant market's events.
    }
  }
  return found === null ? null : { ...found, loans };
}

/** The instant market's switch and fill bound. */
export async function readInstantConfig(c: PublicClient, diamond: Hex): Promise<{ enabled: boolean; maxFills: number }> {
  const [enabled, maxFills] = (await c.readContract({ address: diamond, abi: INSTANT_MARKET, functionName: 'getInstantMarketConfig' })) as readonly [boolean, number];
  return { enabled, maxFills: Number(maxFills) };
}

// ─── What the borrower types ──────────────────────────────────────────────

/** Text as typed, kept so a navigation away and back keeps it. */
export interface BorrowNowInput {
  amount: string;
  collateral: string;
  days: string;
  rate: string;
  allowsPartialRepay: boolean;
}

export const DEFAULT_BORROW_NOW: BorrowNowInput = { amount: '', collateral: '', days: '30', rate: '', allowsPartialRepay: true };

export type BorrowNowField = 'amount' | 'collateral' | 'days' | 'rate';
export type BorrowNowError = ParseError | 'high' | 'empty' | 'invalid' | 'zero';

export function parseBorrowNow(
  input: BorrowNowInput,
  lending: Hex,
  collateral: Hex,
  decimals: { lending: number; collateral: number },
  maxDays: number,
): { ok: true; terms: BorrowNowTerms } | { ok: false; errors: Partial<Record<BorrowNowField, BorrowNowError>> } {
  const errors: Partial<Record<BorrowNowField, BorrowNowError>> = {};
  const amount = parseAmount(input.amount, decimals.lending);
  if (!amount.ok) errors.amount = amount.error;
  const coll = parseAmount(input.collateral, decimals.collateral);
  if (!coll.ok) errors.collateral = coll.error;
  const days = parseDays(input.days, maxDays);
  if (!days.ok) errors.days = days.error;
  const rate = parseRateBps(input.rate);
  if (!rate.ok) errors.rate = rate.error;
  if (!amount.ok || !coll.ok || !days.ok || !rate.ok) return { ok: false, errors };
  return {
    ok: true,
    terms: { lending, collateral, amount: amount.value, collateralOffered: coll.value, termDays: days.value, maxRateBps: rate.value, allowsPartialRepay: input.allowsPartialRepay },
  };
}

// ─── The review's read ────────────────────────────────────────────────────

/** Why nothing can be borrowed now, where the protocol says so up front. */
export type BorrowNowState =
  | { kind: 'plan'; plan: BorrowNowPlan }
  /** The instant market's switch is off on this network. */
  | { kind: 'market-off' }
  /** No standing source on the pair could take this borrow. */
  | { kind: 'no-source' }
  /** The wallet holds less collateral than its part. */
  | { kind: 'short-collateral'; have: bigint; need: bigint }
  /** The figure needs the approval in place and the token's allowance could
   *  not be set for the question: stated as not known until approved.
   *  `preview` is the protocol's preview, which needs no approval (null
   *  when it could not be read). */
  | { kind: 'needs-approval'; preview: BorrowPreview | null }
  /** The protocol refused the call as stated (its first refusal, by name). */
  | { kind: 'refused'; code: string; reason: string };

export interface BorrowNowReview {
  terms: BorrowNowTerms;
  sources: InstantSource[];
  state: BorrowNowState;
  /** The collateral the wallet supplies (the rest comes from the vault's
   *  free balance), and the approval that needs. */
  walletPart: bigint;
  allowance: bigint;
  approvalNeeded: boolean;
  /** The wallet prompts the approval takes (0, 1, or 2 where the token must
   *  be set to zero first). */
  approvalSteps: number;
  /** The wallet and network the review was read under (`reviewIdentity`). */
  identity: string;
  /** The risk-access step a fill on the pair would refuse without, if any. */
  risk: RiskNeed | null;
  /** The loan initiation fee's term rule, or null when it could not be read
   *  (the fee is then stated as unknown, never as zero). */
  lif: LifTerms | null;
  readAt: number;
}

/** The plan under review, when the state carries one. */
export function planOf(r: BorrowNowReview): BorrowNowPlan | null {
  return r.state.kind === 'plan' ? r.state.plan : null;
}

/** A request for exactly what was not borrowed, as the request form takes
 *  it: the same pair, rate limit and term, interest by time (as every
 *  instant-market loan), and the borrower's choice on repaying in parts. */
export function restRequestInput(t: BorrowNowTerms, rest: { amount: bigint; collateral: bigint }, decimals: { lending: number; collateral: number }): PostInput {
  return {
    ...DEFAULT_INPUT,
    amount: formatUnits(rest.amount, decimals.lending),
    collateral: formatUnits(rest.collateral, decimals.collateral),
    rate: formatUnits(t.maxRateBps, 2),
    customTerm: true,
    termDays: String(t.termDays),
    fullTerm: false,
    allowsPartialRepay: t.allowsPartialRepay,
  };
}
