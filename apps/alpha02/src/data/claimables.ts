/**
 * On-chain-authoritative claimables (issue #921 item 7 / #958).
 *
 * alpha02 previously read the indexer's `/claimables` endpoint and
 * merged `fallback_pending` lender loans back client-side — because the
 * endpoint lists only terminal statuses, and the indexer deliberately
 * does NOT mirror `FallbackPending` (it's transient/reversible). Rather
 * than push reversible state onto shared indexer infra apps/defi also
 * reads, this matches apps/defi's `useClaimables`: the indexer stays the
 * fast approximate candidate layer (via `useMyLoans`), and the chain is
 * the authority for what is actually collectable.
 *
 * Per candidate loan we confirm on-chain: the wallet still HOLDS that
 * side's position NFT (`ownerOf`), and `getClaimable(loanId, isLender)`
 * reports an unclaimed, actionable payout (mirroring ClaimFacet's own
 * actionability guard, incl. the Phase-5 borrower LIF rebate). A
 * `fallback_pending` lender loan surfaces naturally — `getClaimable`
 * reports the recoverable collateral the claim-time fallback resolves —
 * so the client-side special-case merge is gone.
 *
 * Honesty contract preserved: a per-loan REVERT means "not claimable
 * this side" (exclude); a TRANSPORT failure means "couldn't confirm" and
 * collapses the whole result to `null` (unavailable) rather than a
 * confident short list that hides real, collectable funds.
 *
 * Known parity gap vs apps/defi (deliberate, tracked): the candidate set
 * is the wallet's own loans (`useMyLoans`, keyed on original
 * lender/borrower). A pure secondary-market BUYER — holding a position
 * NFT for a loan it was never an original party to — is not yet
 * discovered here; apps/defi unions an on-chain `getUserPositionLoans`
 * enumeration for that. The current code had the same gap, so this is
 * not a regression; adding the on-chain enumeration is a follow-up.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { AssetType } from '../lib/types';
import { useMyLoans, type PositionLoan } from './hooks';

const REFRESH_MS = 30_000;

/** `getClaimable(loanId, isLender)` return — accept named-object OR
 *  positional shape defensively (older ABIs predate the named fields). */
interface ClaimableTuple {
  amount?: bigint;
  claimed?: boolean;
  assetType?: bigint;
  heldForLender?: bigint;
  hasRentalNftReturn?: boolean;
  1?: bigint;
  2?: boolean;
  3?: bigint;
  6?: bigint;
  7?: boolean;
}

/** True when a failed read is a contract REVERT / empty-data (an
 *  authoritative "no" — e.g. a burned position NFT or a not-claimable
 *  side) rather than a transport error. */
function isRevert(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    (e.walk((x) => x instanceof ContractFunctionRevertedError) !== null ||
      e.walk((x) => x instanceof ContractFunctionZeroDataError) !== null)
  );
}

/** Claimable loans for the connected wallet, tagged with role.
 *  `undefined` = loading, `null` = unavailable (never a partial list). */
export function useMyClaimables() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const loans = useMyLoans();
  const diamond = readChain.diamondAddress;

  return useQuery({
    // Re-derive whenever the candidate loan set refreshes so a newly
    // terminal loan is confirmed on the next tick.
    queryKey: [
      'claimables',
      readChain.chainId,
      address?.toLowerCase(),
      loans.dataUpdatedAt,
    ],
    enabled: Boolean(address) && loans.data !== undefined,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<PositionLoan[] | null> => {
      if (!address) return [];
      // Candidate source (indexer) unavailable, or no RPC to confirm
      // against → unavailable, never a confident empty/partial list.
      // (`enabled` already gates on defined data; the `== null` check
      // covers both the null "unavailable" contract and narrows the type.)
      if (loans.data == null) return null;
      if (!publicClient) return null;

      const me = address.toLowerCase();
      // Fast approximate layer: the wallet's loans, minus Active (a live
      // loan has nothing to claim yet). `getClaimable` is the authority.
      const candidates = loans.data.filter((l) => l.status !== 'active');

      let transportFailed = false;

      const confirmed = await Promise.all(
        candidates.map(async (loan): Promise<PositionLoan | null> => {
          const isLender = loan.role === 'lender';
          const tokenId = isLender ? loan.lenderTokenId : loan.borrowerTokenId;

          // 1. Does the wallet still hold this side's position NFT? A
          //    sold position isn't ours to claim; a burned one (revert)
          //    means the loan fully settled — nothing to claim either.
          try {
            const owner = (await publicClient.readContract({
              address: diamond,
              abi: DIAMOND_ABI_VIEM,
              functionName: 'ownerOf',
              args: [BigInt(tokenId)],
            })) as string;
            if (owner.toLowerCase() !== me) return null;
          } catch (e) {
            if (isRevert(e)) return null;
            transportFailed = true;
            return null;
          }

          // 2. Authoritative claimable probe + Phase-5 borrower rebate.
          try {
            const res = (await publicClient.readContract({
              address: diamond,
              abi: DIAMOND_ABI_VIEM,
              functionName: 'getClaimable',
              args: [BigInt(loan.loanId), isLender],
            })) as ClaimableTuple;
            const amount = res.amount ?? res[1] ?? 0n;
            const claimed = res.claimed ?? res[2] ?? false;
            const assetType = Number(res.assetType ?? res[3] ?? 0n);
            const heldForLender = res.heldForLender ?? res[6] ?? 0n;
            const hasRentalNftReturn = res.hasRentalNftReturn ?? res[7] ?? false;

            let lifRebate = 0n;
            if (!isLender) {
              try {
                const rebate = (await publicClient.readContract({
                  address: diamond,
                  abi: DIAMOND_ABI_VIEM,
                  functionName: 'getBorrowerLifRebate',
                  args: [BigInt(loan.loanId)],
                })) as readonly [bigint, bigint] | { rebateAmount?: bigint };
                lifRebate = Array.isArray(rebate)
                  ? (rebate[0] ?? 0n)
                  : ((rebate as { rebateAmount?: bigint }).rebateAmount ?? 0n);
              } catch (e) {
                // Old ABI without the Phase-5 view reverts → treat as no
                // rebate; a transport error is a real "couldn't confirm".
                if (!isRevert(e)) transportFailed = true;
              }
            }

            // Mirror ClaimFacet's actionability guard.
            const actionable =
              amount > 0n ||
              assetType !== AssetType.ERC20 ||
              heldForLender > 0n ||
              hasRentalNftReturn ||
              lifRebate > 0n;
            return !claimed && actionable ? loan : null;
          } catch (e) {
            if (isRevert(e)) return null;
            transportFailed = true;
            return null;
          }
        }),
      );

      // Any unconfirmable candidate ⇒ unavailable, not a short list.
      if (transportFailed) return null;
      return confirmed.filter((l): l is PositionLoan => l !== null);
    },
  });
}
