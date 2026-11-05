/**
 * Home's rules (RW-70, RB-CLICKS), kept out of the components so they are
 * written once and tested: what stage each live loan is in and which loans
 * come first, how the children of one offer are grouped, and what can be
 * honestly said about which side of the wallet's book is larger.
 *
 * Nothing here decides whether an action is OPEN (RB-ELIG): Home names each
 * position's next step and opens the position, whose page reads the verdict.
 */

/** The protocol's `LoanStatus` members Home handles (the dashboard lists
 *  Active and FallbackPending as live). */
export const LOAN_STATUS_ACTIVE = 0;
export const LOAN_STATUS_FALLBACK_PENDING = 4;

/** Live = Active or FallbackPending, the protocol's own active set (#940):
 *  a FallbackPending loan is still curable by the borrower. */
export function isLiveStatus(status: number): boolean {
  return status === LOAN_STATUS_ACTIVE || status === LOAN_STATUS_FALLBACK_PENDING;
}

/** One key per held position: a wallet holding both sides of a loan holds
 *  two positions on it, each with its own value and rounding. */
export function positionKey(p: { loan: { id: bigint }; borrowerSide: boolean }): string {
  return `${p.loan.id}:${p.borrowerSide ? 'borrower' : 'lender'}`;
}

/** `AssetType.ERC20`; anything else is an NFT leg. */
export const ASSET_ERC20 = 0;

/** `OfferType.Lender`: the creator lends. */
export const OFFER_TYPE_LENDER = 0;

/** A due date this close is called out as soon (the borrower's last days to
 *  repay without a late fee). */
export const DUE_SOON_SECONDS = 3 * 86_400;

export interface LoanSummary {
  id: bigint;
  offerId: bigint;
  principal: bigint;
  principalAsset: `0x${string}`;
  assetType: number;
  tokenId: bigint;
  interestRateBps: bigint;
  durationDays: bigint;
  startTime: bigint;
  status: number;
  collateralAsset: `0x${string}`;
  collateralAmount: bigint;
  collateralAssetType: number;
  collateralTokenId: bigint;
  lenderTokenId: bigint;
  borrowerTokenId: bigint;
}

export interface LiveLoanRow {
  loan: LoanSummary;
  /** 0 when the protocol could not price the loan (an unpriced asset, or a
   *  read that failed inside the view): never a real health factor of 0. */
  healthFactor: bigint;
  borrowerSide: boolean;
}

export interface Deadlines {
  /** The due date with paused time credited. */
  maturity: bigint;
  graceEnd: bigint;
  /** Seconds of pause credited to this loan's dates. */
  pauseCredit: bigint;
  /** The loan's periodic-interest checkpoint (`previewPeriodicSettle`), or
   *  null when it has no cadence. Missing it lets anyone sell collateral to
   *  cover the shortfall once the checkpoint's grace ends, whether or not
   *  maturity has come. */
  periodic: PeriodicCheckpoint | null;
}

export interface PeriodicCheckpoint {
  periodEndAt: bigint;
  graceEndsAt: bigint;
  /** Interest still owed for the current period, in the principal asset. */
  shortfall: bigint;
  /** Whether periodic settlement is switched on (`getPeriodicInterestEnabled`).
   *  Switched off, `settlePeriodicInterest` refuses, so no collateral is
   *  sold at a checkpoint and the checkpoint sets no deadline. */
  enforced: boolean;
}

/** Where the loan stands against its final due date. */
export type LoanStage =
  | { kind: 'fallback' }
  | { kind: 'deadline-unknown' }
  | { kind: 'running'; dueAt: number }
  | { kind: 'due-soon'; dueAt: number }
  | { kind: 'in-grace'; dueAt: number; graceEndsAt: number }
  | { kind: 'grace-over'; graceEndedAt: number };

/** Where the loan stands against an owed periodic-interest checkpoint. */
export type InterestStage =
  | { kind: 'interest-later'; dueAt: number; shortfall: bigint }
  | { kind: 'interest-soon'; dueAt: number; shortfall: bigint }
  | { kind: 'interest-in-grace'; dueAt: number; graceEndsAt: number; shortfall: bigint }
  | { kind: 'interest-overdue'; graceEndedAt: number; shortfall: bigint };

export type AnyStage = LoanStage | InterestStage;

/**
 * Every obligation a live loan answers to. A loan with an enforced
 * periodic-interest cadence and interest still owed answers to TWO dates,
 * the final due date and the current checkpoint, each with its own grace;
 * either can let collateral be sold first, and their grace periods differ.
 * Both are kept and both are shown: neither is chosen over the other.
 */
export interface LoanObligations {
  stage: LoanStage;
  interest: InterestStage | null;
}

/** The loan's stage against its final due date alone. */
export function loanStage(row: LiveLoanRow, deadlines: Deadlines | null, nowSec: number): LoanStage {
  if (row.loan.status === LOAN_STATUS_FALLBACK_PENDING) return { kind: 'fallback' };
  if (!deadlines) return { kind: 'deadline-unknown' };
  const dueAt = Number(deadlines.maturity);
  const graceEnd = Number(deadlines.graceEnd);
  if (nowSec >= graceEnd) return { kind: 'grace-over', graceEndedAt: graceEnd };
  if (nowSec >= dueAt) return { kind: 'in-grace', dueAt, graceEndsAt: graceEnd };
  if (dueAt - nowSec <= DUE_SOON_SECONDS) return { kind: 'due-soon', dueAt };
  return { kind: 'running', dueAt };
}

/** The current checkpoint's stage, when it can lead to a sale: periodic
 *  settlement switched on and interest still owed, whatever the checkpoint's
 *  date (one on the due date itself included). */
export function interestStage(deadlines: Deadlines | null, nowSec: number): InterestStage | null {
  const p = deadlines?.periodic;
  if (!p || !p.enforced || p.shortfall === 0n) return null;
  const at = Number(p.periodEndAt);
  const until = Number(p.graceEndsAt);
  const shortfall = p.shortfall;
  if (nowSec >= until) return { kind: 'interest-overdue', graceEndedAt: until, shortfall };
  if (nowSec >= at) return { kind: 'interest-in-grace', dueAt: at, graceEndsAt: until, shortfall };
  if (at - nowSec <= DUE_SOON_SECONDS) return { kind: 'interest-soon', dueAt: at, shortfall };
  return { kind: 'interest-later', dueAt: at, shortfall };
}

export function loanObligations(row: LiveLoanRow, deadlines: Deadlines | null, nowSec: number): LoanObligations {
  const stage = loanStage(row, deadlines, nowSec);
  // A fallback loan is no longer Active, so no periodic settlement applies.
  return { stage, interest: stage.kind === 'fallback' ? null : interestStage(deadlines, nowSec) };
}

/** The obligation that orders the loan in the list: the more urgent of the
 *  two. Ordering only; the card shows both. */
export function mostUrgent(o: LoanObligations): AnyStage {
  return o.interest && compareStages(o.interest, o.stage) < 0 ? o.interest : o.stage;
}

/** Which stage needs the reader first: an ended grace period, then one
 *  running, then a fallback, then a due date close, then the rest. An unknown
 *  deadline sorts with the urgent ones, because it may be. */
const STAGE_RANK: Record<AnyStage['kind'], number> = {
  'grace-over': 0,
  'interest-overdue': 0,
  'in-grace': 1,
  'interest-in-grace': 1,
  fallback: 2,
  'deadline-unknown': 3,
  'due-soon': 4,
  'interest-soon': 4,
  running: 5,
  'interest-later': 5,
};

function stageTime(s: AnyStage): number {
  switch (s.kind) {
    case 'running':
    case 'due-soon':
    case 'interest-later':
    case 'interest-soon':
      return s.dueAt;
    case 'in-grace':
    case 'interest-in-grace':
      return s.graceEndsAt;
    case 'grace-over':
    case 'interest-overdue':
      return s.graceEndedAt;
    default:
      return 0;
  }
}

export function compareStages(a: AnyStage, b: AnyStage): number {
  return STAGE_RANK[a.kind] - STAGE_RANK[b.kind] || stageTime(a) - stageTime(b);
}

/** Several loans opened from ONE offer (a range offer filled in parts),
 *  summarised the way RW-70 asks: the principal filled, the rate weighted by
 *  principal, and the lowest health factor among the children the protocol
 *  could price. */
export interface OfferGroup {
  offerId: bigint;
  borrowerSide: boolean;
  asset: `0x${string}`;
  principal: bigint;
  /** Principal-weighted rate in basis points, rounded down. */
  weightedRateBps: bigint;
  /** The lowest priced child's health factor; null when none is priced. */
  minHealthFactor: bigint | null;
  /** Children with no health reading, so `minHealthFactor` covers the rest. */
  unpricedChildren: number;
  rows: LiveLoanRow[];
}

export type LoanEntry = { kind: 'single'; row: LiveLoanRow } | { kind: 'group'; group: OfferGroup };

/** Groups the children of one offer (same offer, same side, an ERC-20
 *  principal in one asset) and leaves every other loan on its own. Order is
 *  kept: a group sits where its first child was. */
export function groupByOffer(rows: readonly LiveLoanRow[]): LoanEntry[] {
  const keyOf = (r: LiveLoanRow) =>
    r.loan.assetType === ASSET_ERC20 && r.loan.offerId !== 0n ? `${r.loan.offerId}:${r.borrowerSide}:${r.loan.principalAsset.toLowerCase()}` : null;
  const members = new Map<string, LiveLoanRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k) members.set(k, [...(members.get(k) ?? []), r]);
  }
  const out: LoanEntry[] = [];
  const placed = new Set<string>();
  for (const r of rows) {
    const k = keyOf(r);
    const group = k ? members.get(k)! : null;
    if (!k || !group || group.length < 2) {
      out.push({ kind: 'single', row: r });
      continue;
    }
    if (placed.has(k)) continue;
    placed.add(k);
    const principal = group.reduce((s, g) => s + g.loan.principal, 0n);
    const weighted = group.reduce((s, g) => s + g.loan.principal * g.loan.interestRateBps, 0n);
    const priced = group.filter((g) => g.healthFactor > 0n).map((g) => g.healthFactor);
    out.push({
      kind: 'group',
      group: {
        offerId: r.loan.offerId,
        borrowerSide: r.borrowerSide,
        asset: r.loan.principalAsset,
        principal,
        weightedRateBps: principal === 0n ? 0n : weighted / principal,
        minHealthFactor: priced.length === 0 ? null : priced.reduce((m, v) => (v < m ? v : m)),
        unpricedChildren: group.length - priced.length,
        rows: group,
      },
    });
  }
  return out;
}

/**
 * The exposure headline (RW-70 [B]: it names the larger side). Each loan's
 * principal is valued in the numeraire now (a debt rounded up, an asset
 * rounded down, the protocol's rule); a loan the protocol cannot value is
 * counted, never valued at zero. The larger side is named only when the
 * unvalued loans could not change the answer: they all sit on the side that
 * is already larger. Otherwise it is `unknown`, and the totals are labelled
 * as covering the valued loans only.
 */
export interface Exposure {
  lent: bigint;
  borrowed: bigint;
  lentLoans: number;
  borrowedLoans: number;
  unvaluedLent: number;
  unvaluedBorrowed: number;
  /** `partial`: the walk of the wallet's positions stopped before the end,
   *  so no conclusion about the whole book is drawn from the part read. */
  larger: 'none' | 'only-lent' | 'only-borrowed' | 'lent' | 'borrowed' | 'even' | 'unknown' | 'partial';
}

export function exposure(rows: readonly LiveLoanRow[], valueOf: (row: LiveLoanRow) => bigint | null, complete: boolean): Exposure {
  const e: Exposure = { lent: 0n, borrowed: 0n, lentLoans: 0, borrowedLoans: 0, unvaluedLent: 0, unvaluedBorrowed: 0, larger: 'none' };
  for (const r of rows) {
    const v = valueOf(r);
    if (r.borrowerSide) {
      e.borrowedLoans++;
      if (v === null) e.unvaluedBorrowed++;
      else e.borrowed += v;
    } else {
      e.lentLoans++;
      if (v === null) e.unvaluedLent++;
      else e.lent += v;
    }
  }
  if (e.lentLoans === 0 && e.borrowedLoans === 0) e.larger = complete ? 'none' : 'partial';
  else if (!complete) e.larger = 'partial';
  else if (e.borrowedLoans === 0) e.larger = 'only-lent';
  else if (e.lentLoans === 0) e.larger = 'only-borrowed';
  else if (e.lent > e.borrowed) e.larger = e.unvaluedBorrowed === 0 ? 'lent' : 'unknown';
  else if (e.borrowed > e.lent) e.larger = e.unvaluedLent === 0 ? 'borrowed' : 'unknown';
  else e.larger = e.unvaluedLent + e.unvaluedBorrowed === 0 ? 'even' : 'unknown';
  return e;
}
