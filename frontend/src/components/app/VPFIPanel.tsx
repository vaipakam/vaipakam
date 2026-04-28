import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Coins, ExternalLink } from 'lucide-react';
import i18n from '../../i18n';
import { useVPFIToken } from '../../hooks/useVPFIToken';
import { useUserVPFI } from '../../hooks/useUserVPFI';
import { formatVpfiUnits } from '../../hooks/useVPFIDiscount';
import { CardInfo } from '../CardInfo';
import { InfoTip } from '../InfoTip';
import { Pager } from './Pager';

interface VPFIPanelProps {
  vpfi: ReturnType<typeof useVPFIToken>['snapshot'];
  userVpfi: ReturnType<typeof useUserVPFI>['snapshot'];
  /** 18-dec VPFI currently locked in the user's protocol escrow on the
   *  active chain. `null` when the escrow hasn't been deployed yet or
   *  the balance fetch is still in flight — rendered as "—". */
  escrowVpfiWei: bigint | null;
  networkName: string;
  networkChainId: number;
  blockExplorer: string;
  isCanonicalVPFI: boolean;
  /** Advanced-mode flag from `<ModeContext>`. When false, the two
   *  technical badges in the card header (chain-name+id and the
   *  Canonical/Mirror role pill) are hidden — they're protocol
   *  detail that beginners don't need to see. */
  isAdvanced: boolean;
}

const DIRECTION_LABEL: Record<'in' | 'out' | 'mint' | 'burn' | 'self', string> = {
  in: 'Received',
  out: 'Sent',
  mint: 'Minted to you',
  burn: 'Burned',
  self: 'Self-transfer',
};

const ACTIVITY_PAGE_SIZE = 10;

function shortenAddr(a: string | null | undefined): string {
  if (!a) return '—';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function i18nResolved(): string {
  return i18n.resolvedLanguage ?? 'en';
}

function formatVpfi(n: number): string {
  const lng = i18nResolved();
  if (n === 0) return new Intl.NumberFormat(lng).format(0);
  if (n >= 1000) {
    return new Intl.NumberFormat(lng, {
      notation: 'compact',
      maximumFractionDigits: 2,
    }).format(n);
  }
  return new Intl.NumberFormat(lng, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function VPFIPanel({
  vpfi,
  userVpfi,
  escrowVpfiWei,
  networkName,
  networkChainId,
  blockExplorer,
  isCanonicalVPFI,
  isAdvanced,
}: VPFIPanelProps) {
  const { t } = useTranslation();
  const registered = !!vpfi?.registered;
  const tokenAddr = vpfi?.token ?? null;
  const minterAddr = vpfi?.minter ?? null;
  const balance = userVpfi?.balance ?? 0;
  const escrowVpfiUnits = escrowVpfiWei == null ? 0 : formatVpfiUnits(escrowVpfiWei);
  const totalSupply = vpfi?.totalSupply ?? 0;
  const effectiveShareOfCirculating =
    totalSupply > 0 ? (balance + escrowVpfiUnits) / totalSupply : 0;
  const recentMints = userVpfi?.recentMints ?? [];
  const recentTransfers = userVpfi?.recentTransfers ?? [];
  const treasury = userVpfi?.treasury ?? null;

  // Activity pagination — slice recentTransfers to a 10-row page. Resets to
  // page 0 whenever the underlying list grows / changes (e.g. a chain switch
  // or a new transfer comes in) so the user never lands on a stale page.
  const [activityPage, setActivityPage] = useState(0);
  useEffect(() => {
    setActivityPage(0);
  }, [recentTransfers.length, networkChainId]);
  const activityPageStart = activityPage * ACTIVITY_PAGE_SIZE;
  const pagedTransfers = recentTransfers.slice(
    activityPageStart,
    activityPageStart + ACTIVITY_PAGE_SIZE,
  );

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Coins size={16} style={{ color: 'var(--brand)' }} />
          <div className="card-title" style={{ marginBottom: 0 }}>
            {t('vpfiTokenCard.title')}
            <CardInfo id="dashboard.vpfi-panel" />
          </div>
        </div>
        {isAdvanced && (
          <div
            style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}
          >
            <span
              className="status-badge"
              style={{ background: 'rgba(148, 163, 184, 0.12)', color: 'var(--text-tertiary)' }}
            >
              {t('vpfiTokenCard.chainBadge', { chain: networkName, chainId: networkChainId })}
            </span>
            <span
              className="status-badge"
              style={{
                background: isCanonicalVPFI
                  ? 'rgba(79, 70, 229, 0.12)'
                  : 'rgba(16, 185, 129, 0.12)',
                color: isCanonicalVPFI ? 'var(--brand)' : 'var(--accent-green)',
              }}
            >
              {isCanonicalVPFI ? t('vpfiTokenCard.canonical') : t('vpfiTokenCard.mirror')}
            </span>
            <InfoTip ariaLabel={isCanonicalVPFI ? t('vpfiTokenCard.canonicalAria') : t('vpfiTokenCard.mirrorAria')}>
              {isCanonicalVPFI ? t('vpfiTokenCard.canonicalTip') : t('vpfiTokenCard.mirrorTip')}
            </InfoTip>
          </div>
        )}
      </div>

      {!registered ? (
        <div className="empty-state" style={{ padding: '16px 0' }}>
          <p style={{ margin: 0 }}>{t('vpfiTokenCard.notRegistered', { chain: networkName })}</p>
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div>
              <div
                className="stat-value"
                data-tooltip={t('vpfiTokenCard.shareTooltip')}
                data-tooltip-placement="below-start"
              >
                {(effectiveShareOfCirculating * 100).toFixed(2)}%
              </div>
              <div className="stat-label">{t('vpfiTokenCard.shareCirculating')}</div>
            </div>
            <div>
              <div className="stat-value">{vpfi ? formatVpfi(vpfi.totalSupply) : '—'}</div>
              <div className="stat-label">{t('vpfiTokenCard.circulatingThisChain')}</div>
            </div>
            <div>
              <div className="stat-value">{vpfi ? formatVpfi(vpfi.capHeadroom) : '—'}</div>
              <div className="stat-label">{t('vpfiTokenCard.remainingMintable')}</div>
            </div>
          </div>

          <div className="data-row">
            <span className="data-label">{t('vpfiTokenCard.tokenLabel')}</span>
            <a
              href={`${blockExplorer}/address/${tokenAddr}`}
              target="_blank"
              rel="noreferrer"
              className="data-value mono"
              style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {shortenAddr(tokenAddr)}
              <ExternalLink size={14} />
            </a>
          </div>
          <div className="data-row">
            <span className="data-label">{t('vpfiTokenCard.authorizedMinter')}</span>
            <a
              href={`${blockExplorer}/address/${minterAddr}`}
              target="_blank"
              rel="noreferrer"
              className="data-value mono"
              style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {shortenAddr(minterAddr)}
              <ExternalLink size={14} />
            </a>
          </div>
          {treasury && (
            <div className="data-row">
              <span className="data-label">{t('vpfiTokenCard.treasuryMintDestination')}</span>
              <a
                href={`${blockExplorer}/address/${treasury}`}
                target="_blank"
                rel="noreferrer"
                className="data-value mono"
                style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {shortenAddr(treasury)}
                <ExternalLink size={14} />
              </a>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <div className="data-label" style={{ marginBottom: 8 }}>
              {t('vpfiTokenCard.yourActivity')}
            </div>
            {recentTransfers.length === 0 ? (
              <p className="stat-label" style={{ margin: 0 }}>
                {t('vpfiTokenCard.noActivity', { chain: networkName })}
              </p>
            ) : (
              <>
                <div className="loans-table-wrap">
                  <table className="loans-table">
                    <thead>
                      <tr>
                        <th>Direction</th>
                        <th>Amount (VPFI)</th>
                        <th>Counterparty</th>
                        <th>Block</th>
                        <th>Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedTransfers.map((tx) => (
                        <tr key={`${tx.txHash}:${tx.logIndex}`}>
                          <td>
                            <span
                              className="status-badge"
                              style={{
                                background:
                                  tx.direction === 'in' || tx.direction === 'mint'
                                    ? 'rgba(16, 185, 129, 0.12)'
                                    : tx.direction === 'out' || tx.direction === 'burn'
                                      ? 'rgba(239, 68, 68, 0.12)'
                                      : 'rgba(148, 163, 184, 0.12)',
                                color:
                                  tx.direction === 'in' || tx.direction === 'mint'
                                    ? 'var(--accent-green)'
                                    : tx.direction === 'out' || tx.direction === 'burn'
                                      ? 'var(--accent-red, #ef4444)'
                                      : 'var(--text-tertiary)',
                              }}
                            >
                              {DIRECTION_LABEL[tx.direction]}
                            </span>
                          </td>
                          <td className="mono">{formatVpfi(tx.amount)}</td>
                          <td className="mono">
                            {tx.direction === 'mint' || tx.direction === 'burn' ? (
                              <span className="pd-subtle">{shortenAddr(tx.counterparty)}</span>
                            ) : (
                              <a
                                href={`${blockExplorer}/address/${tx.counterparty}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                              >
                                {shortenAddr(tx.counterparty)}
                                <ExternalLink size={12} />
                              </a>
                            )}
                          </td>
                          <td className="mono">{tx.blockNumber}</td>
                          <td>
                            <a
                              href={`${blockExplorer}/tx/${tx.txHash}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            >
                              {shortenAddr(tx.txHash)}
                              <ExternalLink size={12} />
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager
                  total={recentTransfers.length}
                  pageSize={ACTIVITY_PAGE_SIZE}
                  page={activityPage}
                  onPageChange={setActivityPage}
                />
              </>
            )}
          </div>

          {recentMints.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="data-label" style={{ marginBottom: 8 }}>
                Diamond → Treasury mint events
              </div>
              <div className="loans-table-wrap">
                <table className="loans-table">
                  <thead>
                    <tr>
                      <th>Block</th>
                      <th>Amount (VPFI)</th>
                      <th>To</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentMints.map((m) => (
                      <tr key={m.txHash}>
                        <td className="mono">{m.blockNumber}</td>
                        <td className="mono">{formatVpfi(m.amount)}</td>
                        <td className="mono">
                          <a
                            href={`${blockExplorer}/address/${m.to}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            {shortenAddr(m.to)}
                          </a>
                        </td>
                        <td>
                          <a
                            href={`${blockExplorer}/tx/${m.txHash}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            {shortenAddr(m.txHash)}
                            <ExternalLink size={12} />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
