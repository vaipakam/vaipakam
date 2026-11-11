/**
 * LN-21 / LN-16 — what a full-repayment review stands on, read in one go
 * through the wallet's connection: the loan as stored, who holds each
 * position now, the end of its grace period from the loan clock, the
 * borrower position's lock, the protocol's payoff now and a short while
 * ahead (payoff.ts), and the wallet's balance and allowance of what it
 * pays. The eligibility rule (eligibility/repay) turns these into the
 * verdict; the receipt (repayReceipt) states them.
 *
 * The payoff grows by the second, so a re-read does not count that growth
 * as a change: the moment the approval reaches is kept from the review it
 * was first read for, and only the figure AT that moment, or anything else
 * the review states, reopens the review. Once that moment is close, it is
 * moved forward and the review reopens with the new figure.
 */
import { erc20Abi, type Abi, type PublicClient } from 'viem';
import { LoanClockFacetABI, LoanFacetABI, RefinanceFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { repayVerdict, STATUS_FALLBACK_PENDING } from '../eligibility/repay';
import type { Verdict } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { allowanceSteps } from '../tx/approval';
import { putBackPrompts } from './approvalCap';
import { tokenAcceptsApproval } from '../offers/reads';
import { readPayoff, readPayoffAt, type Payoff } from './payoff';
import { positionRouteCallFor, readLiveHolderOrNull } from '../positions/positionNft';
import { answerOrNull } from '../reads/answer';

type Hex = `0x${string}`;

const LOAN = LoanFacetABI as Abi;
const LOAN_CLOCK = LoanClockFacetABI as Abi;
const REFINANCE = RefinanceFacetABI as Abi;

/** A kept moment closer than this to the chain's time is moved forward. */
export const PAYOFF_MIN_LEAD_SECONDS = 10 * 60;

export interface RepayReview {
  /** The wallet and network the review was read under (RB-REVIEW). */
  identity: string;
  loanId: bigint;
  loan: LoanDetails;
  lenderHolder: Hex | null;
  borrowerHolder: Hex | null;
  /** Effective end of the grace period (the loan clock); null when unread
   *  or when the loan is in fallback (a repayment then cures it). */
  graceEnd: bigint | null;
  /** The effective due date (the loan clock); null when unread or in
   *  fallback. Grace runs from here to `graceEnd`. */
  maturity: bigint | null;
  borrowerLock: number | null;
  /** The refinance request recorded for this loan: its offer id (0n when
   *  none was ever recorded) and whether it still stands by the protocol's
   *  own rule (`getRefinanceRequest`'s `live`: not cancelled, taken,
   *  retargeted or expired, and its creator holds the borrower position);
   *  null when unread. It never holds a full repayment; the repayment ends
   *  a standing one, but its offer stays posted until its creator cancels
   *  it. The record keeps the last id after a cancel, so only a standing
   *  request is stated as posted. */
  refinance: { offerId: bigint; live: boolean } | null;
  payoff: Payoff;
  /** Whether `payoff.by` is the end of the grace period rather than the
   *  usual window: a repayment after it is refused anyway. */
  capped: boolean;
  balance: bigint;
  allowance: bigint;
  /** Wallet prompts the approval takes (0, 1, or 2 when the token must be
   *  set to zero first). */
  approvalSteps: number;
  verdict: Verdict;
  readAt: number;
}

/** The loan's own facts: one connection, read together. Shared with the
 *  partial repayment's review, which reads the same loan. */
export async function readLoanFacts(c: PublicClient, diamond: Hex, loanId: bigint) {
  const loan = (await c.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDetails', args: [loanId] })) as LoanDetails;
  const [lenderHolder, borrowerHolder, dates, borrowerLock, refinance] = await Promise.all([
    readLiveHolderOrNull(c, diamond, loan.lenderTokenId),
    readLiveHolderOrNull(c, diamond, loan.borrowerTokenId),
    loan.status === STATUS_FALLBACK_PENDING
      ? null
      : answerOrNull(c.readContract({ address: diamond, abi: LOAN_CLOCK, functionName: 'getLoanDeadlines', args: [loanId] }) as Promise<readonly [bigint, bigint, bigint, bigint]>),
    answerOrNull(c.readContract(positionRouteCallFor(diamond, loan.borrowerTokenId)).then(Number)),
    answerOrNull(c.readContract({ address: diamond, abi: REFINANCE, functionName: 'getRefinanceRequest', args: [loanId] }) as Promise<readonly [bigint, boolean]>),
  ]);
  return {
    loan,
    lenderHolder,
    borrowerHolder,
    graceEnd: dates ? dates[3] : null,
    maturity: dates ? dates[2] : null,
    borrowerLock,
    refinance: refinance ? { offerId: refinance[0], live: refinance[1] } : null,
  };
}

/**
 * Reads the review. `keepBy` is the moment an earlier read of this review
 * reached: it is kept while it is still at least PAYOFF_MIN_LEAD_SECONDS
 * ahead (or it is the end of the grace period), so a re-read compares like
 * with like.
 */
export async function readRepayReview(
  own: OwnStateClient,
  diamond: Hex,
  loanId: bigint,
  identity: string,
  copy: Pick<CopyAccess, 'text' | 'format'>,
  keepBy: { by: bigint; capped: boolean } | null = null,
): Promise<RepayReview> {
  const account = own.account;
  const r = <T>(fn: (c: PublicClient) => Promise<T>) => own.read(fn).then((x) => x.value);
  const facts = await r((c) => readLoanFacts(c, diamond, loanId));
  const { loan } = facts;
  const cap = facts.graceEnd;
  const payoff = await r(async (c): Promise<Payoff> => {
    const fresh = await readPayoff(c, diamond, loanId, cap);
    if (keepBy === null) return fresh;
    const keep = keepBy.capped || keepBy.by >= fresh.chainNow + BigInt(PAYOFF_MIN_LEAD_SECONDS);
    if (!keep) return fresh;
    const atBy = keepBy.by === fresh.by ? fresh.atBy : await readPayoffAt(c, diamond, loanId, keepBy.by);
    return { ...fresh, by: keepBy.by, atBy };
  });
  const capped = cap !== null && payoff.by === cap;
  const asset = loan.principalAsset;
  const [balance, allowance] = await r((c) =>
    Promise.all([
      c.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      c.readContract({ address: asset, abi: erc20Abi, functionName: 'allowance', args: [account, diamond] }),
    ]),
  );
  // The allowance is set to exactly the reviewed maximum whichever way it
  // stands, lowered as well as raised: `repayLoan` takes no maximum of its
  // own, so a larger standing approval would let a late confirmation take
  // more than the review states.
  const approvalSteps = (await allowanceSteps({ accepts: (amount) => r((c) => tokenAcceptsApproval(c, asset, account, diamond, amount)) }, allowance, payoff.atBy)).length;
  const readAt = Date.now();
  const verdict = repayVerdict(
    {
      status: loan.status,
      assetType: loan.assetType,
      recordedLender: loan.lender,
      lenderHolder: facts.lenderHolder,
      graceEnd: facts.graceEnd,
      chainNow: payoff.chainNow,
      borrowerLock: facts.borrowerLock,
    },
    account,
    copy,
    readAt,
  );
  return {
    identity,
    loanId,
    loan,
    lenderHolder: facts.lenderHolder,
    borrowerHolder: facts.borrowerHolder,
    graceEnd: facts.graceEnd,
    maturity: facts.maturity,
    borrowerLock: facts.borrowerLock,
    refinance: facts.refinance,
    payoff,
    capped,
    balance,
    allowance,
    approvalSteps,
    verdict,
    readAt,
  };
}

/** Whether the connected wallet holds the borrower position: a payment by
 *  anyone else gives them no right to the collateral. */
export function paysAsBorrower(r: RepayReview, account: Hex): boolean {
  return r.borrowerHolder?.toLowerCase() === account.toLowerCase();
}

/** Every field of the loan record the receipt states (repayReceipt): a
 *  change to any of them, such as a partial withdrawal lowering the
 *  collateral, reopens the review. One list, so a row added to the receipt
 *  is compared by adding its field here. */
export const STATED_LOAN_FIELDS = [
  'status',
  'principal',
  'principalAsset',
  'useFullTermInterest',
  'collateralAsset',
  'collateralAssetType',
  'collateralAmount',
  'collateralTokenId',
  'collateralQuantity',
  'borrowerTokenId',
] as const satisfies readonly (keyof LoanDetails)[];

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. The payoff now is not compared: it grows by the second,
 *  and the approval is sized to the figure at the kept moment. */
export function changedBetween(a: RepayReview, b: RepayReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if (STATED_LOAN_FIELDS.some((k) => a.loan[k] !== b.loan[k])) return text('repay.changedLoan');
  if (
    a.lenderHolder !== b.lenderHolder ||
    a.borrowerHolder !== b.borrowerHolder ||
    a.borrowerLock !== b.borrowerLock ||
    a.graceEnd !== b.graceEnd ||
    a.maturity !== b.maturity ||
    a.refinance?.offerId !== b.refinance?.offerId ||
    a.refinance?.live !== b.refinance?.live
  )
    return text('repay.changedHolders');
  if (a.payoff.by !== b.payoff.by || a.payoff.atBy !== b.payoff.atBy) return text('repay.changedPayoff');
  if (a.allowance !== b.allowance || a.approvalSteps !== b.approvalSteps || a.balance < a.payoff.now !== b.balance < b.payoff.now) return text('repay.changedFunds');
  if (a.verdict.state !== b.verdict.state || a.verdict.refusals[0]?.code !== b.verdict.refusals[0]?.code) return text('repay.changedVerdict');
  return null;
}

/** What stops the review here, in words (empty when nothing does): the
 *  verdict's own refusal, or a balance short of the payoff now. */
export function reviewBlockers(r: RepayReview, shortText: (short: bigint) => string): string[] {
  if (r.verdict.state !== 'open') return [r.verdict.refusals[0]?.reason ?? ''];
  if (r.balance < r.payoff.now) return [shortText(r.payoff.now - r.balance)];
  return [];
}

/** The wallet prompts the repayment takes: the approval's steps, then the
 *  repayment. */
export function promptCount(r: RepayReview): number {
  return r.approvalSteps + 1;
}

/** The prompts that may follow a repayment that took effect, to put back
 *  what it did not use of the approval: none when no approval was made;
 *  two on a token that needs a step to zero first (only when going back to
 *  a non-zero allowance, so "up to"); otherwise one. */
export function putBackPromptCount(r: RepayReview): number {
  return putBackPrompts(r.approvalSteps);
}
