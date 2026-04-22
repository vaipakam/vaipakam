import { AlertTriangle } from 'lucide-react';
import { useWallet } from '../../context/WalletContext';
import { useEscrowUpgrade } from '../../hooks/useEscrowUpgrade';

/**
 * Surfaces the README-required forced-upgrade flow (see README §"Escrow
 * Upgrades", lines 960 & 1100). When governance raises the mandatory escrow
 * version above a user's current version, `getOrCreateUserEscrow` reverts
 * `EscrowUpgradeRequired()`, which would otherwise block every diamond flow
 * that touches the user's escrow (offer creation, accept, repay, claim, ...).
 *
 * Rendering this banner at the layout level gives the user a direct,
 * actionable CTA before they hit a revert on any page.
 */
export function EscrowUpgradeBanner() {
  const { address, isCorrectChain } = useWallet();
  const { info, upgrading, error, txHash, upgrade } = useEscrowUpgrade(
    isCorrectChain ? address : null,
  );

  if (!info || !info.upgradeRequired) return null;

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
          Escrow upgrade required — your escrow is at v{info.userVersion.toString()}, mandatory floor is v
          {info.mandatoryVersion.toString()} (latest v{info.currentVersion.toString()}). Diamond flows
          will revert until you upgrade.
        </span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {error && <span style={{ fontSize: '0.78rem' }}>{error}</span>}
        {txHash && !upgrading && (
          <span style={{ fontSize: '0.78rem' }} className="mono">
            tx {txHash.slice(0, 10)}…
          </span>
        )}
        <button
          type="button"
          className="btn btn-warning btn-sm"
          onClick={upgrade}
          disabled={upgrading}
        >
          {upgrading ? 'Upgrading…' : 'Upgrade Escrow'}
        </button>
      </span>
    </div>
  );
}
