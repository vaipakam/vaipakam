import { useMemo } from 'react';
import { Contract, JsonRpcProvider } from 'ethers';
import { usePublicClient } from 'wagmi';
import { createPublicClient, http, type PublicClient } from 'viem';
import { useWallet } from '../context/WalletContext';
import { useChainOverride } from '../context/ChainContext';
import { CHAIN_REGISTRY, DEFAULT_CHAIN, type ChainConfig } from './config';
import { DIAMOND_ABI } from './abis';

/**
 * Resolves the chain that reads should target, in priority order:
 *   1. Explicit view-chain override (set by wallet-less UIs like the public
 *      dashboard's per-chain selector).
 *   2. The wallet's active chain, if it's a supported Diamond-deployed chain.
 *   3. DEFAULT_CHAIN — so read-only flows always work.
 *
 * The override wins over the wallet so a disconnected visitor (or a connected
 * user who hasn't switched networks yet) can still browse any chain's data.
 */
function resolveReadChain(
  viewChainId: number | null,
  activeChain: ChainConfig | null,
  isCorrectChain: boolean,
): ChainConfig {
  if (viewChainId != null) {
    const override = CHAIN_REGISTRY[viewChainId];
    if (override && override.diamondAddress) return override;
  }
  if (activeChain && isCorrectChain && activeChain.diamondAddress) {
    return activeChain;
  }
  return DEFAULT_CHAIN;
}

/**
 * Returns a Contract instance pointing at the Diamond proxy.
 * - With a connected signer (for write txs) when the wallet is connected and
 *   on a supported chain.
 * - With a read-only provider otherwise — either the wallet's active chain
 *   (supported) or DEFAULT_CHAIN (unsupported / disconnected).
 */
export function useDiamondContract() {
  const { signer, isCorrectChain, activeChain } = useWallet();
  const { viewChainId } = useChainOverride();
  const chain = resolveReadChain(viewChainId, activeChain, isCorrectChain);
  // The signer only matches the wallet's actual chain — if the user has
  // overridden the view chain, fall back to a read-only provider so the
  // Contract doesn't try to sign txs against the wrong network.
  const signerMatches =
    isCorrectChain &&
    (viewChainId == null || viewChainId === activeChain?.chainId);

  return useMemo(() => {
    const address = chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress!;
    if (signer && signerMatches) {
      return new Contract(address, DIAMOND_ABI, signer);
    }
    const provider = new JsonRpcProvider(chain.rpcUrl);
    return new Contract(address, DIAMOND_ABI, provider);
  }, [signer, signerMatches, chain.diamondAddress, chain.rpcUrl]);
}

/**
 * Returns a read-only Contract (always uses a public RPC — no wallet needed).
 * Targets the wallet's active chain when supported, otherwise DEFAULT_CHAIN.
 */
export function useDiamondRead() {
  const { activeChain, isCorrectChain } = useWallet();
  const { viewChainId } = useChainOverride();
  const chain = resolveReadChain(viewChainId, activeChain, isCorrectChain);

  return useMemo(() => {
    const provider = new JsonRpcProvider(chain.rpcUrl);
    const address = chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress!;
    return new Contract(address, DIAMOND_ABI, provider);
  }, [chain.rpcUrl, chain.diamondAddress]);
}

/** viem `PublicClient` bound to the current read chain. Hooks that need to
 *  drive raw multicalls, `getLogs` scans, or other viem-native actions
 *  against the same chain as `useDiamondRead()` should use this instead of
 *  reaching into the ethers contract's internals.
 *
 *  This helper was added during the Phase B-full migration (B1) so new
 *  hooks can target viem without waiting for the whole ethers-hook
 *  cleanup to finish. Legacy ethers hooks keep working via
 *  `useDiamondRead()` until they're individually migrated. */
export function useDiamondPublicClient(): PublicClient {
  const { activeChain, isCorrectChain } = useWallet();
  const { viewChainId } = useChainOverride();
  const chain = resolveReadChain(viewChainId, activeChain, isCorrectChain);
  const wagmiClient = usePublicClient({ chainId: chain.chainId });
  return useMemo(
    () =>
      wagmiClient ??
      createPublicClient({ transport: http(chain.rpcUrl) }),
    [wagmiClient, chain.rpcUrl],
  );
}

/** The ChainConfig reads will be dispatched against. Useful for hooks that
 *  also need to know the deploy block, explorer URL, or chainId that goes
 *  with the Diamond they just read. */
export function useReadChain(): ChainConfig {
  const { activeChain, isCorrectChain } = useWallet();
  const { viewChainId } = useChainOverride();
  return resolveReadChain(viewChainId, activeChain, isCorrectChain);
}

/**
 * Single source of truth for "can this page submit a write tx right now?".
 *
 * A write is safe iff all of these hold:
 *   - wallet is connected (address + signer present)
 *   - wallet is on a supported chain (isCorrectChain)
 *   - the dashboard's view-chain override, if set, matches the wallet's
 *     actual chain — otherwise useDiamondContract() has silently fallen
 *     back to a read-only provider and any attempt to sign would revert.
 *
 * Write pages MUST gate buttons/handlers on this instead of just
 * isCorrectChain, or they'll allow clicks that can never settle.
 */
export function useCanWrite(): boolean {
  const { signer, address, isCorrectChain, activeChain } = useWallet();
  const { viewChainId } = useChainOverride();
  return (
    !!address &&
    !!signer &&
    isCorrectChain &&
    (viewChainId == null || viewChainId === activeChain?.chainId)
  );
}
