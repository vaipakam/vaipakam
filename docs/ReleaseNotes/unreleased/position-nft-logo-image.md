## Position NFT — default image is the Vaipakam logo, served from the website

A newly deployed Diamond now gives its lender and borrower position NFTs
the Vaipakam logo as their default image, at
`https://vaipakam.com/nft/position.jpg`, replacing the earlier placeholder
on a public IPFS gateway. The marketing site serves the file with a one-day
cache, and any origin may read it.

The image is served from our own domain rather than an IPFS gateway because
marketplaces, wallets and the indexer fetch NFT images from their own
servers. The public ipfs.io gateway rate-limits them, and a pinning
service's private gateway depends on that account's plan. The same bytes
stay pinned on IPFS (`QmaejkrKx9e9AHZUVPojuANYRwzsskXbRcghvEX45N1dAn`) as
the permanent copy. A position NFT's terms live on-chain; the image is only
branding, so a website file that can be replaced is acceptable.

This only changes what `initializeNFT` writes at deploy. Diamonds already
deployed keep the image stored in them until an admin rotates it with
`setDefaultImage` (for example through `ConfigureNFTImageURIs.s.sol` with
`NFT_DEFAULT_IMAGE_LENDER` and `NFT_DEFAULT_IMAGE_BORROWER` set).

> Caveat: the 2026-11-17 testnet Diamonds (Base Sepolia, Arbitrum Sepolia,
> BNB Testnet) still serve the old image until that admin update is sent.
