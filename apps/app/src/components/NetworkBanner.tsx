/**
 * Plain-language unsupported-network banner.
 *
 * Deliberately user-centred (per naive-user audit finding
 * F-20260702-004): says which networks work and offers the switch —
 * no internal rollout language, no phase numbers, no chain-id hex.
 * Renders nothing when the wallet is disconnected or already on a
 * supported chain.
 */
import { TriangleAlert } from 'lucide-react';
import { useActiveChain } from '../chain/useActiveChain';
import { supportedChainNames } from '../chain/chains';
import { copy } from '../content/copy';

export function NetworkBanner() {
  const { isConnected, onSupportedChain, switchToSupported, switchPending } =
    useActiveChain();

  if (!isConnected || onSupportedChain) return null;

  return (
    <div className="banner banner-warn" role="alert">
      <TriangleAlert aria-hidden />
      <div className="banner-body">
        <div className="banner-title">
          {copy.wallet.unsupportedNetwork(supportedChainNames())}
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          style={{ marginTop: 8 }}
          disabled={switchPending}
          onClick={() => switchToSupported()}
        >
          {copy.wallet.switchNetwork}
        </button>
      </div>
    </div>
  );
}
