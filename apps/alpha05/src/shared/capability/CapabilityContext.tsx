import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPublicClient, toFunctionSelector, type Abi } from 'viem';
import { useAccount } from 'wagmi';
import { DiamondLoupeFacetABI } from '@vaipakam/contracts/abis';
import { DEFAULT_CHAIN, getSupportedChain } from '../../chain/chains';
import { httpTransports } from '../../chain/wagmi';
import type { ChainCapabilities } from './types';

/** The one `facets()` read the loupe offers, typed from the exported ABI. */
const LOUPE_ABI = DiamondLoupeFacetABI as Abi;

const SNAPSHOT_TTL_MS = 10 * 60_000;

interface CapabilityContextValue {
  /** The active chain's snapshot, `null` until the first read completes. */
  caps: ChainCapabilities | null;
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
  const current: Snapshot = snapshot?.chainId === chain.chainId ? snapshot : { chainId: chain.chainId, caps: null, error: null };

  useEffect(() => {
    let cancelled = false;
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
      setSnapshot({
        chainId: chain.chainId,
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
          expiresAt: Date.now() + SNAPSHOT_TTL_MS,
          source: routed ? 'chain' : 'none',
        },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [chain]);

  const value = useMemo(
    () => ({ caps: current.caps, chainId: chain.chainId, error: current.error }),
    [current.caps, current.error, chain.chainId],
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
