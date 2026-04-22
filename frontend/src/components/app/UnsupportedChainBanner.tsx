import { AlertTriangle } from 'lucide-react';
import { useWallet } from '../../context/WalletContext';
import { CHAIN_REGISTRY, DEFAULT_CHAIN, isChainRegistered } from '../../contracts/config';

/**
 * Surfaces a persistent warning when the connected wallet is on a chain the
 * app has no Diamond deploy for. Complements the Navbar / AppLayout
 * "Switch Network" button by giving a visible explanation of *why* every
 * protocol action is blocked, rather than relying on the user to notice
 * the warning colour on a small button.
 *
 * Phase 1 deploys a separate Diamond per supported network (see
 * docs/WebsiteReadme.md — "Connected-app network model in Phase 1"), so the
 * copy distinguishes between networks that are already live and ones the
 * registry knows about but hasn't deployed on yet.
 *
 * Hidden when no wallet is connected (public read-only flows don't depend
 * on the wallet's chain) or when the wallet's chain is supported.
 */
export function UnsupportedChainBanner() {
  const { address, chainId, isCorrectChain, switchToDefaultChain } = useWallet();

  if (!address || isCorrectChain) return null;

  const allRegistered = Object.values(CHAIN_REGISTRY);
  const liveChains = allRegistered.filter((c) => c.diamondAddress !== null);
  const pendingChains = allRegistered.filter(
    (c) => c.diamondAddress === null && !c.testnet,
  );

  const liveList = liveChains.map((c) => c.name).join(', ') || '—';
  const pendingList = pendingChains.map((c) => c.name).join(', ');
  const walletChain = chainId ?? 'unknown';
  const walletChainRecognised = isChainRegistered(chainId);

  return (
    <div
      className="app-wallet-error"
      style={{
        background: 'rgba(234, 179, 8, 0.12)',
        color: 'var(--accent-yellow, #eab308)',
        borderBottom: '1px solid rgba(234, 179, 8, 0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      }}
      role="alert"
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <AlertTriangle size={16} />
        <span>
          {walletChainRecognised ? 'Phase 1 Diamond pending' : 'Unsupported network'}{' '}
          (chainId {walletChain}). Vaipakam runs as a separate Diamond on each
          supported network — currently live on: {liveList}.
          {pendingList && (
            <>
              {' '}Mainnet rollout to {pendingList} is planned for Phase 1.
            </>
          )}
          {' '}Protocol actions are disabled until you switch to a supported network.
        </span>
      </span>
      <button
        type="button"
        className="btn btn-warning btn-sm"
        onClick={switchToDefaultChain}
      >
        Switch to {DEFAULT_CHAIN.name}
      </button>
    </div>
  );
}
