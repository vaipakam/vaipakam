## Position NFT — default image is the Vaipakam logo

A newly deployed Diamond now gives its position NFTs the Vaipakam logo as
their default image (IPFS `QmaejkrKx9e9AHZUVPojuANYRwzsskXbRcghvEX45N1dAn`,
served through the ipfs.io gateway) for both lender and borrower tokens,
replacing the earlier placeholder image. The link stays on a plain HTTP
gateway because marketplaces, wallets and the indexer fetch NFT images from
their own servers.

This only changes what `initializeNFT` writes at deploy. Diamonds already
deployed keep the image stored in them until an admin rotates it with
`setDefaultImage` (for example through `ConfigureNFTImageURIs.s.sol` with
`NFT_DEFAULT_IMAGE_LENDER` and `NFT_DEFAULT_IMAGE_BORROWER` set).

> Caveat: the 2026-11-17 testnet Diamonds (Base Sepolia, Arbitrum Sepolia,
> BNB Testnet) still serve the old image until that admin update is sent.
