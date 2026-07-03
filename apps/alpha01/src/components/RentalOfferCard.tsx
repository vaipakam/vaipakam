import type { IndexedOffer } from '@vaipakam/defi-client';
import {
  computeRentalPrepayWei,
  nftAssetKindLabel,
  rentalDailyFeeWei,
} from '@vaipakam/defi-client';
import { shortenAddr } from '@vaipakam/lib/address';
import { AssetAmount } from './AssetAmount';
import { useTokenMeta } from '../lib/tokenMeta';

interface Props {
  offer: IndexedOffer;
  rentalBufferBps: number;
  advanced?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}

export function RentalOfferCard({ offer, rentalBufferBps, advanced = false, selected, onSelect }: Props) {
  const prepayMeta = useTokenMeta(offer.prepayAsset || null);
  const dailyWei = rentalDailyFeeWei(offer);
  const totalPrepay = computeRentalPrepayWei(dailyWei, offer.durationDays, rentalBufferBps);

  const body = (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong>
          {nftAssetKindLabel(offer.assetType)} #{offer.tokenId}
        </strong>
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          {offer.durationDays} days
        </span>
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        {shortenAddr(offer.lendingAsset)} · Offer #{offer.offerId}
      </div>
      <div style={{ fontSize: '0.85rem', marginTop: 4 }}>
        Daily fee{' '}
        <AssetAmount mode="raw" amount={dailyWei.toString()} address={offer.prepayAsset} meta={prepayMeta} />
        {' · Total prepay '}
        <AssetAmount mode="raw" amount={totalPrepay.toString()} address={offer.prepayAsset} meta={prepayMeta} />
      </div>
      <p style={{ margin: '8px 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        You receive temporary use rights only — not ownership.
      </p>
      {advanced ? (
        <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          Buffer {(rentalBufferBps / 100).toFixed(1)}% · Prepay wei {totalPrepay.toString()} · Rights: temporary use
        </div>
      ) : null}
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        className={`position-card${selected ? ' position-card--selected' : ''}`}
        style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
        onClick={onSelect}
      >
        {body}
      </button>
    );
  }

  return <div className="position-card position-card--static">{body}</div>;
}