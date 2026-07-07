import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../utils';

// #1076: Dashboard migrated off ethers → viem AND off the legacy
// getUserVault + getLoanDetails + ownerOf walk. It now renders its loan
// table from a single bundled hook — `useDashboardLoansBothSides` (backed
// by MetricsDashboardFacet.getUserDashboardLoansBothSides) — mapped through
// `lib/dashboardAdapters`. So the test drives that hook directly (keeping
// the real adapter under test) and neutralises the peripheral summary cards
// (their own suites cover them; here they'd just drag in the watermark /
// freshness / reward provider chains omitted from the harness).

const loansMock: {
  rows: any[];
  loading: boolean;
  error: Error | null;
  reload: ReturnType<typeof vi.fn>;
} = { rows: [], loading: false, error: null, reload: vi.fn(async () => {}) };

vi.mock('../../src/hooks/useDashboardLoansBothSides', () => ({
  useDashboardLoansBothSides: () => loansMock,
  __clearDashboardLoansBothSidesCache: () => {},
}));

vi.mock('../../src/hooks/useClaimables', () => ({
  useClaimables: () => ({ claims: [], loading: false, reload: vi.fn(async () => {}) }),
}));

vi.mock('../../src/hooks/useMyOffers', () => ({
  useMyOffers: () => ({ rows: [], loading: false, refetch: vi.fn(async () => {}) }),
}));

vi.mock('../../src/hooks/useProtocolConfig', () => ({
  useProtocolConfig: () => ({ config: null, loading: false, error: null, reload: vi.fn() }),
}));

const diamondMock: any = { cancelOffer: vi.fn() };
const publicClientStub: any = { readContract: async () => null, multicall: async () => [] };
const readChainStub = {
  chainId: 11155111,
  diamondAddress: '0x00000000000000000000000000000000000000D1',
  deployBlock: 1,
  rpcUrl: 'http://localhost:8545',
  blockExplorer: 'https://sepolia.etherscan.io',
  name: 'Sepolia',
};
vi.mock('../../src/contracts/useDiamond', () => ({
  useReadChain: () => readChainStub,
  useDiamondPublicClient: () => publicClientStub,
  useReadyDiamond: () => diamondMock,
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
}));

// #1076: token-meta prewarm drives a viem multicall against the read chain;
// no-op it so the stubbed client isn't exercised.
vi.mock('../../src/lib/tokenMeta', async (orig) => {
  const actual = await orig<any>();
  return { ...actual, prewarmTokenMeta: () => {} };
});

// Peripheral cards + presentational cells that pull their own hook/provider
// chains (or the omitted watermark/freshness providers). Stubbed to null so
// the loan table itself is what's under test.
vi.mock('../../src/components/app/PrincipalCell', () => ({ PrincipalCell: () => null }));
vi.mock('../../src/components/app/MyOffersTable', () => ({ MyOffersTable: () => null }));
vi.mock('../../src/components/app/DataSyncStatus', () => ({ DataSyncStatus: () => null }));
vi.mock('../../src/components/app/SanctionsBanner', () => ({ SanctionsBanner: () => null }));
vi.mock('../../src/components/app/VPFIDiscountConsentCard', () => ({ default: () => null }));
vi.mock('../../src/components/app/AutoLifecycleSettingsCard', () => ({ default: () => null }));
vi.mock('../../src/components/app/AutoLendSummaryCard', () => ({ AutoLendSummaryCard: () => null }));
vi.mock('../../src/components/app/StakeVPFICTA', () => ({ StakeVPFICTA: () => null }));
vi.mock('../../src/components/app/RewardsSummaryCard', () => ({ RewardsSummaryCard: () => null }));

const walletMock = { address: null as string | null };
vi.mock('../../src/context/WalletContext', async (orig) => {
  const actual = await orig<any>();
  return {
    ...actual,
    useWallet: () => ({ address: walletMock.address, activeChain: readChainStub }),
  };
});

import Dashboard from '../../src/pages/Dashboard';

// One `LoanWithRiskAndSide` row (contract shape) → the real adapter shapes
// it into the `LoanSummary` the table renders.
function mkRow(over: any = {}) {
  const { borrowerSide = false, ltvBps = 0n, healthFactor = 0n, ...loanOver } = over;
  return {
    borrowerSide,
    ltvBps,
    healthFactor,
    loan: {
      id: 1n, offerId: 1n,
      principal: 1_000_000_000_000_000_000n, principalAsset: '0xPA', assetType: 0,
      tokenId: 0n,
      interestRateBps: 500n, durationDays: 30n, startTime: 1_700_000_000n, status: 0,
      collateralAsset: '0xCOL', collateralAmount: 2n * 10n ** 18n,
      collateralAssetType: 0, collateralTokenId: 0n,
      lenderTokenId: 1n, borrowerTokenId: 2n,
      allowsPartialRepay: false,
      liquidationLtvBpsAtInit: 0,
      minHealthFactorAtInit: 0n,
      ...loanOver,
    },
  };
}

describe('Dashboard', () => {
  beforeEach(() => {
    walletMock.address = null;
    loansMock.rows = [];
    loansMock.loading = false;
    loansMock.error = null;
  });

  it('shows connect-wallet empty state without address', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByRole('heading', { name: /Connect Your Wallet/i })).toBeInTheDocument();
  });

  it('renders loans for the connected wallet', async () => {
    walletMock.address = '0xHOLDER';
    loansMock.rows = [mkRow({ borrowerSide: false })];
    renderWithProviders(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/Your Loans/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText(/#1/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Lender/).length).toBeGreaterThan(0);
  });

  it('renders empty state when the wallet holds no loans', async () => {
    walletMock.address = '0xNOBODY';
    loansMock.rows = [];
    renderWithProviders(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/No Loans Yet/i)).toBeInTheDocument());
  });

  it('swallows loan-fetch errors and still renders', async () => {
    walletMock.address = '0xX';
    loansMock.rows = [];
    loansMock.error = new Error('nope');
    renderWithProviders(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/No Loans Yet/i)).toBeInTheDocument());
  });
});
