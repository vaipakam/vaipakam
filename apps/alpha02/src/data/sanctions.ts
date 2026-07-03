/**
 * Sanctions screening read — `ProfileFacet.isSanctionedAddress(who)`.
 * FAIL-OPEN on ERRORS (matches the contract's posture: no oracle
 * configured or oracle outage → not flagged), but NOT fail-open on
 * LOADING: `ready` is false until the read settles, and write flows
 * hold their checklist pending — otherwise a genuinely flagged wallet
 * could sign an approval in the pre-read window and only then hit the
 * contract's SanctionedAddress revert.
 *
 * The full banner copy is shown ONLY to a flagged wallet — never on
 * marketing surfaces (retail-deploy policy in CLAUDE.md).
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { copy } from '../content/copy';

export interface SanctionsState {
  flagged: boolean;
  /** True once the check settled (or no wallet is connected). */
  ready: boolean;
}

export function useSanctionsCheck(): SanctionsState {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data, isFetched } = useQuery({
    queryKey: ['sanctions', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address) && Boolean(publicClient),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<boolean> => {
      try {
        return (await publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'isSanctionedAddress',
          args: [address!],
        })) as boolean;
      } catch {
        return false; // fail open on ERRORS only
      }
    },
  });

  if (!address) return { flagged: false, ready: true };
  return { flagged: data ?? false, ready: isFetched };
}

/** LIVE submit-time re-read. The hook above caches for five minutes —
 *  a wallet flagged inside that window would still see enabled buttons
 *  and could mine an approval before the contract's SanctionedAddress
 *  revert. Call this in submit paths BEFORE any approval; throws the
 *  user-facing message when flagged. Fail-open on read errors, same
 *  posture as the hook and the contract (oracle outage ≠ flagged). */
export async function assertWalletNotSanctionedLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  wallet: `0x${string}`,
): Promise<void> {
  const flagged = await publicClient
    .readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'isSanctionedAddress',
      args: [wallet],
    })
    .catch(() => false);
  if (flagged) {
    throw new Error(copy.errors.sanctionsBlocked);
  }
}
