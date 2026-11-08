/**
 * RB-ELIG for paying part of a loan (LN-22, LN-64): the one rule that decides
 * whether this wallet may make a partial repayment now, used by the loan
 * page's action and by the review alike. It reads the inputs the protocol
 * checks in `repayPartial`, in the order it checks them, and the dry run
 * before signing stays the protocol's own last word.
 *
 * What it holds, and why:
 * - a loan that is not running: a loan in fallback can only be repaid in
 *   full (which cures it), and an ended loan has nothing to pay;
 * - a rental: its partial payment is a number of rental days, which this
 *   page does not offer yet (the app's limit, not the protocol's);
 * - any wallet but the borrower position's holder: the protocol accepts a
 *   partial repayment from the borrower only;
 * - a loan whose terms do not allow partial repayment (the lender's choice,
 *   fixed when it opened);
 * - past the end of the grace period: the protocol refuses it then;
 * - a pending swap-to-repay order on the borrower position, and a live
 *   refinance request for the loan: the protocol refuses both;
 * - a live offset on the borrower position: the replacement offer is pinned
 *   to the loan as it stands, so the app holds a partial while it is live
 *   (the app's rule; the protocol does not refuse it).
 * Deliberately NOT held: the protocol pause (a borrower can always lower
 * their risk) and a lender's sale listing.
 *
 * The amount itself (at least the protocol's minimum part, and less than
 * the whole principal) is checked where it is entered.
 */
import type { CopyAccess } from '../copy/useCopy';
import { formatUtc } from '../ui/format';
import { LOCK_SWAP_INTENT, STATUS_ACTIVE, STATUS_FALLBACK_PENDING } from './repay';
import { closed, OPEN, unknownVerdict, type Refusal, type Verdict } from './types';

type Hex = `0x${string}`;

/** `LibVaipakam.AssetType.ERC20`. */
const ASSET_ERC20 = 0;
/** `LibERC721.LockReason.PrecloseOffset`. */
export const LOCK_PRECLOSE_OFFSET = 1;

export interface PartialRepayInputs {
  status: number;
  assetType: number;
  allowsPartialRepay: boolean;
  /** Who holds the borrower position now; null when unread. */
  borrowerHolder: Hex | null;
  /** The effective end of the grace period; null when unread. */
  graceEnd: bigint | null;
  /** The latest block's time. */
  chainNow: bigint;
  /** The borrower position's lock (`positionLock`); null when unread. */
  borrowerLock: number | null;
  /** Whether a refinance request is live for the loan; null when unread. */
  refinanceLive: boolean | null;
}

export function partialRepayVerdict(i: PartialRepayInputs, payer: Hex, copy: Pick<CopyAccess, 'text' | 'format'>, readAt: number): Verdict {
  const { text, format } = copy;
  const refuse = (code: string, reason: string): Verdict => closed([{ code, reason, reopensAt: null, remedy: null } satisfies Refusal], null, readAt, 'own');
  if (i.status === STATUS_FALLBACK_PENDING) return refuse('InvalidLoanStatus', text('partial.fallback'));
  if (i.status !== STATUS_ACTIVE) return refuse('InvalidLoanStatus', text('repay.notRunning'));
  if (i.assetType !== ASSET_ERC20) return refuse('RentalNotHere', text('partial.rentalLater'));
  if (i.borrowerHolder === null) return unknownVerdict(text('partial.unread'));
  if (i.borrowerHolder.toLowerCase() !== payer.toLowerCase()) return refuse('NotBorrower', text('partial.notBorrower'));
  if (!i.allowsPartialRepay) return refuse('PartialRepayNotAllowed', text('partial.notAllowed'));
  if (i.graceEnd === null || i.borrowerLock === null || i.refinanceLive === null) return unknownVerdict(text('partial.unread'));
  if (i.chainNow > i.graceEnd) return refuse('RepaymentPastGracePeriod', format('repay.pastGrace', { time: formatUtc(Number(i.graceEnd)) }));
  if (i.borrowerLock === LOCK_SWAP_INTENT) return refuse('LiveIntentCommit', text('repay.swapOrder'));
  if (i.refinanceLive) return refuse('RefinanceRequestLive', text('partial.refinanceLive'));
  if (i.borrowerLock === LOCK_PRECLOSE_OFFSET) return refuse('OffsetLive', text('partial.offsetLive'));
  return { ...OPEN, readAt, rail: 'own' };
}

/** Whether `amount` is a principal part the protocol takes: at least its
 *  minimum part (and more than nothing), and less than the whole principal
 *  (a payment of all of it is a full repayment). `floor` null is unread. */
export type AmountCheck = { ok: true } | { ok: false; why: 'zero' | 'below-floor' | 'whole' | 'floor-unread' };

export function checkPartialAmount(amount: bigint, principal: bigint, floor: bigint | null): AmountCheck {
  if (amount <= 0n) return { ok: false, why: 'zero' };
  if (amount >= principal) return { ok: false, why: 'whole' };
  if (floor === null) return { ok: false, why: 'floor-unread' };
  if (amount < floor) return { ok: false, why: 'below-floor' };
  return { ok: true };
}
