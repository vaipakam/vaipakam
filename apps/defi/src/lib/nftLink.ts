import { getChainByChainId } from '../contracts/config';

/**
 * Where an NFT row's "open this NFT externally" link should send the user.
 *
 * Three destinations, in priority order:
 *   1. **Vaipakam position NFT** — the Diamond is its own ERC-721 contract
 *      (every loan mints a lender + a borrower position NFT). When the
 *      contract address matches the chain's `diamondAddress`, the link
 *      goes to our in-app `/nft-verifier` page where the position is
 *      cross-checked against the on-chain loan struct. Marketplaces
 *      (OpenSea / etc.) can render the NFT image, but only the verifier
 *      can prove the position is current and not transferred.
 *   2. **OpenSea** — mainnet only. OpenSea sunset their testnet
 *      marketplace UI on 2025-07-23
 *      (`support.opensea.io/en/articles/11833955-farewell-testnets`),
 *      so testnet chains fall through to the explorer.
 *   3. **Chain explorer NFT page** — fallback for chains OpenSea doesn't
 *      support (BNB Chain, Polygon zkEVM) AND every testnet.
 *
 * Pure helper — no React hooks, no async I/O. Callers pass the chain id
 * and the helper consults the chain registry directly.
 */

/** Mainnet chain-id → OpenSea URL slug. Slugs sourced from
 *  opensea.io/assets/<slug>/... URLs (the v2 path). Missing entries
 *  mean OpenSea doesn't support the chain — fall through to the
 *  explorer. Polygon PoS (137) is intentionally absent because Phase 1
 *  scope dropped it; Polygon zkEVM (1101) is missing because OpenSea
 *  has no v2 surface for it. */
const OPENSEA_MAINNET_SLUG: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  10: 'optimism',
  42161: 'arbitrum',
};

export type NftLinkKind = 'verifier' | 'opensea' | 'explorer';

export interface NftLink {
  href: string;
  kind: NftLinkKind;
  /** True for marketplace / explorer links that open in a new tab. The
   *  verifier link is in-app SPA navigation — keep it in the same tab. */
  external: boolean;
}

/**
 * Resolve the right destination for an NFT row's "open externally" link.
 *
 * Returns `null` only when the chain is unknown to the registry — every
 * registered chain has a block explorer fallback, so callers in normal
 * use can treat the result as always defined.
 */
export function nftLinkFor(
  chainId: number,
  contract: string,
  tokenId: bigint | string,
): NftLink | null {
  const chain = getChainByChainId(chainId);
  if (!chain) return null;

  const tokenIdStr = typeof tokenId === 'bigint' ? tokenId.toString() : tokenId;
  const contractLc = contract.toLowerCase();

  // 1. Vaipakam position NFT — route to the in-app verifier.
  if (
    chain.diamondAddress &&
    contractLc === chain.diamondAddress.toLowerCase()
  ) {
    return {
      href: `/nft-verifier?contract=${contract}&id=${tokenIdStr}`,
      kind: 'verifier',
      external: false,
    };
  }

  // 2. OpenSea where supported — mainnet only (testnet sunset
  //    2025-07-23). Testnet chains skip straight to the explorer.
  if (!chain.testnet) {
    const slug = OPENSEA_MAINNET_SLUG[chainId];
    if (slug) {
      return {
        href: `https://opensea.io/assets/${slug}/${contract}/${tokenIdStr}`,
        kind: 'opensea',
        external: true,
      };
    }
  }

  // 3. Chain explorer fallback.
  const base = chain.blockExplorer.replace(/\/$/, '');
  return {
    href: `${base}/nft/${contract}/${tokenIdStr}`,
    kind: 'explorer',
    external: true,
  };
}
