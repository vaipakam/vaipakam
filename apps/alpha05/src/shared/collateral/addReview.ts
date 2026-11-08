/**
 * LN-31 — what a top-up's review stands on, read in one go through the
 * wallet's connection: the loan as stored, who holds the borrower position
 * and its lock, whether governance has paused the collateral asset and
 * whether the protocol prices it now, the loan's health factor and
 * loan-to-value now, the protocol pause (stated: it does not hold a
 * top-up), and the wallet's balance and allowance of the collateral asset.
 *
 * A top-up moves exactly the amount chosen (the protocol pulls that amount
 * and checks it all arrived), so a larger standing approval is left as it
 * is and a smaller one is raised to exactly the amount. No view states the
 * health factor a top-up leads to ahead of the call, so the review states
 * the figures now and the finish card states the protocol's own figures
 * after, from the transaction's log.
 */
import { erc20Abi, type Abi, type PublicClient } from 'viem';
import { AdminFacetABI, LoanFacetABI, OracleFacetABI, RiskFacetABI, VaipakamNFTFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { addCollateralVerdict, checkTopUp, type TopUpCheck } from '../eligibility/addCollateral';
import { STATUS_FALLBACK_PENDING } from '../eligibility/repay';
import type { Verdict } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { tokenAcceptsApproval } from '../offers/reads';
import { allowanceSteps } from '../tx/approval';
import { answerOrNull } from '../reads/answer';

type Hex = `0x${string}`;

const LOAN = LoanFacetABI as Abi;
const NFT = VaipakamNFTFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const ORACLE = OracleFacetABI as Abi;
const RISK = RiskFacetABI as Abi;
/** `LibVaipakam.LiquidityStatus.Liquid`. */
const LIQUID = 0;

export interface AddReview {
  /** The wallet and network the review was read under (RB-REVIEW). */
  identity: string;
  loanId: bigint;
  amount: bigint;
  loan: LoanDetails;
  borrowerHolder: Hex | null;
  borrowerLock: number | null;
  assetPaused: boolean | null;
  collateralLiquid: boolean | null;
  /** 1e18-scaled, as the protocol computes it; null when unread. */
  healthFactor: bigint | null;
  ltvBps: bigint | null;
  /** The protocol pause; null when unread. A top-up is open under it. */
  paused: boolean | null;
  balance: bigint;
  allowance: bigint;
  /** Wallet prompts the approval takes: 0 when the standing approval
   *  already covers the amount, else 1, or 2 when the token must be set to
   *  zero first. */
  approvalSteps: number;
  amountCheck: TopUpCheck;
  verdict: Verdict;
  readAt: number;
}

export async function readAddReview(own: OwnStateClient, diamond: Hex, loanId: bigint, amount: bigint, identity: string, copy: Pick<CopyAccess, 'text'>): Promise<AddReview> {
  const account = own.account;
  const r = <T>(fn: (c: PublicClient) => Promise<T>) => own.read(fn).then((x) => x.value);
  const facts = await r(async (c) => {
    const loan = (await c.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDetails', args: [loanId] })) as LoanDetails;
    const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) => answerOrNull(c.readContract({ address: diamond, abi, functionName, args }) as Promise<T>);
    const [borrowerHolder, borrowerLock, assetPaused, liquidity, healthFactor, ltvBps, paused] = await Promise.all([
      read<Hex>(NFT, 'ownerOf', [loan.borrowerTokenId]),
      read<number>(NFT, 'positionLock', [loan.borrowerTokenId]).then((v) => (v === null ? null : Number(v))),
      read<boolean>(ADMIN, 'isAssetPaused', [loan.collateralAsset]),
      read<number>(ORACLE, 'checkLiquidity', [loan.collateralAsset]).then((v) => (v === null ? null : Number(v))),
      read<bigint>(RISK, 'calculateHealthFactor', [loanId]),
      read<bigint>(RISK, 'calculateLTV', [loanId]),
      read<boolean>(ADMIN, 'paused'),
    ]);
    return { loan, borrowerHolder, borrowerLock, assetPaused, collateralLiquid: liquidity === null ? null : liquidity === LIQUID, healthFactor, ltvBps, paused };
  });
  const { loan } = facts;
  const asset = loan.collateralAsset;
  const [balance, allowance] = await r((c) =>
    Promise.all([
      c.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      c.readContract({ address: asset, abi: erc20Abi, functionName: 'allowance', args: [account, diamond] }),
    ]),
  );
  // The top-up pulls exactly `amount`: a standing approval that covers it is
  // left alone, and a smaller one is raised to exactly the amount.
  const approvalSteps =
    allowance >= amount ? 0 : (await allowanceSteps({ accepts: (v) => r((c) => tokenAcceptsApproval(c, asset, account, diamond, v)) }, allowance, amount)).length;
  const readAt = Date.now();
  const verdict = addCollateralVerdict(
    {
      status: loan.status,
      assetType: loan.assetType,
      borrowerHolder: facts.borrowerHolder,
      borrowerLock: facts.borrowerLock,
      assetPaused: facts.assetPaused,
      collateralLiquid: facts.collateralLiquid,
    },
    account,
    copy,
    readAt,
  );
  return {
    identity,
    loanId,
    amount,
    loan,
    borrowerHolder: facts.borrowerHolder,
    borrowerLock: facts.borrowerLock,
    assetPaused: facts.assetPaused,
    collateralLiquid: facts.collateralLiquid,
    healthFactor: facts.healthFactor,
    ltvBps: facts.ltvBps,
    paused: facts.paused,
    balance,
    allowance,
    approvalSteps,
    amountCheck: checkTopUp(amount, balance),
    verdict,
    readAt,
  };
}

/** Whether the loan is in fallback, where a top-up that restores the
 *  protocol's opening limits cures it. */
export const inFallback = (r: AddReview): boolean => r.loan.status === STATUS_FALLBACK_PENDING;

/** Every loan field the receipt states: a change to any reopens the review. */
export const ADD_STATED_LOAN_FIELDS = [
  'status',
  'assetType',
  'collateralAsset',
  'collateralAmount',
  'principal',
  'principalAsset',
  'borrowerTokenId',
  'borrower',
] as const satisfies readonly (keyof LoanDetails)[];

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. The health factor and loan-to-value move with prices, so
 *  they are restated without reopening the review: a top-up only raises
 *  them. */
export function addChanged(a: AddReview, b: AddReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if (ADD_STATED_LOAN_FIELDS.some((k) => a.loan[k] !== b.loan[k])) return text('repay.changedLoan');
  if (a.borrowerHolder !== b.borrowerHolder || a.borrowerLock !== b.borrowerLock || a.paused !== b.paused) return text('repay.changedHolders');
  if (a.allowance !== b.allowance || a.approvalSteps !== b.approvalSteps || a.amountCheck.ok !== b.amountCheck.ok) return text('repay.changedFunds');
  if (a.verdict.state !== b.verdict.state || a.verdict.refusals[0]?.code !== b.verdict.refusals[0]?.code) return text('repay.changedVerdict');
  return null;
}

/** What stops the review here, in words (empty when nothing does). */
export function addBlockers(r: AddReview, shortText: (short: bigint) => string): string[] {
  if (r.verdict.state !== 'open') return [r.verdict.refusals[0]?.reason ?? ''];
  if (!r.amountCheck.ok) return [r.amountCheck.why === 'over-balance' ? shortText(r.amount - r.balance) : ''];
  return [];
}

/** The wallet prompts the top-up takes: the approval's steps, then the
 *  top-up. Nothing is put back after a top-up that took effect: it uses the
 *  whole approval it made. */
export const addPromptCount = (r: AddReview): number => r.approvalSteps + 1;
