import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ChainProvider } from '../../src/context/ChainContext';
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
  // #564 D.1 — collateral-lien read consumed by useLoanCollateralLien.
  // Default: no live lien (released, zero amount) so the card stays hidden
  // in tests that don't opt into it.
  getLoanCollateralLien: vi.fn().mockResolvedValue({
    user: '0xBORROWER',
    asset: '0xCOL',
    tokenId: 0n,
    amount: 0n,
    assetType: 0,
    released: true,
  }),
};
vi.mock('../../src/contracts/useDiamond', () => ({
  useReadChain: (() => { const c = { chainId: 11155111, diamondAddress: '0x00000000000000000000000000000000000000D1', deployBlock: 1, rpcUrl: 'http://localhost:8545', blockExplorer: 'https://sepolia.etherscan.io', name: 'Sepolia' }; return () => c; })(),
  useDiamondPublicClient: (() => { const pc = {}; return () => pc; })(),
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
  // useLoanCollateralLien reads through useReadyDiamond — return the same
  // mock so the hook resolves against `getLoanCollateralLien` above.
  useReadyDiamond: () => diamondMock,
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
    <MemoryRouter initialEntries={[`/loans/${id}`]}>
      <ThemeProvider>
        <ChainProvider>
        <ModeProvider>
          <Routes>
            <Route path="/loans/:loanId" element={<LoanDetails />} />
          </Routes>
        </ModeProvider>
      </ChainProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('LoanDetails', () => {
  beforeEach(() => {
    walletMock.address = null;
    Object.values(diamondMock).forEach((m: any) => m.mockReset && m.mockReset());
    // mockReset wipes resolved values set at mock creation — restore the
    // defaults needed by every test.
    diamondMock.calculateRepaymentAmount.mockResolvedValue(0n);
    // #564 D.1 — default to "no live lien" so the card is hidden unless a
    // test opts into an active lien explicitly.
    diamondMock.getLoanCollateralLien.mockResolvedValue({
      user: '0xBORROWER',
      asset: '0xCOL',
      tokenId: 0n,
      amount: 0n,
      assetType: 0,
      released: true,
    });
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

  // #564 D.1 — collateral-lien card.
  it('shows collateral-lien card with active lien for a party', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan({ borrower: '0xME' }));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => (t === 20n ? '0xME' : '0xX'));
    diamondMock.getLoanCollateralLien.mockResolvedValue({
      user: '0xBORROWER',
      asset: '0xCOL',
      tokenId: 0n,
      amount: 2n * 10n ** 18n,
      assetType: 0,
      released: false,
    });
    renderLoan();
    await waitFor(() =>
      expect(screen.getByText(/Collateral backing this loan/i)).toBeInTheDocument(),
    );
    // Active lien renders the "Active" status label.
    expect(screen.getByText(/^Active$/)).toBeInTheDocument();
  });

  it('hides collateral-lien card when there is no live lien', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan({ borrower: '0xME' }));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => (t === 20n ? '0xME' : '0xX'));
    // Default mock already resolves a released, zero-amount lien.
    renderLoan();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Loan #1/i })).toBeInTheDocument());
    expect(screen.queryByText(/Collateral backing this loan/i)).not.toBeInTheDocument();
  });

  // Finding 4 — the lien card must refresh after a mutation that changes
  // the on-chain lien. `addCollateral` increments the lien, so a successful
  // add must re-pull `getLoanCollateralLien` (via the hook's `reload`).
  it('refreshes the collateral lien after a successful add-collateral', async () => {
    walletMock.address = '0xME';
    localStorage.setItem('vaipakam.uiMode', 'advanced');
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan({ borrower: '0xME' }));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => (t === 20n ? '0xME' : '0xX'));
    diamondMock.addCollateral.mockResolvedValue({
      hash: '0xTX',
      wait: vi.fn().mockResolvedValue(undefined),
    });
    renderLoan();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Repay in Full/i })).toBeInTheDocument(),
    );
    // Initial mount read of the lien (the hook's first load).
    await waitFor(() => expect(diamondMock.getLoanCollateralLien).toHaveBeenCalled());
    const callsBefore = diamondMock.getLoanCollateralLien.mock.calls.length;
    await userEvent.type(screen.getByPlaceholderText(/Amount to add/i), '5');
    await userEvent.click(screen.getByRole('button', { name: /^Add Collateral$/i }));
    await waitFor(() => expect(diamondMock.addCollateral).toHaveBeenCalled());
    // The success path must re-read the lien (reloadLien) on top of the
    // mount read — the card can't go stale after the increment.
    await waitFor(() =>
      expect(diamondMock.getLoanCollateralLien.mock.calls.length).toBeGreaterThan(
        callsBefore,
      ),
    );
  });

  it('does not show collateral-lien card to a non-party even with an active lien', async () => {
    walletMock.address = '0xSOMEONE';
    diamondMock.getLoanDetails.mockResolvedValue(mkLoan());
    diamondMock.ownerOf.mockResolvedValue('0xNOBODY');
    diamondMock.getLoanCollateralLien.mockResolvedValue({
      user: '0xBORROWER',
      asset: '0xCOL',
      tokenId: 0n,
      amount: 2n * 10n ** 18n,
      assetType: 0,
      released: false,
    });
    renderLoan();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Loan #1/i })).toBeInTheDocument());
    expect(screen.queryByText(/Collateral backing this loan/i)).not.toBeInTheDocument();
  });
});
