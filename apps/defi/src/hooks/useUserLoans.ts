import { useEffect, useState, useCallback } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';
import { batchCalls, encodeBatchCalls } from '@vaipakam/lib/multicall';
import { useLogIndex } from './useLogIndex';
import { fetchLoansByCurrentHolder } from '../lib/indexerClient';
import { type LoanStatus, type LoanSummary, type LoanDetails } from '../types/loan';
import { beginStep } from '../lib/journeyLog';
import { useDataFreshness } from '../context/DataFreshnessContext';

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
  const { report } = useDataFreshness();
  const [loans, setLoans] = useState<LoanSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;

  const load = useCallback(async () => {
    if (!address) {
      setLoans([]);
      report('userLoans', { loading: false });
      return;
    }
    setLoading(true);
    report('userLoans', { loading: true });
    const step = beginStep({ area: 'dashboard', flow: 'useUserLoans', step: 'scan-known-loans', wallet: address });
    try {
      const me = address.toLowerCase();

      // Three-layer narrowing of `knownLoans` down to the user's
      // loans BEFORE the getLoanDetails multicall fans out. Mirrors
      // useClaimables's fix:
      //
      //   Layer 1 — indexer HTTP (fetchLoansByLender + by-borrower)
      //   Layer 2 — on-chain user-filter view
      //             (getUserDashboardLoans, server-side filtered)
      //   Layer 3 — walk every knownLoan (legacy, last resort)
      //
      // Without this gate, the getLoanDetails multicall payload
      // scaled with every loan in the protocol (a single round-trip
      // but N-sized; ~30-50ms per 100 loans). With it, the payload
      // shrinks to the user's loans (typically 1-5) — same
      // LoanSummary shape, faster paint, less RPC load.
      // Walk-all (knownLoans) is intentionally NOT the default
      // anymore. `getUserDashboardLoans` is authoritative for every
      // loan tracked in `userLoanIds[user]` storage. The secondary-
      // market NFT recipient gap will be closed by the planned
      // `/loans/by-current-holder/{addr}` indexer endpoint; until
      // then, NFT-transferred holders see their loans only after a
      // manual operator rescan. Mirrors the 2026-05-11 decision in
      // useClaimables.
      let walkSet: typeof knownLoans = [];
      let narrowedBy:
        | 'indexer+onchain'
        | 'onchain'
        | 'indexer-only(onchain-failed)'
        | 'failed' = 'failed';
      const idSet = new Set<string>();

      // Indexer `/loans/by-current-holder/:addr` — a cheap HTTP CACHE of the
      // NFT-holder projection (returns null when unreachable). Unioned in below.
      const holderPage = await fetchLoansByCurrentHolder(chain.chainId, address);
      if (holderPage) for (const l of holderPage.loans) idSet.add(String(l.loanId));
      const indexerCount = idSet.size;

      // #749 — AUTHORITATIVE on-chain `getUserPositionLoans` (ERC721Enumerable +
      // `loanIdByPositionTokenId`) read with the USER's OWN RPC. Run ALWAYS and
      // UNIONed with the indexer — NOT only when the indexer returns empty — so a
      // stale or gappy indexer projection can never HIDE a position the wallet
      // currently holds (the indexer is a cache that can only ADD candidates,
      // never be the sole authority). The per-loan `ownerOf` check below then
      // confirms each candidate on-chain. Only if the on-chain read itself fails
      // (old ABI / RPC blip) do we fall back to the indexer-only set rather than
      // dropping the wallet's loans entirely.
      let onchainOk = false;
      try {
        // #769 — paginate: a single unbounded `getUserPositionLoans` loops the
        // whole `balanceOf`, so a wallet griefed with a huge position-NFT
        // inventory could make that one `eth_call` exceed the RPC limit and
        // revert. Each page is O(PAGE)-bounded; the loop runs to COMPLETION
        // (`offset` climbs by `PAGE` toward the contract-reported, finite
        // `totalBalance`, so it terminates) — a page cap is intentionally NOT
        // used, since truncating would re-hide exactly the bloated wallet's real
        // positions this view exists to surface. Total work stays wallet-scoped.
        const PAGE = 200n;
        let offset = 0n;
        for (;;) {
          const [loanIds, , total] = (await publicClient.readContract({
            address: diamondAddress,
            abi: DIAMOND_ABI,
            functionName: 'getUserPositionLoansPaginated',
            args: [address as Address, offset, PAGE],
          })) as readonly [readonly bigint[], readonly bigint[], bigint];
          for (const id of loanIds) idSet.add(String(id));
          offset += PAGE;
          if (offset >= total) break;
        }
        onchainOk = true;
      } catch {
        // #769 — a Diamond that predates the paginated selector (deploy-
        // transition window, or a chain not yet upgraded) reverts the call
        // above. Fall back to the original unbounded `getUserPositionLoans` so
        // the authoritative on-chain layer is preserved for secondary-market
        // holders (it can't bound a deliberately-bloated wallet — the only case
        // the paginated view adds — but for any normal wallet it's correct).
        // Only if THAT also fails do we drop to the indexer-only union.
        try {
          const legacy = (await publicClient.readContract({
            address: diamondAddress,
            abi: DIAMOND_ABI,
            functionName: 'getUserPositionLoans',
            args: [address as Address],
          })) as readonly [readonly bigint[], readonly bigint[]];
          for (const id of legacy[0]) idSet.add(String(id));
          onchainOk = true;
        } catch {
          // both on-chain reads failed — keep the indexer-only union.
        }
      }

      // Build the walk set from the UNION ids — NOT `knownLoans.filter(...)`,
      // which would discard any authoritative on-chain id the browser log index
      // hasn't seen yet (it can lag/fast-forward past the indexer cursor). Reuse
      // the known entry when present; synthesize a minimal one otherwise. The
      // synthetic `lender`/`borrower` are empty, which is safe: an on-chain
      // `getUserPositionLoans` id is a CURRENT holder, so it's matched by the
      // live `ownerOf` (`isCurrentLender`/`Borrower`) below, never the
      // burned-NFT historical fallback that reads those fields (Codex #781).
      const knownById = new Map(knownLoans.map((e) => [String(e.loanId), e]));
      walkSet = [...idSet].map(
        (id) => knownById.get(id) ?? { loanId: BigInt(id), lender: '', borrower: '' },
      );
      narrowedBy = onchainOk
        ? indexerCount > 0
          ? 'indexer+onchain'
          : 'onchain'
        : indexerCount > 0
          ? 'indexer-only(onchain-failed)'
          : 'failed';

      // 1. Batch all getLoanDetails calls in one Multicall3 round-trip.
      const detailCalls = encodeBatchCalls(
        diamondAddress,
        DIAMOND_ABI,
        'getLoanDetails',
        walkSet.map((e) => [e.loanId] as const),
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
      //    `details[i]` corresponds to `walkSet[i]` (the narrowed set),
      //    not `knownLoans[i]`. The historical-fallback below reads
      //    `entry.lender` / `entry.borrower` from the walkSet entry.
      const found: LoanSummary[] = [];
      for (let i = 0; i < details.length; i++) {
        const loan = details[i];
        if (!loan) continue;
        const entry = walkSet[i];
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
          offerId: loan.offerId,
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
          collateralAssetType: Number(loan.collateralAssetType ?? 0n),
          collateralTokenId:
            (loan.collateralTokenId as bigint | undefined) ?? 0n,
          lenderTokenId: loan.lenderTokenId,
          borrowerTokenId: loan.borrowerTokenId,
          allowsPartialRepay:
            (loan.allowsPartialRepay as boolean | undefined) ?? false,
          // PR2 / B.2.2 — per-loan liquidation threshold snapshot.
          // Defaults to 0 on legacy diamonds that don't yet carry
          // the field, in which case the Dashboard's near-
          // liquidation banner stays inert for these loans (the
          // `isNearInternalMatchWindow` helper short-circuits on
          // zero — see `lib/internalMatchSignals.ts`).
          liquidationLtvBpsAtInit: Number(
            (loan.liquidationLtvBpsAtInit as bigint | number | undefined) ?? 0n,
          ),
          // #394 Lever A (Codex #647 round-5) — snapshotted admission HF floor
          // (1e18-scaled bigint); 0n on pre-#394 loans ⇒ gauge defaults to 1.5.
          minHealthFactorAtInit:
            (loan.minHealthFactorAtInit as bigint | undefined) ?? 0n,
        });
      }
      setLoans(found);
      step.success({ note: `${found.length} loans for wallet (narrowed-by=${narrowedBy}, walked=${walkSet.length}/${knownLoans.length})` });
    } catch (err) {
      step.failure(err);
    } finally {
      setLoading(false);
      report('userLoans', { loading: false });
    }
  }, [address, publicClient, knownLoans, getOwner, diamondAddress, chain.chainId, report]);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    await reloadIndex();
    await load();
  }, [reloadIndex, load]);

  return { loans, loading: loading || indexLoading, reload };
}
