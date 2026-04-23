import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { BrowserProvider, JsonRpcSigner } from 'ethers';
import {
  DEFAULT_CHAIN,
  CHAIN_REGISTRY,
  getChainByChainId,
  isChainSupported,
  type ChainConfig,
} from '../contracts/config';
import type { Eip1193Provider, WalletProviderError } from '../types/wallet';
import { beginStep, emit } from '../lib/journeyLog';
import {
  getWalletConnectProvider,
  isWalletConnectConfigured,
  resetWalletConnectProvider,
  type WalletConnectEip1193,
} from '../lib/walletConnect';

/** Which EIP-1193 provider is currently driving the connection. Drives
 *  listener attachment, chain-switch routing, and disconnect semantics
 *  (injected → clear state; walletconnect → close the remote session). */
export type WalletSource = 'injected' | 'walletconnect';

interface WalletState {
  provider: BrowserProvider | null;
  signer: JsonRpcSigner | null;
  address: string | null;
  chainId: number | null;
  isConnecting: boolean;
  error: string | null;
  /** Which EIP-1193 path is currently active, or null when disconnected.
   *  Consumers can read this to hide UI that's only meaningful for one
   *  source (e.g. "Open wallet app" shortcut for WalletConnect). */
  source: WalletSource | null;
}

interface WalletContextType extends WalletState {
  /** Connect via the chosen wallet source. Defaults to 'injected' for
   *  back-compat with existing call sites; pass 'walletconnect' to open
   *  the WC v2 QR flow. When 'walletconnect' is requested but the build
   *  has no `VITE_WALLETCONNECT_PROJECT_ID`, the call surfaces an error
   *  instead of silently falling through. */
  connect: (source?: WalletSource) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Ask the wallet to switch to the app's default chain (adds it via
   *  wallet_addEthereumChain if the wallet doesn't know the chain yet). */
  switchToDefaultChain: () => Promise<void>;
  /** Ask the wallet to switch to a specific chainId (must be an entry in
   *  CHAIN_REGISTRY). Mirrors the add-on-404 fallback of switchToDefaultChain.
   *  Used by flows that are pinned to a non-default chain (e.g. Buy VPFI on
   *  the canonical chain). */
  switchToChain: (chainId: number) => Promise<void>;
  /** The ChainConfig matching the wallet's current chainId, or null when
   *  the wallet is on a chain the app has no Diamond deploy for. */
  activeChain: ChainConfig | null;
  /** True iff the wallet's chainId resolves to an entry in CHAIN_REGISTRY. */
  isCorrectChain: boolean;
  /** True iff the build was compiled with a WalletConnect project ID.
   *  The UI can hide the "Use WalletConnect" option when false. */
  walletConnectAvailable: boolean;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

function getEthereum(): Eip1193Provider | null {
  if (typeof window !== 'undefined' && (window as { ethereum?: Eip1193Provider }).ethereum) {
    return (window as unknown as { ethereum: Eip1193Provider }).ethereum;
  }
  return null;
}

/**
 * Coarse-grained mobile-OS detection. Only used to decide whether to
 * fall back to the MetaMask mobile deep link (`metamask.app.link/dapp/…`)
 * when no in-browser EIP-1193 provider is injected. Errs on the side of
 * "treat as mobile" for known mobile OS substrings — a false positive
 * just means a desktop user clicking Connect with no wallet installed
 * gets routed to the MetaMask mobile app store page, which is harmless.
 */
function _isMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(ua);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>({
    provider: null,
    signer: null,
    address: null,
    chainId: null,
    isConnecting: false,
    error: null,
    source: null,
  });

  const activeChain = getChainByChainId(state.chainId) ?? null;
  const isCorrectChain = isChainSupported(state.chainId);
  const walletConnectAvailable = isWalletConnectConfigured();

  // The EIP-1193 provider currently driving the connection. Stored in a
  // ref (not state) so listener callbacks always see the LATEST one even
  // when they were bound during a prior render — important because
  // switching from injected → WalletConnect (or vice versa) within the
  // same session must re-route event handling without a full remount.
  const activeEip1193Ref = useRef<Eip1193Provider | null>(null);

  const updateChainId = useCallback(async (provider: BrowserProvider) => {
    const network = await provider.getNetwork();
    setState((prev) => ({ ...prev, chainId: Number(network.chainId) }));
  }, []);

  /**
   * Core connect flow factored out of `connect()` so both the injected
   * path and the WalletConnect path share the same "approve → store
   * ethers Provider / Signer / address / chainId" epilogue. The caller
   * supplies the raw EIP-1193 surface; this function owns everything
   * downstream of it.
   */
  const _finalizeConnection = useCallback(
    async (eip1193: Eip1193Provider, source: WalletSource) => {
      const provider = new BrowserProvider(eip1193);
      // WalletConnect's `connect()` already prompts the peer and yields
      // approved accounts, so `eth_requestAccounts` on an already-bonded
      // provider is a no-op that just reads the session. For injected
      // it's the actual approval prompt.
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      const network = await provider.getNetwork();

      activeEip1193Ref.current = eip1193;
      setState({
        provider,
        signer,
        address,
        chainId: Number(network.chainId),
        isConnecting: false,
        error: null,
        source,
      });
    },
    [],
  );

  const connect = useCallback(
    async (source: WalletSource = 'injected') => {
      const step = beginStep({
        area: 'wallet',
        flow: 'connect',
        step: 'request-accounts',
      });

      // ── WalletConnect v2 path ──────────────────────────────────────
      if (source === 'walletconnect') {
        if (!walletConnectAvailable) {
          const msg =
            'WalletConnect is not configured for this build. Set ' +
            'VITE_WALLETCONNECT_PROJECT_ID in .env.local and rebuild.';
          setState((prev) => ({ ...prev, error: msg }));
          step.failure(null, { errorType: 'validation', errorMessage: msg });
          return;
        }
        setState((prev) => ({ ...prev, isConnecting: true, error: null }));
        try {
          const wc = await getWalletConnectProvider();
          // `.connect()` is idempotent — if a session is already active
          // (auto-reconnect case below) this resolves immediately.
          await wc.connect({});
          await _finalizeConnection(wc, 'walletconnect');
          step.success({ wallet: 'walletconnect' });
        } catch (err) {
          const e = err as WalletProviderError;
          setState((prev) => ({
            ...prev,
            isConnecting: false,
            error:
              e?.code === 4001
                ? 'Connection rejected by user.'
                : 'WalletConnect session failed. Try again, or use a browser wallet.',
          }));
          step.failure(err);
        }
        return;
      }

      // ── Injected wallet path (window.ethereum) ─────────────────────
      const ethereum = getEthereum();
      if (!ethereum) {
        // Mobile Safari / Chrome don't inject `window.ethereum`. Rather
        // than tell the user to install MetaMask (which they already
        // might have, just not integrated into their mobile browser),
        // detect mobile and deep-link into the MetaMask mobile app's
        // in-app browser using the well-known `metamask.app.link` path.
        // On desktop this case still means "no wallet installed" — show
        // the old error.
        //
        // Note: WalletConnect is the other valid path for "no injected
        // provider". The UI should offer the WC choice when
        // `walletConnectAvailable` is true. This branch only fires if
        // the caller explicitly requested 'injected'.
        if (typeof window !== 'undefined' && _isMobileUserAgent()) {
          const host =
            window.location.host + window.location.pathname + window.location.search;
          const deepLink = `https://metamask.app.link/dapp/${host}`;
          const msg =
            'No in-browser wallet detected. Redirecting to MetaMask mobile — ' +
            "if you don't have it installed, the app store will open. Once " +
            'installed, Vaipakam will open inside the MetaMask in-app browser.';
          setState((prev) => ({ ...prev, error: msg }));
          step.failure(null, { errorType: 'wallet', errorMessage: 'mobile-deep-link' });
          window.location.href = deepLink;
          return;
        }
        const msg = walletConnectAvailable
          ? 'No in-browser wallet detected. Use WalletConnect to connect from your phone.'
          : 'No wallet detected. Install MetaMask (or another Web3 wallet) in ' +
            'this browser and reload. On mobile, open this page from inside ' +
            "the MetaMask app's browser.";
        setState((prev) => ({ ...prev, error: msg }));
        step.failure(null, { errorType: 'wallet', errorMessage: msg });
        return;
      }

      setState((prev) => ({ ...prev, isConnecting: true, error: null }));
      try {
        await _finalizeConnection(ethereum, 'injected');
        step.success({ wallet: 'injected', chainId: state.chainId ?? 0 });
      } catch (err) {
        const e = err as WalletProviderError;
        setState((prev) => ({
          ...prev,
          isConnecting: false,
          error: e?.code === 4001 ? 'Connection rejected by user.' : 'Failed to connect wallet.',
        }));
        step.failure(err);
      }
    },
    [walletConnectAvailable, _finalizeConnection, state.chainId],
  );

  const disconnect = useCallback(async () => {
    emit({ area: 'wallet', flow: 'disconnect', step: 'clear-state', status: 'info' });

    // Close the WC session on the peer side so the user's wallet app
    // stops showing Vaipakam as connected. For injected, there's no
    // standard "disconnect" RPC — the wallet manages its own connection
    // set, so we just drop our local references.
    if (state.source === 'walletconnect') {
      try {
        const wc = activeEip1193Ref.current as WalletConnectEip1193 | null;
        await wc?.disconnect?.();
      } catch {
        // WC session might already be closed / network unreachable.
        // Local state clear below still happens.
      }
      resetWalletConnectProvider();
    }

    activeEip1193Ref.current = null;
    setState({
      provider: null,
      signer: null,
      address: null,
      chainId: null,
      isConnecting: false,
      error: null,
      source: null,
    });
  }, [state.source]);

  const switchToChain = useCallback(async (targetChainId: number) => {
    const target = CHAIN_REGISTRY[targetChainId];
    const step = beginStep({
      area: 'wallet',
      flow: 'switch-chain',
      step: 'wallet_switchEthereumChain',
      chainId: targetChainId,
    });
    // Route through whichever provider is currently active — injected
    // for window.ethereum sessions, the WC session provider for
    // WalletConnect sessions. Falling back to window.ethereum here
    // would send the switch request to the wrong wallet.
    const active = activeEip1193Ref.current ?? getEthereum();
    if (!active) {
      step.failure(null, { errorType: 'wallet', errorMessage: 'No wallet connected.' });
      return;
    }
    if (!target) {
      step.failure(null, {
        errorType: 'validation',
        errorMessage: `Chain ${targetChainId} not in CHAIN_REGISTRY`,
      });
      return;
    }

    try {
      await active.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: target.chainIdHex }],
      });
      step.success({ chainId: target.chainId });
    } catch (err) {
      const e = err as WalletProviderError;
      if (e.code === 4902) {
        try {
          await active.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: target.chainIdHex,
                chainName: target.name,
                rpcUrls: [target.rpcUrl],
                blockExplorerUrls: [target.blockExplorer],
              },
            ],
          });
          step.success({ chainId: target.chainId, note: 'added chain via wallet_addEthereumChain' });
        } catch (addErr) {
          step.failure(addErr);
        }
      } else {
        step.failure(err);
      }
    }
  }, []);

  const switchToDefaultChain = useCallback(
    () => switchToChain(DEFAULT_CHAIN.chainId),
    [switchToChain],
  );

  // Listen for account and chain changes on the ACTIVE provider —
  // whichever was latched by `connect(source)`. Previously this was
  // hard-wired to `window.ethereum`, which silently broke chain-switch
  // bookkeeping for WalletConnect sessions.
  useEffect(() => {
    // Fallback to window.ethereum so listeners attach on page load even
    // if the user hasn't explicitly clicked Connect yet (enables the
    // auto-reconnect path below to surface accountsChanged properly).
    const eip1193 = activeEip1193Ref.current ?? getEthereum();
    if (!eip1193) return;

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = (args[0] ?? []) as string[];
      if (accounts.length === 0) {
        void disconnect();
      } else if (state.provider) {
        state.provider.getSigner().then((signer) => {
          setState((prev) => ({ ...prev, address: accounts[0], signer }));
        });
      }
    };

    // ethers v6 BrowserProvider caches the network on first getNetwork() call,
    // so we must rebuild the provider + signer when the wallet switches
    // chains — otherwise signer.getChainId() keeps returning the old value
    // and txs go to the wrong network.
    const handleChainChanged = async () => {
      try {
        const nextProvider = new BrowserProvider(eip1193);
        const network = await nextProvider.getNetwork();
        const nextSigner = state.address
          ? await nextProvider.getSigner().catch(() => null)
          : null;
        setState((prev) => ({
          ...prev,
          provider: nextProvider,
          signer: nextSigner,
          chainId: Number(network.chainId),
        }));
      } catch (err) {
        emit({
          area: 'wallet',
          flow: 'chain-changed',
          step: 'rebuild-provider',
          status: 'failure',
          errorMessage: (err as Error)?.message,
        });
      }
    };

    // WalletConnect emits 'disconnect' when the user ends the session
    // from the wallet side; window.ethereum doesn't fire that, so guard
    // by optional-chain — setting a listener on an injected provider
    // that doesn't support the event is harmless.
    const handleWcDisconnect = () => {
      void disconnect();
    };

    eip1193.on('accountsChanged', handleAccountsChanged);
    eip1193.on('chainChanged', handleChainChanged);
    eip1193.on('disconnect', handleWcDisconnect);

    return () => {
      eip1193.removeListener('accountsChanged', handleAccountsChanged);
      eip1193.removeListener('chainChanged', handleChainChanged);
      eip1193.removeListener('disconnect', handleWcDisconnect);
    };
    // `state.source` re-runs the effect when the active path changes
    // (injected ↔ walletconnect) so listeners attach to the right
    // provider. `state.address` is read inside handleChainChanged to
    // decide whether to rebuild a signer.
  }, [state.source, state.provider, state.address, disconnect, updateChainId]);

  // Auto-reconnect if the previous session is still live. Two paths:
  //   1. Injected (window.ethereum): `eth_accounts` returns a non-empty
  //      array iff the user previously approved this origin.
  //   2. WalletConnect: the WC provider persists the session topic in
  //      localStorage; `getWalletConnectProvider()` loads it and
  //      `.connected` is true when the session is still alive.
  //
  // WC takes precedence because it's a deliberate user choice — if the
  // user previously connected via WC, they probably want to stay on WC
  // even if the browser also has window.ethereum (they may have Rabby
  // installed but connect via their phone's Rainbow wallet).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (walletConnectAvailable) {
        try {
          const wc = await getWalletConnectProvider();
          if (!cancelled && wc.connected === true) {
            void connect('walletconnect');
            return;
          }
        } catch {
          // WC init failure is non-fatal for auto-reconnect — fall
          // through to the injected path.
        }
      }
      const ethereum = getEthereum();
      if (!ethereum) return;
      const result = await ethereum
        .request({ method: 'eth_accounts' })
        .catch(() => [] as unknown);
      const accounts = (result ?? []) as string[];
      if (!cancelled && accounts.length > 0) {
        void connect('injected');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <WalletContext.Provider
      value={{
        ...state,
        connect,
        disconnect,
        switchToDefaultChain,
        switchToChain,
        activeChain,
        isCorrectChain,
        walletConnectAvailable,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
