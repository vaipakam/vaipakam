/**
 * WalletConnect v2 integration — lazy-initialized EIP-1193 provider.
 *
 * Why lazy: `@walletconnect/ethereum-provider` pulls in ~900KB of code
 * including a QR-code library. We don't want that in the initial bundle
 * for users who connect via an injected browser wallet. This module
 * dynamic-imports the provider the first time someone picks the
 * "WalletConnect" path.
 *
 * Required env: `VITE_WALLETCONNECT_PROJECT_ID` — obtain from
 *   https://cloud.walletconnect.com (creates a project, copy the
 *   project ID). Unset → the WalletConnect path is reported as
 *   unavailable and the UI hides the option.
 */
import type { Eip1193Provider } from '../types/wallet';
import { CHAIN_REGISTRY } from '../contracts/config';

/** EIP-1193 methods we use, plus WalletConnect-specific `disconnect`
 *  + `on` surface. The provider from `@walletconnect/ethereum-provider`
 *  exposes these; we type-narrow so the rest of the app stays in pure
 *  EIP-1193 land. */
export interface WalletConnectEip1193 extends Eip1193Provider {
  /** Launches the modal / URI flow and resolves once the peer wallet has
   *  approved the session. Safe to call multiple times; subsequent calls
   *  no-op if a session is active. */
  connect: (opts?: { chains?: number[] }) => Promise<unknown>;
  /** Close the WC session and purge persisted state. */
  disconnect: () => Promise<void>;
  /** True after `connect` / reconnect, until `disconnect`. */
  connected?: boolean;
  /** Current accounts (may be empty before `connect`). */
  accounts?: readonly string[];
}

/** True iff the build env contains a non-empty project ID. Callers use
 *  this to decide whether to show the WalletConnect option in the UI. */
export function isWalletConnectConfigured(): boolean {
  const id = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ?? '';
  return id.trim().length > 0;
}

let _cachedProvider: Promise<WalletConnectEip1193> | null = null;

/**
 * Resolve a singleton WalletConnect provider. Caches the initialization
 * promise so concurrent callers share the same session — two buttons
 * clicked in quick succession don't create two providers.
 */
export function getWalletConnectProvider(): Promise<WalletConnectEip1193> {
  if (!isWalletConnectConfigured()) {
    return Promise.reject(
      new Error(
        'WalletConnect not configured. Set VITE_WALLETCONNECT_PROJECT_ID in .env.local to enable.',
      ),
    );
  }
  if (_cachedProvider) return _cachedProvider;
  _cachedProvider = _initProvider();
  return _cachedProvider;
}

/** Internal: dynamic-import the package, init against the Phase 1 chain
 *  set, return a typed EIP-1193 provider. */
async function _initProvider(): Promise<WalletConnectEip1193> {
  const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string;

  // Dynamic import — keeps the 900KB WC bundle out of the initial load.
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');

  // Build the chain lists from the same registry the rest of the app
  // uses so WalletConnect advertises the chains we actually support.
  // Split into required (mainnet Phase 1) and optional (testnets) so a
  // wallet that only supports mainnets can still connect.
  const chainsAll = Object.values(CHAIN_REGISTRY);
  const mainnetIds = chainsAll.filter((c) => !c.testnet).map((c) => c.chainId);
  const testnetIds = chainsAll.filter((c) => c.testnet).map((c) => c.chainId);

  // At least one of the two must be non-empty for the WC type
  // contract (`ArrayOneOrMore<number>`). Guard against the degenerate
  // "no chains configured" case with a clear error instead of a
  // runtime crash inside the WC library.
  if (mainnetIds.length === 0 && testnetIds.length === 0) {
    throw new Error('WalletConnect init: CHAIN_REGISTRY is empty');
  }

  // If we have mainnets, they're the required set and testnets are
  // optional. If we have only testnets (local dev build), testnets
  // become required and optional is empty.
  const required = mainnetIds.length > 0 ? mainnetIds : testnetIds;
  const optional = mainnetIds.length > 0 ? testnetIds : [];

  // rpcMap lets WC route eth_call / eth_estimateGas through OUR RPC
  // config instead of the wallet's default (avoids the "wallet returns
  // stale data" class of bug when wallet RPC is out of sync with ours).
  const rpcMap: Record<number, string> = {};
  for (const c of chainsAll) {
    rpcMap[c.chainId] = c.rpcUrl;
  }

  // Type-assert the required list as the tuple the WC type expects.
  // We've guarded above that `required` has length ≥ 1.
  const requiredTuple = required as unknown as [number, ...number[]];

  const provider = await EthereumProvider.init({
    projectId,
    chains: requiredTuple,
    optionalChains: optional.length > 0 ? (optional as unknown as [number, ...number[]]) : undefined,
    rpcMap,
    showQrModal: true,
    // App metadata shown inside the connecting wallet's approval UI.
    metadata: {
      name: 'Vaipakam',
      description:
        'Peer-to-peer lending fully on-chain. Lend and borrow tokens, ' +
        'rent NFTs, set your own terms — every position tracked by a ' +
        'unique NFT.',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://vaipakam.app',
      icons: [
        typeof window !== 'undefined'
          ? `${window.location.origin}/logo-light.png`
          : 'https://vaipakam.app/logo-light.png',
      ],
    },
  });

  return provider as unknown as WalletConnectEip1193;
}

/** Reset the module singleton — used on explicit disconnect so the next
 *  connect() starts a fresh session instead of reusing a closed one. */
export function resetWalletConnectProvider(): void {
  _cachedProvider = null;
}
