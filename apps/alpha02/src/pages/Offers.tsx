/**
 * Offer Book — a browse surface (advanced navigation, still readable
 * in plain language). Accepting an offer from here is the next
 * alpha02 milestone; for now rows explain the market and guide users
 * into the guided flows.
 *
 * Empty-state honesty rule (audit F-20260702-001): "no offers" is
 * only said when the indexer POSITIVELY returned zero offers; a
 * failed load shows the unavailable state instead.
 */
import { BookOpen, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { copy } from '../content/copy';
import { useActiveOffers } from '../data/hooks';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { useTokenMeta } from '../contracts/erc20';
import {
  formatBpsAsPercent,
  formatDurationDays,
  formatTokenAmount,
  shortAddress,
} from '../lib/format';
import type { IndexedOffer } from '../data/indexer';

function OfferRow({ offer }: { offer: IndexedOffer }) {
  const meta = useTokenMeta(offer.lendingAsset);
  const collateralMeta = useTokenMeta(offer.collateralAsset);
  const isLending = offer.offerType === 0;
  const amount = meta.data
    ? formatTokenAmount(offer.amountMax, meta.data.decimals)
    : '…';
  const rate = isLending
    ? formatBpsAsPercent(offer.interestRateBps)
    : formatBpsAsPercent(offer.interestRateBpsMax);

  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">
          {isLending ? copy.offers.lenderOffer : copy.offers.borrowerOffer} ·{' '}
          {amount} {meta.data?.symbol ?? ''}
        </span>
        <br />
        <span className="row-sub">
          {rate} yearly · {formatDurationDays(offer.durationDays)} · collateral{' '}
          {collateralMeta.data?.symbol ?? shortAddress(offer.collateralAsset)} · by{' '}
          {shortAddress(offer.creator)}
        </span>
      </span>
      <span className={`badge ${isLending ? 'badge-info' : 'badge-neutral'}`}>
        {isLending ? 'Lender' : 'Borrower'}
      </span>
    </div>
  );
}

export function Offers() {
  const offers = useActiveOffers();

  return (
    <div>
      <h1 className="page-title">{copy.offers.title}</h1>
      <p className="page-lede">{copy.offers.lede}</p>

      {offers.isLoading ? (
        <EmptyState icon={LoaderCircle} title="Loading the offer book…" />
      ) : offers.data === null || offers.data === undefined ? (
        <UnavailableState body={copy.offers.unavailable} />
      ) : offers.data.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={copy.offers.emptyTitle}
          body={copy.offers.emptyBody}
          action={
            <Link to="/" className="btn btn-primary">
              Create an offer
            </Link>
          }
        />
      ) : (
        <>
          <div className="row-list">
            {offers.data.map((o) => (
              <OfferRow key={o.offerId} offer={o} />
            ))}
          </div>
          <p className="muted" style={{ marginTop: 16 }}>
            To take one of these, use the guided{' '}
            <Link to="/borrow">Borrow</Link> or <Link to="/lend">Lend</Link>{' '}
            flows — one-tap accept from this page arrives in an upcoming
            alpha02 build.
          </p>
        </>
      )}
    </div>
  );
}
