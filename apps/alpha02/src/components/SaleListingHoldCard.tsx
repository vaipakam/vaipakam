/**
 * Borrower-side notice for a lender-sale listing on THEIR loan
 * (#1503 PR-A follow-up). Two states, both chain-derived (see
 * data/saleListingHold.ts — the state IS the teardown probe):
 *
 *  - `live`: a bounded listing stands. Explains exactly which options
 *    are held (preclose + collateral withdrawal), which stay open
 *    (full/partial repay), and the structural bound on how long the
 *    hold can last. No action — the contracts refuse teardown while
 *    the listing is live, so no button is shown for a transaction
 *    that would revert.
 *
 *  - `clearable`: the listing has ended (expired, legacy GTC, or the
 *    loan reached a terminal state) but the hold persists until the
 *    one-time permissionless cleanup runs. One button sends
 *    `teardownStaleSaleListing(loanId)` — deliberately available
 *    even while the protocol is paused (the entry moves no value).
 *
 * The borrower is exactly who the PR-A action window exists for, so
 * this card is the surface where that escape actually reaches them.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Hourglass } from 'lucide-react';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useDiamondWrite } from '../contracts/diamond';
import type { SaleListingHoldState } from '../data/saleListingHold';

export function SaleListingHoldCard({
  loanId,
  state,
}: {
  loanId: number;
  state: SaleListingHoldState;
}) {
  const { write, ready } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);

  if (state !== 'live' && state !== 'clearable' && !cleared) return null;

  async function freeOptions() {
    setError(null);
    setBusy(true);
    try {
      await write('teardownStaleSaleListing', [BigInt(loanId)]);
      setCleared(true);
      void queryClient.invalidateQueries({
        queryKey: ['saleListingHold'],
      });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-testid="sale-listing-hold-card">
      <div className="card-title">
        <Hourglass aria-hidden />
        <h3 style={{ margin: 0 }}>{copy.saleHold.title}</h3>
      </div>
      {cleared ? (
        <p className="muted">{copy.saleHold.clearedNote}</p>
      ) : state === 'live' ? (
        <>
          <p className="muted">{copy.saleHold.liveBody}</p>
          <p className="field-hint">{copy.saleHold.liveEnds}</p>
        </>
      ) : (
        <>
          <p className="muted">{copy.saleHold.clearableBody}</p>
          {error ? (
            <div
              className="banner banner-danger"
              role="alert"
              style={{ marginBottom: 12 }}
            >
              {error}
            </div>
          ) : null}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void freeOptions()}
            disabled={busy || !ready}
            data-testid="free-held-options"
          >
            {busy ? copy.saleHold.workingDots : copy.saleHold.clearableAction}
          </button>
        </>
      )}
    </section>
  );
}
