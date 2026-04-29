import { useEffect, useState, useCallback } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';
import { batchCalls, encodeBatchCalls } from '../lib/multicall';
import { useLogIndex } from './useLogIndex';
import { type LoanStatus, type LoanSummary, type LoanDetails } from '../types/loan';
import { beginStep } from '../lib/journeyLog';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Returns every loan the connected address currently participates in —
 * either as lender (holds the lender NFT) or borrower (holds the borrower
 * NFT). Discovery is driven by the event-indexed loan list from
 * `useLogIndex`, so we only visit known loan IDs.
 *
 * Performance: fans out one Multicall3 batch for `getLoanDetails` across all
 * known loans, then a second batch for any `ownerOf` lookups the indexer's
 * Transfer cache missed. On chains where every loan's NFT-owner is already
 * cached, the whole scan is a single round-trip — independent of how many
 * loans exist globally.
 */
export function useUserLoans(address: string | null) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const { loans: knownLoans, getOwner, loading: indexLoading, reload: reloadIndex } = useLogIndex();
  const [loans, setLoans] = useState<LoanSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;

  const load = useCallback(async () => {
    if (!address) {
      setLoans([]);
      return;
    }
    setLoading(true);
    const step = beginStep({ area: 'dashboard', flow: 'useUserLoans', step: 'scan-known-loans', wallet: address });
    try {
      const me = address.toLowerCase();

      // 1. Batch all getLoanDetails calls in one Multicall3 round-trip.
      const detailCalls = encodeBatchCalls(
        diamondAddress,
        DIAMOND_ABI,
        'getLoanDetails',
        knownLoans.map((e) => [e.loanId] as const),
      );
      const details = await batchCalls<LoanDetails>(
        publicClient,
        DIAMOND_ABI,
        'getLoanDetails',
        detailCalls,
      );

      // 2. Collect tokenIds whose current owner the Transfer cache doesn't
      //    know yet, and batch a single ownerOf multicall to resolve them.
      const pendingOwnerIds: bigint[] = [];
      for (const loan of details) {
        if (!loan) continue;
        if (getOwner(loan.lenderTokenId) == null) pendingOwnerIds.push(loan.lenderTokenId);
        if (getOwner(loan.borrowerTokenId) == null) pendingOwnerIds.push(loan.borrowerTokenId);
      }
      const liveOwners = new Map<string, string>();
      if (pendingOwnerIds.length > 0) {
        const ownerCalls = encodeBatchCalls(
          diamondAddress,
          DIAMOND_ABI,
          'ownerOf',
          pendingOwnerIds.map((tokenId) => [tokenId] as const),
        );
        const owners = await batchCalls<string>(publicClient, DIAMOND_ABI, 'ownerOf', ownerCalls);
        for (let i = 0; i < pendingOwnerIds.length; i++) {
          const o = owners[i];
          liveOwners.set(
            pendingOwnerIds[i].toString(),
            (o ?? ZERO_ADDRESS).toLowerCase(),
          );
        }
      }

      const resolveOwner = (tokenId: bigint): string => {
        const cached = getOwner(tokenId);
        if (cached) return cached;
        return liveOwners.get(tokenId.toString()) ?? ZERO_ADDRESS;
      };

      // 3. Filter to the user's loans and shape the LoanSummary payload.
      const found: LoanSummary[] = [];
      for (let i = 0; i < details.length; i++) {
        const loan = details[i];
        if (!loan) continue;
        const entry = knownLoans[i];
        const lenderHolder = resolveOwner(loan.lenderTokenId);
        const borrowerHolder = resolveOwner(loan.borrowerTokenId);
        const isCurrentLender = lenderHolder === me;
        const isCurrentBorrower = borrowerHolder === me;
        // Historical fallback: terminal states (Repaid, Settled, Claimed,
        // Defaulted, Preclosed, EarlyWithdrawn) burn the position NFTs, so
        // current ownership goes empty. Fall back to the LoanInitiated
        // event's original lender/borrower only when the corresponding NFT
        // is burned — otherwise we'd double-count transferred loans.
        const lenderBurned = lenderHolder === ZERO_ADDRESS;
        const borrowerBurned = borrowerHolder === ZERO_ADDRESS;
        const isHistoricLender = lenderBurned && entry.lender === me;
        const isHistoricBorrower = borrowerBurned && entry.borrower === me;
        const isLender = isCurrentLender || isHistoricLender;
        const isBorrower = isCurrentBorrower || isHistoricBorrower;
        if (!isLender && !isBorrower) continue;
        found.push({
          id: loan.id,
          principal: loan.principal,
          principalAsset: loan.principalAsset,
          assetType: Number(loan.assetType ?? 0n),
          principalTokenId: (loan.tokenId as bigint | undefined) ?? 0n,
          interestRateBps: loan.interestRateBps,
          durationDays: loan.durationDays,
          startTime: loan.startTime,
          status: Number(loan.status) as LoanStatus,
          role: isLender ? 'lender' : 'borrower',
          collateralAsset: loan.collateralAsset,
          collateralAmount: loan.collateralAmount,
          lenderTokenId: loan.lenderTokenId,
          borrowerTokenId: loan.borrowerTokenId,
        });
      }
      setLoans(found);
      step.success({ note: `${found.length} loans for wallet` });
    } catch (err) {
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [address, publicClient, knownLoans, getOwner, diamondAddress]);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    await reloadIndex();
    await load();
  }, [reloadIndex, load]);

  return { loans, loading: loading || indexLoading, reload };
}
