import { ASSET_TYPE_ERC1155, ASSET_TYPE_ERC20, ASSET_TYPE_ERC721 } from '@vaipakam/defi-client';
import { formatUnits } from 'viem';
import { shortenAddr } from '@vaipakam/lib/address';
import type { TokenMeta } from './tokenMeta';

export function isNftAssetType(assetType: number): boolean {
  return assetType === ASSET_TYPE_ERC721 || assetType === ASSET_TYPE_ERC1155;
}

/** Human label for vaulted NFT collateral/principal (matches defi `PrincipalCell`). */
export function formatNftLabel(assetType: number, amount: string, tokenId: string): string {
  const id = tokenId && tokenId !== '0' ? tokenId : '?';
  if (assetType === ASSET_TYPE_ERC721) return `NFT #${id}`;
  if (assetType === ASSET_TYPE_ERC1155) {
    const qty = amount.trim() && amount !== '0' ? amount : '1';
    return `${qty} × NFT #${id}`;
  }
  return '';
}

/** Trim trailing zeros from a decimal string (e.g. "1.5000" → "1.5"). */
export function trimFraction(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/, '');
}

export function formatRawTokenAmount(raw: string, decimals: number): string {
  try {
    return trimFraction(formatUnits(BigInt(raw), decimals));
  } catch {
    return raw;
  }
}

export function resolveSymbol(meta: TokenMeta | null | undefined, address: string): string {
  if (meta?.symbol) return meta.symbol;
  return shortenAddr(address);
}

/** Human-entered amount + on-chain symbol (e.g. "0.1 mWETH"). */
export function formatHumanAssetAmount(
  amount: string,
  meta: TokenMeta | null | undefined,
  address: string,
): string {
  const trimmed = amount.trim();
  if (!trimmed) return '—';
  const symbol = resolveSymbol(meta, address);
  return symbol ? `${trimmed} ${symbol}` : trimmed;
}

/** Indexer / on-chain raw amount + symbol (e.g. "100 mUSDC"). */
export function formatRawAssetAmount(
  raw: string,
  meta: TokenMeta | null | undefined,
  address: string,
  assetType = ASSET_TYPE_ERC20,
  tokenId = '0',
): string {
  if (isNftAssetType(assetType)) {
    const label = formatNftLabel(assetType, raw, tokenId);
    const symbol = resolveSymbol(meta, address);
    return symbol ? `${label} ${symbol}` : label;
  }
  if (meta?.decimals == null) {
    return raw.trim() || '—';
  }
  const amount = formatRawTokenAmount(raw, meta.decimals);
  const symbol = resolveSymbol(meta, address);
  return symbol ? `${amount} ${symbol}` : amount;
}

export function formatIndexedAmount(
  raw: string,
  meta: TokenMeta | null | undefined,
  _address: string,
  assetType: number,
  tokenId: string,
): string {
  if (isNftAssetType(assetType)) return formatNftLabel(assetType, raw, tokenId);
  if (meta?.decimals == null) return raw.trim() || '—';
  return formatRawTokenAmount(raw, meta.decimals);
}