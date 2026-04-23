/**
 * WalletContext — compatibility shim over wagmi + ConnectKit.
 *
 * This context preserves the exact public API (`useWallet()` return shape,
 * `WalletProvider` boundary, `WalletSource` union) that every screen + hook
 * in the app consumes today, while delegating the actual connection
 * management to wagmi v2 and the wallet-picker UX to ConnectKit.
 *
 * Why a shim instead of cutting over directly to wagmi hooks everywhere:
 *   - ~30 call sites destructure from `useWallet()` today. Touching all of
 *     them in one pass would be a sprawling diff and block every unrelated
 *     change until it landed.
 *   - Our contract-interaction layer (`useDiamond`, every write hook) is
 *     still ethers-based. Exposing an ethers `BrowserProvider` + `signer`
 *     via the adapter in `lib/viemToEthers.ts` keeps those working without
 *     rewrite. They migrate in Phase B of the wallet migration plan.
 *
 * What changes for consumers: **nothing.** Every field and method exposed
 * previously is still exposed, with the same types and same semantics.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { BrowserProvider, JsonRpcSigner } from 'ethers';
import {
  useAccount,
  useChainId,
  useConnect,
  useConnectors,
  useDisconnect as useWagmiDisconnect,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { useModal } from 'connectkit';
import {
  CHAIN_REGISTRY,
  DEFAULT_CHAIN,
  getChainByChainId,
  isChainSupported,
  type ChainConfig,
} from '../contracts/config';
import { walletConnectAvailable as envWalletConnectAvailable } from '../lib/wagmiConfig';
import { walletClientToEthers } from '../lib/viemToEthers';
import { beginStep, emit } from '../lib/journeyLog';

/** Which EIP-1193 path is currently driving the connection. Retained for
 *  back-compat with screens that hide / show UI per source. Mapped from
 *  wagmi's active connector id. */
export type WalletSource = 'injected' | 'walletconnect';

interface WalletState {
  provider: BrowserProvider | null;
  signer: JsonRpcSigner | null;
  address: string | null;
  chainId: number | null;
  isConnecting: boolean;
  error: string | null;
  /** Non-error informational notices — surfaced to the UI as a yellow
   *  warning banner instead of the red error banner. Kept null today
   *  because the "no injected wallet detected" nudge is now owned by
   *  ConnectKit's modal (shown inline in the wallet picker). */
  warning: string | null;
  source: WalletSource | null;
}

interface WalletContextType extends WalletState {
  /** Open the wallet-picker modal. The `source` argument is advisory —
   *  ConnectKit's picker lets the user choose regardless. Kept on the API
   *  for call-site compat.  */
  connect: (source?: WalletSource) => Promise<void>;
  disconnect: () => Promise<void>;
  switchToDefaultChain: () => Promise<void>;
  switchToChain: (chainId: number) => Promise<void>;
  activeChain: ChainConfig | null;
  isCorrectChain: boolean;
  walletConnectAvailable: boolean;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

/** Map wagmi's connector id to the legacy `WalletSource` union so the
 *  existing auto-reconnect / analytics / UI-visibility code keeps
 *  working. Any injected wallet (browser extension) collapses to
 *  'injected'; WalletConnect and Coinbase Wallet both surface as
 *  'walletconnect' because from our UI's perspective they share the
 *  same "remote session" shape. */
function mapConnectorIdToSource(connectorId: string | undefined): WalletSource | null {
  if (!connectorId) return null;
  const id = connectorId.toLowerCase();
  if (id.includes('injected') || id.includes('metamask') || id.includes('rabby')) {
    return 'injected';
  }
  return 'walletconnect';
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const {
    address: rawAddress,
    connector,
    isConnecting: wagmiConnecting,
    isReconnecting,
    status,
  } = useAccount();
  const chainId = useChainId();
  const { disconnectAsync } = useWagmiDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const { setOpen: setConnectKitOpen } = useModal();
  const { connectAsync } = useConnect();
  const connectors = useConnectors();

  // Derived ethers adapter — rebuilt whenever wagmi hands us a new viem
  // WalletClient (on connect, account change, or chain change).
  const [adapter, setAdapter] = useState<{
    provider: BrowserProvider;
    signer: JsonRpcSigner;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!walletClient) {
      setAdapter(null);
      return;
    }
    walletClientToEthers(walletClient)
      .then((next) => {
        if (!cancelled) setAdapter(next);
      })
      .catch((err) => {
        emit({
          area: 'wallet',
          flow: 'adapter',
          step: 'walletClientToEthers',
          status: 'failure',
          errorMessage: (err as Error)?.message,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [walletClient]);

  // Clear transient errors once a connection succeeds.
  useEffect(() => {
    if (status === 'connected' && error) setError(null);
  }, [status, error]);

  // Safe-App auto-connect. When Vaipakam is embedded as an iframe inside
  // Safe's multisig UI, the wagmi `safe()` connector completes an iframe
  // postMessage handshake with the parent frame and becomes ready. At
  // that point the connected "wallet" IS the Safe itself — the user
  // should not have to click Connect. We detect the iframe context,
  // look up the safe connector among the registered set, and attempt a
  // connect on mount. The connector's `connect()` call rejects when
  // not inside a real Safe context (no handshake), so this is safe to
  // attempt even in normal browser loads — it just errors out silently.
  useEffect(() => {
    // If already connected (e.g. reconnect via wagmi storage), skip.
    if (status !== 'disconnected') return;
    if (typeof window === 'undefined') return;
    // Only worth trying inside an iframe. Outside an iframe the safe
    // handshake can't possibly succeed, so skip the attempt to avoid
    // polluting the journey log with expected failures.
    if (window.parent === window) return;

    const safeConnector = connectors.find((c) => c.id === 'safe');
    if (!safeConnector) return;

    let cancelled = false;
    (async () => {
      try {
        await connectAsync({ connector: safeConnector });
        if (cancelled) return;
        emit({
          area: 'wallet',
          flow: 'safe-app',
          step: 'auto-connect',
          status: 'success',
          note: 'connected via Safe App iframe handshake',
        });
      } catch {
        // Expected when we're inside SOME iframe that isn't Safe's
        // (e.g. a third-party widget embed). Silently fall through
        // to the normal ConnectKit picker flow.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally only on mount + when connector set stabilises —
    // running this on every render would attempt the handshake
    // repeatedly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectors]);

  const address = rawAddress ?? null;
  const source = mapConnectorIdToSource(connector?.id);
  const activeChain = getChainByChainId(chainId) ?? null;
  const isCorrectChain = isChainSupported(chainId);
  const isConnecting = wagmiConnecting || isReconnecting;

  const connect = useCallback(
    async (_source?: WalletSource) => {
      // Delegate UI entirely to ConnectKit. The `_source` param stays on
      // the signature for back-compat but is not used to preselect a
      // connector — that's the picker's job.
      const step = beginStep({
        area: 'wallet',
        flow: 'connect',
        step: 'open-picker',
      });
      try {
        setConnectKitOpen(true);
        step.success({ wallet: _source ?? 'picker' });
      } catch (err) {
        setError('Failed to open wallet picker.');
        step.failure(err);
      }
    },
    [setConnectKitOpen],
  );

  const disconnect = useCallback(async () => {
    emit({ area: 'wallet', flow: 'disconnect', step: 'clear-state', status: 'info' });
    try {
      await disconnectAsync();
    } catch (err) {
      emit({
        area: 'wallet',
        flow: 'disconnect',
        step: 'wagmi-disconnect',
        status: 'failure',
        errorMessage: (err as Error)?.message,
      });
    }
  }, [disconnectAsync]);

  const switchToChain = useCallback(
    async (targetChainId: number) => {
      const target = CHAIN_REGISTRY[targetChainId];
      const step = beginStep({
        area: 'wallet',
        flow: 'switch-chain',
        step: 'wagmi-switch',
        chainId: targetChainId,
      });
      if (!target) {
        step.failure(null, {
          errorType: 'validation',
          errorMessage: `Chain ${targetChainId} not in CHAIN_REGISTRY`,
        });
        return;
      }
      try {
        // wagmi's switchChainAsync handles wallet_switchEthereumChain and
        // the 4902 → wallet_addEthereumChain fallback internally.
        await switchChainAsync({ chainId: targetChainId });
        step.success({ chainId: targetChainId });
      } catch (err) {
        setError('Chain switch rejected or failed.');
        step.failure(err);
      }
    },
    [switchChainAsync],
  );

  const switchToDefaultChain = useCallback(
    () => switchToChain(DEFAULT_CHAIN.chainId),
    [switchToChain],
  );

  const value = useMemo<WalletContextType>(
    () => ({
      provider: adapter?.provider ?? null,
      signer: adapter?.signer ?? null,
      address,
      chainId: chainId ?? null,
      isConnecting,
      error,
      // `warning` is retained in the shape for back-compat; today ConnectKit
      // owns the "no wallet detected" nudge inside its picker, so nothing
      // writes to this slot. If a future flow needs it, wire it through
      // setWarning() here the same way error already works.
      warning: null,
      source,
      connect,
      disconnect,
      switchToDefaultChain,
      switchToChain,
      activeChain,
      isCorrectChain,
      walletConnectAvailable: envWalletConnectAvailable,
    }),
    [
      adapter,
      address,
      chainId,
      isConnecting,
      error,
      source,
      connect,
      disconnect,
      switchToDefaultChain,
      switchToChain,
      activeChain,
      isCorrectChain,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
