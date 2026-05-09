import { useCallback, useEffect, useState } from 'react';
import { type Address } from 'viem';
import {
  useDiamondContract,
  useDiamondPublicClient,
  useReadChain,
} from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM } from '../contracts/abis';
import { useWallet } from '../context/WalletContext';
import { beginStep } from '../lib/journeyLog';

/**
 * On-chain Terms-of-Service gating.
 *
 * Reads the current protocol ToS version + hash from {LegalFacet}, reads
 * the connected wallet's own acceptance record, and derives whether the
 * wallet has accepted the current version. `accept()` submits an
 * `acceptTerms(version, hash)` tx using the current on-chain values.
 *
 * Gate disabled until governance installs a version: when the on-chain
 * `currentTosVersion` is zero, every wallet is implicitly accepted so the
 * frontend can ship the gating path live but inert.
 */
export interface TosAcceptanceState {
  /** True iff the wallet has accepted the current on-chain ToS version.
   *  Also true when the gate is disabled (currentTosVersion == 0) so the
   *  frontend can render `/app` routes unconditionally in that state. */
  hasAccepted: boolean;
  /** Current in-force ToS version. 0 means the gate is disabled. */
  currentVersion: number;
  /** Current in-force ToS content hash. */
  currentHash: `0x${string}`;
  /** The wallet's own recorded version (0 if never accepted). */
  userVersion: number;
  /** True while the initial read is in flight. */
  loading: boolean;
  /** Last error surfaced by a read or write. */
  error: string | null;
  /** Submit an `acceptTerms` tx against the current on-chain version. */
  accept: () => Promise<void>;
  /** Re-read the on-chain state (e.g. after accepting). */
  reload: () => Promise<void>;
  /** True while an accept tx is in flight. */
  submitting: boolean;
}

const ZERO_HASH = `0x${'0'.repeat(64)}` as const;

export function useTosAcceptance(): TosAcceptanceState {
  const { address } = useWallet();
  const publicClient = useDiamondPublicClient();
  const diamond = useDiamondContract();
  const chain = useReadChain();
  const diamondAddress = chain.diamondAddress as Address | null;

  const [currentVersion, setCurrentVersion] = useState(0);
  const [currentHash, setCurrentHash] = useState<`0x${string}`>(ZERO_HASH);
  const [userVersion, setUserVersion] = useState(0);
  const [userHash, setUserHash] = useState<`0x${string}`>(ZERO_HASH);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(async () => {
    if (!diamondAddress) return;
    setLoading(true);
    setError(null);
    try {
      const [curr, user] = await Promise.all([
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getCurrentTos',
        }) as Promise<readonly [number, `0x${string}`]>,
        address
          ? (publicClient.readContract({
              address: diamondAddress,
              abi: DIAMOND_ABI_VIEM,
              functionName: 'getUserTosAcceptance',
              args: [address as Address],
            }) as Promise<{
              version: number;
              hash: `0x${string}`;
              acceptedAt: bigint;
            }>)
          : Promise.resolve({
              version: 0,
              hash: ZERO_HASH,
              acceptedAt: 0n,
            }),
      ]);
      setCurrentVersion(Number(curr[0]));
      setCurrentHash(curr[1]);
      setUserVersion(Number(user.version));
      setUserHash(user.hash);
    } catch (e) {
      setError((e as Error)?.message ?? 'Failed to read ToS state');
    } finally {
      setLoading(false);
    }
  }, [publicClient, diamondAddress, address]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const accept = useCallback(async () => {
    if (!address || !diamond) return;
    if (currentVersion === 0) return; // gate disabled; nothing to sign
    setError(null);
    setSubmitting(true);
    const step = beginStep({
      area: 'profile',
      flow: 'acceptTerms',
      step: 'submit-tx',
      wallet: address,
    });
    try {
      const tx = await (
        diamond as unknown as {
          acceptTerms: (
            v: number,
            h: `0x${string}`,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).acceptTerms(currentVersion, currentHash);
      await tx.wait();
      step.success({ note: `version=${currentVersion}` });
      await reload();
    } catch (e) {
      setError((e as Error)?.message ?? 'Acceptance failed');
      step.failure(e);
    } finally {
      setSubmitting(false);
    }
  }, [address, diamond, currentVersion, currentHash, reload]);

  // Gate disabled (currentVersion=0) → everyone is accepted.
  // Otherwise: user version + hash must both match current.
  const hasAccepted =
    currentVersion === 0 ||
    (userVersion === currentVersion && userHash === currentHash);

  return {
    hasAccepted,
    currentVersion,
    currentHash,
    userVersion,
    loading,
    error,
    accept,
    reload,
    submitting,
  };
}
