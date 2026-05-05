/**
 * Live-tail watermark probe.
 *
 * One cheap `eth_call` per tick (`MetricsFacet.getGlobalCounts()`)
 * fingerprints the lifetime offer + loan id sequences. Both numbers are
 * strictly increasing on create events, so a tick where neither moves
 * means no new offers / loans landed since the previous tick — and the
 * subscriber data hooks can skip the heavier indexer + RPC catch-up
 * refetch entirely. That gates the 5s cadence so it stays cheap on RPC.
 *
 * Reads with `blockTag: 'safe'` to avoid reorg flicker — a head-of-chain
 * read could see a counter advance briefly during a one-block reorg and
 * trigger a refetch that's then immediately stale.
 *
 * Pauses on `document.hidden` — when the user switches tabs we stop
 * polling entirely. On re-focus we fire one immediate probe so freshly-
 * focused tabs hydrate without waiting up to 5 s.
 *
 * Cancels / partial-fills are NOT caught by this watermark (lifetime
 * counters don't move on those state transitions). They're covered by:
 *   - the user's own action: the post-tx `useWaitForTransactionReceipt`
 *     hook's success callback fires `refetch()` on the relevant data
 *     query, picking up the change immediately;
 *   - other users' actions: the tab-focus probe forces a fresh indexer
 *     hit, and the indexer's own cron loop catches it within ~60 s;
 *   - shared state truth-up: every tick where the watermark DID move
 *     also re-pulls the active set, which naturally drops cancelled /
 *     filled rows.
 *
 * Returns a monotonically-increasing `version` integer that bumps every
 * time either counter advances — that's the dependency subscribers list
 * in their useEffect to drive their own refetch logic.
 */

import { useEffect, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { type Abi, type Address, type PublicClient } from 'viem';
import { useReadChain } from '../contracts/useDiamond';

const TICK_MS = 5_000;

/** Minimal ABI surface for the watermark probe. Inlined so the hook
 *  doesn't have to import the full MetricsFacet bundle just to call one
 *  function. The signature must match the on-chain selector exactly:
 *  `getGlobalCounts() returns (uint256 totalLoansCreated, uint256 totalOffersCreated)`. */
const WATERMARK_ABI = [
  {
    type: 'function',
    name: 'getGlobalCounts',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'totalLoansCreated', type: 'uint256' },
      { name: 'totalOffersCreated', type: 'uint256' },
    ],
  },
] as const satisfies Abi;

export interface WatermarkSnapshot {
  /** Lifetime offer count — `s.nextOfferId` on-chain. */
  nextOfferId: bigint;
  /** Lifetime loan count — `s.nextLoanId` on-chain. */
  nextLoanId: bigint;
  /** Last `safe`-tag block at which the probe last succeeded. Subscribers
   *  use this as the upper bound of their RPC catch-up windows so the
   *  catch-up doesn't read past the tip and pick up a soon-to-reorg log. */
  safeBlock: bigint;
  /** UNIX seconds — when the probe completed. */
  fetchedAt: number;
}

export type WatermarkStatus = 'idle' | 'live' | 'unreachable';

export interface UseLiveWatermarkResult {
  /** Bumps every time the probe sees either counter advance. Subscribers
   *  list this in their useEffect deps to refetch their data set. Also
   *  bumps once on initial mount so first-paint subscribers fire. */
  version: number;
  /** Latest watermark observation, or `null` while we haven't completed
   *  a successful probe yet. */
  snapshot: WatermarkSnapshot | null;
  /** Probe health. `unreachable` means the diamond / RPC isn't responding
   *  — subscribers should fall back to whatever they did pre-watermark
   *  (e.g. plain indexer poll without RPC catch-up). */
  status: WatermarkStatus;
}

/**
 * Hook signature is intentionally argument-less. It reads the public
 * client + chain config from context so any number of subscribers can
 * call it from anywhere in the tree without prop drilling. The probe is
 * still made per-call rather than via a singleton — at a 5s cadence the
 * cost is negligible and per-instance state simplifies cleanup on
 * unmount / chain switch.
 */
export function useLiveWatermark(): UseLiveWatermarkResult {
  const publicClient = usePublicClient();
  const chain = useReadChain();
  const diamond = chain.diamondAddress;

  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<WatermarkSnapshot | null>(null);
  const [status, setStatus] = useState<WatermarkStatus>('idle');
  const lastProbeRef = useRef<{ nextOfferId: bigint; nextLoanId: bigint } | null>(null);

  useEffect(() => {
    if (!publicClient || !diamond) {
      setSnapshot(null);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function probe(): Promise<void> {
      try {
        const result = (await publicClient!.readContract({
          address: diamond as Address,
          abi: WATERMARK_ABI,
          functionName: 'getGlobalCounts',
          blockTag: 'safe',
        })) as readonly [bigint, bigint];
        if (cancelled) return;
        const [nextLoanId, nextOfferId] = result;
        // Read the safe block separately so subscribers know the upper
        // bound of the just-observed counters. A head-tag read here would
        // be racy with the watermark (counters at `safe`, block at
        // `latest`) and the subscribers' RPC catch-ups could miss events
        // sitting in the head→safe gap.
        const safeBlock = await publicClient!.getBlock({ blockTag: 'safe' });
        if (cancelled) return;
        const last = lastProbeRef.current;
        const advanced =
          last === null ||
          nextOfferId !== last.nextOfferId ||
          nextLoanId !== last.nextLoanId;
        lastProbeRef.current = { nextOfferId, nextLoanId };
        // Only push a new snapshot reference when something subscribers
        // actually use changed. Without this, the safeBlock advancing
        // every block (~12 s on Sepolia) churned the snapshot ref every
        // probe, which propagated through any consumer using `snapshot`
        // in a useEffect / useCallback dep list — even when neither
        // counter advanced. Subscribers that need the freshest
        // safeBlock at refetch time should read it via a ref pattern;
        // this state is for components that want React-reactive
        // updates only when the values they observe meaningfully
        // changed.
        setSnapshot((prev) => {
          if (
            prev &&
            prev.nextOfferId === nextOfferId &&
            prev.nextLoanId === nextLoanId &&
            prev.safeBlock === safeBlock.number
          ) {
            return prev;
          }
          return {
            nextOfferId,
            nextLoanId,
            safeBlock: safeBlock.number,
            fetchedAt: Math.floor(Date.now() / 1000),
          };
        });
        setStatus('live');
        if (advanced) setVersion((v) => v + 1);
      } catch {
        // Diamond unreachable / RPC erroring out — flag and let the
        // tick loop retry. We intentionally do NOT bump `version` here;
        // subscribers stay on whatever data they last hydrated.
        if (!cancelled) setStatus('unreachable');
      }
    }

    function schedule(): void {
      if (cancelled) return;
      if (document.hidden) return; // paused while tab is hidden
      timer = setTimeout(async () => {
        await probe();
        schedule();
      }, TICK_MS);
    }

    function onVisibility(): void {
      if (document.hidden) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      // Re-focused: fire an immediate probe + restart the loop.
      void probe().then(() => {
        if (!cancelled) schedule();
      });
    }

    void probe().then(() => {
      if (!cancelled) schedule();
    });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [publicClient, diamond]);

  return { version, snapshot, status };
}

/** Imperative one-shot watermark fetch. Useful inside event handlers
 *  (e.g. post-tx callbacks) where the caller wants to advance the
 *  watermark immediately rather than wait for the next 5 s tick. */
export async function probeWatermarkOnce(
  publicClient: PublicClient,
  diamond: Address,
): Promise<WatermarkSnapshot | null> {
  try {
    const [counts, block] = await Promise.all([
      publicClient.readContract({
        address: diamond,
        abi: WATERMARK_ABI,
        functionName: 'getGlobalCounts',
        blockTag: 'safe',
      }),
      publicClient.getBlock({ blockTag: 'safe' }),
    ]);
    const [nextLoanId, nextOfferId] = counts as readonly [bigint, bigint];
    return {
      nextOfferId,
      nextLoanId,
      safeBlock: block.number,
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  } catch {
    return null;
  }
}
