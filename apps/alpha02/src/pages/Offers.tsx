/**
 * Offer Book — a browse surface (advanced navigation, still readable
 * in plain language). Each ERC-20/ERC-20 row deep-links into the
 * guided flow's review step ("Use this offer" → /borrow?offer=N for
 * lending offers, /lend?offer=N for borrow requests), so accepting
 * from the book shares the exact receipt/checklist/signing path.
 *
 * Empty-state honesty rule (audit F-20260702-001): "no offers" is
 * only said when the indexer POSITIVELY returned zero offers; a
 * failed load shows the unavailable state instead.
 */
import { BookOpen, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { copy } from '../content/copy';
import { useActiveOffers } from '../data/hooks';
import { useActiveChain } from '../chain/useActiveChain';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { useTokenMeta } from '../contracts/erc20';
import { AssetType } from '../lib/types';
import {
  formatBpsAsPercent,
  formatDurationDays,
  formatTokenAmount,
  shortAddress,
} from '../lib/format';
import type { IndexedOffer } from '../data/indexer';

function OfferRow({ offer }: { offer: IndexedOffer }) {
  const { address } = useActiveChain();
  const meta = useTokenMeta(offer.lendingAsset);
  const collateralMeta = useTokenMeta(offer.collateralAsset);
  const isLending = offer.offerType === 0;
  const amount = meta.data
    ? formatTokenAmount(
        isLending ? offer.amountMax : offer.amount,
        meta.data.decimals,
      )
    : '…';
  const rate = isLending
    ? formatBpsAsPercent(offer.interestRateBps)
    : formatBpsAsPercent(offer.interestRateBpsMax);

  // "Use this offer" routes into the guided flow's review step. Only
  // ERC-20/ERC-20 offers for now (NFT legs need the rental/NFT-aware
  // approval surface), and never the creator's own offer.
  const acceptable =
    offer.assetType === AssetType.ERC20 &&
    offer.collateralAssetType === AssetType.ERC20 &&
    (!address || offer.creator.toLowerCase() !== address.toLowerCase());
  const acceptHref = isLending
    ? `/borrow?offer=${offer.offerId}`
    : `/lend?offer=${offer.offerId}`;

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
      {acceptable ? (
        <Link to={acceptHref} className="btn btn-primary btn-sm">
          Use this offer
        </Link>
      ) : (
        <span className={`badge ${isLending ? 'badge-info' : 'badge-neutral'}`}>
          {isLending ? 'Lender' : 'Borrower'}
        </span>
      )}
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
            “Use this offer” takes you through the same review-and-sign steps
            as the guided <Link to="/borrow">Borrow</Link> and{' '}
            <Link to="/lend">Lend</Link> flows.
          </p>
        </>
      )}
    </div>
  );
}
