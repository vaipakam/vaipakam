import { ASSET_TYPE_ERC20 } from '@vaipakam/defi-client';
import { formatIndexedAmount, isNftAssetType } from '../lib/formatAsset';
import type { TokenMeta } from '../lib/tokenMeta';
import { AssetSymbolLink } from './AssetSymbolLink';

interface Props {
  amount: string;
  address: string;
  meta?: TokenMeta | null;
  mode: 'human' | 'raw';
  /** 0 = ERC20, 1 = ERC721, 2 = ERC1155 — matches on-chain `AssetType`. */
  assetType?: number;
  /** Required for ERC721 / ERC1155 indexed amounts. */
  tokenId?: string;
  className?: string;
}

export function AssetAmount({
  amount,
  address,
  meta,
  mode,
  assetType = ASSET_TYPE_ERC20,
  tokenId = '0',
  className,
}: Props) {
  const trimmed = amount.trim();
  const display =
    mode === 'raw' || isNftAssetType(assetType)
      ? formatIndexedAmount(trimmed || '0', meta, address, assetType, tokenId)
      : trimmed || '—';

  return (
    <span className={className}>
      {display} <AssetSymbolLink address={address} meta={meta} />
    </span>
  );
}