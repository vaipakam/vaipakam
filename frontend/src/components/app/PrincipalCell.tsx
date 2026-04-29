import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TokenAmount } from './TokenAmount';
import { AssetSymbol } from './AssetSymbol';

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
   * Block-explorer base URL (no trailing slash). When provided AND the
   * asset is an NFT, an inline external-link icon next to the asset
   * symbol opens the explorer's NFT-page viewer
   * (`<base>/nft/<contract>/<tokenId>`) — the explorer renders the
   * image, traits, and owner history. ERC20 rows do **not** get a
   * link icon (visual clutter trade-off, see frontend/.../release notes).
   */
  blockExplorer?: string;
}

/**
 * Unified principal-amount cell. Renders three asset-type cases with a
 * consistent two-row "value + symbol" layout — the same pattern Your
 * Loans uses for its Principal column. Replaces the historical split
 * Asset + Amount columns on OfferTable so a row's principal reads as
 * one cohesive figure.
 *
 *   - ERC20: `1,000` / `USDC`
 *   - ERC721: `NFT #42` / `BAYC ↗` (↗ = explorer NFT-page link)
 *   - ERC1155: `5 × NFT #42` / `Sandbox ↗`
 *
 * The explorer link applies to NFTs only by intent: the explorer's
 * NFT-page viewer surfaces the image, traits, and ownership history
 * — qualitatively new info beyond the symbol. ERC20 rows get the
 * existing `<AssetSymbol>` hover-tooltip with the contract address;
 * inline links per row would clutter the table for no decision-
 * relevant payoff (token vetting belongs on Create Offer's review
 * surface where `<TokenInfoTag>` already shows CoinGecko rank +
 * "unknown token" warning).
 */
export function PrincipalCell({
  assetType,
  asset,
  amount,
  tokenId,
  blockExplorer,
}: Props) {
  const { t } = useTranslation();
  const isERC721 = assetType === 1;
  const isERC1155 = assetType === 2;

  if (isERC721 || isERC1155) {
    const nftHref =
      blockExplorer && tokenId !== undefined
        ? `${blockExplorer.replace(/\/$/, '')}/nft/${asset}/${tokenId.toString()}`
        : null;
    const idLabel = isERC1155
      ? t('principalCell.nftIdQuantity', {
          qty: amount.toString(),
          id: tokenId?.toString() ?? '?',
        })
      : t('principalCell.nftId', { id: tokenId?.toString() ?? '?' });
    return (
      <div>
        <div className="mono">{idLabel}</div>
        <div className="asset-addr" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <AssetSymbol address={asset} />
          {nftHref && (
            <a
              href={nftHref}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t('principalCell.openOnExplorer')}
              style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center' }}
            >
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    );
  }

  // ERC20 — preserve the existing TokenAmount + AssetSymbol pattern.
  return (
    <div>
      <span className="mono">
        <TokenAmount amount={amount} address={asset} />
      </span>
      <div className="asset-addr">
        <AssetSymbol address={asset} />
      </div>
    </div>
  );
}
