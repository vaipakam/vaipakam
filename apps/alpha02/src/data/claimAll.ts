/**
 * "Claim all eligible" assembly (#1268 / E-10).
 *
 * The one-click Claim-All flow batches every ready payout into ONE
 * `multicall` signature (see `contracts/src/facets/MulticallFacet.sol`)
 * instead of one transaction per claim. This module is the PURE,
 * unit-testable core: it turns the already-fetched claim data into a
 * typed, ordered item list, and encodes a chosen subset into the
 * `Call[]` the Diamond's `multicall` takes.
 *
 * Kept free of React/wagmi so it can be tested directly, and so the
 * exact call surface (which functions the batch invokes) is greppable.
 *
 * Scope (this slice): the four data-ready payout types —
 *   - `claimAsLender(loanId)`   — lender loan/rental proceeds
 *   - `claimAsBorrower(loanId)` — borrower collateral/buffer + LIF rebate
 *   - `claimInteractionRewards()` — pending interaction-reward VPFI
 *   - `withdrawVPFIFromVault(amount)` — free (unencumbered) vault VPFI
 * Lender-intent capital and payroll salary are a documented follow-up
 * (no alpha02 read surface yet).
 */
import { encodeFunctionData } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { AssetType } from '../lib/types';
import { formatTokenAmount } from '../lib/format';
import { VPFI_DECIMALS } from './vpfi';
import { copySource } from '../content/copy';
import type { ClaimableLoan } from './claimables';

/** Upper bound mirrors `MulticallFacet.MAX_MULTICALL_CALLS` — a batch
 *  past this reverts on-chain, so the UI caps the SELECTED count here
 *  and asks the user to claim the rest in a second pass. */
export const MAX_CLAIM_ALL = 30;

export type ClaimAllKind =
  | 'loan-lender'
  | 'loan-borrower'
  | 'rewards'
  | 'vpfi-vault';

export interface ClaimAllItem {
  /** Stable identity for include/exclude toggles and React keys. */
  key: string;
  kind: ClaimAllKind;
  /** Diamond function this item calls in its delegatecall frame. */
  functionName: 'claimAsLender' | 'claimAsBorrower' | 'claimInteractionRewards' | 'withdrawVPFIFromVault';
  args: readonly unknown[];
  /** Short, self-contained preview label (no async token metadata). */
  label: string;
  /** Whether the item is checked by DEFAULT. Loan proceeds + rewards
   *  are money owed → on. Vault VPFI is a balance the user parked for a
   *  fee-discount tier, so pulling it is opt-IN (withdrawing lowers the
   *  tier) — off by default with a warning in the UI. */
  defaultSelected: boolean;
}

/** The subset of copy.claimAll the builder composes labels from. Passed
 *  in (defaulting to the English source) so the module stays a pure,
 *  node-testable builder while the app supplies the translated copy. */
export interface ClaimAllLabels {
  loanNoun: string;
  rentalNoun: string;
  itemLabel: (noun: string, id: number, what: string) => string;
  lenderProceeds: string;
  lenderRentalFeesNft: string;
  borrowerBufferBack: string;
  borrowerSurplus: string;
  borrowerResidual: string;
  borrowerCollateralBack: string;
  rewardsLabel: (amount: string) => string;
  vaultVpfiLabel: (amount: string) => string;
}

export interface BuildClaimAllInput {
  /** Confirmed claimable loans (from `useMyClaimables`). */
  loans: ClaimableLoan[];
  /** Pending interaction-reward VPFI (18-dec). */
  rewardsPending: bigint;
  /** Free (unencumbered) vault VPFI withdrawable now (18-dec). */
  vpfiFree: bigint;
  /** Translatable label strings. Defaults to the English source so
   *  existing callers / tests keep working unchanged. */
  labels?: ClaimAllLabels;
}

/**
 * Build the ordered Claim-All item list from already-fetched data.
 * Deterministic and side-effect free: same inputs → same items, in a
 * stable order (loan claims first, in the order the claimables hook
 * returned them, then rewards, then vault VPFI). Zero-value rewards /
 * vault legs are omitted entirely.
 */
export function buildClaimAllItems({
  loans,
  rewardsPending,
  vpfiFree,
  labels = copySource.claimAll,
}: BuildClaimAllInput): ClaimAllItem[] {
  const items: ClaimAllItem[] = [];

  for (const loan of loans) {
    const isRental = loan.assetType !== AssetType.ERC20;
    const noun = isRental ? labels.rentalNoun : labels.loanNoun;
    if (loan.role === 'lender') {
      items.push({
        key: `loan-lender-${loan.loanId}`,
        kind: 'loan-lender',
        functionName: 'claimAsLender',
        args: [BigInt(loan.loanId)],
        label: labels.itemLabel(
          noun,
          loan.loanId,
          isRental ? labels.lenderRentalFeesNft : labels.lenderProceeds,
        ),
        defaultSelected: true,
      });
    } else {
      // Status-aware, mirroring the detailed Claim Center row copy: a
      // defaulted/liquidated or internally-matched borrower gets at most
      // a surplus residual (+ VPFI rebate), NOT their collateral back —
      // labelling every borrower ERC-20 claim "collateral back" would
      // overstate what the batch returns (Codex #1291 r1).
      let borrowerWhat: string;
      if (isRental) {
        borrowerWhat = labels.borrowerBufferBack;
      } else if (loan.status === 'defaulted' || loan.status === 'liquidated') {
        borrowerWhat = labels.borrowerSurplus;
      } else if (loan.status === 'internal_matched') {
        borrowerWhat = labels.borrowerResidual;
      } else {
        borrowerWhat = labels.borrowerCollateralBack;
      }
      items.push({
        key: `loan-borrower-${loan.loanId}`,
        kind: 'loan-borrower',
        functionName: 'claimAsBorrower',
        args: [BigInt(loan.loanId)],
        label: labels.itemLabel(noun, loan.loanId, borrowerWhat),
        defaultSelected: true,
      });
    }
  }

  if (rewardsPending > 0n) {
    items.push({
      key: 'rewards',
      kind: 'rewards',
      functionName: 'claimInteractionRewards',
      args: [],
      label: labels.rewardsLabel(formatTokenAmount(rewardsPending, VPFI_DECIMALS)),
      defaultSelected: true,
    });
  }

  if (vpfiFree > 0n) {
    items.push({
      // The key carries the amount so a one-time opt-in binds to THIS
      // exact withdrawal: if the free balance changes, or the item
      // leaves (after a withdrawal) and later reappears (more VPFI
      // parked), the stale opt-in does NOT carry over — the default-off
      // vault leg re-defaults to off and needs a fresh, explicit opt-in.
      // Without this, a single historical check could silently authorize
      // a later/larger withdrawal, the fee-tier footgun (Codex #1291 r2).
      key: `vpfi-vault-${vpfiFree}`,
      kind: 'vpfi-vault',
      // Pull the WHOLE free (unencumbered) balance — the amount the
      // snapshot reports as withdrawable. Encumbered VPFI stays put.
      functionName: 'withdrawVPFIFromVault',
      args: [vpfiFree],
      label: labels.vaultVpfiLabel(formatTokenAmount(vpfiFree, VPFI_DECIMALS)),
      // Opt-in: withdrawing parked VPFI lowers the fee-discount tier.
      defaultSelected: false,
    });
  }

  return items;
}

/** The kinds that come from a loan/rental position (vs the standalone
 *  rewards / vault-VPFI legs). */
export function isLoanItem(item: ClaimAllItem): boolean {
  return item.kind === 'loan-lender' || item.kind === 'loan-borrower';
}

/**
 * The default-checked key set for a fresh item list: every
 * `defaultSelected` item, but never more than `cap` — so the initial
 * selection is always submittable without the user having to uncheck
 * down to the on-chain batch bound. A whale with 90 claimable loans
 * lands with the first {MAX_CLAIM_ALL} pre-checked and the rest off,
 * instead of 90 checked and a forced unchecking chore.
 */
export function defaultSelectedKeys(
  items: ClaimAllItem[],
  cap: number = MAX_CLAIM_ALL,
): Set<string> {
  return new Set(
    items
      .filter((i) => i.defaultSelected)
      .slice(0, cap)
      .map((i) => i.key),
  );
}

/** One encoded `MulticallFacet.Call` — index-aligned with its item. */
export interface EncodedClaimCall {
  callData: `0x${string}`;
  /** Always true for Claim-All: an item finalized by another party
   *  between preview and tx is SKIPPED, and the rest still execute
   *  (a reverted delegatecall rolls back only its own frame). */
  allowFailure: boolean;
}

/**
 * Encode a chosen set of items into the `Call[]` `multicall` takes.
 * Every item is `allowFailure: true` so a stale/racing item can't abort
 * the batch. Callers must enforce {MAX_CLAIM_ALL} on the input length —
 * this function does not truncate.
 */
export function encodeClaimAllCalls(
  items: ClaimAllItem[],
): EncodedClaimCall[] {
  return items.map((item) => ({
    callData: encodeFunctionData({
      abi: DIAMOND_ABI_VIEM,
      functionName: item.functionName,
      args: item.args as unknown[],
    }),
    allowFailure: true,
  }));
}
