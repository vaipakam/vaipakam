import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../utils';

// #1076: PublicDashboard migrated ethers → viem AND was re-sourced. It no
// longer drives its cards from a single `useProtocolStats` multicall — that
// hook is pinned `enabled: false` on this page. The count cards are now
// indexer-first via `useLoanStats` / `useOfferStats` / `useTVL` /
// `useUserStats`, with a cross-chain roll-up from `useCombinedChainsStats`.
// The test stubs each of those hooks (mutable singletons so per-render
// identity stays stable — a fresh object/array per render would loop the
// page's memo/effect chain) and neutralises the page chrome (Navbar / Footer
// / DiagnosticsDrawer / DataSyncStatus / ChainPicker) which pull their own
// wallet / watermark / freshness provider chains omitted from the harness.

const loanStatsMock: any = { stats: null, loading: false, reload: vi.fn() };
vi.mock('../../src/hooks/useLoanStats', () => ({ useLoanStats: () => loanStatsMock }));

const protocolStatsMock: any = { stats: null };
vi.mock('../../src/hooks/useProtocolStats', () => ({ useProtocolStats: () => protocolStatsMock }));

const tvlMock: any = { snapshot: null, loading: false, error: null };
vi.mock('../../src/hooks/useTVL', () => ({ useTVL: () => tvlMock }));

const userStatsMock: any = {
  stats: { uniqueWallets: 0, lenderWallets: 0, borrowerWallets: 0, bothSides: 0 },
  loading: false,
};
vi.mock('../../src/hooks/useUserStats', () => ({ useUserStats: () => userStatsMock }));

const offerStatsMock: any = { stats: null, loading: false };
vi.mock('../../src/hooks/useOfferStats', () => ({ useOfferStats: () => offerStatsMock }));

const assetBreakdownMock: any = { rows: null, loading: false };
vi.mock('../../src/hooks/useAssetBreakdown', () => ({ useAssetBreakdown: () => assetBreakdownMock }));

const treasuryMock: any = { metrics: null, loading: false, error: null, reload: vi.fn() };
vi.mock('../../src/hooks/useTreasuryMetrics', () => ({ useTreasuryMetrics: () => treasuryMock }));

const recentOffersMock: any = { offers: [], loading: false, reload: vi.fn() };
vi.mock('../../src/hooks/useRecentOffers', () => ({ useRecentOffers: () => recentOffersMock }));

const recentLoansMock: any = { loans: [], loading: false, reload: vi.fn() };
vi.mock('../../src/hooks/useRecentLoans', () => ({ useRecentLoans: () => recentLoansMock }));

const vpfiMock: any = { snapshot: null, loading: false, error: null, reload: vi.fn(), getBalanceOf: vi.fn() };
vi.mock('../../src/hooks/useVPFIToken', () => ({ useVPFIToken: () => vpfiMock }));

const historicalMock: any = { series: null, loading: false };
vi.mock('../../src/hooks/useHistoricalData', () => ({ useHistoricalData: () => historicalMock }));

const combinedMock: any = { snapshot: null, loading: false, error: null, reload: vi.fn() };
vi.mock('../../src/hooks/useCombinedChainsStats', () => ({
  useCombinedChainsStats: () => combinedMock,
}));

vi.mock('../../src/hooks/useLiveWatermark', () => ({
  useLiveWatermark: () => ({ version: 0, snapshot: null, status: 'unreachable' }),
}));

// Read chain — stable stub (this page only reads the chain, never writes).
const readChainStub = {
  chainId: 84532,
  diamondAddress: '0x00000000000000000000000000000000000000D1',
  deployBlock: 1,
  rpcUrl: 'http://localhost:8545',
  blockExplorer: 'https://sepolia.basescan.org',
  name: 'Base Sepolia',
  metricsFacetAddress: null,
};
vi.mock('../../src/contracts/useDiamond', () => ({ useReadChain: () => readChainStub }));

// Page chrome — pull wallet / watermark / freshness chains; stub to null so
// the analytics body itself is what's under test.
vi.mock('../../src/components/Navbar', () => ({ default: () => null }));
vi.mock('../../src/components/Footer', () => ({ default: () => null }));
vi.mock('../../src/components/app/DiagnosticsDrawer', () => ({ default: () => null }));
vi.mock('../../src/components/app/DataSyncStatus', () => ({ DataSyncStatus: () => null }));
vi.mock('../../src/components/CardInfo', () => ({ CardInfo: () => null }));
vi.mock('@vaipakam/ui/ChainPicker', () => ({ ChainPicker: () => null }));

import PublicDashboard from '../../src/pages/PublicDashboard';

// Indexer LoanStats shape (see lib/indexerClient.ts).
function mkLoanStats(over: any = {}) {
  return {
    chainId: 84532,
    active: 1, repaid: 0, defaulted: 0, liquidated: 0, settled: 0, total: 1,
    erc20ActiveLoans: 1, nftRentalsActive: 0,
    volumeByAsset: {}, loansByAsset: {},
    averageInterestRateBps: 500,
    indexer: { lastBlock: 100, updatedAt: Math.floor(Date.now() / 1000) },
    ...over,
  };
}

function mkCombined(over: any = {}) {
  return {
    combined: {
      tvlUsd: 12345, erc20CollateralUsd: 2000, nftCollateralCount: 0,
      tvlChange24hPct: null, tvlChange7dPct: null,
      activeLoans: 1, activeLoansValueUsd: 10345, activeOffers: 2,
      lifetimeOffers: 3, volumeLentUsd: 10000, interestEarnedUsd: 50,
      lifetimeLoans: 1, chainsCovered: 1, chainsErrored: 0,
      fetchedAt: Date.now(),
      ...over,
    },
  };
}

beforeEach(() => {
  loanStatsMock.stats = null;
  loanStatsMock.loading = false;
  protocolStatsMock.stats = null;
  tvlMock.snapshot = null;
  tvlMock.loading = false;
  tvlMock.error = null;
  offerStatsMock.stats = null;
  assetBreakdownMock.rows = null;
  treasuryMock.metrics = null;
  recentOffersMock.offers = [];
  recentLoansMock.loans = [];
  vpfiMock.snapshot = null;
  historicalMock.series = null;
  combinedMock.snapshot = null;
  userStatsMock.stats = { uniqueWallets: 0, lenderWallets: 0, borrowerWallets: 0, bothSides: 0 };
  localStorage.clear();
});

describe('PublicDashboard', () => {
  it('renders header, disclaimer, and export controls', () => {
    renderWithProviders(<PublicDashboard />, { route: '/analytics' });
    expect(
      screen.getByRole('heading', { name: /Public Analytics Dashboard/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/fully decentralized, non-custodial protocol/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /CSV/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /JSON/i })).toBeInTheDocument();
  });

  it('shows loading state before stats resolve', () => {
    // #1076: loading gate is now `loanStatsLoading || tvlLoading` and the
    // empty state hides once EITHER indexer source has data.
    loanStatsMock.loading = true;
    renderWithProviders(<PublicDashboard />, { route: '/analytics' });
    expect(screen.getByText(/Aggregating on-chain state/i)).toBeInTheDocument();
  });

  it('degrades gracefully when the TVL source errors', () => {
    // #1076 STALE: the old `useProtocolStats.error` red banner was removed —
    // analytics is a best-effort public surface that shows "—"/$0 placeholders
    // on a worker outage rather than an error banner. Intended behaviour now:
    // with the loan counts present but TVL unavailable, the page still renders
    // its metric grid (TVL card falls back to $0) and never crashes.
    loanStatsMock.stats = mkLoanStats();
    tvlMock.error = new Error('rpc down');
    renderWithProviders(<PublicDashboard />, { route: '/analytics' });
    expect(screen.getByText(/Total Value Locked/i)).toBeInTheDocument();
  });

  it('renders metrics + disclaimer once stats resolve', async () => {
    loanStatsMock.stats = mkLoanStats();
    tvlMock.snapshot = {
      totalUsd: 12345,
      erc20CollateralUsd: 2000,
      principalUsd: 10345,
      nftCollateralCount: 0,
      byAsset: [],
      fetchedAt: Date.now(),
    };
    offerStatsMock.stats = {
      chainId: 84532, active: 2, accepted: 1, cancelled: 0, expired: 0, total: 3,
      indexer: { lastBlock: 100, updatedAt: Math.floor(Date.now() / 1000) },
    };
    userStatsMock.stats = { uniqueWallets: 3, lenderWallets: 2, borrowerWallets: 2, bothSides: 1 };
    renderWithProviders(<PublicDashboard />, { route: '/analytics' });
    await waitFor(() =>
      expect(screen.getByText(/Total Value Locked/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Unique Wallets/i)).toBeInTheDocument();
    expect(screen.getByText(/Active Loans/i)).toBeInTheDocument();
    expect(screen.getByText(/Offers Posted/i)).toBeInTheDocument();
    expect(screen.getByText(/\$12\.35K|\$12\.34K/)).toBeInTheDocument();
  });

  it('range tabs switch active tab selection', async () => {
    loanStatsMock.stats = mkLoanStats();
    renderWithProviders(<PublicDashboard />, { route: '/analytics' });
    await waitFor(() => expect(screen.getByRole('tab', { name: '30d' })).toBeInTheDocument());
    const tab7d = screen.getByRole('tab', { name: '7d' });
    await userEvent.click(tab7d);
    expect(tab7d.getAttribute('aria-selected')).toBe('true');
  });

  it('advanced mode reveals recent activity + protocol health', async () => {
    localStorage.setItem('vaipakam.uiMode', 'advanced');
    loanStatsMock.stats = mkLoanStats();
    renderWithProviders(<PublicDashboard />, { route: '/analytics' });
    await waitFor(() => expect(screen.getByText(/Recent Activity/i)).toBeInTheDocument());
    expect(screen.getByText(/Protocol Health/i)).toBeInTheDocument();
  });

  it('JSON export triggers a download (anchor click)', async () => {
    loanStatsMock.stats = mkLoanStats();
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:mock'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    renderWithProviders(<PublicDashboard />, { route: '/analytics' });
    await waitFor(() => expect(screen.getByText(/Total Value Locked/i)).toBeInTheDocument());
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await userEvent.click(screen.getByRole('button', { name: /JSON/i }));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('CSV export triggers a download (anchor click)', async () => {
    loanStatsMock.stats = mkLoanStats();
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:mock'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    renderWithProviders(<PublicDashboard />, { route: '/analytics' });
    await waitFor(() => expect(screen.getByText(/Total Value Locked/i)).toBeInTheDocument());
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await userEvent.click(screen.getByRole('button', { name: /CSV/i }));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('renders the cross-chain combined section when the roll-up resolves', async () => {
    // #1076: replaces the removed "reload button calls reload hook" test — this
    // page has NO manual Refresh by design (public, wallet-less; it auto-
    // refreshes on the watermark bump). Instead assert the multi-chain roll-up
    // section (useCombinedChainsStats, now the top section) renders its cards.
    combinedMock.snapshot = mkCombined();
    renderWithProviders(<PublicDashboard />, { route: '/analytics' });
    await waitFor(() => expect(screen.getByText(/Lifetime Offers/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Refresh/i })).not.toBeInTheDocument();
  });
});
