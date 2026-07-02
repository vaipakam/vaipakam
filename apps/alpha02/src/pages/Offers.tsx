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
  const isLending = offer.offerType === 0;
  const isRentalListing = offer.assetType !== AssetType.ERC20 && isLending;
  // A rental listing's "lending asset" is the NFT contract and its
  // price lives in the prepay asset — never format it through the
  // ERC-20 loan template (it renders "… / 0% yearly / 0x0000…0000").
  const meta = useTokenMeta(isRentalListing ? undefined : offer.lendingAsset);
  const prepayMeta = useTokenMeta(isRentalListing ? offer.prepayAsset : undefined);
  const hasCollateral =
    offer.collateralAsset.toLowerCase() !==
    '0x0000000000000000000000000000000000000000';
  const collateralMeta = useTokenMeta(hasCollateral ? offer.collateralAsset : undefined);

  const notMine =
    !address || offer.creator.toLowerCase() !== address.toLowerCase();
  const acceptable =
    notMine &&
    (isRentalListing ||
      (offer.assetType === AssetType.ERC20 &&
        offer.collateralAssetType === AssetType.ERC20));
  const acceptHref = isRentalListing
    ? `/rent?offer=${offer.offerId}`
    : isLending
      ? `/borrow?offer=${offer.offerId}`
      : `/lend?offer=${offer.offerId}`;

  const title = isRentalListing
    ? `NFT rental · ${shortAddress(offer.lendingAsset)} #${offer.tokenId}${
        offer.assetType === AssetType.ERC1155 ? ` ×${offer.quantity}` : ''
      }`
    : `${isLending ? copy.offers.lenderOffer : copy.offers.borrowerOffer} · ${
        meta.data
          ? formatTokenAmount(
              isLending ? offer.amountMax : offer.amount,
              meta.data.decimals,
            )
          : '…'
      } ${meta.data?.symbol ?? ''}`;

  const sub = isRentalListing
    ? `${
        prepayMeta.data
          ? `${formatTokenAmount(offer.amount, prepayMeta.data.decimals)} ${prepayMeta.data.symbol}/day`
          : 'daily fee loading…'
      } · ${formatDurationDays(offer.durationDays)} · fees prepaid · by ${shortAddress(offer.creator)}`
    : `${formatBpsAsPercent(
        isLending ? offer.interestRateBps : offer.interestRateBpsMax,
      )} yearly · ${formatDurationDays(offer.durationDays)} · collateral ${
        hasCollateral
          ? (collateralMeta.data?.symbol ?? shortAddress(offer.collateralAsset))
          : 'none'
      } · by ${shortAddress(offer.creator)}`;

  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">{title}</span>
        <br />
        <span className="row-sub">{sub}</span>
      </span>
      {acceptable ? (
        <Link to={acceptHref} className="btn btn-primary btn-sm">
          {isRentalListing ? 'Rent this NFT' : 'Use this offer'}
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
