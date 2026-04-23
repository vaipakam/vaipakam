import {
  createContext,
  useContext,
  useCallback,
  useEffect,
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

interface WalletState {
  provider: BrowserProvider | null;
  signer: JsonRpcSigner | null;
  address: string | null;
  chainId: number | null;
  isConnecting: boolean;
  error: string | null;
}

interface WalletContextType extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => void;
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
  });

  const activeChain = getChainByChainId(state.chainId) ?? null;
  const isCorrectChain = isChainSupported(state.chainId);

  const updateChainId = useCallback(async (provider: BrowserProvider) => {
    const network = await provider.getNetwork();
    setState((prev) => ({ ...prev, chainId: Number(network.chainId) }));
  }, []);

  const connect = useCallback(async () => {
    const step = beginStep({ area: 'wallet', flow: 'connect', step: 'request-accounts' });
    const ethereum = getEthereum();
    if (!ethereum) {
      // Mobile Safari / Chrome don't inject `window.ethereum`. Rather
      // than tell the user to install MetaMask (which they already
      // might have, just not integrated into their mobile browser),
      // detect mobile and deep-link into the MetaMask mobile app's
      // in-app browser using EIP-6963's well-known `metamask.app.link`.
      // On desktop this case still means "no wallet installed" — show
      // the old error.
      if (typeof window !== 'undefined' && _isMobileUserAgent()) {
        const host = window.location.host + window.location.pathname + window.location.search;
        const deepLink = `https://metamask.app.link/dapp/${host}`;
        const msg =
          'No in-browser wallet detected. Redirecting to MetaMask mobile — ' +
          'if you don\'t have it installed, the app store will open. Once ' +
          'installed, Vaipakam will open inside the MetaMask in-app browser.';
        setState((prev) => ({ ...prev, error: msg }));
        step.failure(null, { errorType: 'wallet', errorMessage: 'mobile-deep-link' });
        window.location.href = deepLink;
        return;
      }
      const msg =
        'No wallet detected. Install MetaMask (or another Web3 wallet) in ' +
        'this browser and reload. On mobile, open this page from inside ' +
        'the MetaMask app\'s browser.';
      setState((prev) => ({ ...prev, error: msg }));
      step.failure(null, { errorType: 'wallet', errorMessage: msg });
      return;
    }

    setState((prev) => ({ ...prev, isConnecting: true, error: null }));

    try {
      const provider = new BrowserProvider(ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      const network = await provider.getNetwork();

      setState({
        provider,
        signer,
        address,
        chainId: Number(network.chainId),
        isConnecting: false,
        error: null,
      });
      step.success({ wallet: address, chainId: Number(network.chainId) });
    } catch (err) {
      const e = err as WalletProviderError;
      setState((prev) => ({
        ...prev,
        isConnecting: false,
        error: e.code === 4001 ? 'Connection rejected by user.' : 'Failed to connect wallet.',
      }));
      step.failure(err);
    }
  }, []);

  const disconnect = useCallback(() => {
    emit({ area: 'wallet', flow: 'disconnect', step: 'clear-state', status: 'info' });
    setState({
      provider: null,
      signer: null,
      address: null,
      chainId: null,
      isConnecting: false,
      error: null,
    });
  }, []);

  const switchToChain = useCallback(async (targetChainId: number) => {
    const target = CHAIN_REGISTRY[targetChainId];
    const step = beginStep({
      area: 'wallet',
      flow: 'switch-chain',
      step: 'wallet_switchEthereumChain',
      chainId: targetChainId,
    });
    const ethereum = getEthereum();
    if (!ethereum) {
      step.failure(null, { errorType: 'wallet', errorMessage: 'No wallet detected.' });
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
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: target.chainIdHex }],
      });
      step.success({ chainId: target.chainId });
    } catch (err) {
      const e = err as WalletProviderError;
      if (e.code === 4902) {
        try {
          await ethereum.request({
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

  // Listen for account and chain changes
  useEffect(() => {
    const ethereum = getEthereum();
    if (!ethereum) return;

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = (args[0] ?? []) as string[];
      if (accounts.length === 0) {
        disconnect();
      } else if (state.provider) {
        state.provider.getSigner().then((signer) => {
          setState((prev) => ({ ...prev, address: accounts[0], signer }));
        });
      }
    };

    // ethers v6 BrowserProvider caches the network on first getNetwork() call,
    // so we must rebuild the provider + signer when MetaMask switches chains —
    // otherwise signer.getChainId() keeps returning the old value and txs go
    // to the wrong network.
    const handleChainChanged = async () => {
      try {
        const nextProvider = new BrowserProvider(ethereum);
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
        emit({ area: 'wallet', flow: 'chain-changed', step: 'rebuild-provider', status: 'failure', errorMessage: (err as Error)?.message });
      }
    };

    ethereum.on('accountsChanged', handleAccountsChanged);
    ethereum.on('chainChanged', handleChainChanged);

    return () => {
      ethereum.removeListener('accountsChanged', handleAccountsChanged);
      ethereum.removeListener('chainChanged', handleChainChanged);
    };
    // `state.address` is read inside handleChainChanged to decide whether to
    // rebuild a signer. Without it in the deps, the handler would close over a
    // stale address after a late connect/disconnect.
  }, [state.provider, state.address, disconnect, updateChainId]);

  // Auto-reconnect if previously connected
  useEffect(() => {
    const ethereum = getEthereum();
    if (!ethereum) return;

    ethereum.request({ method: 'eth_accounts' }).then((result) => {
      const accounts = (result ?? []) as string[];
      if (accounts.length > 0) connect();
    });
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
