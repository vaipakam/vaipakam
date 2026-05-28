import { Tag, Clock, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TokenAmount } from '../app/TokenAmount';
import { AddressDisplay } from '../app/AddressDisplay';
import { openSeaAssetUrl } from '@vaipakam/lib/prepayOrderShape';
import type { IndexedPrepayListing } from '../../lib/indexerClient';

interface Props {
  listing: IndexedPrepayListing;
  /** Principal asset (loan.principalAsset) — controls TokenAmount decimals
   *  and symbol the ask-price renders against. */
  principalAsset: string;
  /** Active chain id — drives the OpenSea deep-link host + slug. */
  chainId: number;
  /** Collateral NFT contract address — `loan.collateralAsset`. The
   *  OpenSea asset URL points at the marketplace page for this
   *  contract + token id, where the live listing surfaces once
   *  OpenSea has ingested it (frontend-direct path: ~3-10s after
   *  tx-confirm; indexer-autonomous fallback: ~30-90s). */
  collateralAsset: string;
  /** Collateral NFT token id — `loan.collateralTokenId`. */
  collateralTokenId: bigint;
}

/**
 * T-086 step 13 — informational banner shown on the loan-details page
 * when a Seaport prepay listing is live for the loan.
 *
 * Visible to everyone (lender, borrower, third-party viewer); the borrower
 * gets the management surface (update / cancel) inside the Actions card
 * via `PrepayListingActions`. This banner is read-only.
 *
 * State signal: green when `now < gracePeriodEnd` (active), grey when the
 * grace window has closed (permissionless cancelExpired is now callable
 * but the listing hasn't been swept yet).
 */
export function PrepayListingBanner({
  listing,
  principalAsset,
  chainId,
  collateralAsset,
  collateralTokenId,
}: Props) {
  const { t } = useTranslation();
  const now = Math.floor(Date.now() / 1000);
  // Strict `>` to match `CollateralListingExecutor`'s boundary
  // (`block.timestamp > pctx.graceEnd` rejects fills). The exact
  // `endTime + grace` tick is still fillable on-chain. Codex
  // round-4 P3 fix on PR #308.
  const graceClosed = now > listing.gracePeriodEnd;
  const secondsLeft = Math.max(0, listing.gracePeriodEnd - now);
  const daysLeft = Math.floor(secondsLeft / 86400);
  const hoursLeft = Math.floor((secondsLeft % 86400) / 3600);

  const stateColor = graceClosed
    ? 'rgba(160,160,160,0.4)'
    : 'rgba(0,255,136,0.4)';
  const stateBg = graceClosed
    ? 'rgba(160,160,160,0.08)'
    : 'rgba(0,255,136,0.08)';

  // T-086 step 14 — OpenSea asset URL is deterministic from the
  // collateral contract + token id; the listing surfaces here once
  // OpenSea has ingested the publish (frontend-direct path: seconds;
  // indexer-autonomous fallback: ~minute). Returns null when the
  // active chain isn't on OpenSea's supported chain list — banner
  // then omits the link without breaking.
  const openseaUrl = openSeaAssetUrl(chainId, collateralAsset, collateralTokenId);

  return (
    <div
      className="card"
      style={{
        border: `1px solid ${stateColor}`,
        background: stateBg,
        marginBottom: 16,
      }}
    >
      <div
        className="card-title"
        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <Tag size={16} />
        {t('prepayListing.banner.title')}
      </div>

      <div className="data-row">
        <span className="data-label">{t('prepayListing.banner.askPrice')}</span>
        <span className="data-value">
          <TokenAmount
            amount={BigInt(listing.askPrice)}
            address={principalAsset}
            withSymbol
          />
        </span>
      </div>

      <div className="data-row">
        <span className="data-label">{t('prepayListing.banner.orderHash')}</span>
        {/* Plain text — the orderHash is a Seaport-internal EIP-712
            digest, NOT a transaction hash. Block explorers won't
            resolve it under `/tx/`; linking there would 404 every
            time. The posting transaction hash isn't carried on the
            indexer payload yet (separate follow-up — see release-note
            fragment), so we render the order hash without a link. */}
        <span
          className="data-value"
          style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
          title={listing.orderHash}
        >
          {listing.orderHash.slice(0, 10)}…{listing.orderHash.slice(-8)}
        </span>
      </div>

      <div className="data-row">
        <span className="data-label">{t('prepayListing.banner.conduit')}</span>
        <span className="data-value">
          <AddressDisplay address={listing.conduit} compact />
        </span>
      </div>

      <div className="data-row">
        <span className="data-label">{t('prepayListing.banner.lister')}</span>
        <span className="data-value">
          <AddressDisplay address={listing.lister} compact />
        </span>
      </div>

      <div className="data-row">
        <span
          className="data-label"
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <Clock size={12} />
          {t('prepayListing.banner.graceEnds')}
        </span>
        <span className="data-value">
          {graceClosed
            ? t('prepayListing.banner.graceClosed')
            : daysLeft > 0
              ? t('prepayListing.banner.graceLeftDaysHours', {
                  days: daysLeft,
                  hours: hoursLeft,
                })
              : t('prepayListing.banner.graceLeftHours', {
                  hours: hoursLeft,
                })}
        </span>
      </div>

      {graceClosed && (
        <p
          className="action-desc"
          style={{ marginTop: 8, fontSize: '0.85rem' }}
        >
          {t('prepayListing.banner.graceClosedHint')}
        </p>
      )}

      {/* T-086 step 14 — OpenSea marketplace deep-link. Visible
          whenever a listing is live + the active chain is on
          OpenSea's supported chain set. The link lands on the
          collateral asset's marketplace page; the live listing
          appears once OpenSea has ingested the publish (frontend
          push: seconds; indexer fallback: minute). */}
      {!graceClosed && openseaUrl && (
        <div style={{ marginTop: 12 }}>
          <a
            href={openseaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary btn-sm"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: '0.85rem',
            }}
          >
            {t('prepayListing.banner.viewOnOpenSea')}
            <ExternalLink size={14} />
          </a>
        </div>
      )}
    </div>
  );
}
