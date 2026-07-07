import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectKitProvider } from 'connectkit';
import { wagmiConfig } from '../../src/lib/wagmiConfig';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ChainProvider } from '../../src/context/ChainContext';
import { ModeProvider } from '../../src/context/ModeContext';

// #1076: defi migrated ethers → viem. The old `vi.mock('ethers')` is DEAD
// (src/ has zero ethers imports). CreateOffer drives the Diamond through
// the viem-backed `useDiamondContract` handle (`handle.fn(...args)`), so we
// mock that module instead.

// #1076: any read that soft-fails is fine — the config/gate hooks all
// catch. A Proxy client whose every method rejects makes them degrade to
// safe defaults without needing a live chain.
const stubClient: any = new Proxy(
  {},
  { get: () => async () => { throw new Error('function does not exist'); } },
);

// #1076: the Diamond write handle. `createOffer` / `createOfferWithPermit`
// are the controllable surfaces; every OTHER method (the config-bundle /
// risk-gate reads fired by useProtocolConfig / useMidTierAckGate) throws a
// "function does not exist" error so `useMidTierAckGate`'s missing-facet
// branch resolves *Known=true (gate not blocking) instead of hanging.
const diamondTarget: any = {
  createOffer: vi.fn(),
  createOfferWithPermit: vi.fn(),
};
const diamondMock: any = new Proxy(diamondTarget, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    return async () => { throw new Error('function does not exist'); };
  },
});

vi.mock('../../src/contracts/useDiamond', () => ({
  useReadChain: () => ({
    chainId: 11155111,
    diamondAddress: '0x00000000000000000000000000000000000000D1',
    deployBlock: 1,
    rpcUrl: 'http://localhost:8545',
    blockExplorer: 'https://sepolia.etherscan.io',
    name: 'Sepolia',
  }),
  useDiamondPublicClient: () => stubClient,
  useReadyDiamond: () => diamondMock,
  useReadyDiamondClient: () => null,
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
  useCanWrite: () => true,
}));

// #1076: viem-shaped ERC20 handle — reads resolve, writes resolve to
// `{ wait }` (mirrors the DiamondHandle write shape the page consumes).
const erc20Mock: any = {
  allowance: vi.fn(),
  approve: vi.fn(),
  decimals: vi.fn().mockResolvedValue(18),
  symbol: vi.fn().mockResolvedValue('MOCK'),
  balanceOf: vi.fn().mockResolvedValue(10n ** 30n),
};
vi.mock('../../src/contracts/useERC20', () => ({ useERC20: () => erc20Mock }));

const walletMock: any = { address: null as string | null, chainId: undefined, activeChain: null, isCorrectChain: true };
vi.mock('../../src/context/WalletContext', () => ({
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  useWallet: () => walletMock,
}));

// Drive the asset-type detection per address without a live provider.
const detectionMock: { byAddress: Record<string, 'erc20' | 'erc721' | 'erc1155' | 'unknown'> } = {
  byAddress: {},
};
vi.mock('../../src/hooks/useAssetType', () => ({
  useAssetType: (addr: string | null | undefined) => {
    if (!addr) return { type: null, loading: false };
    const t = detectionMock.byAddress[addr.toLowerCase()] ?? null;
    return { type: t, loading: false };
  },
}));

import CreateOffer from '../../src/pages/CreateOffer';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

// #1076: full provider tree (mirrors renderWithProviders) plus the two
// routes the Cancel/success flows navigate between — the single-route
// harness can't express the `/offers` target.
function renderCO() {
  const queryClient = makeQueryClient();
  return render(
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ConnectKitProvider mode="auto">
            <ChainProvider>
              <ModeProvider>
                <MemoryRouter initialEntries={['/create-offer']}>
                  <Routes>
                    <Route path="/create-offer" element={<CreateOffer />} />
                    <Route path="/offers" element={<div>offer-book</div>} />
                  </Routes>
                </MemoryRouter>
              </ModeProvider>
            </ChainProvider>
          </ConnectKitProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>,
  );
}

// #1076: the risk-and-terms consent checkbox (validateOfferForm requires
// it) is the only checkbox on the basic-mode form.
async function tickConsent() {
  const consent = screen.getByRole('checkbox');
  await userEvent.click(consent);
}

// #1076: a minimal VALID lender offer no longer needs collateral — leaving
// it empty keeps `createPair` null so the progressive-risk gate (which
// would otherwise disable submit while its read resolves) stays inert.
async function fillBasicForm() {
  const [lendingInput] = screen.getAllByPlaceholderText('0x...');
  await userEvent.type(lendingInput, '0x' + 'a'.repeat(40));
  await userEvent.type(screen.getByPlaceholderText('1000'), '100');
  await userEvent.type(screen.getByPlaceholderText('5.00'), '5');
  // duration defaults to 30 (a valid bucket); no need to touch the Picker.
  await tickConsent();
}

function setAdvancedMode() {
  localStorage.setItem('vaipakam.uiMode', 'advanced');
}

describe('CreateOffer', () => {
  beforeEach(() => {
    walletMock.address = null;
    walletMock.chainId = undefined;
    walletMock.activeChain = null;
    walletMock.isCorrectChain = true;
    diamondTarget.createOffer.mockReset();
    diamondTarget.createOfferWithPermit.mockReset();
    erc20Mock.allowance.mockReset();
    erc20Mock.approve.mockReset();
    erc20Mock.decimals.mockResolvedValue(18);
    erc20Mock.symbol.mockResolvedValue('MOCK');
    erc20Mock.balanceOf.mockResolvedValue(10n ** 30n);
    localStorage.removeItem('vaipakam.uiMode');
    detectionMock.byAddress = {};
  });

  it('shows connect prompt without wallet', () => {
    renderCO();
    expect(screen.getByRole('heading', { name: /Connect Your Wallet/i })).toBeInTheDocument();
  });

  it('basic mode hides advanced options card', () => {
    walletMock.address = '0xME';
    renderCO();
    // #1076: the "Asset Type" inline section was removed (detection is now
    // automatic). The canonical advanced-only surface is the "Advanced
    // Options" card, gated on global mode.
    expect(screen.queryByText(/Advanced Options/i)).not.toBeInTheDocument();
  });

  it('advanced mode surfaces Advanced Options card', () => {
    walletMock.address = '0xME';
    setAdvancedMode();
    renderCO();
    expect(screen.getByText(/Advanced Options/i)).toBeInTheDocument();
  });

  it('toggles lender/borrower offer type', async () => {
    walletMock.address = '0xME';
    renderCO();
    expect(screen.getByText(/specify what you want to lend/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /I want to Borrow/i }));
    expect(screen.getByText(/specify what you need/i)).toBeInTheDocument();
  });

  it('submits basic ERC-20 lender offer with approval', async () => {
    walletMock.address = '0xME';
    erc20Mock.allowance.mockResolvedValue(0n);
    erc20Mock.approve.mockResolvedValue({ wait: vi.fn().mockResolvedValue(undefined) });
    diamondTarget.createOffer.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderCO();
    await fillBasicForm();
    await userEvent.click(screen.getByRole('button', { name: /^Create Offer$/i }));
    await waitFor(() => expect(diamondTarget.createOffer).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Offer Created Successfully/i)).toBeInTheDocument());
    expect(erc20Mock.approve).toHaveBeenCalled();
  });

  it('skips approve if allowance sufficient', async () => {
    walletMock.address = '0xME';
    erc20Mock.allowance.mockResolvedValue(10n ** 30n);
    diamondTarget.createOffer.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderCO();
    await fillBasicForm();
    await userEvent.click(screen.getByRole('button', { name: /^Create Offer$/i }));
    await waitFor(() => expect(diamondTarget.createOffer).toHaveBeenCalled());
    expect(erc20Mock.approve).not.toHaveBeenCalled();
  });

  it('shows error when createOffer fails', async () => {
    walletMock.address = '0xME';
    erc20Mock.allowance.mockResolvedValue(10n ** 30n);
    diamondTarget.createOffer.mockRejectedValue({ reason: 'bad params', message: 'bad params' });
    renderCO();
    await fillBasicForm();
    await userEvent.click(screen.getByRole('button', { name: /^Create Offer$/i }));
    await waitFor(() => expect(screen.getByText(/bad params/i)).toBeInTheDocument());
  });

  it('basic mode surfaces the mandatory risk disclosures + consent', () => {
    walletMock.address = '0xME';
    renderCO();
    // Risk disclosures are mandatory and visible out-of-the-box (not gated
    // behind Advanced mode).
    expect(screen.getAllByText(/Risk Disclosures/i).length).toBeGreaterThan(0);
    // The single risk-and-terms consent checkbox is available without
    // advanced mode.
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    // #1076: the standalone "illiquid consent" checkbox was folded into the
    // one risk-and-terms consent; the in-kind disclosure line only shows for
    // an illiquid/NFT collateral leg — not the default ERC-20/ERC-20 form.
    expect(screen.queryByText(/In-kind settlement/i)).not.toBeInTheDocument();
  });

  it('ERC-721 lending address auto-switches UI to NFT rental copy', async () => {
    walletMock.address = '0xME';
    const nftAddr = '0x' + 'c'.repeat(40);
    detectionMock.byAddress[nftAddr.toLowerCase()] = 'erc721';
    renderCO();
    const [lendingInput] = screen.getAllByPlaceholderText('0x...');
    await userEvent.type(lendingInput, nftAddr);
    await waitFor(() =>
      expect(screen.getByText(/NFT Details/i)).toBeInTheDocument(),
    );
  });

  it('ERC-1155 lending address auto-exposes quantity input', async () => {
    walletMock.address = '0xME';
    const nftAddr = '0x' + 'd'.repeat(40);
    detectionMock.byAddress[nftAddr.toLowerCase()] = 'erc1155';
    renderCO();
    const [lendingInput] = screen.getAllByPlaceholderText('0x...');
    await userEvent.type(lendingInput, nftAddr);
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/^1$/)).toBeInTheDocument(),
    );
  });

  it('ERC-721 collateral address surfaces the in-kind settlement disclosure', async () => {
    walletMock.address = '0xME';
    const lendAddr = '0x' + 'a'.repeat(40);
    const nftCollat = '0x' + 'e'.repeat(40);
    detectionMock.byAddress[lendAddr.toLowerCase()] = 'erc20';
    detectionMock.byAddress[nftCollat.toLowerCase()] = 'erc721';
    renderCO();
    const addrs = screen.getAllByPlaceholderText('0x...');
    await userEvent.type(addrs[0], lendAddr);
    await userEvent.type(addrs[1], nftCollat);
    // #1076: the old "Illiquid leg — full collateral transfer" copy is now
    // the RiskDisclosures in-kind settlement line, auto-surfaced when the
    // ERC-20 offer's collateral is an NFT / illiquid leg.
    await waitFor(() =>
      expect(screen.getByText(/In-kind settlement/i)).toBeInTheDocument(),
    );
  });

  it('success screen "Create Another" resets form', async () => {
    walletMock.address = '0xME';
    erc20Mock.allowance.mockResolvedValue(10n ** 30n);
    diamondTarget.createOffer.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderCO();
    await fillBasicForm();
    await userEvent.click(screen.getByRole('button', { name: /^Create Offer$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Create Another/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Create Another/i }));
    expect(screen.getByRole('button', { name: /I want to Lend/i })).toBeInTheDocument();
  });

  it('keeperAccess checkbox toggles', async () => {
    walletMock.address = '0xME';
    setAdvancedMode();
    renderCO();
    const keeper = screen.getByLabelText(/authorized keeper/i);
    await userEvent.click(keeper);
    expect(keeper).toBeChecked();
  });

  it('gracePeriodLabel updates as duration buckets are picked', async () => {
    walletMock.address = '0xME';
    renderCO();
    // #1076: duration is now a bucketed <Picker> (7/14/30/60/90/180/365),
    // not a free-text field, so drive it by selecting buckets. Grace label
    // buckets: <30 → "1 day", <90 → "3 days", <180 → "1 week", else
    // "2 weeks".
    const openPicker = () =>
      userEvent.click(screen.getByRole('button', { name: /Loan duration/i }));
    // Default bucket is 30 → grace "3 days".
    expect(screen.getByText(/3 days/i)).toBeInTheDocument();
    await openPicker();
    await userEvent.click(screen.getByRole('option', { name: /^7 days$/i }));
    expect(screen.getByText(/1 day/i)).toBeInTheDocument();
    await openPicker();
    await userEvent.click(screen.getByRole('option', { name: /^90 days$/i }));
    expect(screen.getByText(/1 week/i)).toBeInTheDocument();
    await openPicker();
    await userEvent.click(screen.getByRole('option', { name: /^365 days$/i }));
    expect(screen.getByText(/2 weeks/i)).toBeInTheDocument();
  });

  it('cancel navigates away', async () => {
    walletMock.address = '0xME';
    renderCO();
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.getByText('offer-book')).toBeInTheDocument();
  });
});
