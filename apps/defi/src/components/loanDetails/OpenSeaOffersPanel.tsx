/**
 * T-086 Round-5 Block C (#309 Mode B) + Round-6 Block D (#345) —
 * OpenSea Offers panel for the loan card. The English-auction surface
 * the borrower uses to match an off-chain signed Offer against their
 * locked collateral.
 *
 * Renders the polled offers list from `useOpenSeaOffers` and gives
 * the borrower a "Match offer" affordance per acceptable row.
 * "Match" goes through `useNFTPrepayListing.matchOpenSeaOffer` which
 * calls `NFTPrepayListingAtomicFacet.matchOpenSeaOffer` — a single
 * Seaport `matchAdvancedOrders` invocation that settles the bidder's
 * offer + the Vaipakam counter-order atomically inside the diamond.
 *
 * **No race window (Round-6 Block D):** pre-Round-6 the v1 flow ran
 * a two-step rotate-listing + fulfillOrder dance with a window during
 * which any buyer could front-run the matched bidder. Atomic
 * match-rotation closed that window structurally (PR #346) — the
 * borrower no longer needs to acknowledge a race warning before
 * Match; the modal just confirms intent.
 *
 * **Fee-enforced collections (PR #349 follow-up):** the agent's
 * signed-offer proxy wraps OpenSea Fulfillment Data so the panel can
 * Match SignedZone (fee-enforced) collections + criteria offers
 * end-to-end. The facet does the authoritative fee-sum check on-chain
 * at match time; the panel's threshold scaling is advisory polish.
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
   *  atomic-match modal. Wired to
   *  `useNFTPrepayListing.matchOpenSeaOffer` by the parent (T-086
   *  Round-6 Block D). */
  onMatchOffer: (offer: NormalizedOffer) => Promise<boolean>;
  /** Disables every "Match" button while another tx is mid-flight
   *  (parent passes `useNFTPrepayListing.actionLoading`). */
  actionLoading: boolean;
  /** True when the loan has no active listing. The panel renders
   *  a hint that the borrower must `postPrepayListing` first
   *  before offers can be matched, instead of an empty offers
   *  list with no explanation. */
  hasActiveListing: boolean;
  /** Codex P2 review #328 — decimals of the loan's principal token.
   *  v1 fee-free flow expects every acceptable offer to be paid in
   *  the loan's principal (the hook flags wrong-token offers as
   *  unacceptable), so a single decimals number drives the
   *  amount-rendering for both the row and the confirm modal.
   *  Without this, the panel formats every amount as if it were
   *  18-decimals — a 1,000 USDC offer (1e9 base units) shows as
   *  `0.000000` and looks worthless. */
  decimals: number;
}

export function OpenSeaOffersPanel({
  loanId,
  offersResult,
  onMatchOffer,
  actionLoading,
  // T-086 Round-6 / Block D (#345) — Codex PR #346 round-2 P2 #325.
  // `hasActiveListing` was previously the gate that hid the offers
  // list when no v1 listing existed; the atomic match path doesn't
  // require one (§17.11 step 0 handles `existingHash == 0`), so
  // the prop is now informational only — kept on the props
  // surface for any future caller that wants to show context
  // text but no longer consumed inside the panel.
  hasActiveListing: _hasActiveListing,
  decimals,
}: OpenSeaOffersPanelProps) {
  const { offers, loadingInitial, error, refresh } = offersResult;
  const [confirming, setConfirming] = useState<NormalizedOffer | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);

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
          Matching settles the offer atomically — the diamond's
          single transaction either delivers the collateral + pays
          out all the legs, or nothing changes on-chain.
        </div>

        {/* T-086 Round-6 / Block D (#345) — Codex PR #346 round-2
            P2 #325. The atomic match-rotation flow doesn't require
            a v1 listing (§17.11 step 0 supports `existingHash == 0`),
            so the "Post a fixed-price listing first" hint is stale;
            offers render whenever the loan is allowsPrepayListing.
            `hasActiveListing` is kept as a prop (the caller still
            knows whether a v1 listing is live for unrelated banners)
            but no longer gates the offers list. */}
        {loadingInitial && (
          <div className="action-row">Loading offers…</div>
        )}

        {!loadingInitial && offers.length === 0 && (
          <div className="action-row">
            No active offers right now. Refresh in 30 s.
          </div>
        )}

        {offers.length > 0 && (
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
                    <strong>{formatBigInt(offer.value, decimals)}</strong>{' '}
                    <span>{offer.paymentToken.slice(0, 10)}…</span>
                    {/* #336 — surface the quantity when > 1
                        (ERC1155). For ERC721 the value is always
                        1 and the label adds noise. */}
                    {offer.quantity > 1n && (
                      <span style={offerMetaStyle}>
                        {' '}× {offer.quantity.toString()} units
                      </span>
                    )}
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

        {/* #336 — partial-fill filter footnote. Bidders can place
            OpenSea offers for a partial number of ERC1155 units
            (e.g. 1 of 5 locked); the dapp filters those because
            the canonical Seaport order pins the full vaulted
            quantity. The filter is silent (no rejected-with-
            reason row), so this note tells the borrower why
            their inbox of "offers visible on OpenSea" may be
            larger than what the panel surfaces. */}
        <div className="text-muted" style={partialFillNoteStyle}>
          Note: partial-fill collection offers (different quantity
          than your locked lot) stay on OpenSea's marketplace but
          don't appear here — they can't be matched through the
          dapp.
        </div>
      </div>

      {confirming && (
        <ConfirmMatchModal
          offer={confirming}
          decimals={decimals}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const target = confirming;
            setConfirming(null);
            // Codex P1 review #328 — revalidate before sending the
            // rotation tx. Between the borrower opening the modal
            // and clicking Match, the offer can be cancelled /
            // filled / expired / drained from the bidder's wallet
            // (the polling refreshes every 30 s, but the modal can
            // sit open longer than that). A stale match would
            // rotate the listing down to a price no one can
            // fulfill at — only an unrelated sniper could.
            //
            // Codex round-3 P1 review #328 — read the refreshed
            // offers array directly from the `refresh()` return
            // value, NOT `offersResult.offers`. The latter is the
            // render-closure capture from when this modal opened;
            // React doesn't mutate it synchronously when
            // `refresh()` calls setState. Without the direct
            // return-value read, the stale-offer guard would
            // happily find the now-removed/changed row and let
            // the rotation tx fire.
            const refreshed = await offersResult.refresh();
            const fresh = refreshed.find(
              (o) => o.orderHash === target.orderHash,
            );
            if (
              !fresh ||
              !fresh.acceptable ||
              fresh.value !== target.value
            ) {
              setStaleNotice(
                fresh
                  ? `Offer at ${fresh.value} no longer matches the previewed value (${target.value}). Reopen Match to confirm.`
                  : 'Offer is no longer available. Refreshing the list.',
              );
              return;
            }
            await onMatchOffer(target);
          }}
          actionLoading={actionLoading}
        />
      )}
      {staleNotice && (
        <div className="alert alert-warning" style={{ marginTop: 8 }}>
          {staleNotice}
        </div>
      )}
    </div>
  );
}

interface ConfirmMatchModalProps {
  offer: NormalizedOffer;
  decimals: number;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  actionLoading: boolean;
}

/** Confirm dialog for matching an OpenSea offer atomically.
 *
 *  Pre-Round-6 this surfaced a "race-window warning" — the v1
 *  two-step cancel + post left a window during which any buyer
 *  (not just the matched bidder) could fulfill the rotated listing.
 *  Round-6 Block D's atomic match-rotation closed that window
 *  structurally (single Seaport `matchAdvancedOrders` call settles
 *  cancel + replacement + bidder fill in one tx); see #348
 *  follow-up for the modal copy refresh that retired the
 *  race-window framing. The modal now just confirms the borrower
 *  intends to match at the offer's price. */
function ConfirmMatchModal({
  offer,
  decimals,
  onCancel,
  onConfirm,
  actionLoading,
}: ConfirmMatchModalProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-match-modal-title"
      style={modalBackdropStyle}
    >
      <div className="card" style={modalCardStyle}>
        <h3 id="confirm-match-modal-title">
          Match this offer at {formatBigInt(offer.value, decimals)}?
        </h3>
        <p>
          The whole rotation — cancel any live listing, settle this
          bidder's offer, deliver the collateral, pay the protocol
          legs, return the remainder to you — runs in a single
          transaction. Either every step succeeds together, or
          nothing changes on-chain.
        </p>
        {/* T-086 Block D follow-up (#348) — the cross-link to the
            Advanced User Guide's "Matching OpenSea offers" section
            is dropped here. That section still describes the v1
            race-window flow this PR retired; pointing borrowers at
            it from the new atomic confirm dialog would surface
            conflicting instructions. The user guide refresh +
            re-translate across the 9 supported locales is tracked
            as a separate Block D follow-up; until that lands the
            modal stays a clean confirm-only dialog. */}
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

function formatBigInt(v: bigint, decimals: number): string {
  // Codex P2 review #328 — caller passes the loan's principal-token
  // decimals so non-18-decimal ERC20s (USDC = 6, USDT = 6, WBTC = 8)
  // render correctly. Without this, a 1,000 USDC offer
  // (1_000_000_000 base units) shows as `0.000000` and looks
  // worthless to the borrower. Quick & cheap rendering — pulling
  // in the loan card's `format` module would add a Vite-coupled
  // dep to the offers panel; this six-fractional-digit form is
  // fine for the offer-comparison surface.
  const s = v.toString();
  if (s.length <= decimals) {
    const padded = s.padStart(decimals, '0');
    return `0.${padded.slice(0, Math.min(6, decimals))}`;
  }
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals, s.length - decimals + Math.min(6, decimals));
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

const partialFillNoteStyle = {
  fontSize: '0.85em',
  marginTop: '0.5rem',
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
