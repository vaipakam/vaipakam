/**
 * Per-loan keeper enables — the third leg of the Phase 6 trio. The
 * Settings whitelist alone executes nothing: each loan must also be
 * switched on for a keeper (setLoanKeeperEnabled, callable by either
 * position-NFT holder). Rendered only when the viewer has approved
 * keepers, so the surface never nags users who opted out.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWalletClient } from 'wagmi';
import { copy } from '../content/copy';
import { submitErrorText } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { useKeeperConfig, useLoanKeeperEnables } from '../data/keepers';
import { shortAddress } from '../lib/format';

export function LoanKeeperCard({
  loanId,
  busy,
  setBusy,
}: {
  loanId: number;
  /** The PAGE's shared write lock. */
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const config = useKeeperConfig();
  const keepers = (config.data?.keepers ?? []).map((k) => k.keeper);
  const enables = useLoanKeeperEnables(loanId, keepers, keepers.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // No approved keepers → nothing to manage; stay out of the way.
  if (!config.data || config.data.keepers.length === 0) return null;

  const walletReady = onSupportedChain && Boolean(walletClient);

  async function toggle(keeper: `0x${string}`, next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await write('setLoanKeeperEnabled', [BigInt(loanId), keeper, next]);
      setDone(next ? copy.keepers.loanToggleOn : copy.keepers.loanToggleOff);
      void queryClient.invalidateQueries({ queryKey: ['loanKeeperEnabled'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3>{copy.keepers.loanTitle}</h3>
      <p className="muted">{copy.keepers.loanBlurb}</p>
      {!config.data.enabled ? (
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">{copy.keepers.loanMasterOff}</span>
        </div>
      ) : null}
      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
        {config.data.keepers.map((entry) => {
          const on = enables.data?.[entry.keeper.toLowerCase()] ?? false;
          return (
            <label
              key={entry.keeper}
              className="cluster"
              style={{ alignItems: 'center' }}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={busy || !walletReady || enables.data === undefined}
                onChange={(e) => void toggle(entry.keeper, e.target.checked)}
              />
              <span>{shortAddress(entry.keeper)}</span>
            </label>
          );
        })}
      </div>
      {done ? (
        <div className="banner banner-info" role="status" style={{ marginTop: 12 }}>
          <span className="banner-body">{done}</span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}
