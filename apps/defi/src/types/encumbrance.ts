/**
 * Shared type for the on-chain collateral / principal encumbrance (lien)
 * records exposed by `MetricsFacet`.
 *
 * Mirrors the `Encumbrance` tuple returned by
 * `getLoanCollateralLien(loanId)` and `getOfferPrincipalLien(offerId)` so
 * every lien-aware surface shares one mental model instead of passing an
 * untyped tuple around. `assetType` uses the same numeric codes as
 * {@link AssetType} in `./loan` (0 = ERC20, 1 = ERC721, 2 = ERC1155).
 *
 * #564 — dapp surface for collateral lien.
 */
export interface Encumbrance {
  /** Vault owner whose balance the lien is locked against. */
  user: string;
  /** Encumbered asset contract (zero address = native ETH). */
  asset: string;
  /** Token id — meaningful for ERC721 / ERC1155; 0 for ERC20. */
  tokenId: bigint;
  /** Encumbered amount in the asset's own units. */
  amount: bigint;
  /** Numeric asset-type code (see {@link AssetType}). */
  assetType: number;
  /** True once the lien has been lifted (loan/offer terminal). */
  released: boolean;
}
