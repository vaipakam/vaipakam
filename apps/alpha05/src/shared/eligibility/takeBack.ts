/**
 * RB-ELIG for taking back collateral from a loan (LN-32): the one rule that
 * decides whether this wallet may withdraw part of a loan's collateral now,
 * used by the loan page's action and by the review alike. It reads the
 * inputs the protocol checks in `partialWithdrawCollateral`, in the order it
 * checks them, and the dry run stays the protocol's own last word.
 *
 * What it holds, and why:
 * - the protocol pause: a withdrawal is a position change the pause stops;
 * - a pending swap-to-repay order on the borrower position, and a standing
 *   refinance request for the loan: the protocol refuses both;
 * - any wallet but the borrower position's holder;
 * - a loan that is not running (a loan in fallback included: its collateral
 *   is held for the close-out);
 * - a rental: it has no collateral leg;
 * - collateral the protocol does not price now: the limit is a price check;
 * - nothing above the loan's limits: the protocol's own most that can be
 *   taken back now is zero.
 * A lender's linked sale listing also holds it; no view exposes that link,
 * so the review's dry run names it (#3308).
 *
 * The amount itself (more than nothing, at most the protocol's limit) is
 * checked where it is entered.
 */
import type { CopyAccess } from '../copy/useCopy';
import { LOCK_SWAP_INTENT, STATUS_ACTIVE } from './repay';
import { closed, OPEN, unknownVerdict, type Refusal, type Verdict } from './types';

type Hex = `0x${string}`;

/** `LibVaipakam.AssetType.ERC20`. */
const ASSET_ERC20 = 0;

export interface TakeBackInputs {
  status: number;
  assetType: number;
  /** The protocol pause; null when unread. */
  paused: boolean | null;
  borrowerHolder: Hex | null;
  borrowerLock: number | null;
  /** Whether a refinance request stands for the loan; null when unread. */
  refinanceLive: boolean | null;
  /** Whether the protocol prices the collateral token now; null when unread. */
  collateralLiquid: boolean | null;
  /** The protocol's most that can be taken back now; null when unread. */
  maxWithdrawable: bigint | null;
}

export function takeBackVerdict(i: TakeBackInputs, caller: Hex, copy: Pick<CopyAccess, 'text'>, readAt: number): Verdict {
  const { text } = copy;
  const refuse = (code: string, reason: string): Verdict => closed([{ code, reason, reopensAt: null, remedy: null } satisfies Refusal], null, readAt, 'own');
  if (i.paused === null || i.borrowerLock === null || i.refinanceLive === null || i.borrowerHolder === null) return unknownVerdict(text('takeBack.unread'));
  if (i.paused) return refuse('EnforcedPause', text('takeBack.paused'));
  if (i.borrowerLock === LOCK_SWAP_INTENT) return refuse('IntentPending', text('takeBack.swapOrder'));
  if (i.refinanceLive) return refuse('RefinanceRequestOpen', text('takeBack.refinanceLive'));
  if (i.borrowerHolder.toLowerCase() !== caller.toLowerCase()) return refuse('NotNFTOwner', text('takeBack.notBorrower'));
  if (i.status !== STATUS_ACTIVE) return refuse('LoanNotActive', text('takeBack.notRunning'));
  if (i.assetType !== ASSET_ERC20) return refuse('RentalCollateralNotAllowed', text('addColl.rental'));
  if (i.collateralLiquid === null || i.maxWithdrawable === null) return unknownVerdict(text('takeBack.unread'));
  if (!i.collateralLiquid) return refuse('IlliquidAsset', text('takeBack.illiquid'));
  if (i.maxWithdrawable === 0n) return refuse('NothingToTakeBack', text('takeBack.nothing'));
  return { ...OPEN, readAt, rail: 'own' };
}

/** Whether `amount` can be taken back: more than nothing and at most the
 *  protocol's limit now. */
export type TakeBackCheck = { ok: true } | { ok: false; why: 'zero' | 'over-limit' };

export function checkTakeBack(amount: bigint, max: bigint | null): TakeBackCheck {
  if (amount <= 0n) return { ok: false, why: 'zero' };
  if (max !== null && amount > max) return { ok: false, why: 'over-limit' };
  return { ok: true };
}
