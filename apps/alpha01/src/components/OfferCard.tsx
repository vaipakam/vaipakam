import type { IndexedOffer } from '@vaipakam/defi-client';
import { formatBpsAsPercent, OFFER_TYPE_LENDER } from '@vaipakam/defi-client';
import { AssetAmount } from './AssetAmount';
import { AssetSymbolLink } from './AssetSymbolLink';
import { useTokenMeta } from '../lib/tokenMeta';

interface Props {
  offer: IndexedOffer;
}

export function OfferCard({ offer }: Props) {
  const lendingMeta = useTokenMeta(offer.lendingAsset || null);
  const collateralMeta = useTokenMeta(offer.collateralAsset || null);
  const isLender = offer.offerType === OFFER_TYPE_LENDER;
  const rateBps = isLender ? offer.interestRateBps : offer.interestRateBpsMax;

  return (
    <div className="position-card position-card--static">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong>
          {isLender ? 'Lending offer' : 'Borrow request'} #{offer.offerId}
        </strong>
        <span style={{ color: 'var(--accent-green)', fontSize: '0.85rem' }}>Open</span>
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        <AssetSymbolLink address={offer.lendingAsset} meta={lendingMeta} /> · {offer.durationDays} days ·{' '}
        {formatBpsAsPercent(rateBps)}
      </div>
      <div style={{ fontSize: '0.85rem' }}>
        {isLender ? 'Lending ' : 'Borrowing '}
        <AssetAmount
          mode={isLender ? 'raw' : 'human'}
          amount={isLender ? offer.amountMax || offer.amount : offer.amount}
          address={offer.lendingAsset}
          meta={lendingMeta}
          assetType={offer.assetType}
          tokenId={offer.tokenId}
        />
        {' · Lock '}
        <AssetAmount
          mode="raw"
          amount={offer.collateralAmount}
          address={offer.collateralAsset}
          meta={collateralMeta}
          assetType={offer.collateralAssetType}
          tokenId={offer.collateralTokenId}
        />
      </div>
    </div>
  );
}