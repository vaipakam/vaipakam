import { useCallback, useEffect, useRef, useState } from 'react';
import { type Address } from 'viem';
import {
  useDiamondContract,
  useDiamondPublicClient,
  useReadChain,
} from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
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
   *  frontend can render the connected-app routes unconditionally in that
   *  state. **Only ever true after a SUCCESSFUL read** (see `readOk`) — a
   *  still-loading or errored read leaves this `false` so the gate fails
   *  CLOSED rather than mistaking the unread default version (0) for the
   *  gate-disabled state (#822). */
  hasAccepted: boolean;
  /** True once an on-chain read has completed successfully. While this is
   *  false (initial load, or after a read error) the gate must not open. */
  readOk: boolean;
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
  // #822 — the gate must fail CLOSED until a read actually succeeds. Without
  // this, a read error left `currentVersion` at its default 0, which the
  // gate-disabled check (`currentVersion === 0`) read as "accepted", silently
  // opening the gated routes on any RPC failure.
  const [readOk, setReadOk] = useState(false);
  // #828 r2 — monotonic request counter. Each `reload()` claims the next value;
  // a read that resolves after a newer `reload()` has started is stale (the
  // wallet / chain changed mid-flight) and must NOT apply its result, or it
  // would clobber the current wallet's state with the previous one's.
  const reqSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reqSeq.current;
    // #828 r1 — reset the success flag on every (re)load so that when the
    // connected wallet or read chain changes, the gate can't keep reporting the
    // PREVIOUS wallet's acceptance until the new read lands; it holds closed
    // (verifying) during the transition.
    setReadOk(false);
    setLoading(true);
    setError(null);
    // #828 r1 — no diamond deployed on this chain ⇒ there is no on-chain Terms
    // gate to enforce. Treat as gate-disabled (pass through) rather than leaving
    // `loading` true forever, which would pin the gate on its "verifying" state.
    if (!diamondAddress) {
      setCurrentVersion(0);
      setReadOk(true);
      setLoading(false);
      return;
    }
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
      // #828 r2 — drop a stale in-flight read superseded by a newer reload().
      if (seq !== reqSeq.current) return;
      setCurrentVersion(Number(curr[0]));
      setCurrentHash(curr[1]);
      setUserVersion(Number(user.version));
      setUserHash(user.hash);
      setReadOk(true);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      // Fail CLOSED: drop `readOk` so a stale prior success can't keep the
      // gate open through an RPC outage, and reset the version so nothing
      // downstream mistakes the unread value for a real "gate disabled".
      setReadOk(false);
      setCurrentVersion(0);
      setError((e as Error)?.message ?? 'Failed to read ToS state');
    } finally {
      // Only the current request owns `loading`; a stale one clearing it would
      // prematurely reveal the gate while the live read is still in flight.
      if (seq === reqSeq.current) setLoading(false);
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
  // #822 — gated on `readOk` so the unread/errored default (version 0) is NOT
  // mistaken for the genuine gate-disabled state. Only a SUCCESSFUL read of a
  // real on-chain 0 opens the gate via the disabled branch.
  const hasAccepted =
    readOk &&
    (currentVersion === 0 ||
      (userVersion === currentVersion && userHash === currentHash));

  return {
    hasAccepted,
    readOk,
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
