import { Tag, Clock, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TokenAmount } from '../app/TokenAmount';
import { AddressDisplay } from '../app/AddressDisplay';
import type { IndexedPrepayListing } from '../../lib/indexerClient';

interface Props {
  listing: IndexedPrepayListing;
  /** Principal asset (loan.principalAsset) — controls TokenAmount decimals
   *  and symbol the ask-price renders against. */
  principalAsset: string;
  /** Block explorer base URL for the active chain. Used to deep-link the
   *  orderHash to an explorer "see this Seaport order" lookup. Pass `null`
   *  to suppress the link. */
  blockExplorer: string | null;
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
export function PrepayListingBanner({ listing, principalAsset, blockExplorer }: Props) {
  const { t } = useTranslation();
  const now = Math.floor(Date.now() / 1000);
  const graceClosed = now >= listing.gracePeriodEnd;
  const secondsLeft = Math.max(0, listing.gracePeriodEnd - now);
  const daysLeft = Math.floor(secondsLeft / 86400);
  const hoursLeft = Math.floor((secondsLeft % 86400) / 3600);

  const stateColor = graceClosed
    ? 'rgba(160,160,160,0.4)'
    : 'rgba(0,255,136,0.4)';
  const stateBg = graceClosed
    ? 'rgba(160,160,160,0.08)'
    : 'rgba(0,255,136,0.08)';

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
        <span className="data-value" style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
          {listing.orderHash.slice(0, 10)}…{listing.orderHash.slice(-8)}
          {blockExplorer && (
            <a
              href={`${blockExplorer}/tx/${listing.orderHash}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: 6, verticalAlign: 'middle' }}
              aria-label={t('prepayListing.banner.viewOnExplorer')}
            >
              <ExternalLink size={12} />
            </a>
          )}
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
    </div>
  );
}
