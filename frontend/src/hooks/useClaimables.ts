import { useEffect, useState, useCallback } from 'react';
import type { Address, PublicClient } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';
import { useLogIndex } from './useLogIndex';
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
  hasRentalNFTReturn?: boolean;
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
      const perLoan = await Promise.all(
        knownLoans.map(async (entry): Promise<ClaimableEntry[]> => {
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
                  const hasRentalNFTReturn = res.hasRentalNFTReturn ?? res[7] ?? false;

                  // Mirror ClaimFacet's actionability guard: fungible amount,
                  // NFT payload (assetType != ERC20), held-for-lender funds,
                  // or a rental NFT awaiting return all count as claimable.
                  const actionable =
                    amount > 0n ||
                    assetType !== AssetType.ERC20 ||
                    heldForLender > 0n ||
                    hasRentalNFTReturn;
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
      step.success({ note: `${found.length} claimable entries` });
    } catch (err) {
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [address, publicClient, diamondAddress, knownLoans, getOwner]);

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
