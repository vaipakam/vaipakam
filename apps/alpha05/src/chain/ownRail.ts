/**
 * The OWN rail (RB-RAILS): a connected user's positions, vault, allowances,
 * claimables and pending rows are read through the wallet's own provider
 * first, so the app spends the user's RPC quota on the user's state and the
 * shared proxy only as a fallback, then the chain's keyless public endpoint
 * behind the proxy. The world rail (the indexer) never answers an own-state
 * question; the pre-sign rail re-reads through the same source order at
 * review.
 *
 * The sources are SEPARATE clients tried in order by `read`, not one viem
 * `fallback` transport: a fallback answers from whichever leg succeeded and
 * does not say which, so a surface could state "read through your wallet"
 * for a figure the proxy supplied. Here every answer names the source that
 * produced it (Codex on #3210), and a surface states that, never the
 * configured preference.
 *
 * `useOwnStateClient` returns `null` while no wallet is connected on a
 * supported chain: a caller then shows a connect prompt, never a confident
 * empty state.
 */
import { useEffect, useState } from 'react';
import { createPublicClient, custom, http, type EIP1193Provider, type PublicClient } from 'viem';
import { useAccount } from 'wagmi';
import { getSupportedChain } from './chains';
import { RPC_PROXY_MAX_BATCH } from '@vaipakam/lib/rpcProxyPolicy';

/** Which source answered an own-state read. */
export type OwnSource = 'wallet' | 'proxy' | 'public';

export interface OwnStateSource {
  via: OwnSource;
  client: PublicClient;
}

export interface OwnStateClient {
  chainId: number;
  /** The identity every answer from this client is bound to (`reads`). */
  account: `0x${string}`;
  /** The sources in the order `read` tries them. */
  sources: readonly OwnStateSource[];
  /** Whether the wallet's provider is a source at all; false means the
   *  connector exposes no EIP-1193 provider and the proxy carries every read,
   *  which the surface states. */
  walletFirst: boolean;
  /** Run one read through the sources in order and name the one that
   *  answered. A source that throws is passed over; when every source
   *  fails, the first failure (the wallet's, when it was tried) is thrown
   *  with the others as its cause chain. */
  read<T>(fn: (client: PublicClient) => Promise<T>): Promise<{ value: T; via: OwnSource }>;
}

export async function readThrough<T>(sources: readonly OwnStateSource[], fn: (client: PublicClient) => Promise<T>): Promise<{ value: T; via: OwnSource }> {
  const failures: unknown[] = [];
  for (const source of sources) {
    try {
      return { value: await fn(source.client), via: source.via };
    } catch (e) {
      failures.push(e);
    }
  }
  const first = failures[0];
  if (first instanceof Error && failures.length > 1) {
    throw new Error(first.message, { cause: failures.slice(1) });
  }
  throw first ?? new Error('own rail: no source to read through');
}

export function useOwnStateClient(): OwnStateClient | null {
  const { address, chainId, connector, status } = useAccount();
  const chain = getSupportedChain(chainId);
  const identity = status === 'connected' && address && chain && connector ? `${chain.chainId}:${address.toLowerCase()}:${connector.uid}` : null;
  // The client is keyed by the identity it was built for, so a wallet or
  // chain change yields `null` at once (the old client is simply not for this
  // identity) with no state write in the effect body.
  const [built, setBuilt] = useState<{ identity: string; own: OwnStateClient } | null>(null);

  useEffect(() => {
    if (!identity || !address || !chain || !connector) return;
    let cancelled = false;
    (async () => {
      let provider: EIP1193Provider | null = null;
      try {
        provider = (await connector.getProvider({ chainId: chain.chainId })) as EIP1193Provider;
      } catch {
        provider = null;
      }
      if (cancelled) return;
      const sources: OwnStateSource[] = [];
      if (provider) {
        sources.push({ via: 'wallet', client: createPublicClient({ transport: custom(provider, { retryCount: 0 }), batch: { multicall: true } }) });
      }
      for (const e of chain.rpcEndpoints) {
        // The proxy's route is batched within the proxy's cap and not retried
        // (a refusal will not change in a second; the public endpoint behind
        // it is the retry). A public endpoint keeps viem's defaults.
        const transport = e.viaProxy ? http(e.url, { batch: { batchSize: RPC_PROXY_MAX_BATCH }, retryCount: 0 }) : http(e.url, { batch: true });
        sources.push({ via: e.viaProxy ? 'proxy' : 'public', client: createPublicClient({ transport, batch: { multicall: true } }) });
      }
      setBuilt({
        identity,
        own: {
          chainId: chain.chainId,
          account: address,
          sources,
          walletFirst: provider !== null,
          read: (fn) => readThrough(sources, fn),
        },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [identity, address, chain, connector]);

  return built && built.identity === identity ? built.own : null;
}
