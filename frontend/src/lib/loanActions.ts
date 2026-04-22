/**
 * Pure availability logic for the LoanDetails action panel. Kept React-free
 * so the per-role gating matrix can be unit-tested without mounting the
 * full page.
 *
 * The gates mirror the JSX conditions in `pages/LoanDetails.tsx` — when that
 * file changes, update this one (and its tests) in lockstep.
 */

import { LoanStatus, AssetType } from '../types/loan';

export type LoanRole = 'lender' | 'borrower' | 'none';

export interface LoanActionContext {
  /** `LoanStatus` enum value (Active, FallbackPending, Repaid, Defaulted, Settled, …). */
  status: number;
  /** Which side of the loan (if any) the current wallet holds. */
  role: LoanRole;
  /** Block-time past the loan's end. */
  isOverdue: boolean;
  /** `AssetType` enum for the principal leg. */
  assetType: number;
  /** UI mode gate — many strategic actions are advanced-only. */
  showAdvanced: boolean;
  /** True when a wallet is connected. */
  walletConnected: boolean;
}

export interface LoanActionAvailability {
  /** Repay in full — borrower cures OR any funded wallet pays off the loan. */
  repay: boolean;
  /** Borrower-only top-up to restore HF/LTV. */
  addCollateral: boolean;
  /** Public — anyone may trigger default once the grace period lapses. */
  triggerDefault: boolean;
  /** Lender-only pre-maturity exit. ERC-20-only. */
  earlyWithdrawal: boolean;
  /** Borrower-only close-early flow. ERC-20-only, advanced-mode. */
  preclose: boolean;
  /** Borrower-only lender-swap flow. ERC-20-only, advanced-mode. */
  refinance: boolean;
}

/**
 * Derive which actions should render on the panel from the (loan, wallet,
 * UI-mode) tuple. The rules intentionally mirror the JSX `&&` chains in
 * LoanDetails.tsx rather than introducing a new policy — this file exists so
 * those rules are testable, not so they are reinterpreted.
 */
export function getLoanActionAvailability(ctx: LoanActionContext): LoanActionAvailability {
  const isActive = ctx.status === LoanStatus.Active;
  const isFallbackPending = ctx.status === LoanStatus.FallbackPending;
  const canAct = (isActive || isFallbackPending) && ctx.walletConnected;
  const isBorrower = ctx.role === 'borrower';
  const isLender = ctx.role === 'lender';
  const isErc20 = ctx.assetType === AssetType.ERC20;

  // All actions render inside the top-level `{canAct && address && ...}`
  // wrapper in LoanDetails.tsx — so every gate below inherits that AND.
  return {
    repay: canAct,
    addCollateral: canAct && isBorrower && ctx.showAdvanced,
    triggerDefault: canAct && ctx.isOverdue && isActive,
    earlyWithdrawal: canAct && isLender && !ctx.isOverdue && isActive && isErc20,
    preclose: canAct && isBorrower && !ctx.isOverdue && isActive && ctx.showAdvanced && isErc20,
    refinance: canAct && isBorrower && !ctx.isOverdue && isActive && ctx.showAdvanced && isErc20,
  };
}
