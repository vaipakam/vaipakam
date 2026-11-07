/**
 * LN-22 / LN-64 — what a partial repayment's review stands on, read in one
 * go through the wallet's connection: the loan and its holders, dates and
 * locks (shared with the full repayment, readLoanFacts), whether a refinance
 * request is live, the protocol's minimum part for the lending asset, the
 * current interest period, the protocol's payoff now and a short while ahead,
 * and the wallet's balance and allowance.
 *
 * What a partial repayment takes is the principal part chosen plus the
 * interest accrued since the loan's interest clock last started (net of any
 * periodic credit). No view returns that interest ahead of the call (#3299),
 * so the review states it from the protocol's own settlement figure: the
 * payoff less the principal. That is exactly the partial's interest on a
 * pro-rata loan up to its due date; on a full-term loan it also carries the
 * remaining term's minimum, and past the due date a late fee, neither of
 * which a partial charges, so there it is an upper bound and the review says
 * so. The approval is sized to the bound at the moment ahead; what the
 * payment does not use is put back, and the outcome is measured.
 */
import { erc20Abi, type Abi, type PublicClient } from 'viem';
import { ConfigFacetABI, RepayPeriodicFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { checkPartialAmount, partialRepayVerdict, type AmountCheck } from '../eligibility/partialRepay';
import type { Verdict } from '../eligibility/types';
import type { LoanDetails, PeriodSchedule } from '../positions/loanView';
import { allowanceSteps } from '../tx/approval';
import { tokenAcceptsApproval } from '../offers/reads';
import { readPayoff, readPayoffAt, type Payoff } from './payoff';
import { PAYOFF_MIN_LEAD_SECONDS, readLoanFacts } from './repayReview';

type Hex = `0x${string}`;

const CONFIG = ConfigFacetABI as Abi;
const PERIODIC = RepayPeriodicFacetABI as Abi;
const BPS = 10_000n;

export interface PartialReview {
  identity: string;
  loanId: bigint;
  loan: LoanDetails;
  lenderHolder: Hex | null;
  borrowerHolder: Hex | null;
  graceEnd: bigint | null;
  /** The effective due date; null when unread. */
  maturity: bigint | null;
  borrowerLock: number | null;
  refinanceLive: boolean | null;
  /** The principal part chosen. */
  amount: bigint;
  /** The protocol's minimum part for this loan now (`principal ×
   *  minPartialBps`, never below one unit); null when unread. */
  floor: bigint | null;
  amountCheck: AmountCheck;
  payoff: Payoff;
  capped: boolean;
  /** The interest the partial charges, now and at `payoff.by`, from the
   *  protocol's settlement figure (payoff less principal). */
  interestNow: bigint;
  interestBy: bigint;
  /** Whether those figures are exactly the partial's interest (a pro-rata
   *  loan, both moments at or before its due date) rather than an upper
   *  bound. */
  interestExact: boolean;
  /** What leaves the wallet at most, and what the approval reaches. */
  totalBy: bigint;
  /** The current interest period (`previewPeriodicSettle`); null for a loan
   *  with no schedule or when unread (`periodUnread`). */
  period: PeriodSchedule | null;
  periodUnread: boolean;
  balance: bigint;
  allowance: bigint;
  approvalSteps: number;
  verdict: Verdict;
  readAt: number;
}

/** The protocol's minimum part: the same product `repayPartial` compares
 *  against, and at least one unit, since it refuses nothing at all. */
export function minimumPart(principal: bigint, minPartialBps: bigint): bigint {
  const floor = (principal * minPartialBps) / BPS;
  return floor > 0n ? floor : 1n;
}

/** The protocol's minimum part for a loan, read on its own for the amount
 *  form; null when unread. */
export async function readPartialFloor(c: PublicClient, diamond: Hex, asset: Hex, principal: bigint): Promise<bigint | null> {
  try {
    const p = (await c.readContract({ address: diamond, abi: CONFIG, functionName: 'getAssetRiskParams', args: [asset] })) as { minPartialBps: bigint };
    return minimumPart(principal, BigInt(p.minPartialBps));
  } catch {
    return null;
  }
}

export async function readPartialReview(
  own: OwnStateClient,
  diamond: Hex,
  loanId: bigint,
  amount: bigint,
  identity: string,
  copy: Pick<CopyAccess, 'text' | 'format'>,
  keepBy: { by: bigint; capped: boolean } | null = null,
): Promise<PartialReview> {
  const account = own.account;
  const r = <T>(fn: (c: PublicClient) => Promise<T>) => own.read(fn).then((x) => x.value);
  const facts = await r((c) => readLoanFacts(c, diamond, loanId));
  const { loan } = facts;
  const scheduled = loan.periodicInterestCadence !== 0;
  const [risk, periodic] = await r((c) =>
    Promise.all([
      c.readContract({ address: diamond, abi: CONFIG, functionName: 'getAssetRiskParams', args: [loan.principalAsset] }).then(
        (p) => p as { minPartialBps: bigint },
        () => null,
      ),
      scheduled
        ? c.readContract({ address: diamond, abi: PERIODIC, functionName: 'previewPeriodicSettle', args: [loanId] }).then(
            (p) => p as readonly [number, bigint, bigint, bigint, bigint, bigint, boolean],
            () => null,
          )
        : Promise.resolve(null),
    ]),
  );
  const floor = risk ? minimumPart(loan.principal, BigInt(risk.minPartialBps)) : null;
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
  const over = (v: bigint) => (v > loan.principal ? v - loan.principal : 0n);
  const interestNow = over(payoff.now);
  const interestBy = over(payoff.atBy);
  const interestExact = !loan.useFullTermInterest && facts.maturity !== null && payoff.by <= facts.maturity;
  const totalBy = amount + interestBy;
  const asset = loan.principalAsset;
  const [balance, allowance] = await r((c) =>
    Promise.all([
      c.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      c.readContract({ address: asset, abi: erc20Abi, functionName: 'allowance', args: [account, diamond] }),
    ]),
  );
  const approvalSteps =
    allowance >= totalBy ? 0 : (await allowanceSteps({ accepts: (v) => r((c) => tokenAcceptsApproval(c, asset, account, diamond, v)) }, allowance, totalBy)).length;
  const readAt = Date.now();
  const verdict = partialRepayVerdict(
    {
      status: loan.status,
      assetType: loan.assetType,
      allowsPartialRepay: loan.allowsPartialRepay,
      borrowerHolder: facts.borrowerHolder,
      graceEnd: facts.graceEnd,
      chainNow: payoff.chainNow,
      borrowerLock: facts.borrowerLock,
      refinanceLive: facts.refinance ? facts.refinance.live : null,
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
    refinanceLive: facts.refinance ? facts.refinance.live : null,
    amount,
    floor,
    amountCheck: checkPartialAmount(amount, loan.principal, floor),
    payoff,
    capped,
    interestNow,
    interestBy,
    interestExact,
    totalBy,
    period: periodic
      ? {
          cadence: Number(periodic[0]),
          periodEndAt: periodic[1],
          graceEndsAt: periodic[2],
          expected: periodic[3],
          paid: periodic[4],
          shortfall: periodic[5],
          canSettleNow: periodic[6],
        }
      : null,
    periodUnread: scheduled && periodic === null,
    balance,
    allowance,
    approvalSteps,
    verdict,
    readAt,
  };
}

/** What a re-read found changed, in words, or null. The interest figures
 *  now are not compared (they grow by the second); the figure at the kept
 *  moment is. */
export function partialChanged(a: PartialReview, b: PartialReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if (a.loan.status !== b.loan.status || a.loan.principal !== b.loan.principal || a.loan.principalAsset !== b.loan.principalAsset || a.floor !== b.floor)
    return text('repay.changedLoan');
  if (
    a.lenderHolder !== b.lenderHolder ||
    a.borrowerHolder !== b.borrowerHolder ||
    a.borrowerLock !== b.borrowerLock ||
    a.graceEnd !== b.graceEnd ||
    a.refinanceLive !== b.refinanceLive
  )
    return text('repay.changedHolders');
  if (a.payoff.by !== b.payoff.by || a.interestBy !== b.interestBy) return text('repay.changedPayoff');
  if (a.period?.periodEndAt !== b.period?.periodEndAt || a.period?.paid !== b.period?.paid || a.period?.expected !== b.period?.expected) return text('partial.changedPeriod');
  if (a.approvalSteps !== b.approvalSteps || a.balance < a.amount + a.interestNow !== b.balance < b.amount + b.interestNow) return text('repay.changedFunds');
  if (a.verdict.state !== b.verdict.state || a.verdict.refusals[0]?.code !== b.verdict.refusals[0]?.code) return text('repay.changedVerdict');
  return null;
}

/** What stops the review (empty when nothing does): the verdict's refusal,
 *  the amount, or a balance short of what the payment takes now. */
export function partialBlockers(r: PartialReview, copy: Pick<CopyAccess, 'text' | 'format'>, amountText: (v: bigint) => string): string[] {
  if (r.verdict.state !== 'open') return [r.verdict.refusals[0]?.reason ?? ''];
  const check = r.amountCheck;
  if (!check.ok) return [amountSentence(check.why, r.loan.principal, r.floor, copy, amountText)];
  const now = r.amount + r.interestNow;
  if (r.balance < now) return [copy.format('repay.short', { amount: amountText(now - r.balance) })];
  return [];
}

/** The sentence for an amount the protocol would refuse, shared by the
 *  form and the review. */
export function amountSentence(
  why: Exclude<AmountCheck, { ok: true }>['why'],
  principal: bigint,
  floor: bigint | null,
  copy: Pick<CopyAccess, 'text' | 'format'>,
  amountText: (v: bigint) => string,
): string {
  switch (why) {
    case 'zero':
      return copy.text('partial.amountZero');
    case 'whole':
      return copy.format('partial.amountWhole', { amount: amountText(principal) });
    case 'floor-unread':
      return copy.text('partial.floorUnread');
    case 'below-floor':
      return copy.format('partial.amountBelowFloor', { amount: amountText(floor ?? 0n) });
  }
}

export function partialPromptCount(r: PartialReview): number {
  return r.approvalSteps + 1;
}
