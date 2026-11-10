/**
 * NFT-05 — what closing a rental stands on, read in one go through the
 * renter's own connection: the rental as stored, who holds each position,
 * its due date and grace end from the loan clock, and the late fee the
 * protocol quotes now and a short while ahead.
 *
 * Where each figure comes from, and why:
 * - the late fee is the protocol's own figure: on a rental its repayment
 *   quote (`calculateRepaymentAmount`) is the late fee alone, read now and
 *   at a moment ahead the same way a loan's payoff is (payoff.ts);
 * - the rent owed has no protocol view, so it is counted here by the
 *   settler's own rule, line for line (`accruedUnpaidRentalDays`,
 *   `remainingRentalDays`), from the stored rental, and the dry run before
 *   signing is the protocol's last word on it. The outcome is then measured
 *   from the claim the close records, so a count that disagreed would show
 *   as a figure outside the stated range, never as a silent difference.
 *
 * A close pays out of the rent and buffer the renter prepaid into their own
 * vault, so the review asks nothing of the wallet: no balance, no approval.
 */
import type { PublicClient } from 'viem';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { closeRentalVerdict } from '../eligibility/closeRental';
import type { Verdict } from '../eligibility/types';
import { treasuryShareBps, type LoanDetails } from '../positions/loanView';
import { readLoanFacts } from '../repay/repayReview';
import { readPayoff, readPayoffAt, type Payoff } from '../repay/payoff';

type Hex = `0x${string}`;

const DAY = 86_400n;

/** A kept moment closer than this to the chain's time is moved forward. */
export const CLOSE_MIN_LEAD_SECONDS = 10 * 60;

/** The stored rental fields the rent rule reads. */
export type RentTerms = Pick<LoanDetails, 'principal' | 'durationDays' | 'startTime' | 'lastDeductTime' | 'useFullTermInterest'>;

/** Days already paid by the daily settlement (`consumedRentalDays`). */
export function settledDays(t: RentTerms): bigint {
  return t.lastDeductTime > t.startTime ? (t.lastDeductTime - t.startTime) / DAY : 0n;
}

/**
 * The rent days a close at `at` (unix seconds) pays for, by the settler's
 * rule: a full-term rental pays every agreed day not yet settled; a pro-rata
 * one pays the days used since the start (a part day counts as a whole day,
 * at least one day), capped at the term, less the days already settled.
 */
export function rentDaysAt(t: RentTerms, at: bigint): bigint {
  const settled = settledDays(t);
  if (t.useFullTermInterest) return settled >= t.durationDays ? 0n : t.durationDays - settled;
  let used = 0n;
  if (at >= t.startTime) {
    used = (at - t.startTime + DAY - 1n) / DAY;
    if (used === 0n) used = 1n;
  }
  if (used > t.durationDays) used = t.durationDays;
  return used > settled ? used - settled : 0n;
}

/** What a close at one moment settles. */
export interface CloseFigures {
  /** Rent days paid, and their rent (daily fee × days). */
  days: bigint;
  rent: bigint;
  /** The protocol's late fee, capped at the buffer. */
  lateFee: bigint;
  /** What comes back to the renter as a claim: rent plus buffer prepaid,
   *  less the rent and late fee; null when the prepayment cannot cover the
   *  close (the protocol refuses it). */
  refund: bigint | null;
  /** The owner's share of rent plus late fee, after the protocol's share. */
  ownerShare: bigint;
  protocolShare: bigint;
}

export function figuresAt(l: RentTerms & Pick<LoanDetails, 'prepayAmount' | 'bufferAmount' | 'treasuryFeeBpsAtInit'>, at: bigint, lateFee: bigint): CloseFigures {
  const days = rentDaysAt(l, at);
  const rent = l.principal * days;
  const total = rent + lateFee;
  const covered = rent <= l.prepayAmount && total <= l.prepayAmount + l.bufferAmount;
  const protocolShare = (total * BigInt(treasuryShareBps(l).bps)) / 10_000n;
  return { days, rent, lateFee, refund: covered ? l.prepayAmount + l.bufferAmount - total : null, ownerShare: total - protocolShare, protocolShare };
}

export interface CloseReview {
  identity: string;
  loanId: bigint;
  loan: LoanDetails;
  lenderHolder: Hex | null;
  borrowerHolder: Hex | null;
  /** The due date and grace end with paused time credited; null when unread. */
  maturity: bigint | null;
  graceEnd: bigint | null;
  /** The protocol's late fee now and at `by` (payoff.ts). */
  late: Payoff;
  /** Whether `late.by` is the end of the grace period: a close after it is
   *  refused anyway. */
  capped: boolean;
  now: CloseFigures;
  atBy: CloseFigures;
  verdict: Verdict;
  readAt: number;
}

/**
 * Reads the review. `keepBy` is the moment an earlier read reached: kept
 * while it is still at least CLOSE_MIN_LEAD_SECONDS ahead (or is the grace
 * end), so a re-read compares like with like.
 */
export async function readCloseReview(
  own: OwnStateClient,
  diamond: Hex,
  loanId: bigint,
  identity: string,
  copy: Pick<CopyAccess, 'text' | 'format'>,
  keepBy: { by: bigint; capped: boolean } | null = null,
): Promise<CloseReview> {
  const r = <T>(fn: (c: PublicClient) => Promise<T>) => own.read(fn).then((x) => x.value);
  const facts = await r((c) => readLoanFacts(c, diamond, loanId));
  const { loan } = facts;
  const late = await r(async (c): Promise<Payoff> => {
    const fresh = await readPayoff(c, diamond, loanId, facts.graceEnd);
    if (keepBy === null) return fresh;
    const keep = keepBy.capped || keepBy.by >= fresh.chainNow + BigInt(CLOSE_MIN_LEAD_SECONDS);
    if (!keep) return fresh;
    const atBy = keepBy.by === fresh.by ? fresh.atBy : await readPayoffAt(c, diamond, loanId, keepBy.by);
    return { ...fresh, by: keepBy.by, atBy };
  });
  const capped = facts.graceEnd !== null && late.by === facts.graceEnd;
  const readAt = Date.now();
  const verdict = closeRentalVerdict(
    { status: loan.status, assetType: loan.assetType, borrowerHolder: facts.borrowerHolder, graceEnd: facts.graceEnd, chainNow: late.chainNow },
    own.account,
    copy,
    readAt,
  );
  return {
    identity,
    loanId,
    loan,
    lenderHolder: facts.lenderHolder,
    borrowerHolder: facts.borrowerHolder,
    maturity: facts.maturity,
    graceEnd: facts.graceEnd,
    late,
    capped,
    now: figuresAt(loan, late.chainNow, late.now),
    atBy: figuresAt(loan, late.by, late.atBy),
    verdict,
    readAt,
  };
}

/** Every stored field the receipt states or the rent rule reads: a change
 *  to any of them (a daily settlement moving the settled-through moment,
 *  above all) reopens the review. */
export const STATED_RENTAL_FIELDS = [
  'status',
  'principal',
  'prepayAsset',
  'prepayAmount',
  'bufferAmount',
  'lastDeductTime',
  'useFullTermInterest',
  'durationDays',
  'treasuryFeeBpsAtInit',
  'principalAsset',
  'tokenId',
  'quantity',
] as const satisfies readonly (keyof LoanDetails)[];

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. The figures now are not compared: the days used grow with
 *  time, and the figures at the kept moment are what the review binds. */
export function closeChangedBetween(a: CloseReview, b: CloseReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if (STATED_RENTAL_FIELDS.some((k) => a.loan[k] !== b.loan[k])) return text('rentClose.changedRental');
  if (a.lenderHolder !== b.lenderHolder || a.borrowerHolder !== b.borrowerHolder || a.graceEnd !== b.graceEnd || a.maturity !== b.maturity) return text('rentClose.changedHolders');
  if (a.late.by !== b.late.by || a.atBy.lateFee !== b.atBy.lateFee || a.atBy.days !== b.atBy.days) return text('rentClose.changedFigures');
  if (a.verdict.state !== b.verdict.state || a.verdict.refusals[0]?.code !== b.verdict.refusals[0]?.code) return text('rentClose.changedVerdict');
  return null;
}

/** What stops the review here, in words (empty when nothing does): the
 *  verdict's own refusal, or a prepayment that cannot cover the close now. */
export function closeBlockers(r: CloseReview, copy: Pick<CopyAccess, 'text'>): string[] {
  if (r.verdict.state !== 'open') return [r.verdict.refusals[0]?.reason ?? ''];
  if (r.now.refund === null) return [copy.text('rentClose.shortPrepay')];
  return [];
}
