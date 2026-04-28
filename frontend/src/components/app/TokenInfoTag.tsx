import { ExternalLink, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVerifyContract } from '../../hooks/useCoinGecko';
import { useOnchainTokenInfo } from '../../hooks/useOnchainTokenInfo';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Inline trust + identification block rendered below an `<AssetPicker>`
 * in flows where the user commits real value (Create Offer's lending
 * and collateral asset fields).
 *
 * Behaviour:
 *   - Shows `symbol` + `name` for every valid ERC-20 address. Pulls
 *     from the CoinGecko registry first (canonical names + market-cap
 *     rank), and falls back to on-chain `symbol()` / `name()` reads
 *     when the address isn't on the registry — so you never end up
 *     looking at a bare hex address with no identification.
 *   - Shows `decimals` only in Advanced mode (per design note in
 *     CreateOffer — Basic users don't need that technical surface).
 *   - Always renders a "view on explorer" link so the user can
 *     manually inspect the contract (verified source, holders, recent
 *     activity) on the active chain's block explorer.
 *   - Renders a phishing warning when the address is NOT on the
 *     CoinGecko registry, OR is on the registry but ranked outside
 *     the top 200. Anyone can deploy a token with any symbol — the
 *     warning explicitly tells the user to confirm the contract
 *     address itself rather than relying on the symbol they see.
 *
 * Visible to both Basic and Advanced users, so a fresh user pasting
 * a sketchy address sees the warning at the same spot a power user
 * does. No phishing-protection should be Advanced-gated.
 */
interface Props {
  chainId: number | null | undefined;
  address: string | null | undefined;
  blockExplorer: string | null | undefined;
  showAdvanced: boolean;
}

export function TokenInfoTag({
  chainId,
  address,
  blockExplorer,
  showAdvanced,
}: Props) {
  const { t } = useTranslation();
  const cg = useVerifyContract(chainId, address);
  const onchain = useOnchainTokenInfo(address);

  if (!address || !ADDRESS_RE.test(address)) return null;

  // Prefer CoinGecko-resolved metadata (canonical, includes rank), fall
  // back to on-chain reads when the address isn't on the registry.
  const symbol = cg.result?.symbol ?? onchain.symbol;
  const name = cg.result?.name ?? onchain.name;
  const rank = cg.result?.marketCapRank ?? null;
  const decimals = onchain.decimals;
  const known = cg.result?.known ?? false;
  const inTop200 = cg.result?.inTop200 ?? false;
  const verificationLoading = cg.loading || cg.result === null;

  // Don't fire the warning while the CoinGecko lookup is still
  // resolving — otherwise a known top-tier token shows the warning for
  // ~400ms before the verification result arrives, which is misleading.
  // After resolution: warn if the address isn't in the registry at all
  // OR is on the registry but ranked > 200 (i.e. not a tier-1 token).
  const showWarning = !verificationLoading && (!known || !inTop200);

  // Nothing useful resolved yet — keep the slot empty rather than
  // rendering a half-loaded info card.
  if (!symbol && !name && !showWarning) return null;

  const explorerHref = blockExplorer
    ? `${blockExplorer.replace(/\/$/, '')}/address/${address}`
    : null;

  return (
    <div
      className="form-hint"
      style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      {(symbol || name || decimals !== null || rank !== null) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
          {symbol && (
            <strong style={{ color: 'var(--text-primary)' }}>{symbol}</strong>
          )}
          {name && name !== symbol && (
            <span style={{ opacity: 0.85 }}>{name}</span>
          )}
          {rank !== null && (
            <span style={{ opacity: 0.7 }}>
              {t('tokenInfoTag.rank', { rank })}
            </span>
          )}
          {showAdvanced && decimals !== null && (
            <span style={{ opacity: 0.7 }}>
              {t('tokenInfoTag.decimals', { decimals })}
            </span>
          )}
          {explorerHref && (
            <a
              href={explorerHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: 'var(--brand)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
              }}
            >
              {t('tokenInfoTag.viewOnExplorer')}
              <ExternalLink size={11} />
            </a>
          )}
        </div>
      )}
      {showWarning && (
        <div
          className="alert alert-warning"
          style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px' }}
        >
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ fontSize: '0.85rem', lineHeight: 1.4 }}>
            {t('tokenInfoTag.trustWarning')}
          </span>
        </div>
      )}
    </div>
  );
}
