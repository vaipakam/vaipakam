/**
 * The OWN rail (RB-RAILS): a connected user's positions, vault, allowances,
 * claimables and pending rows are read through the wallet's own provider
 * first, so the app spends the user's RPC quota on the user's state and the
 * shared proxy only as a fallback. The world rail (the indexer) never
 * answers an own-state question; the pre-sign rail re-reads through the
 * same provider order at review.
 *
 * `useOwnStateClient` returns a viem public client for the connected chain
 * whose transport is `custom(walletProvider)` then the chain's HTTP
 * endpoints, or `null` while no wallet is connected on a supported chain:
 * a caller then shows a connect prompt, never a confident empty state.
 */
import { useEffect, useState } from 'react';
import { createPublicClient, custom, fallback, type EIP1193Provider, type PublicClient } from 'viem';
import { useAccount } from 'wagmi';
import { getSupportedChain } from './chains';
import { httpTransports } from './wagmi';

export interface OwnStateClient {
  client: PublicClient;
  chainId: number;
  /** The identity every answer from this client is bound to (`reads`). */
  account: `0x${string}`;
  /** Whether the wallet's provider is first in the transport order; false
   *  means the connector exposes no EIP-1193 provider and the proxy carries
   *  every read, which the freshness stamp states. */
  walletFirst: boolean;
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
      const http = httpTransports(chain.rpcEndpoints);
      const transport = provider ? fallback([custom(provider, { retryCount: 0 }), http]) : http;
      setBuilt({
        identity,
        own: {
          client: createPublicClient({ transport, batch: { multicall: true } }),
          chainId: chain.chainId,
          account: address,
          walletFirst: provider !== null,
        },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [identity, address, chain, connector]);

  return built && built.identity === identity ? built.own : null;
}
