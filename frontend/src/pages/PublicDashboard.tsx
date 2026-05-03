import { useCallback, useEffect, useMemo, useState } from 'react';
import { L as Link } from '../components/L';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import {
  BarChart3,
  Download,
  ExternalLink,
  Lock,
  ShieldCheck,
  Users,
  Activity,
  Gauge,
  Coins,
  RefreshCw,
  TrendingUp,
  PiggyBank,
  Landmark,
  Image as ImageIcon,
} from 'lucide-react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import DiagnosticsDrawer from '../components/app/DiagnosticsDrawer';
import { ChainPicker } from '../components/ChainPicker';
import { ErrorAlert } from '../components/app/ErrorAlert';
import { CardInfo } from '../components/CardInfo';
import { useMode } from '../context/ModeContext';
import { useProtocolStats } from '../hooks/useProtocolStats';
import { useTVL } from '../hooks/useTVL';
import { useUserStats } from '../hooks/useUserStats';
import { useTreasuryMetrics } from '../hooks/useTreasuryMetrics';
import { useRecentOffers } from '../hooks/useRecentOffers';
import { useVPFIToken } from '../hooks/useVPFIToken';
import { useHistoricalData, type TimeRange } from '../hooks/useHistoricalData';
import { useCombinedChainsStats } from '../hooks/useCombinedChainsStats';
import {
  DEFAULT_CHAIN,
  CHAIN_REGISTRY,
  compareChainsForDisplay,
} from '../contracts/config';
import { useReadChain } from '../contracts/useDiamond';
import { useWallet } from '../context/WalletContext';
import { useChainOverride } from '../context/ChainContext';
import { shortenAddr, bpsToPercent, formatUnitsPretty } from '../lib/format';
import { CopyableAddress } from '../components/app/CopyableAddress';
import { AssetLink } from '../components/app/AssetLink';
import { AssetType, LoanStatus, LOAN_STATUS_LABELS } from '../types/loan';
import { Pager } from '../components/app/Pager';
import './PublicDashboard.css';

const RANGES: TimeRange[] = ['24h', '7d', '30d', '90d', 'All'];
const RECENT_PAGE_SIZE = 15;

// Local formatters thread the active i18n locale via the helpers in
// lib/format.ts so dashboard cells render with locale-correct grouping
// + decimal separators (`1,000.00` en-US vs `1.000,00` de-DE vs
// `1 000,00` fr-FR vs `1٬000٫00` ar). The compact-vs-precise switch
// at $1k stays here — that's a UX rule for THIS dashboard, not a
// locale concern.
function formatUsd(n: number): string {
  if (!isFinite(n)) return '—';
  const lng = i18n.resolvedLanguage ?? 'en';
  if (n === 0) {
    return new Intl.NumberFormat(lng, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(0);
  }
  if (n < 1) {
    return new Intl.NumberFormat(lng, { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(n);
  }
  if (n < 1_000) {
    return new Intl.NumberFormat(lng, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  }
  // Compact notation handles K/M/B/T suffixes per locale.
  return new Intl.NumberFormat(lng, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(n);
}

function formatCompact(n: number): string {
  const lng = i18n.resolvedLanguage ?? 'en';
  if (n < 1_000) return new Intl.NumberFormat(lng).format(n);
  return new Intl.NumberFormat(lng, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function formatPct(pct: number | null): string {
  if (pct == null) return '—';
  // `signDisplay: 'exceptZero'` gives `+5%`, `0%`, `-5%` per locale —
  // same semantics as the previous manual `+` prefix.
  return new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'exceptZero',
  }).format(pct / 100);
}

function formatChangeLine(pct24h: number | null, pct7d: number | null): string {
  if (pct24h == null && pct7d == null) return '24h / 7d change available once baseline snapshot lands';
  return `24h ${formatPct(pct24h)} · 7d ${formatPct(pct7d)}`;
}

export default function PublicDashboard() {
  const { t } = useTranslation();
  const { mode } = useMode();
  const readChain = useReadChain();
  const { switchToChain, address: walletAddress } = useWallet();
  const { setViewChainId } = useChainOverride();
  const blockExplorer = readChain.blockExplorer ?? DEFAULT_CHAIN.blockExplorer;
  const diamondAddress = readChain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress;
  const chainId = readChain.chainId ?? DEFAULT_CHAIN.chainId;
  // Consolidated Transparency link. Prefers the standalone MetricsFacet
  // address when the chain has one configured — landing users on that
  // contract's `#readContract` tab surfaces the full list of metrics
  // getters (getProtocolTVL, getProtocolStats, getTotalInterestEarnedUSD,
  // etc.) that map 1:1 to the card labels on this page. Falls back to
  // the Diamond `#readProxyContract` tab when the facet address isn't
  // configured yet for this chain.
  const metricsFacetAddress = readChain.metricsFacetAddress ?? null;
  const transparencyHref = metricsFacetAddress
    ? `${blockExplorer}/address/${metricsFacetAddress}#readContract`
    : `${blockExplorer}/address/${diamondAddress}#readProxyContract`;
  const { stats, loading: statsLoading, error: statsError, reload } = useProtocolStats();
  const { snapshot: tvl, loading: tvlLoading } = useTVL();
  const { stats: userStats } = useUserStats();
  const { metrics: treasuryMetrics } = useTreasuryMetrics();
  const { offers: recentOffers } = useRecentOffers(50);
  const { snapshot: vpfi } = useVPFIToken();
  const {
    snapshot: combined,
    loading: combinedLoading,
    reload: reloadCombined,
  } = useCombinedChainsStats();
  const [range, setRange] = useState<TimeRange>('30d');
  const { series } = useHistoricalData(range);
  const isAdvanced = mode === 'advanced';
  const [recentOffersPage, setRecentOffersPage] = useState(0);
  const recentOffersPageCount = Math.max(
    1,
    Math.ceil(recentOffers.length / RECENT_PAGE_SIZE),
  );
  const recentOffersCurrentPage = Math.min(recentOffersPage, recentOffersPageCount - 1);
  const recentOffersPageSlice = useMemo(() => {
    const start = recentOffersCurrentPage * RECENT_PAGE_SIZE;
    return recentOffers.slice(start, start + RECENT_PAGE_SIZE);
  }, [recentOffers, recentOffersCurrentPage]);
  const [recentLoansPage, setRecentLoansPage] = useState(0);

  const deployedChainOptions = useMemo(
    () =>
      Object.values(CHAIN_REGISTRY)
        .filter((c) => c.diamondAddress !== null)
        .sort(compareChainsForDisplay),
    [],
  );

  const handleChainSelect = useCallback(
    (nextChainId: number) => {
      if (nextChainId === chainId) return;
      // Always pin the view override — this is what makes the selector work
      // for disconnected visitors, who would otherwise be stuck on
      // DEFAULT_CHAIN because `switchToChain` needs `window.ethereum`.
      setViewChainId(nextChainId);
      // If a wallet is present, ask it to follow so any subsequent writes
      // land on the same chain the user is reading.
      if (walletAddress) void switchToChain(nextChainId);
    },
    [chainId, setViewChainId, switchToChain, walletAddress],
  );

  // Drop the view-chain override when leaving the dashboard. The override is a
  // dashboard-scoped read-preference; carrying it into write-heavy pages
  // (BuyVPFI, Rewards, etc.) is a foot-gun — if the wallet's actual chain
  // doesn't match, useDiamondContract falls back to a read-only provider and
  // write guards would have to each remember to check the divergence. Clearing
  // on unmount keeps that blast radius confined to this page.
  useEffect(
    () => () => {
      setViewChainId(null);
    },
    [setViewChainId],
  );

  const freshness = stats?.fetchedAt
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(stats.fetchedAt))
    : null;

  const loading = statsLoading || tvlLoading;
  const error = statsError;

  const recentLoans = useMemo(() => {
    if (!stats) return [];
    return [...stats.loans]
      .sort((a, b) => Number(b.startTime - a.startTime))
      .slice(0, 50);
  }, [stats]);
  const recentLoansPageCount = Math.max(
    1,
    Math.ceil(recentLoans.length / RECENT_PAGE_SIZE),
  );
  const recentLoansCurrentPage = Math.min(recentLoansPage, recentLoansPageCount - 1);
  const recentLoansPageSlice = useMemo(() => {
    const start = recentLoansCurrentPage * RECENT_PAGE_SIZE;
    return recentLoans.slice(start, start + RECENT_PAGE_SIZE);
  }, [recentLoans, recentLoansCurrentPage]);

  const handleExport = (fmt: 'csv' | 'json') => {
    if (!stats) return;
    const snapshot = {
      fetchedAt: new Date(stats.fetchedAt).toISOString(),
      blockNumber: stats.blockNumber,
      chainId,
      diamondAddress,
      metrics: {
        totalLoans: stats.totalLoans,
        activeLoans: stats.activeLoans,
        completedLoans: stats.completedLoans,
        defaultedLoans: stats.defaultedLoans,
        totalOffers: stats.totalOffers,
        activeOffers: stats.activeOffers,
        nftRentalsActive: stats.nftRentalsActive,
        averageAprPercent: stats.averageAprBps / 100,
        liquidationRatePercent: stats.liquidationRate,
        totalValueLockedUsd: tvl?.totalUsd ?? 0,
        principalUsd: tvl?.principalUsd ?? 0,
        erc20CollateralUsd: tvl?.erc20CollateralUsd ?? 0,
        nftCollateralCount: tvl?.nftCollateralCount ?? 0,
        uniqueWallets: userStats?.uniqueWallets ?? 0,
        totalVolumeLentUsd: stats.totalVolumeLentUsd,
        totalInterestEarnedUsd: stats.totalInterestEarnedUsd,
        activeLoansValueUsd: stats.activeLoansValueUsd,
        treasuryBalanceUsd: treasuryMetrics?.treasuryBalanceNumeraire ?? 0,
        treasuryFeesLifetimeUsd: treasuryMetrics?.totalFeesCollectedNumeraire ?? 0,
        treasuryFees24hUsd: treasuryMetrics?.feesLast24hNumeraire ?? 0,
        treasuryFees7dUsd: treasuryMetrics?.feesLast7dNumeraire ?? 0,
      },
      assetBreakdown: stats.assetBreakdown,
      collateralBreakdown: stats.collateralBreakdown,
      tvlByAsset: tvl?.byAsset ?? [],
    };

    if (fmt === 'json') {
      downloadFile(
        `vaipakam-snapshot-${Date.now()}.json`,
        JSON.stringify(
          snapshot,
          (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
          2,
        ),
        'application/json',
      );
      return;
    }
    const rows: string[] = [
      '# Vaipakam Public Dashboard Snapshot',
      `# fetchedAt,${snapshot.fetchedAt}`,
      `# blockNumber,${snapshot.blockNumber ?? ''}`,
      `# chainId,${snapshot.chainId}`,
      `# diamondAddress,${snapshot.diamondAddress}`,
      '',
      'metric,value',
      ...Object.entries(snapshot.metrics).map(([k, v]) => `${k},${v}`),
      '',
      'asset,symbol,decimals,loans,volumeRaw,volumeUsd,sharePercent,liquid',
      ...snapshot.assetBreakdown.map(
        (r) =>
          `${r.asset},${r.symbol},${r.decimals},${r.loans},${r.volume.toString()},${r.volumeUsd},${r.share},${r.liquid}`,
      ),
    ];
    downloadFile(`vaipakam-snapshot-${Date.now()}.csv`, rows.join('\n'), 'text/csv');
  };

  return (
    <>
      <Navbar />
      <main className="public-dashboard public-page-glow">
        <div className="container">
          <header className="pd-header">
            <div>
              <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <BarChart3 size={28} style={{ verticalAlign: 'middle', marginRight: 8 }} />
                {t('publicDashboard.pageTitle')}
                <CardInfo id="public-dashboard.overview" />
              </h1>
              <p className="page-subtitle">{t('publicDashboard.pageSubtitle')}</p>
            </div>
            <div className="pd-header-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  void reload();
                  void reloadCombined();
                }}
                aria-label={t('publicDashboard.refreshAria')}
              >
                <RefreshCw size={14} /> {t('publicDashboard.refresh')}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleExport('csv')}
                aria-label={t('publicDashboard.exportCsvAria')}
              >
                <Download size={14} /> CSV
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleExport('json')}
                aria-label={t('publicDashboard.exportJsonAria')}
              >
                <Download size={14} /> JSON
              </button>
            </div>
          </header>

          {error && (
            <ErrorAlert message={`${t('publicDashboard.errorLoading')} ${error.message}`} />
          )}

          <section className="pd-section" aria-label={t('publicDashboard.combinedAria')}>
            <div className="pd-section-head">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {t('publicDashboard.combinedTitle')}
                <CardInfo id="public-dashboard.combined" />
              </h2>
              {combined?.combined.fetchedAt && (
                <span className="pd-subtle">
                  {combined.combined.chainsCovered} chain
                  {combined.combined.chainsCovered === 1 ? '' : 's'}
                  {combined.combined.chainsErrored > 0
                    ? ` · ${combined.combined.chainsErrored} unreachable`
                    : ''}
                </span>
              )}
            </div>
            {combinedLoading && !combined ? (
              <p className="pd-subtle">{t('publicDashboard.aggregatingCombined')}</p>
            ) : !combined ? (
              <p className="pd-subtle">{t('publicDashboard.noDeployedChains')}</p>
            ) : (
              <div className="pd-metrics-grid">
                <MetricCard
                  icon={<Lock size={18} />}
                  label="Total Value Locked"
                  value={formatUsd(combined.combined.tvlUsd)}
                  hint={[
                    `${formatUsd(combined.combined.erc20CollateralUsd)} ERC-20 collateral · ${combined.combined.nftCollateralCount} NFT positions`,
                    formatChangeLine(
                      combined.combined.tvlChange24hPct,
                      combined.combined.tvlChange7dPct,
                    ),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  onchainFn="getProtocolTVL"
                />
                <MetricCard
                  icon={<Activity size={18} />}
                  label="Active Loans"
                  value={combined.combined.activeLoans.toString()}
                  hint={`${formatUsd(combined.combined.activeLoansValueUsd)} live value · across ${combined.combined.chainsCovered} chain${combined.combined.chainsCovered === 1 ? '' : 's'}`}
                  onchainFn="getLoanSummary"
                />
                <MetricCard
                  icon={<Coins size={18} />}
                  label="Active Offers"
                  value={combined.combined.activeOffers.toString()}
                  hint="Currently open offers across every deployed Diamond"
                  onchainFn="getProtocolStats"
                />
                <MetricCard
                  icon={<Coins size={18} />}
                  label="Lifetime Offers"
                  value={combined.combined.lifetimeOffers.toString()}
                  hint="Every offer ever posted across every deployed Diamond"
                  onchainFn="getGlobalCounts"
                />
                <MetricCard
                  icon={<TrendingUp size={18} />}
                  label="Lifetime Volume Lent"
                  value={formatUsd(combined.combined.volumeLentUsd)}
                  hint="Sum of every ERC-20 principal ever originated, oracle-priced"
                  onchainFn="getProtocolStats"
                />
                <MetricCard
                  icon={<PiggyBank size={18} />}
                  label="Lifetime Interest Earned"
                  value={formatUsd(combined.combined.interestEarnedUsd)}
                  hint="Interest paid to lenders across every completed loan"
                  onchainFn="getProtocolStats"
                />
                <MetricCard
                  icon={<BarChart3 size={18} />}
                  label="Lifetime Loans Originated"
                  value={combined.combined.lifetimeLoans.toString()}
                  hint="Every loan that has ever reached Active"
                  onchainFn="getProtocolStats"
                />
                <MetricCard
                  icon={<ImageIcon size={18} />}
                  label="NFTs Rented"
                  value={combined.combined.nftCollateralCount.toString()}
                  hint={`Currently rented across ${combined.combined.chainsCovered} chain${combined.combined.chainsCovered === 1 ? '' : 's'} (open NFT-collateralised rentals)`}
                  onchainFn="getProtocolTVL"
                />
              </div>
            )}
          </section>

          <section className="pd-section" aria-label={t('publicDashboard.perChainAria')}>
            <div className="pd-section-head">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {t('publicDashboard.perChainTitle')}
                <CardInfo id="public-dashboard.per-chain" />
              </h2>
              <label className="pd-chain-selector">
                <span className="pd-subtle">{t('publicDashboard.chainLabel')}</span>
                <ChainPicker
                  chains={deployedChainOptions}
                  value={chainId}
                  onSelect={handleChainSelect}
                  ariaLabel={t('publicDashboard.chainPickerAria')}
                  menuAlign="right"
                />
              </label>
            </div>
            <p className="pd-subtle" style={{ marginTop: 4 }}>
              {t('publicDashboard.perChainSubtitle')}
            </p>
          </section>

          {loading && !stats && (
            <div className="empty-state" style={{ minHeight: 240 }}>
              <p>{t('publicDashboard.aggregatingOnChain')}</p>
            </div>
          )}

          {stats && (
            <>
              <section className="pd-metrics-grid" aria-label="Top-level metrics">
                <MetricCard
                  icon={<Lock size={18} />}
                  label="Total Value Locked"
                  value={formatUsd(tvl?.totalUsd ?? 0)}
                  hint={
                    tvl
                      ? `${formatUsd(tvl.principalUsd)} principal · ${formatUsd(tvl.erc20CollateralUsd)} ERC-20 collateral`
                      : 'Pricing via Chainlink'
                  }
                  onchainFn="getProtocolTVL"
                />
                <MetricCard
                  icon={<TrendingUp size={18} />}
                  label="Total Volume Lent"
                  value={formatUsd(stats.totalVolumeLentUsd)}
                  hint="Lifetime ERC-20 principal, priced at current oracle"
                  onchainFn="getProtocolStats"
                />
                <MetricCard
                  icon={<PiggyBank size={18} />}
                  label="Interest Earned by Lenders"
                  value={formatUsd(stats.totalInterestEarnedUsd)}
                  hint="Lifetime, completed loans only"
                  onchainFn="getTotalInterestEarnedNumeraire"
                />
                <MetricCard
                  icon={<Landmark size={18} />}
                  label="Treasury Balance"
                  value={formatUsd(treasuryMetrics?.treasuryBalanceNumeraire ?? 0)}
                  hint={
                    treasuryMetrics
                      ? `${formatUsd(treasuryMetrics.totalFeesCollectedNumeraire)} lifetime · ${formatUsd(treasuryMetrics.feesLast24hNumeraire)} 24h`
                      : 'Unclaimed protocol fees'
                  }
                  onchainFn="getTreasuryMetrics"
                />
                <MetricCard
                  icon={<Activity size={18} />}
                  label="Active Loans"
                  value={stats.activeLoans.toString()}
                  hint={`${formatUsd(stats.activeLoansValueUsd)} live value · ${stats.nftRentalsActive} NFT rentals`}
                  onchainFn="getActiveLoansCount"
                />
                <MetricCard
                  icon={<ImageIcon size={18} />}
                  label="NFTs Rented"
                  value={stats.nftRentalsActive.toString()}
                  hint={`Active NFT-collateralised rentals on ${readChain.name}`}
                  onchainFn="getProtocolTVL"
                />
                <MetricCard
                  icon={<Users size={18} />}
                  label="Unique Wallets"
                  value={userStats ? formatCompact(userStats.uniqueWallets) : '—'}
                  hint={
                    userStats
                      ? `${userStats.lenderWallets} lenders · ${userStats.borrowerWallets} borrowers`
                      : ''
                  }
                  onchainFn="getUserCount"
                />
                <MetricCard
                  icon={<Coins size={18} />}
                  label="Offers Posted"
                  value={stats.totalOffers.toString()}
                  hint={`${stats.activeOffers} currently open`}
                  onchainFn="getActiveOffersCount"
                />
                <MetricCard
                  icon={<Gauge size={18} />}
                  label="Average APR"
                  value={
                    stats.totalLoans === 0
                      ? '—'
                      : (stats.averageAprBps / 100).toFixed(2) + '%'
                  }
                  hint={`Across ${stats.totalLoans} loans`}
                  onchainFn="getProtocolStats"
                />
                <MetricCard
                  icon={<Activity size={18} />}
                  label="Liquidation / Default Rate"
                  value={stats.totalLoans === 0 ? '—' : stats.liquidationRate.toFixed(2) + '%'}
                  hint={`${stats.defaultedLoans} defaulted of ${stats.totalLoans} total`}
                  onchainFn="getProtocolHealth"
                />
              </section>

              <section className="pd-section">
                <div className="pd-section-head">
                  <h2>{t('publicDashboard.tvlOverTime')}</h2>
                  <div className="pd-range" role="tablist" aria-label="TVL range">
                    {RANGES.map((r) => (
                      <button
                        key={r}
                        role="tab"
                        aria-selected={range === r}
                        className={`btn btn-sm ${range === r ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setRange(r)}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
                <LineChart data={series?.tvl ?? []} label="Cumulative locked value (approx)" />
              </section>

              <section className="pd-section pd-two-col">
                <div>
                  <h2>{t('publicDashboard.dailyLoanVolume')}</h2>
                  <BarSeries data={series?.dailyVolume ?? []} />
                </div>
                <div>
                  <h2>{t('publicDashboard.activeVsCompleted')}</h2>
                  <Donut
                    slices={[
                      { label: 'Active', value: stats.activeLoans, color: 'var(--brand)' },
                      {
                        label: 'Completed',
                        value: stats.completedLoans - stats.defaultedLoans,
                        color: 'var(--accent-green)',
                      },
                      {
                        label: 'Defaulted',
                        value: stats.defaultedLoans,
                        color: 'var(--accent-red)',
                      },
                    ]}
                  />
                </div>
              </section>

              <section className="pd-section">
                <h2>{t('publicDashboard.assetDistribution')}</h2>
                {stats.assetBreakdown.length === 0 ? (
                  <p className="empty-state-inline">{t('publicDashboard.noLoanVolume')}</p>
                ) : (
                  <div className="pd-distribution">
                    {stats.assetBreakdown.slice(0, 8).map((row) => (
                      <div className="pd-dist-row" key={row.asset}>
                        <div className="pd-dist-label">
                          <span>
                            <strong>
                              <AssetLink
                                kind="erc20"
                                chainId={chainId}
                                address={row.asset}
                                showIcon={false}
                                label={row.symbol}
                              />
                            </strong>{' '}
                            <CopyableAddress address={row.asset} className="pd-subtle" />
                          </span>
                          <span className="pd-dist-share">
                            {row.liquid ? `${row.share.toFixed(1)}%` : 'illiquid'}
                          </span>
                        </div>
                        <div
                          className="pd-dist-bar"
                          style={{ width: `${Math.max(2, Math.min(100, row.share))}%` }}
                        />
                        <div className="pd-dist-meta">
                          {row.loans} loan{row.loans === 1 ? '' : 's'} ·{' '}
                          {formatUnitsPretty(row.volume, row.decimals)}{' '}
                          <AssetLink
                            kind="erc20"
                            chainId={chainId}
                            address={row.asset}
                            showIcon={false}
                            label={row.symbol}
                          />
                          {row.liquid && <> · {formatUsd(row.volumeUsd)}</>}
                          <a
                            href={`${blockExplorer}/address/${row.asset}`}
                            target="_blank"
                            rel="noreferrer"
                            className="pd-chain-link"
                            aria-label={`View ${row.symbol} on explorer`}
                          >
                            <ExternalLink size={12} />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="pd-section">
                <h2>{t('publicDashboard.nftRentalUtilization')}</h2>
                <div className="pd-utilization">
                  <div>
                    <div className="pd-big">{stats.nftRentalsActive}</div>
                    <div className="pd-sub">Active NFT rentals</div>
                  </div>
                  <div>
                    <div className="pd-big">{tvl?.nftCollateralCount ?? 0}</div>
                    <div className="pd-sub">Active NFT collateral positions</div>
                  </div>
                  <div>
                    <div className="pd-big">{stats.erc20ActiveLoans}</div>
                    <div className="pd-sub">Active ERC-20 loans</div>
                  </div>
                </div>
              </section>

              <section className="pd-section">
                <div className="pd-section-head">
                  <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    VPFI Token Transparency
                    <CardInfo id="public-dashboard.vpfi-transparency" />
                  </h2>
                  {vpfi?.registered && (
                    <a
                      href={`${blockExplorer}/address/${vpfi.token}`}
                      target="_blank"
                      rel="noreferrer"
                      className="pd-chain-link"
                      aria-label="View VPFI token on explorer"
                    >
                      <span className="mono pd-subtle">{shortenAddr(vpfi.token)}</span>{' '}
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                {!vpfi || !vpfi.registered ? (
                  <p className="empty-state-inline">
                    VPFI token is not yet registered with this Diamond.
                  </p>
                ) : (
                  <>
                    <div className="pd-utilization">
                      <div>
                        <div className="pd-big">{formatCompact(vpfi.totalSupply)}</div>
                        <div className="pd-sub">Circulating supply (VPFI)</div>
                      </div>
                      <div>
                        <div className="pd-big">{formatCompact(vpfi.cap)}</div>
                        <div className="pd-sub">Hard cap (VPFI)</div>
                      </div>
                      <div>
                        <div className="pd-big">{formatCompact(vpfi.capHeadroom)}</div>
                        <div className="pd-sub">Remaining mintable</div>
                      </div>
                    </div>
                    <div className="pd-dist-row" style={{ marginTop: 16 }}>
                      <div className="pd-dist-label">
                        <span>Cap utilization</span>
                        <span className="pd-dist-share">
                          {(vpfi.circulatingShare * 100).toFixed(2)}%
                        </span>
                      </div>
                      <div
                        className="pd-dist-bar"
                        style={{
                          width: `${Math.max(2, Math.min(100, vpfi.circulatingShare * 100))}%`,
                        }}
                      />
                      <div className="pd-dist-meta">
                        Authorized minter:{' '}
                        <span className="mono">{shortenAddr(vpfi.minter)}</span>
                        <a
                          href={`${blockExplorer}/address/${vpfi.minter}`}
                          target="_blank"
                          rel="noreferrer"
                          className="pd-chain-link"
                          aria-label="View minter on explorer"
                        >
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    </div>
                  </>
                )}
              </section>

              {isAdvanced && (
                <>
                  <section className="pd-section">
                    <h2>{t('publicDashboard.assetWiseBreakdown')}</h2>
                    <div className="pd-table-wrap">
                      <table className="pd-table">
                        <thead>
                          <tr>
                            <th>Asset</th>
                            <th>Symbol</th>
                            <th>Locked amount</th>
                            <th>USD</th>
                            <th>Share of TVL</th>
                            <th>Liquid?</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {(tvl?.byAsset ?? []).map((row) => {
                            const totalUsd = tvl?.totalUsd ?? 0;
                            const share = totalUsd === 0 ? 0 : (row.usd / totalUsd) * 100;
                            return (
                              <tr key={row.asset}>
                                <td>
                                  <CopyableAddress address={row.asset} />
                                </td>
                                <td>
                                  <AssetLink
                                    kind="erc20"
                                    chainId={chainId}
                                    address={row.asset}
                                    showIcon={false}
                                    label={row.symbol}
                                  />
                                </td>
                                <td className="mono">
                                  {formatUnitsPretty(row.amount, row.decimals)}
                                </td>
                                <td>{formatUsd(row.usd)}</td>
                                <td>{share.toFixed(1)}%</td>
                                <td>{row.liquid ? 'Yes' : 'Illiquid ($0)'}</td>
                                <td>
                                  <a
                                    href={`${blockExplorer}/address/${row.asset}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    aria-label="View on explorer"
                                    className="pd-chain-link"
                                  >
                                    <ExternalLink size={12} />
                                  </a>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <section className="pd-section">
                    <h2>{t('publicDashboard.protocolHealth')}</h2>
                    <div className="pd-metrics-grid">
                      <MetricCard
                        label="Average APR"
                        value={(stats.averageAprBps / 100).toFixed(2) + '%'}
                        hint="Mean across all loans (active + closed)"
                      />
                      <MetricCard
                        label="Illiquid assets (loans)"
                        value={(tvl?.byAsset.filter((a) => !a.liquid).length ?? 0).toString()}
                        hint="Assets without a Chainlink feed; contribute $0 to TVL"
                      />
                      <MetricCard
                        label="Default rate"
                        value={stats.liquidationRate.toFixed(2) + '%'}
                        hint={`${stats.defaultedLoans} defaulted of ${stats.totalLoans}`}
                      />
                    </div>
                  </section>

                  <section className="pd-section">
                    <h2>{t('publicDashboard.recentActivity')}</h2>
                    <p className="pd-subtle">
                      Last {recentLoans.length} loans. No addresses shown — positions are
                      keyed by loan ID only.
                    </p>
                    {recentLoans.length === 0 ? (
                      <p className="empty-state-inline">{t('publicDashboard.noLoans')}</p>
                    ) : (
                      <>
                        <div className="pd-table-wrap">
                          <table className="pd-table">
                            <thead>
                              <tr>
                                <th>Loan</th>
                                <th>Principal</th>
                                <th>APR</th>
                                <th>Duration</th>
                                <th>Asset Type</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {recentLoansPageSlice.map((l) => {
                                const status = Number(l.status) as LoanStatus;
                                const info = stats.assetInfo?.[l.principalAsset.toLowerCase()];
                                const decimals = info?.tokenDecimals ?? 18;
                                const symbol = info?.symbol ?? '';
                                return (
                                  <tr key={l.id.toString()}>
                                    <td className="mono">#{l.id.toString()}</td>
                                    <td className="mono">
                                      {formatUnitsPretty(l.principal, decimals)}
                                      {symbol && (
                                        <span className="pd-table-symbol"> {symbol}</span>
                                      )}
                                    </td>
                                    <td>{bpsToPercent(l.interestRateBps)}</td>
                                    <td>{l.durationDays.toString()}d</td>
                                    <td>
                                      {Number(l.assetType) === AssetType.ERC20
                                        ? 'ERC-20'
                                        : Number(l.assetType) === AssetType.ERC721
                                          ? 'ERC-721'
                                          : 'ERC-1155'}
                                    </td>
                                    <td>
                                      <span
                                        className={`status-badge ${LOAN_STATUS_LABELS[status].toLowerCase()}`}
                                      >
                                        {LOAN_STATUS_LABELS[status]}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        <Pager
                          total={recentLoans.length}
                          pageSize={RECENT_PAGE_SIZE}
                          page={recentLoansCurrentPage}
                          onPageChange={setRecentLoansPage}
                          unit="loan"
                        />
                      </>
                    )}
                  </section>

                  <section className="pd-section">
                    <h2>{t('publicDashboard.recentOffers')}</h2>
                    <p className="pd-subtle">
                      Last {recentOffers.length} offers indexed from events. Open, accepted,
                      and cancelled states are all shown.
                    </p>
                    {recentOffers.length === 0 ? (
                      <p className="empty-state-inline">{t('publicDashboard.noOffers')}</p>
                    ) : (
                      <>
                        <div className="pd-table-wrap">
                          <table className="pd-table">
                            <thead>
                              <tr>
                                <th>Offer</th>
                                <th>Side</th>
                                <th>Lending asset</th>
                                <th>Amount</th>
                                <th>APR</th>
                                <th>Duration</th>
                                <th>State</th>
                              </tr>
                            </thead>
                            <tbody>
                              {recentOffersPageSlice.map((o) => {
                                const info = stats.assetInfo?.[o.lendingAsset.toLowerCase()];
                                const decimals = info?.tokenDecimals ?? 18;
                                const symbol = info?.symbol ?? '';
                                return (
                                <tr key={o.id.toString()}>
                                  <td className="mono">#{o.id.toString()}</td>
                                  <td>{o.offerType === 0 ? 'Lender' : 'Borrower'}</td>
                                  <td className="mono">
                                    {symbol ? symbol : shortenAddr(o.lendingAsset)}
                                  </td>
                                  <td className="mono">{formatUnitsPretty(o.amount, decimals)}</td>
                                  <td>{bpsToPercent(o.interestRateBps)}</td>
                                  <td>{o.durationDays.toString()}d</td>
                                  <td>
                                    <span
                                      className={`status-badge ${o.accepted ? 'repaid' : o.creator === '0x0000000000000000000000000000000000000000' ? 'defaulted' : 'active'}`}
                                    >
                                      {o.accepted
                                        ? 'Accepted'
                                        : o.creator === '0x0000000000000000000000000000000000000000'
                                          ? 'Cancelled'
                                          : 'Open'}
                                    </span>
                                  </td>
                                </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        <Pager
                          total={recentOffers.length}
                          pageSize={RECENT_PAGE_SIZE}
                          page={recentOffersCurrentPage}
                          onPageChange={setRecentOffersPage}
                          unit="offer"
                        />
                      </>
                    )}
                  </section>

                </>
              )}

              <section
                id="transparency"
                className="pd-section pd-transparency"
              >
                <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Transparency &amp; Source
                  <CardInfo id="public-dashboard.transparency" />
                </h2>
                <div className="pd-transparency-grid">
                  <div>
                    <div className="pd-sub">Snapshot block</div>
                    <div className="pd-big">{stats.blockNumber ?? '—'}</div>
                  </div>
                  <div>
                    <div className="pd-sub">Data freshness</div>
                    <div className="pd-big">{freshness ?? '—'}</div>
                  </div>
                  <div>
                    <div className="pd-sub">Diamond address</div>
                    <a
                      href={`${blockExplorer}/address/${diamondAddress}`}
                      target="_blank"
                      rel="noreferrer"
                      className="pd-big pd-chain-link"
                    >
                      {shortenAddr(diamondAddress)} <ExternalLink size={14} />
                    </a>
                  </div>
                  <div>
                    <div className="pd-sub">View on-chain</div>
                    <a
                      href={transparencyHref}
                      target="_blank"
                      rel="noreferrer"
                      className="pd-big pd-chain-link"
                      data-tooltip={
                        metricsFacetAddress
                          ? 'MetricsFacet — Read Contract tab. Every getter shown here powers one of the cards above.'
                          : 'Diamond — Read as Proxy tab. Configure the MetricsFacet address for a direct link to the metrics surface.'
                      }
                    >
                      {metricsFacetAddress ? 'MetricsFacet' : 'Diamond proxy'}{' '}
                      <ExternalLink size={14} />
                    </a>
                  </div>
                </div>
                <p className="pd-subtle" style={{ marginTop: 12 }}>
                  All metrics above are reproducible from the Diamond at the
                  block shown. The <strong>View on-chain</strong> link lands on
                  the {metricsFacetAddress ? 'MetricsFacet' : 'Diamond proxy'}{' '}
                  Read Contract tab, where every getter that powers a card on
                  this page is callable directly. See{' '}
                  <Link to="/app">connected app</Link> for wallet-scoped views.
                </p>
              </section>
            </>
          )}

          <div className="pd-disclaimer" role="note" style={{ marginTop: 24, marginBottom: 0 }}>
            <ShieldCheck size={16} />
            <span>
              Vaipakam is a fully decentralized, non-custodial protocol. All
              displayed data is aggregated from on-chain smart contracts. No
              personal user data is collected or stored. This dashboard is
              provided for transparency purposes only.
            </span>
          </div>
        </div>
      </main>
      <Footer />
      <DiagnosticsDrawer />
    </>
  );
}

function MetricCard({
  icon,
  label,
  value,
  hint,
  onchainFn,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  onchainFn?: string;
}) {
  // Per-card "View on-chain" links were removed — users now reach the
  // MetricsFacet's Read Contract tab from the Transparency & Source
  // section below the grid (single consolidated link so an explorer
  // visit lands them on the full getter list, not a single function).
  // `onchainFn` is kept on the card as a tooltip so readers still see
  // which Diamond getter each metric came from without leaving the page.
  return (
    <div
      className="stat-card pd-metric"
      data-tooltip={onchainFn ? `Source: ${onchainFn}` : undefined}
    >
      {icon && <div className="stat-icon pd-metric-icon">{icon}</div>}
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
        {hint && <div className="pd-metric-hint">{hint}</div>}
      </div>
    </div>
  );
}

function LineChart({ data, label }: { data: { t: number; value: number }[]; label: string }) {
  if (data.length === 0) {
    return <div className="pd-chart-empty">No data for this range.</div>;
  }
  const width = 640;
  const height = 200;
  const pad = 24;
  const xs = data.map((d) => d.t);
  const ys = data.map((d) => d.value);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = 0;
  const maxY = Math.max(1, ...ys);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);

  const toX = (t: number) => pad + ((t - minX) / spanX) * (width - pad * 2);
  const toY = (v: number) => height - pad - ((v - minY) / spanY) * (height - pad * 2);

  const path = data
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.t).toFixed(1)},${toY(p.value).toFixed(1)}`)
    .join(' ');

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      className="pd-chart"
      preserveAspectRatio="none"
    >
      <path d={path} fill="none" stroke="var(--brand)" strokeWidth={2} />
      {data.map((p) => (
        <circle key={p.t} cx={toX(p.t)} cy={toY(p.value)} r={2.5} fill="var(--brand)" />
      ))}
    </svg>
  );
}

function BarSeries({ data }: { data: { t: number; value: number; secondary?: number }[] }) {
  if (data.length === 0) return <div className="pd-chart-empty">No data for this range.</div>;
  const width = 480;
  const height = 180;
  const pad = 16;
  const hasInterest = data.some((d) => (d.secondary ?? 0) > 0);
  const maxV = Math.max(1, ...data.map((d) => d.value));
  const maxI = Math.max(1, ...data.map((d) => d.secondary ?? 0));
  const barW = (width - pad * 2) / data.length - 2;

  const toX = (i: number) => pad + i * (barW + 2) + barW / 2;
  const toY = (v: number) => height - pad - ((height - pad * 2) * v) / maxI;

  const linePath = hasInterest
    ? data
        .map(
          (p, i) =>
            `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(p.secondary ?? 0).toFixed(1)}`,
        )
        .join(' ')
    : '';

  return (
    <>
      <svg
        role="img"
        aria-label="Daily loan volume (USD) with interest overlay"
        viewBox={`0 0 ${width} ${height}`}
        className="pd-chart"
        preserveAspectRatio="none"
      >
        {data.map((p, i) => {
          const h = ((height - pad * 2) * p.value) / maxV;
          return (
            <rect
              key={p.t}
              x={pad + i * (barW + 2)}
              y={height - pad - h}
              width={barW}
              height={h}
              fill="var(--brand)"
              opacity={0.8}
            />
          );
        })}
        {hasInterest && (
          <>
            <path d={linePath} fill="none" stroke="var(--accent-green)" strokeWidth={2} />
            {data.map((p, i) => (
              <circle
                key={`i-${p.t}`}
                cx={toX(i)}
                cy={toY(p.secondary ?? 0)}
                r={2}
                fill="var(--accent-green)"
              />
            ))}
          </>
        )}
      </svg>
      <div className="pd-chart-legend">
        <span className="pd-legend-item">
          <span className="pd-legend-dot" style={{ background: 'var(--brand)' }} /> Volume (USD)
        </span>
        {hasInterest && (
          <span className="pd-legend-item">
            <span className="pd-legend-dot" style={{ background: 'var(--accent-green)' }} />{' '}
            Interest (USD)
          </span>
        )}
      </div>
    </>
  );
}

function Donut({ slices }: { slices: { label: string; value: number; color: string }[] }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total === 0) return <div className="pd-chart-empty">No data.</div>;
  const r = 60;
  const cx = 80;
  const cy = 80;
  // Prefix sum over fractional shares — each slice's start is the sum of all
  // prior fractions, computed up-front so the subsequent map is a pure
  // derivation (no mutated outer accumulator during render).
  const prefix = slices.reduce<number[]>((out, s) => {
    const prev = out.length === 0 ? 0 : out[out.length - 1];
    return [...out, prev + s.value / total];
  }, []);
  const arcs = slices.map((s, i) => {
    const start = i === 0 ? 0 : prefix[i - 1];
    const end = prefix[i];
    return { ...s, d: arcPath(cx, cy, r, start, end) };
  });
  return (
    <div className="pd-donut">
      <svg role="img" aria-label="Active vs completed distribution" viewBox="0 0 160 160">
        {arcs.map((a) => (
          <path key={a.label} d={a.d} fill={a.color} stroke="var(--surface)" strokeWidth={1} />
        ))}
        <circle cx={cx} cy={cy} r={30} fill="var(--surface)" />
        <text x={cx} y={cy + 5} textAnchor="middle" fontSize={16} fill="var(--text-primary)">
          {total}
        </text>
      </svg>
      <ul className="pd-legend">
        {arcs.map((a) => (
          <li key={a.label}>
            <span className="pd-legend-dot" style={{ background: a.color }} />
            {a.label}: {a.value} ({total === 0 ? 0 : ((a.value / total) * 100).toFixed(0)}%)
          </li>
        ))}
      </ul>
    </div>
  );
}

function arcPath(cx: number, cy: number, r: number, start: number, end: number) {
  const s = 2 * Math.PI * start - Math.PI / 2;
  const e = 2 * Math.PI * end - Math.PI / 2;
  const x1 = cx + r * Math.cos(s);
  const y1 = cy + r * Math.sin(s);
  const x2 = cx + r * Math.cos(e);
  const y2 = cy + r * Math.sin(e);
  const large = end - start > 0.5 ? 1 : 0;
  return `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
