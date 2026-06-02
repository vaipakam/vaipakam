/**
 * T-086 Round-5 Block C (#309 Mode B) — OpenSea Offers panel for
 * the loan card. The pragmatic English-auction surface.
 *
 * Renders the polled offers list from `useOpenSeaOffers` and gives
 * the borrower a "Match offer" affordance per acceptable row.
 * "Match" goes through `useNFTPrepayListing.updatePrepayListing`
 * which rotates the canonical Seaport order to the offer's price —
 * any buyer can then call `Seaport.fulfillOrder` against the new
 * order to settle.
 *
 * **Race-window warning (§15.3 line ~480, Codex P2):** the borrower
 * is told upfront that the matched order is fulfillable by ANY
 * buyer between `updatePrepayListing` and the bidder's
 * `fulfillOrder`. The warning copy is the dapp-side mitigation
 * (the v2 escape hatch is the atomic match-rotation flow; v1 ships
 * with the visible race).
 *
 * **Fee-free scope (this PR ships):** the threshold computed by
 * the hook collapses to `(lenderLeg + treasuryLeg) × (1 +
 * bufferBps/10000)`. The "Match offer" call passes empty
 * `feeLegs[]`. Fee-enforced collections will plug a follow-up that
 * fetches the OpenSea collection schedule at match time + threads
 * the recomputed `feeLegs` through (per §15.3's "re-fetch on every
 * match-offer click" rule).
 */

import { useState } from 'react';
import type {
  NormalizedOffer,
  UseOpenSeaOffersResult,
} from '../../hooks/useOpenSeaOffers';

export interface OpenSeaOffersPanelProps {
  loanId: bigint;
  offersResult: UseOpenSeaOffersResult;
  /** Called when the borrower clicks "Match offer" + confirms the
   *  race-window warning. Wired to
   *  `useNFTPrepayListing.updatePrepayListing` by the parent. */
  onMatchOffer: (offer: NormalizedOffer) => Promise<boolean>;
  /** Disables every "Match" button while another tx is mid-flight
   *  (parent passes `useNFTPrepayListing.actionLoading`). */
  actionLoading: boolean;
  /** True when the loan has no active listing. The panel renders
   *  a hint that the borrower must `postPrepayListing` first
   *  before offers can be matched, instead of an empty offers
   *  list with no explanation. */
  hasActiveListing: boolean;
}

export function OpenSeaOffersPanel({
  loanId,
  offersResult,
  onMatchOffer,
  actionLoading,
  hasActiveListing,
}: OpenSeaOffersPanelProps) {
  const { offers, loadingInitial, error, refresh } = offersResult;
  const [confirming, setConfirming] = useState<NormalizedOffer | null>(null);

  return (
    <div
      id={`opensea-offers-panel-${loanId}`}
      className="card loan-actions-card"
    >
      <div className="action-group">
        <div className="action-title">OpenSea Offers (English mode)</div>
        <div className="action-subtitle">
          Bidders' offers for your collateral. Acceptable rows cover
          the protocol-leg floor plus your configured buffer.
          Matching rotates your listing to the offer's price — any
          buyer can then settle.
        </div>

        {!hasActiveListing && (
          <div className="alert alert-info">
            Post a fixed-price listing first. Offers will surface
            here once they land on OpenSea.
          </div>
        )}

        {hasActiveListing && loadingInitial && (
          <div className="action-row">Loading offers…</div>
        )}

        {hasActiveListing && !loadingInitial && offers.length === 0 && (
          <div className="action-row">
            No active offers right now. Refresh in 30 s.
          </div>
        )}

        {hasActiveListing && offers.length > 0 && (
          <ul className="opensea-offers-list" style={offerListStyle}>
            {offers.map((offer) => (
              <li
                key={offer.orderHash}
                style={{
                  ...offerRowStyle,
                  opacity: offer.acceptable ? 1 : 0.45,
                }}
              >
                <div style={offerRowBodyStyle}>
                  <div>
                    <strong>{formatBigInt(offer.value)}</strong>{' '}
                    <span>{offer.paymentToken.slice(0, 10)}…</span>
                  </div>
                  <div style={offerMetaStyle}>
                    {offer.kind} · bidder{' '}
                    {offer.bidder.slice(0, 8)}… · ends{' '}
                    {offer.endTime
                      ? new Date(offer.endTime * 1000).toLocaleString()
                      : '—'}
                  </div>
                  {!offer.acceptable && (
                    <div className="text-muted">
                      not actionable:{' '}
                      {offer.rejectReason ?? 'unknown'}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!offer.acceptable || actionLoading}
                  onClick={() => setConfirming(offer)}
                >
                  Match offer
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && (
          <details>
            <summary className="text-muted">Diagnostics</summary>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{error}</pre>
          </details>
        )}

        <div className="action-row">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              void refresh();
            }}
          >
            Refresh now
          </button>
        </div>
      </div>

      {confirming && (
        <RaceWindowModal
          offer={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const target = confirming;
            setConfirming(null);
            await onMatchOffer(target);
          }}
          actionLoading={actionLoading}
        />
      )}
    </div>
  );
}

interface RaceWindowModalProps {
  offer: NormalizedOffer;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  actionLoading: boolean;
}

/** The race-window warning is the dapp-side mitigation for the
 *  §15.3 v1 trade-off: any buyer can fulfill the matched listing
 *  between the borrower's `updatePrepayListing` and the bidder's
 *  `fulfillOrder`. The borrower must acknowledge before the call
 *  goes through. */
function RaceWindowModal({
  offer,
  onCancel,
  onConfirm,
  actionLoading,
}: RaceWindowModalProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="race-window-modal-title"
      style={modalBackdropStyle}
    >
      <div className="card" style={modalCardStyle}>
        <h3 id="race-window-modal-title">
          Match this offer at {formatBigInt(offer.value)}?
        </h3>
        <p>
          Once you match, your listing rotates to this offer's
          price. <strong>Any buyer</strong> — not just this bidder —
          can fulfill at the matched price for the next few minutes.
        </p>
        <p>
          Notify your bidder ({offer.bidder.slice(0, 12)}…) before
          clicking Match so they can complete the purchase before
          someone else snipes it.
        </p>
        <div className="action-row">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={actionLoading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void onConfirm();
            }}
            disabled={actionLoading}
          >
            {actionLoading ? 'Matching…' : 'Match offer'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatBigInt(v: bigint): string {
  // Quick & cheap rendering — the loan card already imports a
  // formatter via the format module, but pulling it in here would
  // add a Vite-coupled dep to the offers panel for very little
  // gain. Tens-of-Eth precision is fine for the offer-comparison
  // surface.
  const s = v.toString();
  if (s.length <= 18) return `0.${s.padStart(18, '0').slice(0, 6)}`;
  const whole = s.slice(0, s.length - 18);
  const frac = s.slice(s.length - 18, s.length - 18 + 6);
  return `${whole}.${frac}`;
}

const offerListStyle = {
  listStyle: 'none' as const,
  padding: 0,
  margin: 0,
};

const offerRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '8px 0',
  borderBottom: '1px solid var(--border-color, #e0e0e0)',
};

const offerRowBodyStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '2px',
};

const offerMetaStyle = {
  fontSize: '0.85em',
  color: 'var(--text-muted, #666)',
};

const modalBackdropStyle = {
  position: 'fixed' as const,
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const modalCardStyle = {
  maxWidth: '480px',
  padding: '24px',
};
