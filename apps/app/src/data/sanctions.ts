/**
 * Sanctions screening read — `ProfileFacet.isSanctionedAddress(who)`.
 * FAIL-OPEN when it has NO ANSWER (matches the contract's posture: no
 * oracle configured or oracle outage → not flagged), though a failed
 * refresh keeps the last answer it had, and NOT fail-open on
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

/** How often the check re-reads, flagged or not. A flag can be added (an
 *  operator flags the wallet or the sender it declared during recovery) or
 *  cleared (an operator clears it, a list's provider delists it), and the
 *  banner and every blocked action hang off this answer, so it is re-read on
 *  this cycle rather than held until a reload. The banner's attribution
 *  refreshes on the same cycle, so the two cannot drift apart for longer than
 *  one of them. */
export const SANCTIONS_REFRESH_MS = 30_000;

export function useSanctionsCheck(): SanctionsState {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data, isFetched } = useQuery({
    queryKey: ['sanctions', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address) && Boolean(publicClient),
    staleTime: SANCTIONS_REFRESH_MS,
    refetchInterval: SANCTIONS_REFRESH_MS,
    // A failed read settles the check at once (no retry delay before `ready`)
    // and is retried on the next cycle instead.
    retry: false,
    // A failed read THROWS rather than answering `false`, so it never
    // overwrites an answer: a failed refresh keeps the last answer the oracle
    // gave (a known flag stays up through an outage; nothing is read as a
    // delisting), and only a check that has never been answered falls open.
    queryFn: async (): Promise<boolean> =>
      (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'isSanctionedAddress',
        args: [address!],
      })) as boolean,
  });

  if (!address) return { flagged: false, ready: true };
  // Fail open on ERRORS only: no answer yet after a settled (failed) read.
  return { flagged: data ?? false, ready: isFetched };
}

/** LIVE submit-time re-read. The hook above re-reads every
 *  {@link SANCTIONS_REFRESH_MS} — a wallet flagged inside that window would
 *  still see enabled buttons
 *  and could mine an approval before the contract's SanctionedAddress
 *  revert. Call this in submit paths BEFORE any approval; throws the
 *  user-facing message when flagged. Fail-open on read errors, same
 *  posture as the contract (oracle outage ≠ flagged); the hook differs only in
 *  keeping an answer it already has through a failed refresh. */
export async function assertWalletNotSanctionedLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  wallet: `0x${string}`,
  opts?: {
    /** Fail CLOSED on read errors. Use for paths where this UI check
     *  is the ONLY enforcement (no on-chain screen — e.g. the
     *  interaction-rewards claim): an unreadable oracle must block,
     *  not wave through. Default false = fail-open, matching the
     *  contract's own posture for paths it screens itself. */
    failClosed?: boolean;
  },
): Promise<void> {
  let flagged: boolean;
  try {
    flagged = (await publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'isSanctionedAddress',
      args: [wallet],
    })) as boolean;
  } catch (err) {
    if (opts?.failClosed) {
      throw new Error(copy.errors.sanctionsCheckRetry);
    }
    flagged = false; // fail-open: contract still screens this path
    void err;
  }
  if (flagged) {
    throw new Error(copy.errors.sanctionsBlocked);
  }
}
