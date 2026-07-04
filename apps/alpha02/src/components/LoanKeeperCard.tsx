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
  const { onSupportedChain, readChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const config = useKeeperConfig();
  const keepers = (config.data?.keepers ?? []).map((k) => k.keeper);
  const enables = useLoanKeeperEnables(loanId, keepers, keepers.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!config.data) {
    // Initial-load failure must not be a silent absence — a user who
    // set keepers up would read "gone" into a missing card.
    if (config.isError) {
      return (
        <section className="card">
          <h3>{copy.keepers.loanTitle}</h3>
          <p className="muted">{copy.keepers.unavailable}</p>
        </section>
      );
    }
    return null;
  }
  // Zero keepers: a one-line pointer keeps the third leg
  // discoverable from the loan page without nagging.
  if (config.data.keepers.length === 0) {
    return (
      <section className="card">
        <h3>{copy.keepers.loanTitle}</h3>
        <p className="muted">{copy.keepers.loanNoKeepers}</p>
      </section>
    );
  }

  const walletReady = onSupportedChain && Boolean(walletClient);

  async function toggle(keeper: `0x${string}`, next: boolean) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await write('setLoanKeeperEnabled', [BigInt(loanId), keeper, next]);
      setDone(next ? copy.keepers.loanToggleOn : copy.keepers.loanToggleOff);
      // Read-after-write honesty: the tx is MINED, so `next` IS the
      // chain state — but an immediate invalidate refetches through a
      // possibly-lagging public RPC and can bounce the checkbox back
      // to the pre-tx value (inviting a duplicate tx). Patch ONLY this
      // loan's cache entry (exact key incl. chain + loanId — a
      // root-key patch would stamp the toggle onto every OTHER loan's
      // card); the 60s interval reconciles once the RPC catches up.
      queryClient.setQueryData(
        [
          'loanKeeperEnabled',
          readChain.chainId,
          loanId,
          [...keepers].sort().join(','),
        ],
        (old: Record<string, boolean> | undefined) =>
          old ? { ...old, [keeper.toLowerCase()]: next } : old,
      );
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
      {enables.isError ? (
        <p className="muted">{copy.keepers.loanEnablesUnavailable}</p>
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
                // isError with RETAINED data still pauses the
                // toggles — the copy promises exactly that, and the
                // retained snapshot may be stale.
                disabled={
                  busy ||
                  !walletReady ||
                  enables.data === undefined ||
                  enables.isError
                }
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
