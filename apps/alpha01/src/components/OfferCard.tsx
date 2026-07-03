import type { IndexedOffer } from '@vaipakam/defi-client';
import { ASSET_TYPE_ERC1155, formatBpsAsPercent, OFFER_TYPE_LENDER } from '@vaipakam/defi-client';
import { AssetAmount } from './AssetAmount';
import { AssetSymbolLink } from './AssetSymbolLink';
import { useTokenMeta } from '../lib/tokenMeta';

interface Props {
  offer: IndexedOffer;
  onCancel?: () => void;
  cancelling?: boolean;
}

export function OfferCard({ offer, onCancel, cancelling = false }: Props) {
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
          mode="raw"
          amount={isLender ? offer.amountMax || offer.amount : offer.amount}
          address={offer.lendingAsset}
          meta={lendingMeta}
          assetType={offer.assetType}
          tokenId={offer.tokenId}
        />
        {' · Lock '}
        <AssetAmount
          mode="raw"
          amount={
            offer.collateralAssetType === ASSET_TYPE_ERC1155
              ? offer.collateralQuantity
              : offer.collateralAmount
          }
          address={offer.collateralAsset}
          meta={collateralMeta}
          assetType={offer.collateralAssetType}
          tokenId={offer.collateralTokenId}
        />
      </div>
      {onCancel ? (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={cancelling}
            onClick={onCancel}
          >
            {cancelling ? 'Cancelling…' : 'Cancel offer'}
          </button>
        </div>
      ) : null}
    </div>
  );
}