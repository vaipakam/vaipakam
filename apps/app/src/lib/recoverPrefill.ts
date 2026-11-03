/**
 * The link from the vault card to the adoption page, and its reading on
 * arrival (#3096). ONE module holds both halves, so the parameters the
 * card writes are exactly the ones the page reads.
 *
 * A prefill only fills the asset fields (kind, contract, token id). The
 * declared source and the amount are never carried: they are the user's
 * own declaration, and the page's warnings and typed confirmation still
 * stand between a prefilled form and a signature.
 */
import { isAddress } from 'viem';
import { ASSET_KIND, type AssetKind } from '../data/protectedAccount';
import { MAX_UINT256 } from './recoverAsset';

export interface RecoverPrefill {
  kind: AssetKind;
  asset: string;
  /** Decimal string; empty for an ERC-20. */
  tokenId: string;
}

/** The blank form. */
export const EMPTY_RECOVER_PREFILL: RecoverPrefill = {
  kind: ASSET_KIND.ERC20,
  asset: '',
  tokenId: '',
};

/** The adoption page's address, prefilled with one asset. */
export function recoverHref(kind: AssetKind, asset: string, tokenId: bigint): string {
  const params = new URLSearchParams({ kind: String(kind), asset });
  if (kind !== ASSET_KIND.ERC20) params.set('tokenId', tokenId.toString());
  return `/recover?${params.toString()}`;
}

/**
 * Read a prefill from a query string. Anything malformed reads as the
 * blank form rather than as a partly-filled one, so a hand-edited link
 * can never name a different asset than it appears to.
 */
export function parseRecoverPrefill(search: string): RecoverPrefill {
  const params = new URLSearchParams(search);
  const kindRaw = params.get('kind');
  const asset = params.get('asset') ?? '';
  const tokenIdRaw = params.get('tokenId');
  if (kindRaw === null && asset === '' && tokenIdRaw === null) return EMPTY_RECOVER_PREFILL;
  const kind =
    kindRaw === '0'
      ? ASSET_KIND.ERC20
      : kindRaw === '1'
        ? ASSET_KIND.ERC721
        : kindRaw === '2'
          ? ASSET_KIND.ERC1155
          : null;
  if (kind === null || !isAddress(asset)) return EMPTY_RECOVER_PREFILL;
  if (kind === ASSET_KIND.ERC20) {
    return tokenIdRaw === null ? { kind, asset, tokenId: '' } : EMPTY_RECOVER_PREFILL;
  }
  if (tokenIdRaw === null || !/^\d+$/.test(tokenIdRaw) || BigInt(tokenIdRaw) > MAX_UINT256) {
    return EMPTY_RECOVER_PREFILL;
  }
  return { kind, asset, tokenId: tokenIdRaw };
}
