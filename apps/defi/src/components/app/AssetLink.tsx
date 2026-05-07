import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AssetSymbol } from './AssetSymbol';
import { useVerifyContract } from '../../hooks/useCoinGecko';
import { erc20LinkFor } from '../../lib/erc20Link';
import { nftLinkFor } from '../../lib/nftLink';

interface BaseProps {
  /** Chain id for the row's context. Drives the destination chain on
   *  the explorer / OpenSea fallback paths and the diamond-address
   *  comparison for the verifier route. */
  chainId: number;
  /** Contract address of the asset. */
  address: string;
  /** Optional className forwarded to the inner symbol. */
  className?: string;
  /** When true, render a small external-link icon after the symbol so
   *  the row signals "this is clickable" at a glance. Default true. */
  showIcon?: boolean;
  /** When provided, override the rendered label (e.g. `NFT #42`). When
   *  omitted, falls back to the live `<AssetSymbol>` resolution. */
  label?: React.ReactNode;
}

export interface AssetLinkErc20Props extends BaseProps {
  kind: 'erc20';
}

export interface AssetLinkNftProps extends BaseProps {
  kind: 'nft';
  /** ERC-721 / ERC-1155 token id. Required for the marketplace /
   *  explorer / verifier URL. */
  tokenId: bigint | string;
}

export type AssetLinkProps = AssetLinkErc20Props | AssetLinkNftProps;

/**
 * Renders a token symbol (or supplied label) wrapped in an external
 * link to the most useful third-party page for that asset:
 *
 *   - **ERC-20** → CoinGecko coin page when indexed; chain-explorer
 *     contract page otherwise.
 *   - **NFT** → in-app `/nft-verifier` when the contract is the
 *     Vaipakam Diamond (position NFT); OpenSea when the chain is
 *     supported there; chain-explorer NFT page otherwise.
 *
 * The CoinGecko lookup runs through {@link useVerifyContract} which is
 * debounced + cached at the localStorage layer — repeated renders of
 * the same address are free, and the first render falls back to the
 * explorer link until the verification result lands. This means the
 * component is safe to drop into list rows without coordinating an
 * upstream verification pass.
 */
export function AssetLink(props: AssetLinkProps) {
  const { t } = useTranslation();
  const { chainId, address, className, showIcon = true, label } = props;

  // Always run the verify hook even on the NFT path — the rules-of-hooks
  // demand a stable call order across renders. The hook short-circuits
  // immediately for the NFT case via the `enabled` arg below.
  const erc20VerifyResult = useVerifyContract(
    props.kind === 'erc20' ? chainId : null,
    props.kind === 'erc20' ? address : null,
  );

  const link =
    props.kind === 'erc20'
      ? erc20LinkFor(chainId, address, erc20VerifyResult.result?.id ?? null)
      : nftLinkFor(chainId, address, props.tokenId);

  const inner = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label ?? <AssetSymbol address={address} className={className} />}
      {showIcon && link && (
        <ExternalLink
          size={11}
          aria-hidden="true"
          style={{ color: 'var(--brand)', flexShrink: 0 }}
        />
      )}
    </span>
  );

  if (!link) return inner;

  // Use react-router for in-app verifier navigation so the page
  // doesn't lose SPA state on click; everything else is a regular
  // anchor with `target="_blank"`.
  if (link.external) {
    return (
      <a
        href={link.href}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={
          link.kind === 'coingecko'
            ? t('assetLink.openOnCoinGecko')
            : link.kind === 'opensea'
              ? t('assetLink.openOnOpenSea')
              : t('assetLink.openOnExplorer')
        }
        style={{ color: 'inherit', textDecoration: 'none' }}
      >
        {inner}
      </a>
    );
  }

  return (
    <Link
      to={link.href}
      aria-label={t('assetLink.openOnVerifier')}
      style={{ color: 'inherit', textDecoration: 'none' }}
    >
      {inner}
    </Link>
  );
}
