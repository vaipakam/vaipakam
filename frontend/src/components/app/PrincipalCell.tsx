import { useTranslation } from 'react-i18next';
import { TokenAmount } from './TokenAmount';
import { AssetLink } from './AssetLink';

interface Props {
  /** 0 = ERC20, 1 = ERC721, 2 = ERC1155. Matches `LibVaipakam.AssetType`. */
  assetType: number;
  /** Contract address of the principal asset. */
  asset: string;
  /**
   * For ERC20: wei amount (formatted via `<TokenAmount>` decimals).
   * For ERC1155: number of NFT copies (rendered as `N ×`).
   * For ERC721: ignored (always 1).
   */
  amount: bigint;
  /** Required for ERC721 / ERC1155 — the specific NFT id. */
  tokenId?: bigint;
  /**
   * Chain id this asset lives on. Drives the per-row "open externally"
   * link target via `<AssetLink>`:
   *
   *   - ERC-20 rows → CoinGecko coin page when the token is indexed;
   *     chain-explorer contract page otherwise.
   *   - NFT rows → Vaipakam in-app verifier when the contract is the
   *     Diamond (position NFT); OpenSea when the chain is supported
   *     there; chain-explorer NFT page otherwise.
   */
  chainId: number;
}

/**
 * Unified principal-amount cell. Renders three asset-type cases with a
 * consistent two-row "value + symbol" layout — the same pattern Your
 * Loans uses for its Principal column. Replaces the historical split
 * Asset + Amount columns on OfferTable so a row's principal reads as
 * one cohesive figure.
 *
 *   - ERC20: `1,000` / `USDC ↗` (↗ = CoinGecko / explorer link)
 *   - ERC721: `NFT #42` / `BAYC ↗` (↗ = OpenSea / explorer / verifier link)
 *   - ERC1155: `5 × NFT #42` / `Sandbox ↗`
 *
 * The link target is decided per-row by `<AssetLink>` from the chain
 * id + asset address: Vaipakam-position NFTs route to the in-app
 * verifier; third-party NFTs route to OpenSea where supported and
 * fall back to the explorer; ERC-20s route to CoinGecko when indexed
 * and fall back to the explorer otherwise.
 */
export function PrincipalCell({
  assetType,
  asset,
  amount,
  tokenId,
  chainId,
}: Props) {
  const { t } = useTranslation();
  const isERC721 = assetType === 1;
  const isERC1155 = assetType === 2;

  if (isERC721 || isERC1155) {
    const idLabel = isERC1155
      ? t('principalCell.nftIdQuantity', {
          qty: amount.toString(),
          id: tokenId?.toString() ?? '?',
        })
      : t('principalCell.nftId', { id: tokenId?.toString() ?? '?' });
    return (
      <div>
        <div className="mono">{idLabel}</div>
        <div className="asset-addr">
          <AssetLink
            kind="nft"
            chainId={chainId}
            address={asset}
            tokenId={tokenId ?? 0n}
          />
        </div>
      </div>
    );
  }

  // ERC20.
  return (
    <div>
      <span className="mono">
        <TokenAmount amount={amount} address={asset} />
      </span>
      <div className="asset-addr">
        <AssetLink kind="erc20" chainId={chainId} address={asset} />
      </div>
    </div>
  );
}
