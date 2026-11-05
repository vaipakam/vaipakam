import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPublicClient, toFunctionSelector, type Abi } from 'viem';
import { useAccount } from 'wagmi';
import { DiamondLoupeFacetABI } from '@vaipakam/contracts/abis';
import { DEFAULT_CHAIN, getSupportedChain } from '../../chain/chains';
import { httpTransports } from '../../chain/wagmi';
import type { ChainCapabilities } from './types';

/** The one `facets()` read the loupe offers, typed from the exported ABI. */
const LOUPE_ABI = DiamondLoupeFacetABI as Abi;

/** How long a snapshot is trusted before it is re-read: a facet refresh
 *  changes the routed set, and the app re-reads it rather than failing on a
 *  missing function (ACC-65, rulebook §5). */
export const SNAPSHOT_TTL_MS = 10 * 60_000;
/** How soon a FAILED read is retried: a transient RPC failure must not leave
 *  the capability line unreadable for the life of the tab. */
export const RETRY_MS = 30_000;

/** When the next read is due after a read that succeeded or failed. */
export function nextReadDelayMs(failed: boolean): number {
  return failed ? RETRY_MS : SNAPSHOT_TTL_MS;
}

interface CapabilityContextValue {
  /** The active chain's snapshot, `null` until the first read completes. */
  caps: ChainCapabilities | null;
  /** The snapshot has passed its expiry (or a retry is due) and a re-read is
   *  in flight; the surface says so rather than presenting it as current. */
  stale: boolean;
  /** The chain the snapshot describes (the wallet's, else the default). */
  chainId: number;
  /** A read failure, stated rather than swallowed. */
  error: string | null;
}

const CapabilityContext = createContext<CapabilityContextValue | null>(null);

function unknownServices(): Record<string, 'unknown'> {
  // Every service the matrix names starts as unknown. Later PRs replace the
  // value with a read (indexer /health, agent /health, proxy probe); a key
  // never read stays unknown and the surface says so.
  return {
    indexer: 'unknown',
    pushRail: 'unknown',
    rpcProxy: 'unknown',
    listingExecutor: 'unknown',
    alertsTelegram: 'unknown',
    alertsPush: 'unknown',
    keeperHealth: 'unknown',
  };
}

interface Snapshot {
  chainId: number;
  /** The read generation that produced this snapshot. */
  generation: number;
  caps: ChainCapabilities | null;
  error: string | null;
}

export function CapabilityProvider({ children }: { children: ReactNode }) {
  const { chainId: walletChainId } = useAccount();
  const chain = getSupportedChain(walletChainId) ?? DEFAULT_CHAIN;
  // The snapshot is keyed by the chain it describes, so a chain change shows
  // "reading" at once (the stale snapshot is simply not for this chain) with
  // no state write in the effect body.
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // Each generation is one read. The expiry timer (or the retry timer after a
  // failure) advances it, and so does a return to a visible tab whose snapshot
  // has expired; the effect below re-reads for the new generation.
  const [generation, setGeneration] = useState(0);
  const current: Snapshot | null = snapshot?.chainId === chain.chainId ? snapshot : null;
  const stale = current !== null && current.generation < generation;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const client = createPublicClient({ transport: httpTransports(chain.rpcEndpoints) });
    (async () => {
      let routed: Set<`0x${string}`> | null = null;
      let error: string | null = null;
      try {
        const facets = (await client.readContract({
          address: chain.diamondAddress,
          abi: LOUPE_ABI,
          functionName: 'facets',
        })) as readonly { facetAddress: `0x${string}`; functionSelectors: readonly `0x${string}`[] }[];
        routed = new Set(facets.flatMap((f) => f.functionSelectors));
      } catch (e) {
        error = `The Diamond's routed functions could not be read: ${(e as Error).message}`;
      }
      if (cancelled) return;
      const delay = nextReadDelayMs(routed === null);
      setSnapshot({
        chainId: chain.chainId,
        generation,
        error,
        caps: {
          chainId: chain.chainId,
          diamond: chain.diamondAddress,
          routedSelectors: routed,
          services: unknownServices(),
          keeper: [],
          provenance: {
            buildHash: import.meta.env.VITE_BUILD_HASH ?? 'unknown',
            buildTime: import.meta.env.VITE_BUILD_TIME ?? 'unknown',
            deployCommit: null,
          },
          expiresAt: Date.now() + delay,
          source: routed ? 'chain' : 'none',
        },
      });
      timer = setTimeout(() => setGeneration((g) => g + 1), delay);
    })();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [chain, generation]);

  // A tab that comes back after being hidden may hold an expired snapshot
  // whose timer fired while throttled; re-read at once if it has expired.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setSnapshot((snap) => {
        if (snap && snap.caps && snap.caps.expiresAt <= Date.now()) setGeneration((g) => g + 1);
        return snap;
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const value = useMemo(
    () => ({ caps: current?.caps ?? null, stale, chainId: chain.chainId, error: current?.error ?? null }),
    [current, stale, chain.chainId],
  );
  return <CapabilityContext.Provider value={value}>{children}</CapabilityContext.Provider>;
}

export function useCapabilities(): CapabilityContextValue {
  const ctx = useContext(CapabilityContext);
  if (!ctx) throw new Error('useCapabilities outside CapabilityProvider');
  return ctx;
}

/** The selector of a function by its human signature, for `requireSelector`. */
export function selectorOf(signature: string): `0x${string}` {
  return toFunctionSelector(signature);
}
