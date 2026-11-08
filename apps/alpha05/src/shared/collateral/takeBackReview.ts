/**
 * LN-32 — what taking back collateral stands on, read in one go through the
 * wallet's connection: the loan as stored, who holds the borrower position
 * and its lock, the protocol pause, whether a refinance request stands,
 * whether the protocol prices the collateral now, the protocol's own most
 * that can be taken back now (`calculateMaxWithdrawable`, which moves with
 * prices), the loan's health factor and loan-to-value now, and the
 * protocol's dry run of this very withdrawal, which names a hold no view
 * exposes (a lender's linked sale listing, #3308).
 *
 * Nothing leaves the wallet and no approval is asked: the protocol sends
 * the collateral from the borrower's vault to the wallet that asks. When
 * that wallet runs protected account mode the payment is routed instead
 * (`payoutRoute`): the borrower's own withdrawal is queued for the
 * account's delay (`LibProtectedAccount.gate`), and a payment to a later
 * holder of the position is paid into that holder's vault. So the review
 * reads the wallet's mode too.
 */
import type { Abi, PublicClient } from 'viem';
import { AdminFacetABI, LoanFacetABI, OracleFacetABI, PartialWithdrawalFacetABI, RefinanceFacetABI, RiskFacetABI, VaipakamNFTFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import { checkTakeBack, takeBackVerdict, type TakeBackCheck } from '../eligibility/takeBack';
import type { Refusal, Verdict } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { payoutRoute, readProtection, type PayoutRoute, type Protection } from '../protection/payout';
import { routeChanged } from '../protection/payoutCopy';
import { askThrough } from '../tx/simulate';

type Hex = `0x${string}`;

const LOAN = LoanFacetABI as Abi;
const NFT = VaipakamNFTFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const ORACLE = OracleFacetABI as Abi;
const RISK = RiskFacetABI as Abi;
const REFINANCE = RefinanceFacetABI as Abi;
export const WITHDRAW = PartialWithdrawalFacetABI as Abi;
/** `LibVaipakam.LiquidityStatus.Liquid`. */
const LIQUID = 0;

export interface TakeBackReview {
  identity: string;
  loanId: bigint;
  amount: bigint;
  loan: LoanDetails;
  borrowerHolder: Hex | null;
  borrowerLock: number | null;
  paused: boolean | null;
  refinanceLive: boolean | null;
  collateralLiquid: boolean | null;
  maxWithdrawable: bigint | null;
  healthFactor: bigint | null;
  ltvBps: bigint | null;
  /** The wallet's protected account mode, or null when it could not be
   *  read. */
  protection: Protection | null;
  /** Where the collateral lands: the wallet, the account's payout queue
   *  (the borrower's own withdrawal), or the account's vault (a later
   *  holder's); `unknown` when the mode could not be read. */
  route: PayoutRoute;
  amountCheck: TakeBackCheck;
  /** The protocol's dry run of this withdrawal now: null when it passes,
   *  its refusal when it refuses, 'unread' when it could not be run. Asked
   *  only when the app's own rule is open and the amount fits. */
  dryRun: Refusal | null | 'unread';
  verdict: Verdict;
  readAt: number;
}

async function maybe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export async function readTakeBackReview(
  own: OwnStateClient,
  diamond: Hex,
  loanId: bigint,
  amount: bigint,
  identity: string,
  copy: Pick<CopyAccess, 'text'>,
): Promise<TakeBackReview> {
  const account = own.account;
  const facts = await own
    .read(async (c: PublicClient) => {
      const loan = (await c.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDetails', args: [loanId] })) as LoanDetails;
      const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) => maybe(c.readContract({ address: diamond, abi, functionName, args }) as Promise<T>);
      const [borrowerHolder, borrowerLock, paused, refinance, liquidity, maxWithdrawable, healthFactor, ltvBps, protectedAccount] = await Promise.all([
        read<Hex>(NFT, 'ownerOf', [loan.borrowerTokenId]),
        read<number>(NFT, 'positionLock', [loan.borrowerTokenId]).then((v) => (v === null ? null : Number(v))),
        read<boolean>(ADMIN, 'paused'),
        read<readonly [bigint, boolean]>(REFINANCE, 'getRefinanceRequest', [loanId]),
        read<number>(ORACLE, 'checkLiquidity', [loan.collateralAsset]).then((v) => (v === null ? null : Number(v))),
        read<bigint>(WITHDRAW, 'calculateMaxWithdrawable', [loanId]),
        read<bigint>(RISK, 'calculateHealthFactor', [loanId]),
        read<bigint>(RISK, 'calculateLTV', [loanId]),
        readProtection(c, diamond, account),
      ]);
      return {
        loan,
        borrowerHolder,
        borrowerLock,
        paused,
        refinanceLive: refinance ? refinance[1] : null,
        collateralLiquid: liquidity === null ? null : liquidity === LIQUID,
        maxWithdrawable,
        healthFactor,
        ltvBps,
        protection: protectedAccount,
      };
    })
    .then((x) => x.value);
  const readAt = Date.now();
  const verdict = takeBackVerdict(
    {
      status: facts.loan.status,
      assetType: facts.loan.assetType,
      paused: facts.paused,
      borrowerHolder: facts.borrowerHolder,
      borrowerLock: facts.borrowerLock,
      refinanceLive: facts.refinanceLive,
      collateralLiquid: facts.collateralLiquid,
      maxWithdrawable: facts.maxWithdrawable,
    },
    account,
    copy,
    readAt,
  );
  const amountCheck = checkTakeBack(amount, facts.maxWithdrawable);
  let dryRun: TakeBackReview['dryRun'] = null;
  if (verdict.state === 'open' && amountCheck.ok) {
    const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: WITHDRAW, functionName: 'partialWithdrawCollateral', args: [loanId, amount], account }));
    dryRun = dry.kind === 'answered' ? null : dry.kind === 'reverted' ? refusalFromError(dry.error) : 'unread';
  }
  // The collateral leaves the vault of the borrower the loan records.
  const route = payoutRoute(facts.protection, account, facts.loan.borrower);
  return { identity, loanId, amount, ...facts, route, amountCheck, dryRun, verdict, readAt };
}

/** Every loan field the receipt states or the route depends on: a change
 *  to any reopens the review. */
export const TAKE_BACK_STATED_LOAN_FIELDS = [
  'status',
  'borrower',
  'assetType',
  'collateralAsset',
  'collateralAmount',
  'principal',
  'principalAsset',
  'borrowerTokenId',
] as const satisfies readonly (keyof LoanDetails)[];

/** What a re-read found changed, in words, or null. The limit, the health
 *  factor and the loan-to-value move with prices: they are restated, and a
 *  limit that falls below the amount blocks the review through the amount
 *  check rather than reopening it. */
export function takeBackChanged(a: TakeBackReview, b: TakeBackReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if (TAKE_BACK_STATED_LOAN_FIELDS.some((k) => a.loan[k] !== b.loan[k])) return text('repay.changedLoan');
  if (a.borrowerHolder !== b.borrowerHolder || a.borrowerLock !== b.borrowerLock || a.paused !== b.paused || a.refinanceLive !== b.refinanceLive)
    return text('repay.changedHolders');
  if (routeChanged(a, b)) return text('payout.changed');
  if (a.verdict.state !== b.verdict.state || a.verdict.refusals[0]?.code !== b.verdict.refusals[0]?.code) return text('repay.changedVerdict');
  return null;
}

/** What stops the review here, in words (empty when nothing does): the
 *  app's own rule, an amount above the limit now, or the protocol's dry
 *  run. */
export function takeBackBlockers(r: TakeBackReview, copy: Pick<CopyAccess, 'text' | 'format'>, amountText: (v: bigint) => string): string[] {
  if (r.verdict.state !== 'open') return [r.verdict.refusals[0]?.reason ?? ''];
  if (!r.amountCheck.ok)
    return [r.amountCheck.why === 'over-limit' ? copy.format('takeBack.overLimit', { max: amountText(r.maxWithdrawable ?? 0n) }) : copy.text('takeBack.amountZero')];
  if (r.dryRun === 'unread') return [copy.text('takeBack.dryRunUnread')];
  if (r.dryRun !== null) return [copy.format('repay.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}
