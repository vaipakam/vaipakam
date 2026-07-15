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

export interface BuildClaimAllInput {
  /** Confirmed claimable loans (from `useMyClaimables`). */
  loans: ClaimableLoan[];
  /** Pending interaction-reward VPFI (18-dec). */
  rewardsPending: bigint;
  /** Free (unencumbered) vault VPFI withdrawable now (18-dec). */
  vpfiFree: bigint;
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
}: BuildClaimAllInput): ClaimAllItem[] {
  const items: ClaimAllItem[] = [];

  for (const loan of loans) {
    const isRental = loan.assetType !== AssetType.ERC20;
    const noun = isRental ? 'Rental' : 'Loan';
    if (loan.role === 'lender') {
      items.push({
        key: `loan-lender-${loan.loanId}`,
        kind: 'loan-lender',
        functionName: 'claimAsLender',
        args: [BigInt(loan.loanId)],
        label: isRental
          ? `${noun} #${loan.loanId} — fees + your NFT back`
          : `${noun} #${loan.loanId} — your proceeds`,
        defaultSelected: true,
      });
    } else {
      items.push({
        key: `loan-borrower-${loan.loanId}`,
        kind: 'loan-borrower',
        functionName: 'claimAsBorrower',
        args: [BigInt(loan.loanId)],
        label: isRental
          ? `${noun} #${loan.loanId} — your buffer back`
          : `${noun} #${loan.loanId} — collateral back`,
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
      label: `Interaction rewards — ${formatTokenAmount(rewardsPending, VPFI_DECIMALS)} VPFI`,
      defaultSelected: true,
    });
  }

  if (vpfiFree > 0n) {
    items.push({
      key: 'vpfi-vault',
      kind: 'vpfi-vault',
      // Pull the WHOLE free (unencumbered) balance — the amount the
      // snapshot reports as withdrawable. Encumbered VPFI stays put.
      functionName: 'withdrawVPFIFromVault',
      args: [vpfiFree],
      label: `Vault VPFI — ${formatTokenAmount(vpfiFree, VPFI_DECIMALS)} VPFI`,
      // Opt-in: withdrawing parked VPFI lowers the fee-discount tier.
      defaultSelected: false,
    });
  }

  return items;
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
