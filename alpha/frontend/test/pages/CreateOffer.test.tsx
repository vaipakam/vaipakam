import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ModeProvider } from '../../src/context/ModeContext';

vi.mock('ethers', async () => ({
  parseUnits: (v: string) => BigInt(Math.floor(parseFloat(v) * 1e18)),
  isAddress: (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v),
  Contract: class {
    constructor(..._args: unknown[]) {}
  },
}));

const diamondMock: any = { createOffer: vi.fn() };
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
}));

const erc20Mock: any = { allowance: vi.fn(), approve: vi.fn() };
vi.mock('../../src/contracts/useERC20', () => ({ useERC20: () => erc20Mock }));

const walletMock = { address: null as string | null };
vi.mock('../../src/context/WalletContext', () => ({
  useWallet: () => ({ address: walletMock.address }),
}));

// Mock the asset-type detection hook so tests can drive the detected type
// without a live provider. The production hook probes ERC-165 on-chain; the
// mock returns a per-address value controlled by `detectionMock` below.
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

function renderCO() {
  return render(
    <MemoryRouter initialEntries={['/app/create-offer']}>
      <ThemeProvider>
        <ModeProvider>
          <Routes>
            <Route path="/app/create-offer" element={<CreateOffer />} />
            <Route path="/app/offers" element={<div>offer-book</div>} />
          </Routes>
        </ModeProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

async function fillBasicForm() {
  const addrs = screen.getAllByPlaceholderText('0x...');
  await userEvent.type(addrs[0], '0x' + 'a'.repeat(40));
  await userEvent.type(screen.getByPlaceholderText('1000'), '100');
  await userEvent.type(screen.getByPlaceholderText('5.00'), '5');
  await userEvent.type(screen.getByPlaceholderText('30'), '30');
  if (addrs.length > 1) await userEvent.type(addrs[1], '0x' + 'b'.repeat(40));
  await userEvent.type(screen.getByPlaceholderText('1500'), '150');
}

function setAdvancedMode() {
  localStorage.setItem('vaipakam.uiMode', 'advanced');
}

describe('CreateOffer', () => {
  beforeEach(() => {
    walletMock.address = null;
    diamondMock.createOffer.mockReset();
    erc20Mock.allowance.mockReset();
    erc20Mock.approve.mockReset();
    localStorage.removeItem('vaipakam.uiMode');
    detectionMock.byAddress = {};
  });

  it('shows connect prompt without wallet', () => {
    renderCO();
    expect(screen.getByRole('heading', { name: /Connect Your Wallet/i })).toBeInTheDocument();
  });

  it('basic mode hides advanced sections, advanced mode reveals them', () => {
    walletMock.address = '0xME';
    renderCO();
    // Basic: Asset Type section hidden (controlled by global mode, not inline toggle)
    expect(screen.queryByText(/^Asset Type$/i)).not.toBeInTheDocument();
  });

  it('advanced mode surfaces Asset Type section', () => {
    walletMock.address = '0xME';
    setAdvancedMode();
    renderCO();
    expect(screen.getByText(/^Asset Type$/i)).toBeInTheDocument();
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
    diamondMock.createOffer.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderCO();
    await fillBasicForm();
    await userEvent.click(screen.getByRole('button', { name: /^Create Offer$/i }));
    await waitFor(() => expect(diamondMock.createOffer).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Offer Created Successfully/i)).toBeInTheDocument());
  });

  it('skips approve if allowance sufficient', async () => {
    walletMock.address = '0xME';
    erc20Mock.allowance.mockResolvedValue(10n ** 30n);
    diamondMock.createOffer.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderCO();
    await fillBasicForm();
    await userEvent.click(screen.getByRole('button', { name: /^Create Offer$/i }));
    await waitFor(() => expect(diamondMock.createOffer).toHaveBeenCalled());
    expect(erc20Mock.approve).not.toHaveBeenCalled();
  });

  it('shows error when createOffer fails', async () => {
    walletMock.address = '0xME';
    erc20Mock.allowance.mockResolvedValue(10n ** 30n);
    diamondMock.createOffer.mockRejectedValue({ reason: 'bad params' });
    renderCO();
    await fillBasicForm();
    await userEvent.click(screen.getByRole('button', { name: /^Create Offer$/i }));
    await waitFor(() => expect(screen.getByText(/bad params/i)).toBeInTheDocument());
  });

  it('basic mode surfaces black-swan + illiquid-consent disclosures', () => {
    walletMock.address = '0xME';
    renderCO();
    // Black-swan / abnormal-market warning is mandatory disclosure per
    // README §Frontend Warnings — it must be visible out-of-the-box.
    expect(screen.getByText(/Abnormal-market fallback/i)).toBeInTheDocument();
    // Illiquid consent checkbox is also visible without advanced mode.
    const illiquidCheckbox = screen.getByLabelText(/I consent to illiquid asset terms/i);
    expect(illiquidCheckbox).toBeInTheDocument();
    // For the default ERC-20/ERC-20 form, the illiquid-specific warning is
    // not yet shown (liquidity depends on oracle presence); ERC-721 collateral
    // (advanced-only) auto-surfaces it — covered by the advanced-mode test below.
    expect(screen.queryByText(/Illiquid leg — full collateral transfer/i)).not.toBeInTheDocument();
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

  it('ERC-721 collateral address surfaces illiquid-leg warning', async () => {
    walletMock.address = '0xME';
    const lendAddr = '0x' + 'a'.repeat(40);
    const nftCollat = '0x' + 'e'.repeat(40);
    detectionMock.byAddress[lendAddr.toLowerCase()] = 'erc20';
    detectionMock.byAddress[nftCollat.toLowerCase()] = 'erc721';
    renderCO();
    const addrs = screen.getAllByPlaceholderText('0x...');
    await userEvent.type(addrs[0], lendAddr);
    await userEvent.type(addrs[1], nftCollat);
    await waitFor(() =>
      expect(
        screen.getByText(/Illiquid leg — full collateral transfer/i),
      ).toBeInTheDocument(),
    );
  });

  it('success screen "Create Another" resets form', async () => {
    walletMock.address = '0xME';
    erc20Mock.allowance.mockResolvedValue(10n ** 30n);
    diamondMock.createOffer.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
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

  it('gracePeriodLabel covers all duration buckets', async () => {
    walletMock.address = '0xME';
    renderCO();
    const duration = screen.getByPlaceholderText('30');
    for (const [val, expected] of [
      ['3', /1 hour/i],
      ['15', /1 day/i],
      ['60', /3 days/i],
      ['120', /1 week/i],
      ['200', /2 weeks/i],
    ] as const) {
      await userEvent.clear(duration);
      await userEvent.type(duration, val);
      expect(screen.getByText(expected)).toBeInTheDocument();
    }
  });

  it('cancel navigates away', async () => {
    walletMock.address = '0xME';
    renderCO();
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.getByText('offer-book')).toBeInTheDocument();
  });
});
