/**
 * RB-ELIG for a full repayment (LN-21, LN-30): the one rule that decides
 * whether this wallet may repay a loan in full now, used by the loan page's
 * action and by the review alike. It reads the same inputs the protocol
 * checks in `repayLoan`, and the dry run before signing stays the
 * protocol's own last word (a refusal this rule does not name still stops
 * the repayment, stated as the protocol gives it).
 *
 * What it holds, and why:
 * - a loan that is not running (or in fallback) has nothing to repay;
 * - a running loan past the end of its grace period: the protocol refuses
 *   a repayment then, and the loan goes to default instead (a loan in
 *   fallback is the exception: a full repayment cures it);
 * - the lender's own wallet, recorded or holding the lender position: the
 *   protocol refuses a lender repaying their own loan;
 * - a pending swap-to-repay order on the borrower position: its collateral
 *   is promised to an order that may still fill;
 * - a rental: the rent comes from the borrower's prepayment, which this
 *   page cannot repay from yet (stated as the app's limit, not the
 *   protocol's).
 * Deliberately NOT held (the canonical spec): a lender's sale listing, a
 * standing refinance request, the protocol pause (repayment stays open so a
 * borrower can always lower their risk), the Terms gate and the sanctions
 * screen on the payer side (repayment is a close-out). A listed sale that a
 * buyer accepts completes inside the buyer's own transaction, so there is no
 * moment in which an accepted sale is still completing on a running loan.
 */
import type { CopyAccess } from '../copy/useCopy';
import { formatUtc } from '../ui/format';
import { closed, OPEN, unknownVerdict, type Refusal, type Verdict } from './types';

type Hex = `0x${string}`;

/** `LibVaipakam.LoanStatus`. */
export const STATUS_ACTIVE = 0;
export const STATUS_FALLBACK_PENDING = 4;
/** `LibVaipakam.AssetType.ERC20`. */
const ASSET_ERC20 = 0;
/** `LibERC721.LockReason.SwapToRepayIntent`. */
export const LOCK_SWAP_INTENT = 4;

export interface RepayInputs {
  status: number;
  assetType: number;
  /** The recorded lender, and who holds the lender position now (null when
   *  unread). */
  recordedLender: Hex;
  lenderHolder: Hex | null;
  /** The end of the grace period (effective, from the loan clock); null
   *  when unread. */
  graceEnd: bigint | null;
  /** The latest block's time. */
  chainNow: bigint;
  /** The borrower position's lock (`positionLock`); null when unread. */
  borrowerLock: number | null;
}

export function repayVerdict(i: RepayInputs, payer: Hex, copy: Pick<CopyAccess, 'text' | 'format'>, readAt: number): Verdict {
  const { text, format } = copy;
  const refuse = (code: string, reason: string, reopensAt: number | null = null): Verdict =>
    closed([{ code, reason, reopensAt, remedy: null } satisfies Refusal], null, readAt, 'own');
  const fallback = i.status === STATUS_FALLBACK_PENDING;
  if (i.status !== STATUS_ACTIVE && !fallback) return refuse('InvalidLoanStatus', text('repay.notRunning'));
  if (i.assetType !== ASSET_ERC20) return refuse('RentalNotHere', text('repay.rentalLater'));
  const me = payer.toLowerCase();
  if (i.recordedLender.toLowerCase() === me || i.lenderHolder?.toLowerCase() === me) return refuse('LenderCannotRepayOwnLoan', text('repay.ownLoan'));
  if (i.lenderHolder === null || i.borrowerLock === null || (!fallback && i.graceEnd === null)) return unknownVerdict(text('repay.unread'));
  if (!fallback && i.graceEnd !== null && i.chainNow > i.graceEnd) return refuse('RepaymentPastGracePeriod', format('repay.pastGrace', { time: formatUtc(Number(i.graceEnd)) }));
  if (i.borrowerLock === LOCK_SWAP_INTENT) return refuse('LiveIntentCommit', text('repay.swapOrder'));
  return { ...OPEN, readAt, rail: 'own' };
}
