import { useEffect, useState, useCallback } from 'react';
import type { Address, PublicClient } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';
import { useLogIndex } from './useLogIndex';
import { fetchLoansByCurrentHolder } from '../lib/indexerClient';
import {
  AssetType,
  LoanStatus,
  type ClaimableEntry,
  type LoanDetails,
  type LoanRole,
} from '../types/loan';
import { beginStep } from '../lib/journeyLog';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Matches the `getClaimable(loanId, isLender)` return tuple. viem returns
// the struct as a named-object (not the ethers positional-or-named mix),
// so we accept both shapes defensively — older ABIs that predate the
// named-output fields will still have positional access.
interface ClaimableTuple {
  asset?: string;
  amount?: bigint;
  claimed?: boolean;
  assetType?: bigint;
  tokenId?: bigint;
  quantity?: bigint;
  heldForLender?: bigint;
  hasRentalNftReturn?: boolean;
  0?: string;
  1?: bigint;
  2?: boolean;
  3?: bigint;
  4?: bigint;
  5?: bigint;
  6?: bigint;
  7?: boolean;
}

/**
 * Walks the event-indexed loan list and surfaces loans where `address` holds
 * a Vaipakam position NFT with unclaimed funds. A single user may hold both
 * the lender and borrower NFT for the same loan (common after secondary-
 * market moves), so we probe each qualifying side independently. NFT
 * ownership is resolved from the Transfer-event cache first; only
 * un-indexed tokens fall through to a live `ownerOf` call.
 */
export function useClaimables(address: string | null) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  const { loans: knownLoans, getOwner, loading: indexLoading, reload: reloadIndex } = useLogIndex();
  const [claims, setClaims] = useState<ClaimableEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!address) {
      setClaims([]);
      return;
    }
    setLoading(true);
    const step = beginStep({ area: 'claim', flow: 'useClaimables', step: 'scan-claimables', wallet: address });
    try {
      const me = address.toLowerCase();

      // Three-layer fallback to narrow `knownLoans` (all loans
      // system-wide) down to JUST the user's loans before the
      // per-loan RPC fan-out below.
      //
      //   Layer 1 — indexer HTTP: fetchLoansByLender +
      //             fetchLoansByBorrower. Cheapest (single HTTP call
      //             each, parallel; ~50-100ms total). Returns null
      //             when the Worker is unreachable.
      //   Layer 2 — on-chain `getUserDashboardClaimables`: the
      //             MetricsDashboardFacet view that paginates the
      //             user's claimable loan IDs server-side. One
      //             multicall via readContract; cheap (~200ms) and
      //             does NOT depend on the indexer. Returns the same
      //             loan-ID set the indexer would, just via the
      //             chain directly.
      //   Layer 3 — walk every `knownLoan` (legacy, last resort):
      //             only fires when both indexer AND on-chain user-
      //             filter view fail. Preserves correctness on the
      //             worst-case "indexer down + Diamond upgrade
      //             dropped the view" path.
      //
      // The N×RPC fan-out below stays unchanged; we just gate it on
      // a much smaller `walkSet` whenever Layer 1 or Layer 2
      // succeeds — typically 1-5 loans for an active user vs.
      // 40-80+ system-wide.
      // Walk-all (knownLoans) is intentionally NOT the default
      // anymore. `getUserDashboardClaimables` is authoritative for
      // every loan tracked in `userLoanIds[user]` storage; the only
      // gap is secondary-market NFT recipients, which is a tomorrow-
      // PR concern (server-side `/loans/by-current-holder/{addr}`
      // indexer endpoint). 2026-05-11 decision: drop the walk-all
      // auto-fallback in hooks that HAVE an on-chain user-filter
      // view. Layer 2 error → empty result + error in diagnostics
      // drawer; operator's Rescan button (or page refresh) re-runs
      // the same chain.
      let walkSet: typeof knownLoans = [];
      let narrowedBy:
        | 'indexer+onchain'
        | 'onchain'
        | 'indexer-only(onchain-failed)'
        | 'failed' = 'failed';
      const idSet = new Set<string>();

      // Indexer `/loans/by-current-holder/:addr` — a cheap HTTP CACHE of the
      // NFT-holder projection (lender_current_owner / borrower_current_owner;
      // returns null when unreachable). Unioned in below.
      const holderPage = await fetchLoansByCurrentHolder(chain.chainId, address);
      if (holderPage) for (const l of holderPage.loans) idSet.add(String(l.loanId));
      const indexerCount = idSet.size;

      // #749 — AUTHORITATIVE on-chain `getUserPositionLoans` (ERC721Enumerable +
      // the `loanIdByPositionTokenId` reverse map) read with the USER's OWN RPC.
      // Run ALWAYS and UNIONed with the indexer — NOT only when the indexer
      // returns empty — so a stale or gappy indexer projection can never HIDE a
      // CLAIMABLE the wallet currently holds (real funds). The indexer is a cache
      // that can only ADD candidates; the per-loan on-chain `ownerOf` +
      // `getClaimable` checks below are the authoritative confirmation. Only if
      // the on-chain read itself fails do we fall back to the indexer-only set.
      let onchainOk = false;
      try {
        const result = (await publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getUserPositionLoans',
          args: [address as Address],
        })) as readonly [readonly bigint[], readonly bigint[]];
        // result[0] = loanIds, result[1] = tokenIds (aligned); we only need
        // the loan-id set for narrowing the per-loan fan-out below.
        for (const id of result[0]) idSet.add(String(id));
        onchainOk = true;
      } catch {
        // on-chain read failed (old ABI / RPC blip) — keep the indexer-only union.
      }

      walkSet = knownLoans.filter((e) => idSet.has(String(e.loanId)));
      narrowedBy = onchainOk
        ? indexerCount > 0
          ? 'indexer+onchain'
          : 'onchain'
        : indexerCount > 0
          ? 'indexer-only(onchain-failed)'
          : 'failed';

      const perLoan = await Promise.all(
        walkSet.map(async (entry): Promise<ClaimableEntry[]> => {
          try {
            const loan = (await publicClient.readContract({
              address: diamondAddress,
              abi: DIAMOND_ABI,
              functionName: 'getLoanDetails',
              args: [entry.loanId],
            })) as LoanDetails;
            const [lenderHolder, borrowerHolder] = await Promise.all([
              resolveOwner(publicClient, diamondAddress, loan.lenderTokenId, getOwner),
              resolveOwner(publicClient, diamondAddress, loan.borrowerTokenId, getOwner),
            ]);
            const isLender = lenderHolder === me;
            const isBorrower = borrowerHolder === me;
            if (!isLender && !isBorrower) return [];

            const status = Number(loan.status) as LoanStatus;
            if (status === LoanStatus.Active) return [];

            const sides: Array<{ isLender: boolean; role: LoanRole }> = [];
            if (isLender) sides.push({ isLender: true, role: 'lender' });
            if (isBorrower) sides.push({ isLender: false, role: 'borrower' });

            // Phase 5 — probe the borrower LIF rebate lane once per loan
            // (lender side never carries it). `getBorrowerLifRebate` returns
            // `(rebateAmount, vpfiHeld)`; rebateAmount > 0 means a proper
            // settlement credited a claimable VPFI rebate for the borrower
            // NFT holder that will be paid out inside `claimAsBorrower`.
            let borrowerLifRebate = 0n;
            if (isBorrower) {
              try {
                const rebate = (await publicClient.readContract({
                  address: diamondAddress,
                  abi: DIAMOND_ABI,
                  functionName: 'getBorrowerLifRebate',
                  args: [entry.loanId],
                })) as readonly [bigint, bigint] | { rebateAmount?: bigint };
                if (Array.isArray(rebate)) {
                  borrowerLifRebate = rebate[0] ?? 0n;
                } else if (rebate && typeof rebate === 'object') {
                  borrowerLifRebate = (rebate as { rebateAmount?: bigint }).rebateAmount ?? 0n;
                }
              } catch {
                // Old ABI without Phase 5 view — treat as zero rebate.
                borrowerLifRebate = 0n;
              }
            }

            const sideEntries = await Promise.all(
              sides.map(async (s): Promise<ClaimableEntry | null> => {
                try {
                  const res = (await publicClient.readContract({
                    address: diamondAddress,
                    abi: DIAMOND_ABI,
                    functionName: 'getClaimable',
                    args: [entry.loanId, s.isLender],
                  })) as ClaimableTuple;
                  const asset = res.asset ?? res[0] ?? '';
                  const amount = res.amount ?? res[1] ?? 0n;
                  const claimed = res.claimed ?? res[2] ?? false;
                  const assetType = Number(res.assetType ?? res[3] ?? 0n) as AssetType;
                  const tokenId = res.tokenId ?? res[4] ?? 0n;
                  const quantity = res.quantity ?? res[5] ?? 0n;
                  const heldForLender = res.heldForLender ?? res[6] ?? 0n;
                  const hasRentalNftReturn = res.hasRentalNftReturn ?? res[7] ?? false;
                  const lifRebate = s.role === 'borrower' ? borrowerLifRebate : 0n;

                  // Mirror ClaimFacet's actionability guard: fungible amount,
                  // NFT payload (assetType != ERC20), held-for-lender funds,
                  // a rental NFT awaiting return, or (Phase 5) a pending
                  // borrower LIF rebate all count as claimable.
                  const actionable =
                    amount > 0n ||
                    assetType !== AssetType.ERC20 ||
                    heldForLender > 0n ||
                    hasRentalNftReturn ||
                    lifRebate > 0n;
                  if (!claimed && actionable) {
                    return {
                      loanId: entry.loanId,
                      role: s.role,
                      status,
                      claimableAmount: amount,
                      claimableAsset: asset,
                      assetType,
                      tokenId,
                      quantity,
                      heldForLender,
                      lifRebate,
                    };
                  }
                  return null;
                } catch {
                  // this side not claimable — skip
                  return null;
                }
              }),
            );
            return sideEntries.filter((e): e is ClaimableEntry => e !== null);
          } catch {
            // Skip individual failures — don't let one bad loan kill the list.
            return [];
          }
        }),
      );
      const found = perLoan.flat();
      setClaims(found);
      step.success({ note: `${found.length} claimable entries (narrowed-by=${narrowedBy}, walked=${walkSet.length}/${knownLoans.length})` });
    } catch (err) {
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [address, publicClient, diamondAddress, knownLoans, getOwner, chain.chainId]);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => {
    await reloadIndex();
    await load();
  }, [reloadIndex, load]);

  return { claims, loading: loading || indexLoading, reload };
}

async function resolveOwner(
  publicClient: PublicClient,
  diamondAddress: Address,
  tokenId: bigint,
  getOwner: (id: bigint) => string | null,
): Promise<string> {
  const cached = getOwner(tokenId);
  if (cached) return cached;
  try {
    const live = (await publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    })) as string;
    return (live ?? ZERO_ADDRESS).toLowerCase();
  } catch {
    return ZERO_ADDRESS;
  }
}
