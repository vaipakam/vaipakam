import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ModeProvider } from '../../src/context/ModeContext';

vi.mock('ethers', () => ({
  isAddress: (v: unknown) =>
    typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v),
  Contract: class {
    constructor(..._args: unknown[]) {}
  },
}));

const diamondMock: any = {
  createLoanSaleOffer: vi.fn(),
  completeLoanSale: vi.fn(),
};
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
}));

const walletMock: { address: string | null; chainId: number | null } = {
  address: '0xME',
  chainId: 11155111,
};
vi.mock('../../src/context/WalletContext', () => ({
  useWallet: () => walletMock,
}));

const loanState: any = {
  loan: null,
  lenderHolder: '',
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
vi.mock('../../src/lib/decodeContractError', () => ({
  decodeContractError: (err: unknown, fallback: string) =>
    (err as Error)?.message ?? fallback,
  extractRevertSelector: () => null,
  namedRevertSelector: () => null,
  extractRevertData: () => null,
}));

import LenderEarlyWithdrawal from '../../src/pages/LenderEarlyWithdrawal';

function renderPage(loanId = '7') {
  return render(
    <MemoryRouter initialEntries={[`/app/loans/${loanId}/withdraw`]}>
      <ThemeProvider>
        <ModeProvider>
          <Routes>
            <Route
              path="/app/loans/:loanId/withdraw"
              element={<LenderEarlyWithdrawal />}
            />
            <Route path="/app/loans/:loanId" element={<div>loan-home</div>} />
            <Route path="/app" element={<div>app-home</div>} />
            <Route path="/app/offers" element={<div>offer-book</div>} />
          </Routes>
        </ModeProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function mkLoan(over: any = {}) {
  return {
    id: 7n,
    status: 0n, // Active
    assetType: 0n, // ERC20
    principal: 1_000_000_000_000_000_000n,
    principalAsset: '0xprincipal',
    interestRateBps: 500n,
    durationDays: 30n,
    lenderTokenId: 3n,
    ...over,
  };
}

function mkTx(hash = '0xDEADBEEF') {
  return { hash, wait: vi.fn().mockResolvedValue({}) };
}

beforeEach(() => {
  loanState.loan = null;
  loanState.lenderHolder = '';
  loanState.loading = false;
  loanState.error = null;
  lockState.lock = 0;
  walletMock.address = '0xME';
  walletMock.chainId = 11155111;
  Object.values(diamondMock).forEach((m: any) => m.mockReset && m.mockReset());
  reloadLoan.mockReset();
  reloadLock.mockReset();
});

describe('LenderEarlyWithdrawal', () => {
  it('shows loading state', () => {
    loanState.loading = true;
    renderPage();
    expect(screen.getByText(/Loading loan #7/i)).toBeInTheDocument();
  });

  it('shows not-found when error set', () => {
    loanState.error = 'boom';
    renderPage();
    expect(screen.getByRole('heading', { name: /Loan Not Found/i })).toBeInTheDocument();
    expect(screen.getByText(/boom/i)).toBeInTheDocument();
  });

  it('shows not-found when loan missing (no error text)', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Loan Not Found/i })).toBeInTheDocument();
  });

  it('rejects non-lender callers', () => {
    loanState.loan = mkLoan();
    loanState.lenderHolder = '0xOTHER';
    renderPage();
    expect(screen.getByRole('heading', { name: /Lender only/i })).toBeInTheDocument();
  });

  it('warns when loan is not active', () => {
    loanState.loan = mkLoan({ status: 1n });
    loanState.lenderHolder = '0xME';
    renderPage();
    expect(
      screen.getByText(/This loan is not active/i),
    ).toBeInTheDocument();
  });

  it('warns when loan is not an ERC20 principal', () => {
    loanState.loan = mkLoan({ assetType: 1n }); // ERC721
    loanState.lenderHolder = '0xME';
    renderPage();
    expect(
      screen.getByText(/Lender-side sale is only supported for ERC-20/i),
    ).toBeInTheDocument();
  });

  it('review button is disabled until rate is entered', () => {
    loanState.loan = mkLoan();
    loanState.lenderHolder = '0xME';
    renderPage();
    expect(
      screen.getByRole('button', { name: /Review Sale Offer/i }),
    ).toBeDisabled();
  });

  it('rejects zero/invalid rate on Confirm', async () => {
    loanState.loan = mkLoan();
    loanState.lenderHolder = '0xME';
    renderPage();
    const input = screen.getByPlaceholderText(/e\.g\. 5/i) as HTMLInputElement;
    await userEvent.type(input, '0');
    await userEvent.click(screen.getByRole('button', { name: /Review Sale Offer/i }));
    await userEvent.click(
      screen.getByRole('button', { name: /Confirm & Create Sale Offer/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Enter a valid interest rate greater than 0%/i),
      ).toBeInTheDocument(),
    );
  });

  it('creates sale offer with bps conversion on Confirm', async () => {
    loanState.loan = mkLoan();
    loanState.lenderHolder = '0xME';
    diamondMock.createLoanSaleOffer.mockResolvedValue(mkTx('0xTXHASH'));
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 5/i), '5.5');
    await userEvent.click(screen.getByRole('button', { name: /Review Sale Offer/i }));
    await userEvent.click(
      screen.getByRole('button', { name: /Confirm & Create Sale Offer/i }),
    );
    await waitFor(() =>
      expect(diamondMock.createLoanSaleOffer).toHaveBeenCalledWith(
        7n,
        550n,
        false,
      ),
    );
  });

  it('passes illiquidConsent=true when checkbox ticked', async () => {
    loanState.loan = mkLoan();
    loanState.lenderHolder = '0xME';
    diamondMock.createLoanSaleOffer.mockResolvedValue(mkTx());
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 5/i), '10');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Review Sale Offer/i }));
    await userEvent.click(
      screen.getByRole('button', { name: /Confirm & Create Sale Offer/i }),
    );
    await waitFor(() =>
      expect(diamondMock.createLoanSaleOffer).toHaveBeenCalledWith(
        7n,
        1000n,
        true,
      ),
    );
  });

  it('surfaces createLoanSaleOffer failure', async () => {
    loanState.loan = mkLoan();
    loanState.lenderHolder = '0xME';
    diamondMock.createLoanSaleOffer.mockRejectedValue(new Error('rpc err'));
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 5/i), '3');
    await userEvent.click(screen.getByRole('button', { name: /Review Sale Offer/i }));
    await userEvent.click(
      screen.getByRole('button', { name: /Confirm & Create Sale Offer/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/rpc err/i)).toBeInTheDocument(),
    );
  });

  it('Back button returns to idle from review step', async () => {
    loanState.loan = mkLoan();
    loanState.lenderHolder = '0xME';
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 5/i), '4');
    await userEvent.click(screen.getByRole('button', { name: /Review Sale Offer/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Back$/ }));
    expect(
      screen.getByRole('button', { name: /Review Sale Offer/i }),
    ).toBeInTheDocument();
  });

  it('renders in-progress section when lock = EarlyWithdrawalSale', () => {
    loanState.loan = mkLoan();
    loanState.lenderHolder = '0xME';
    lockState.lock = 2;
    renderPage();
    expect(
      screen.getByText(/Sale In Progress/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Complete Sale/i }),
    ).toBeInTheDocument();
  });

  it('completes sale via recovery button', async () => {
    loanState.loan = mkLoan();
    loanState.lenderHolder = '0xME';
    lockState.lock = 2;
    diamondMock.completeLoanSale.mockResolvedValue(mkTx());
    renderPage();
    await userEvent.click(
      screen.getByRole('button', { name: /Complete Sale/i }),
    );
    await waitFor(() =>
      expect(diamondMock.completeLoanSale).toHaveBeenCalledWith(7n),
    );
  });

  it('surfaces completeLoanSale failure', async () => {
    loanState.loan = mkLoan();
    loanState.lenderHolder = '0xME';
    lockState.lock = 2;
    diamondMock.completeLoanSale.mockRejectedValue(new Error('boom'));
    renderPage();
    await userEvent.click(
      screen.getByRole('button', { name: /Complete Sale/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/boom/i)).toBeInTheDocument(),
    );
  });
});
