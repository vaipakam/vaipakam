/**
 * The asset rules the adoption page applies to what the user types
 * (#3096), kept apart from the page so they can be tested alone. They
 * mirror `VaultDepositoryFacet.adoptUntracked`: three kinds, a uint256
 * token id, and an ERC-20 whose token id is always zero.
 */
import { ASSET_KIND, type AssetKind } from '../data/protectedAccount';

/** Is `value` one of the three asset kinds the contract takes? */
export function isAssetKind(value: unknown): value is AssetKind {
  return (
    value === ASSET_KIND.ERC20 ||
    value === ASSET_KIND.ERC721 ||
    value === ASSET_KIND.ERC1155
  );
}

/** Upper bound on a token id: a uint256. */
export const MAX_UINT256 = (1n << 256n) - 1n;

/** The token id the form names, or null when it is not a uint256. An
 *  ERC-20 has no token id; the contract forces it to zero, and so does
 *  this page. */
export function tokenIdOf(kind: AssetKind, input: string): bigint | null {
  if (kind === ASSET_KIND.ERC20) return 0n;
  if (!/^\d+$/.test(input)) return null;
  const id = BigInt(input);
  return id <= MAX_UINT256 ? id : null;
}

/** How a lookup names the asset: the symbol for an ERC-20, the
 *  collection's symbol with the token id for an NFT. */
export function assetLabel(kind: AssetKind, symbol: string, tokenId: bigint): string {
  return kind === ASSET_KIND.ERC20 ? symbol : `${symbol} #${tokenId.toString()}`;
}
