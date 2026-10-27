## Thread — Position NFT metadata states each figure in its own asset (PR #2977)

A position NFT's metadata now states every figure in the asset it is
actually in. The claimable amount used to be scaled by a guess from the
holder's role (the lent asset's decimals for a lender, the collateral's for a
borrower). That was wrong for every rental, whose claims are in the prepay
token, and for a lender whose claim is the collateral after an in-kind
default; a 6-decimal stablecoin refund displayed a million million times too
small. The claim is now read from the position's own claim row: an ERC-20
amount at that token's decimals with its symbol, or an NFT named by its
collection and token.

The "Asset Kind" trait showed the collateral's type, which reads "ERC20" on
every rental because a rental has no collateral. It is replaced by two
traits, "Lent Asset Kind" and "Collateral Kind" (None for a rental). A
rental's metadata now shows the rented NFT by its token, the daily rental fee
and the prepaid rent and buffer in the prepay token, and no collateral
fields.

The position summary view behind the metadata carries the new facts (the
lent asset's kind and token, the rental's prepay asset and amounts, and the
claim's kind, symbol, decimals, token and quantity), so the app and other
readers can render the same thing.

The metadata rendering moved to its own facet, VaipakamNFTMetadataFacet,
because the position NFT facet had reached 24 bytes under the contract size
limit. The NFT's token URI, its collection metadata and the admin settings
for its images and external link now live there; the token itself (minting,
transfers, approvals, locks, royalties, name and symbol) stays where it was.
The Diamond's address and every function's signature are unchanged, so a
reader calling through the Diamond sees no difference. The two facets are
refreshed together: the curated redeploy script refuses a Diamond that still
serves the token URI from the old facet, so the split arrives by the
all-facets refresh or a fresh deploy.

Closes #2957.
