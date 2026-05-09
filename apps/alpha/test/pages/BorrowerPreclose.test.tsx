import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ModeProvider } from '../../src/context/ModeContext';

vi.mock('ethers', () => ({
  MaxUint256: 2n ** 256n - 1n,
  parseUnits: (v: string, decimals: number = 18) => {
    if (v === 'BAD') throw new Error('invalid number');
    const [whole, frac = ''] = v.split('.');
    const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  },
  isAddress: (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v),
  Contract: class {
    constructor(..._args: unknown[]) {}
  },
}));

const diamondMock: any = {
  precloseDirect: vi.fn(),
  transferObligationViaOffer: vi.fn(),
  offsetWithNewOffer: vi.fn(),
  completeOffset: vi.fn(),
};
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
}));

const erc20Mock: any = {
  allowance: vi.fn(),
  approve: vi.fn(),
};
const collateralErc20Mock: any = {
  decimals: vi.fn(),
};
vi.mock('../../src/contracts/useERC20', () => ({
  useERC20: (addr: string | null) => {
    if (!addr) return null;
    if (addr === '0xCOL') return collateralErc20Mock;
    return erc20Mock;
  },
}));

const walletMock: { address: string | null; chainId: number | null } = {
  address: null,
  chainId: 1,
};
vi.mock('../../src/context/WalletContext', () => ({
  useWallet: () => walletMock,
}));

const loanState: any = {
  loan: null,
  borrowerHolder: '',
  loading: false,
  error: null,
};
const reloadLoan = vi.fn();
vi.mock('../../src/hooks/useLoan', () => ({
  useLoan: () => ({ ...loanState, reload: reloadLoan }),
}));

const lockState: { lock: number } = { lock: 0 };
const reloadLock = vi.fn();
vi.mock('../../src/hooks/usePositionLock', () => ({
  LockReason: { None: 0, PrecloseOffset: 1, EarlyWithdrawalSale: 2 },
  usePositionLock: () => ({ lock: lockState.lock, reload: reloadLock, loading: false }),
}));

vi.mock('../../src/components/app/TransferLockWarning', () => ({
  TransferLockWarning: () => null,
}));
vi.mock('../../src/components/app/AssetSymbol', () => ({
  AssetSymbol: ({ address }: { address: string }) => <span>{address}</span>,
}));
vi.mock('../../src/components/app/TokenAmount', () => ({
  TokenAmount: ({ amount }: { amount: bigint }) => <span>{amount.toString()}</span>,
}));

import BorrowerPreclose from '../../src/pages/BorrowerPreclose';

function mkLoan(over: any = {}) {
  return {
    id: 7n,
    offerId: 1n,
    lender: '0xLENDER',
    borrower: '0xME',
    lenderTokenId: 10n,
    borrowerTokenId: 20n,
    principal: 1_000_000_000_000_000_000n,
    principalAsset: '0xPA',
    interestRateBps: 500n,
    durationDays: 30n,
    startTime: BigInt(Math.floor(Date.now() / 1000) - 86400),
    status: 0n,
    collateralAsset: '0xCOL',
    collateralAmount: 2n * 10n ** 18n,
    collateralAssetType: 0n,
    assetType: 0n,
    principalLiquidity: 0n,
    collateralLiquidity: 0n,
    lenderKeeperAccessEnabled: false,
    borrowerKeeperAccessEnabled: false,
    tokenId: 0n,
    quantity: 0n,
    prepayAsset: '0x0000000000000000000000000000000000000000',
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    ...over,
  };
}

function renderBP() {
  return render(
    <MemoryRouter initialEntries={['/app/loans/7/preclose']}>
      <ThemeProvider>
        <ModeProvider>
          <Routes>
            <Route path="/app/loans/:loanId/preclose" element={<BorrowerPreclose />} />
            <Route path="/app/loans/:loanId" element={<div>loan-view</div>} />
            <Route path="/app/offers" element={<div>offer-book</div>} />
            <Route path="/app" element={<div>dashboard</div>} />
          </Routes>
        </ModeProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  walletMock.address = '0xME';
  walletMock.chainId = 1;
  loanState.loan = mkLoan();
  loanState.borrowerHolder = '0xME';
  loanState.loading = false;
  loanState.error = null;
  lockState.lock = 0;
  diamondMock.precloseDirect.mockReset();
  diamondMock.transferObligationViaOffer.mockReset();
  diamondMock.offsetWithNewOffer.mockReset();
  diamondMock.completeOffset.mockReset();
  erc20Mock.allowance.mockReset();
  erc20Mock.approve.mockReset();
  collateralErc20Mock.decimals.mockReset();
  reloadLoan.mockReset();
  reloadLock.mockReset();
});

describe('BorrowerPreclose', () => {
  it('shows loading state', () => {
    loanState.loading = true;
    loanState.loan = null;
    renderBP();
    expect(screen.getByText(/Loading loan #7/i)).toBeInTheDocument();
  });

  it('shows not-found when error', () => {
    loanState.loan = null;
    loanState.error = 'bad';
    renderBP();
    expect(screen.getByRole('heading', { name: /Loan Not Found/i })).toBeInTheDocument();
  });

  it('shows borrower-only guard when not the borrower', () => {
    loanState.borrowerHolder = '0xOTHER';
    renderBP();
    expect(screen.getByRole('heading', { name: /Borrower only/i })).toBeInTheDocument();
  });

  it('shows inactive-loan alert when loan not active', () => {
    loanState.loan = mkLoan({ status: 1n });
    renderBP();
    expect(screen.getByText(/This loan is not active/i)).toBeInTheDocument();
  });

  it('direct preclose: happy path runs approval + tx', async () => {
    erc20Mock.allowance.mockResolvedValue(0n);
    erc20Mock.approve.mockResolvedValue({ wait: vi.fn().mockResolvedValue(undefined) });
    diamondMock.precloseDirect.mockResolvedValue({
      hash: '0xDEADBEEFDEADBEEFDEADBEEF',
      wait: vi.fn().mockResolvedValue(undefined),
    });
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Pay & Close Loan/i }));
    await waitFor(() => expect(diamondMock.precloseDirect).toHaveBeenCalledWith(7n));
    expect(erc20Mock.approve).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/Tx submitted/i)).toBeInTheDocument());
  });

  it('direct preclose: skips approve when allowance sufficient', async () => {
    erc20Mock.allowance.mockResolvedValue(2n ** 256n - 1n);
    diamondMock.precloseDirect.mockResolvedValue({
      hash: '0xTX',
      wait: vi.fn().mockResolvedValue(undefined),
    });
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Pay & Close Loan/i }));
    await waitFor(() => expect(diamondMock.precloseDirect).toHaveBeenCalled());
    expect(erc20Mock.approve).not.toHaveBeenCalled();
  });

  it('direct preclose: NFT loan skips ERC-20 allowance path', async () => {
    loanState.loan = mkLoan({ assetType: 1n });
    diamondMock.precloseDirect.mockResolvedValue({
      hash: '0xTX',
      wait: vi.fn().mockResolvedValue(undefined),
    });
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Pay & Close Loan/i }));
    await waitFor(() => expect(diamondMock.precloseDirect).toHaveBeenCalled());
    expect(erc20Mock.allowance).not.toHaveBeenCalled();
  });

  it('direct preclose: failure surfaces decoded error', async () => {
    erc20Mock.allowance.mockResolvedValue(2n ** 256n - 1n);
    diamondMock.precloseDirect.mockRejectedValue({ reason: 'nope' });
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Pay & Close Loan/i }));
    await waitFor(() => expect(screen.getByText(/nope/i)).toBeInTheDocument());
  });

  it('transfer path hidden (disabled) on non-ERC20 loans', () => {
    loanState.loan = mkLoan({ assetType: 1n });
    renderBP();
    const btn = screen.getByRole('button', { name: /Transfer to New Borrower/i });
    expect(btn).toBeDisabled();
  });

  it('transfer: rejects invalid offer id on confirm', async () => {
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Transfer to New Borrower/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/), 'abc');
    await userEvent.click(screen.getByRole('button', { name: /Review Transfer/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Transfer/i }));
    expect(diamondMock.transferObligationViaOffer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/valid Borrower Offer ID/i)).toBeInTheDocument());
  });

  it('transfer: rejects non-positive offer id on confirm', async () => {
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Transfer to New Borrower/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/), '0');
    await userEvent.click(screen.getByRole('button', { name: /Review Transfer/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Transfer/i }));
    await waitFor(() => expect(screen.getByText(/positive integer/i)).toBeInTheDocument());
  });

  it('transfer: review → confirm → success', async () => {
    erc20Mock.allowance.mockResolvedValue(0n);
    erc20Mock.approve.mockResolvedValue({ wait: vi.fn().mockResolvedValue(undefined) });
    diamondMock.transferObligationViaOffer.mockResolvedValue({
      hash: '0xTX',
      wait: vi.fn().mockResolvedValue(undefined),
    });
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Transfer to New Borrower/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/), '42');
    await userEvent.click(screen.getByRole('button', { name: /Review Transfer/i }));
    expect(screen.getByText(/#42/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Transfer/i }));
    await waitFor(() =>
      expect(diamondMock.transferObligationViaOffer).toHaveBeenCalledWith(7n, 42n),
    );
  });

  it('transfer: failure returns to review with error', async () => {
    erc20Mock.allowance.mockResolvedValue(2n ** 256n - 1n);
    diamondMock.transferObligationViaOffer.mockRejectedValue({ reason: 'xfer bad' });
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Transfer to New Borrower/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/), '5');
    await userEvent.click(screen.getByRole('button', { name: /Review Transfer/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Transfer/i }));
    await waitFor(() => expect(screen.getByText(/xfer bad/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Confirm & Transfer/i })).toBeInTheDocument();
  });

  it('transfer: back button returns to idle form', async () => {
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Transfer to New Borrower/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/), '3');
    await userEvent.click(screen.getByRole('button', { name: /Review Transfer/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Back$/i }));
    expect(screen.getByRole('button', { name: /Review Transfer/i })).toBeInTheDocument();
  });

  it('offset: rejects invalid rate', async () => {
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Offset with New Offer/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 4/), '0');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 30/), '30');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 1500/), '100');
    await userEvent.click(screen.getByRole('button', { name: /Review Offset Offer/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Create Offset Offer/i }));
    await waitFor(() => expect(screen.getByText(/valid interest rate/i)).toBeInTheDocument());
    expect(diamondMock.offsetWithNewOffer).not.toHaveBeenCalled();
  });

  it('offset: rejects invalid duration', async () => {
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Offset with New Offer/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 4/), '4');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 30/), '0');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 1500/), '100');
    await userEvent.click(screen.getByRole('button', { name: /Review Offset Offer/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Create Offset Offer/i }));
    await waitFor(() => expect(screen.getByText(/valid duration/i)).toBeInTheDocument());
  });

  it('offset: review → confirm → success (decimals resolved)', async () => {
    collateralErc20Mock.decimals.mockResolvedValue(6);
    erc20Mock.allowance.mockResolvedValue(0n);
    erc20Mock.approve.mockResolvedValue({ wait: vi.fn().mockResolvedValue(undefined) });
    diamondMock.offsetWithNewOffer.mockResolvedValue({
      hash: '0xTX',
      wait: vi.fn().mockResolvedValue(undefined),
    });
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Offset with New Offer/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 4/), '5');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 30/), '60');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 1500/), '1500');
    await userEvent.click(screen.getByLabelText(/illiquid-asset exposure/i));
    await userEvent.click(screen.getByRole('button', { name: /Review Offset Offer/i }));
    expect(screen.getByText(/5%/)).toBeInTheDocument();
    expect(screen.getByText(/60 days/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Create Offset Offer/i }));
    await waitFor(() => expect(diamondMock.offsetWithNewOffer).toHaveBeenCalled());
    const [loanId, rateBps, durationDays, collateralAsset, collateralAmount, illiquid, zero] =
      diamondMock.offsetWithNewOffer.mock.calls[0];
    expect(loanId).toBe(7n);
    expect(rateBps).toBe(500n);
    expect(durationDays).toBe(60n);
    expect(collateralAsset).toBe('0xCOL');
    expect(collateralAmount).toBe(1500n * 10n ** 6n);
    expect(illiquid).toBe(true);
    expect(zero).toBe('0x0000000000000000000000000000000000000000');
  });

  it('offset: falls back to 18 decimals when decimals() throws', async () => {
    collateralErc20Mock.decimals.mockRejectedValue(new Error('no'));
    erc20Mock.allowance.mockResolvedValue(2n ** 256n - 1n);
    diamondMock.offsetWithNewOffer.mockResolvedValue({
      hash: '0xTX',
      wait: vi.fn().mockResolvedValue(undefined),
    });
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Offset with New Offer/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 4/), '5');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 30/), '30');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 1500/), '2');
    await userEvent.click(screen.getByRole('button', { name: /Review Offset Offer/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Create Offset Offer/i }));
    await waitFor(() => expect(diamondMock.offsetWithNewOffer).toHaveBeenCalled());
    const collateralAmount = diamondMock.offsetWithNewOffer.mock.calls[0][4];
    expect(collateralAmount).toBe(2n * 10n ** 18n);
  });

  it('offset: failure returns to review', async () => {
    collateralErc20Mock.decimals.mockResolvedValue(18);
    erc20Mock.allowance.mockResolvedValue(2n ** 256n - 1n);
    diamondMock.offsetWithNewOffer.mockRejectedValue({ reason: 'offset fail' });
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Offset with New Offer/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 4/), '5');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 30/), '30');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 1500/), '10');
    await userEvent.click(screen.getByRole('button', { name: /Review Offset Offer/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Create Offset Offer/i }));
    await waitFor(() => expect(screen.getByText(/offset fail/i)).toBeInTheDocument());
  });

  it('offset: back button returns to idle form', async () => {
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Offset with New Offer/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 4/), '5');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 30/), '30');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 1500/), '5');
    await userEvent.click(screen.getByRole('button', { name: /Review Offset Offer/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Back$/i }));
    expect(screen.getByRole('button', { name: /Review Offset Offer/i })).toBeInTheDocument();
  });

  it('offset in-progress: complete-offset success', async () => {
    lockState.lock = 1;
    diamondMock.completeOffset.mockResolvedValue({
      hash: '0xTX',
      wait: vi.fn().mockResolvedValue(undefined),
    });
    renderBP();
    expect(screen.getByText(/Offset In Progress/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Complete Offset/i }));
    await waitFor(() => expect(diamondMock.completeOffset).toHaveBeenCalledWith(7n));
    await waitFor(() => expect(screen.getByText(/Tx submitted/i)).toBeInTheDocument());
  });

  it('offset in-progress: complete-offset failure', async () => {
    lockState.lock = 1;
    diamondMock.completeOffset.mockRejectedValue({ reason: 'still pending' });
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Complete Offset/i }));
    await waitFor(() => expect(screen.getByText(/still pending/i)).toBeInTheDocument());
  });

  it('switching paths resets step back to idle', async () => {
    renderBP();
    await userEvent.click(screen.getByRole('button', { name: /Transfer to New Borrower/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/), '3');
    await userEvent.click(screen.getByRole('button', { name: /Review Transfer/i }));
    expect(screen.getByRole('button', { name: /Confirm & Transfer/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Direct Preclose$/i }));
    expect(screen.getByRole('button', { name: /Pay & Close Loan/i })).toBeInTheDocument();
  });
});
