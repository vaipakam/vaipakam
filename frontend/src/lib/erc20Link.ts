import { getChainByChainId } from '../contracts/config';

/**
 * Where an ERC-20 row's "open this token externally" link should send
 * the user.
 *
 * Two destinations, in priority order:
 *   1. **CoinGecko** — when the token is indexed on CoinGecko, the
 *      coin page (`/coins/<id>`) shows price, market cap, exchange
 *      coverage, and links — the audience-relevant metadata for any
 *      ERC-20 the user is about to lend or borrow against.
 *   2. **Chain explorer** — fallback for tokens CoinGecko doesn't
 *      index. The contract page (`/address/<contract>`) carries
 *      verified-source / proxy-impl / holder data that the user can
 *      audit themselves.
 *
 * Pure helper — the CoinGecko id has to come from the caller (typically
 * via {@link useVerifyContract}), since the lookup is async and cached
 * outside this function.
 */

export type Erc20LinkKind = 'coingecko' | 'explorer';

export interface Erc20Link {
  href: string;
  kind: Erc20LinkKind;
  /** Always true — both destinations are external sites; open in a new tab. */
  external: true;
}

/**
 * Resolve the right "open token externally" destination for an ERC-20
 * row. Pass `coinGeckoId` when known (resolved via {@link verifyContract}
 * / {@link useVerifyContract}); pass `null` for unknown / unresolved
 * tokens — the helper falls back to the chain explorer's address page
 * cleanly.
 *
 * Returns `null` only when the chain isn't in the registry; every
 * registered chain has a block-explorer fallback, so normal callers
 * can treat the result as always defined.
 */
export function erc20LinkFor(
  chainId: number,
  contract: string,
  coinGeckoId: string | null,
): Erc20Link | null {
  if (coinGeckoId) {
    return {
      href: `https://www.coingecko.com/en/coins/${coinGeckoId}`,
      kind: 'coingecko',
      external: true,
    };
  }
  const chain = getChainByChainId(chainId);
  if (!chain) return null;
  const base = chain.blockExplorer.replace(/\/$/, '');
  return {
    href: `${base}/address/${contract}`,
    kind: 'explorer',
    external: true,
  };
}
