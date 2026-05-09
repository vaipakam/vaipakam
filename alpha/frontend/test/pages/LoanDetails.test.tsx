import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ModeProvider } from '../../src/context/ModeContext';

vi.mock('ethers', async () => {
  const { ethersMockModule } = await import('../ethersMock');
  return ethersMockModule();
});

const diamondMock: any = {
  getLoanDetails: vi.fn(),
  ownerOf: vi.fn(),
  repayLoan: vi.fn(),
  addCollateral: vi.fn(),
  triggerDefault: vi.fn(),
  // handleRepay reads total due up-front to decide whether ERC-20 allowance
  // needs topping up. Default 0n so the allowance path is a no-op in tests
  // that don't care about it.
  calculateRepaymentAmount: vi.fn().mockResolvedValue(0n),
};
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
}));

const walletMock = { address: null as string | null };
vi.mock('../../src/context/WalletContext', () => ({
  useWallet: () => ({ address: walletMock.address }),
}));

import LoanDetails from '../../src/pages/LoanDetails';

function mkLoan(over: any = {}) {
  return {
    id: 1n, principal: 1_000_000_000_000_000_000n, principalAsset: '0xPA',
    interestRateBps: 500n, durationDays: 30n,
    startTime: BigInt(Math.floor(Date.now() / 1000) - 86400), // 1 day ago
    status: 0,
    assetType: 0n,
    collateralAsset: '0xCOL', collateralAmount: 2n * 10n ** 18n,
    collateralAssetType: 0n,
    principalLiquidity: 0n, collateralLiquidity: 0n,
    lenderKeeperAccessEnabled: false,
    borrowerKeeperAccessEnabled: false,
    lender: '0xLENDER', borrower: '0xBORROWER',
    lenderTokenId: 10n, borrowerTokenId: 20n,
    offerId: 7n,
    ...over,
  };
}

function renderLoan(id = '1') {
  return render(
    <MemoryRouter initialEntries={[`/app/loans/${id}`]}>
      <ThemeProvider>
        <ModeProvider>
          <Routes>
            <Route path="/app/loans/:loanId" element={<LoanDetails />} />
          </Routes>
        </ModeProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('LoanDetails', () => {
  beforeEach(() => {
    walletMock.address = null;
    Object.values(diamondMock).forEach((m: any) => m.mockReset && m.mockReset());
    // mockReset wipes resolved values set at mock creation — restore the
    // default needed by every test.
    diamondMock.calculateRepaymentAmount.mockResolvedValue(0n);
    localStorage.removeItem('vaipakam.uiMode');
  });

  it('shows not-found on load error', async () => {
    diamondMock.getLoanDetails.mockRejectedValue(new Error('no'));
    renderLoan();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Loan Not Found/i })).toBeInTheDocument());
  });

  it('renders loan details (non-participant, connected)', async () => {
    walletMock.address = '0xSOMEONE';
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan());
    diamondMock.ownerOf.mockResolvedValue('0xNOBODY');
    renderLoan();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Loan #1/i })).toBeInTheDocument());
    expect(screen.getByText(/Loan Terms/i)).toBeInTheDocument();
    // Repay exposed to anyone on active loan
    expect(screen.getByRole('button', { name: /Repay in Full/i })).toBeInTheDocument();
  });

  it('non-borrower sees warning in confirm step', async () => {
    walletMock.address = '0xSOMEONE';
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan());
    diamondMock.ownerOf.mockResolvedValue('0xNOBODY');
    renderLoan();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Loan #1/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Repay in Full/i }));
    expect(screen.getByText(/Confirm Full Repayment/i)).toBeInTheDocument();
    expect(screen.getAllByText(/does not grant/i).length).toBeGreaterThan(0);
  });

  it('borrower confirm & repay success', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan({ borrower: '0xME' }));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 20n ? '0xME' : '0xOTHER');
    diamondMock.repayLoan.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderLoan();
    await waitFor(() => expect(screen.getByRole('button', { name: /Repay in Full/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Repay in Full/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Repay/i }));
    await waitFor(() => expect(diamondMock.repayLoan).toHaveBeenCalled());
  });

  it('repay failure shows error', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan({ borrower: '0xME' }));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 20n ? '0xME' : '0xX');
    diamondMock.repayLoan.mockRejectedValue({ message: 'revert' });
    renderLoan();
    await waitFor(() => expect(screen.getByRole('button', { name: /Repay in Full/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Repay in Full/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Repay/i }));
    await waitFor(() => expect(screen.getByText(/revert/)).toBeInTheDocument());
  });

  it('repay cancel restores initial view', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan({ borrower: '0xME' }));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 20n ? '0xME' : '0xX');
    renderLoan();
    await waitFor(() => expect(screen.getByRole('button', { name: /Repay in Full/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Repay in Full/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.getByRole('button', { name: /Repay in Full/i })).toBeInTheDocument();
  });

  it('borrower Add Collateral (advanced)', async () => {
    walletMock.address = '0xME';
    localStorage.setItem('vaipakam.uiMode', 'advanced');
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan({ borrower: '0xME' }));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 20n ? '0xME' : '0xX');
    diamondMock.addCollateral.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderLoan();
    await waitFor(() => expect(screen.getByRole('button', { name: /Repay in Full/i })).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText(/Amount to add/i), '5');
    await userEvent.click(screen.getByRole('button', { name: /^Add Collateral$/i }));
    await waitFor(() => expect(diamondMock.addCollateral).toHaveBeenCalled());
  });

  it('overdue shows Trigger Default', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails.mockResolvedValue(
      mkLoan({ startTime: BigInt(Math.floor(Date.now() / 1000) - 86400 * 100) }),
    );
    diamondMock.ownerOf.mockResolvedValue('0xX');
    diamondMock.triggerDefault.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderLoan();
    await waitFor(() => expect(screen.getByRole('button', { name: /Trigger Default/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Trigger Default/i }));
    await waitFor(() => expect(diamondMock.triggerDefault).toHaveBeenCalled());
  });

  it('lender early-withdrawal CTA shown when active and not overdue', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan({ lender: '0xME' }));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 10n ? '0xME' : '0xX');
    renderLoan();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Initiate Early Withdrawal/i })).toBeInTheDocument(),
    );
    expect(screen.getByText(/You are Lender/i)).toBeInTheDocument();
  });

  it('repaid loan hides actions card', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan({ status: 1, borrower: '0xME' }));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 20n ? '0xME' : '0xX');
    renderLoan();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Loan #1/i })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Repay in Full/i })).not.toBeInTheDocument();
  });
});
