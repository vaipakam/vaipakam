/**
 * RB-ELIG for adding collateral to a loan (LN-31): the one rule that decides
 * whether this wallet may top up a loan's collateral now, used by the loan
 * page's action and by the review alike. It reads the inputs the protocol
 * checks in `addCollateral`, in the order it checks them, and the dry run
 * before signing stays the protocol's own last word.
 *
 * What it holds, and why:
 * - a pending swap-to-repay order on the borrower position: the protocol
 *   refuses a top-up while one is committed;
 * - any wallet but the borrower position's holder: the protocol takes a
 *   top-up from that holder only;
 * - a loan that is neither running nor in fallback: there is nothing to
 *   secure (a loan in fallback takes a top-up, which can cure it);
 * - a rental: it has no collateral leg;
 * - a collateral asset governance has paused;
 * - collateral the protocol does not price now: it takes a top-up only for
 *   priced (liquid) collateral, read live, not from the loan's opening class.
 * Deliberately NOT held: the protocol pause (a borrower can always lower
 * their risk), a lender's sale listing, a refinance request and an offset.
 *
 * The amount itself (more than nothing, within the wallet's balance) is
 * checked where it is entered.
 */
import type { CopyAccess } from '../copy/useCopy';
import { LOCK_SWAP_INTENT, STATUS_ACTIVE, STATUS_FALLBACK_PENDING } from './repay';
import { closed, OPEN, unknownVerdict, type Refusal, type Verdict } from './types';

type Hex = `0x${string}`;

/** `LibVaipakam.AssetType.ERC20`. */
const ASSET_ERC20 = 0;

export interface AddCollateralInputs {
  status: number;
  assetType: number;
  /** Who holds the borrower position now; null when unread. */
  borrowerHolder: Hex | null;
  /** The borrower position's lock (`positionLock`); null when unread. */
  borrowerLock: number | null;
  /** Whether governance has paused the collateral asset; null when unread. */
  assetPaused: boolean | null;
  /** Whether the protocol prices the collateral asset now (`checkLiquidity`
   *  reads Liquid); null when unread. */
  collateralLiquid: boolean | null;
}

export function addCollateralVerdict(i: AddCollateralInputs, payer: Hex, copy: Pick<CopyAccess, 'text'>, readAt: number): Verdict {
  const { text } = copy;
  const refuse = (code: string, reason: string): Verdict => closed([{ code, reason, reopensAt: null, remedy: null } satisfies Refusal], null, readAt, 'own');
  if (i.borrowerLock === null || i.borrowerHolder === null) return unknownVerdict(text('addColl.unread'));
  if (i.borrowerLock === LOCK_SWAP_INTENT) return refuse('IntentPending', text('addColl.swapOrder'));
  if (i.borrowerHolder.toLowerCase() !== payer.toLowerCase()) return refuse('NotNFTOwner', text('addColl.notBorrower'));
  if (i.status !== STATUS_ACTIVE && i.status !== STATUS_FALLBACK_PENDING) return refuse('LoanNotActive', text('repay.notRunning'));
  if (i.assetType !== ASSET_ERC20) return refuse('RentalCollateralNotAllowed', text('addColl.rental'));
  if (i.assetPaused === null || i.collateralLiquid === null) return unknownVerdict(text('addColl.unread'));
  if (i.assetPaused) return refuse('AssetPaused', text('addColl.assetPaused'));
  if (!i.collateralLiquid) return refuse('IlliquidAsset', text('addColl.illiquid'));
  return { ...OPEN, readAt, rail: 'own' };
}

/** Whether `amount` is a top-up the wallet can make: more than nothing and
 *  within its balance of the collateral asset. */
export type TopUpCheck = { ok: true } | { ok: false; why: 'zero' | 'over-balance' };

export function checkTopUp(amount: bigint, balance: bigint | null): TopUpCheck {
  if (amount <= 0n) return { ok: false, why: 'zero' };
  if (balance !== null && amount > balance) return { ok: false, why: 'over-balance' };
  return { ok: true };
}
