/**
 * On-chain NFT metadata shape. The Diamond's ERC-721 facet encodes metadata
 * as a base64 data-URI (or raw JSON for older tokens), so most fields are
 * optional — attributes may be absent for burned/partial mints.
 */

export interface NFTAttribute {
  trait_type: string;
  value: string | number;
}

export interface NFTMetadata {
  name?: string;
  description?: string;
  image?: string;
  attributes?: NFTAttribute[];
}

/**
 * Fully-resolved verifier response; `metadata` is null when `tokenURI()`
 * fails or returns a non-parseable URI (Vaipakam NFTs always encode JSON, so
 * a null here usually means the token isn't a Vaipakam NFT).
 */
export interface NFTVerificationResult {
  tokenId: string;
  owner: string;
  metadata: NFTMetadata | null;
}
