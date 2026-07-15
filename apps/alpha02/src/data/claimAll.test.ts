/**
 * #1268 / E-10 — the pure Claim-All assembly: item list + `Call[]`
 * encoding. These are the correctness-load-bearing parts (which
 * functions the batch calls, with which args, and which items are
 * opt-in), so they're unit-tested away from React/wagmi.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { AssetType } from '../lib/types';
import {
  buildClaimAllItems,
  defaultSelectedKeys,
  encodeClaimAllCalls,
  isLoanItem,
  MAX_CLAIM_ALL,
} from './claimAll';
import type { ClaimableLoan } from './claimables';

/** Minimal claimable-loan fixture — the builder only reads loanId,
 *  role, and assetType, so the rest is filler to satisfy the type. */
function loan(
  loanId: number,
  role: 'lender' | 'borrower',
  assetType: number = AssetType.ERC20,
): ClaimableLoan {
  return {
    loanId,
    role,
    assetType,
    status: 'repaid',
    lendingAsset: '0x0000000000000000000000000000000000000001',
    collateralAsset: '0x0000000000000000000000000000000000000002',
    tokenId: 0,
    principal: 0n,
    collateralAmount: 0n,
    lenderTokenId: 0,
    borrowerTokenId: 0,
    claim: {
      asset: null,
      amount: 0n,
      heldForLender: 0n,
      hasRentalNftReturn: false,
      lifRebate: 0n,
    },
  } as unknown as ClaimableLoan;
}

describe('buildClaimAllItems', () => {
  it('maps lender/borrower loans to the right claim selectors', () => {
    const items = buildClaimAllItems({
      loans: [loan(7, 'lender'), loan(9, 'borrower')],
      rewardsPending: 0n,
      vpfiFree: 0n,
    });
    expect(items.map((i) => i.functionName)).toEqual([
      'claimAsLender',
      'claimAsBorrower',
    ]);
    expect(items[0].args).toEqual([7n]);
    expect(items[1].args).toEqual([9n]);
    // Loan proceeds are money owed → checked by default.
    expect(items.every((i) => i.defaultSelected)).toBe(true);
  });

  it('appends rewards + vault VPFI after the loans, in that order', () => {
    const items = buildClaimAllItems({
      loans: [loan(1, 'lender')],
      rewardsPending: 5n * 10n ** 18n,
      vpfiFree: 3n * 10n ** 18n,
    });
    expect(items.map((i) => i.kind)).toEqual([
      'loan-lender',
      'rewards',
      'vpfi-vault',
    ]);
    const rewards = items.find((i) => i.kind === 'rewards')!;
    expect(rewards.functionName).toBe('claimInteractionRewards');
    expect(rewards.args).toEqual([]);
    const vault = items.find((i) => i.kind === 'vpfi-vault')!;
    expect(vault.functionName).toBe('withdrawVPFIFromVault');
    // Withdraws the WHOLE free balance.
    expect(vault.args).toEqual([3n * 10n ** 18n]);
  });

  it('makes vault VPFI opt-IN (default off) — it backs the discount tier', () => {
    const items = buildClaimAllItems({
      loans: [],
      rewardsPending: 0n,
      vpfiFree: 1n,
    });
    const vault = items.find((i) => i.kind === 'vpfi-vault')!;
    expect(vault.defaultSelected).toBe(false);
  });

  it('omits zero-value rewards and vault legs', () => {
    const items = buildClaimAllItems({
      loans: [loan(1, 'lender')],
      rewardsPending: 0n,
      vpfiFree: 0n,
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('loan-lender');
  });

  it('labels a rental lender leg with the NFT return, not a fee number', () => {
    const items = buildClaimAllItems({
      loans: [loan(4, 'lender', AssetType.ERC721)],
      rewardsPending: 0n,
      vpfiFree: 0n,
    });
    expect(items[0].label).toContain('NFT');
  });

  it('gives every item a stable, unique key', () => {
    const items = buildClaimAllItems({
      loans: [loan(1, 'lender'), loan(1, 'borrower')],
      rewardsPending: 1n,
      vpfiFree: 1n,
    });
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('defaultSelectedKeys', () => {
  it('checks every default-on item under the cap', () => {
    const items = buildClaimAllItems({
      loans: [loan(1, 'lender'), loan(2, 'borrower')],
      rewardsPending: 1n,
      vpfiFree: 1n,
    });
    const keys = defaultSelectedKeys(items);
    // Both loans + rewards on; vault VPFI off.
    expect(keys.has('loan-lender-1')).toBe(true);
    expect(keys.has('loan-borrower-2')).toBe(true);
    expect(keys.has('rewards')).toBe(true);
    expect(keys.has('vpfi-vault')).toBe(false);
  });

  it('never pre-checks more than the cap (whale lands submittable)', () => {
    const loans = Array.from({ length: 90 }, (_, i) => loan(i + 1, 'lender'));
    const items = buildClaimAllItems({ loans, rewardsPending: 0n, vpfiFree: 0n });
    const keys = defaultSelectedKeys(items);
    expect(keys.size).toBe(MAX_CLAIM_ALL);
    // The cap slices the FIRST N default-on items — a deterministic,
    // submittable starting selection, not 90 checked boxes.
    expect(keys.has('loan-lender-1')).toBe(true);
    expect(keys.has('loan-lender-90')).toBe(false);
  });
});

describe('isLoanItem', () => {
  it('separates loan legs from rewards / vault legs', () => {
    const items = buildClaimAllItems({
      loans: [loan(1, 'lender')],
      rewardsPending: 1n,
      vpfiFree: 1n,
    });
    expect(items.filter(isLoanItem).map((i) => i.kind)).toEqual([
      'loan-lender',
    ]);
  });
});

describe('encodeClaimAllCalls', () => {
  it('encodes each item to a decodable Diamond call, all allowFailure', () => {
    const items = buildClaimAllItems({
      loans: [loan(7, 'lender'), loan(9, 'borrower')],
      rewardsPending: 2n * 10n ** 18n,
      vpfiFree: 0n,
    });
    const calls = encodeClaimAllCalls(items);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.allowFailure === true)).toBe(true);

    const first = decodeFunctionData({
      abi: DIAMOND_ABI_VIEM,
      data: calls[0].callData,
    });
    expect(first.functionName).toBe('claimAsLender');
    expect(first.args).toEqual([7n]);

    const third = decodeFunctionData({
      abi: DIAMOND_ABI_VIEM,
      data: calls[2].callData,
    });
    expect(third.functionName).toBe('claimInteractionRewards');
  });

  it('MAX_CLAIM_ALL mirrors the on-chain batch bound', () => {
    // MulticallFacet.MAX_MULTICALL_CALLS — kept in lockstep.
    expect(MAX_CLAIM_ALL).toBe(30);
  });
});
