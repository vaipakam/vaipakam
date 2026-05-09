import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ModeProvider } from '../../src/context/ModeContext';

vi.mock('ethers', () => ({
  MaxUint256: 2n ** 256n - 1n,
  isAddress: (v: unknown) =>
    typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v),
  Contract: class {
    constructor(..._args: unknown[]) {}
  },
}));

const diamondMock: any = {
  refinanceLoan: vi.fn(),
};
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
}));

const erc20Mock: any = {
  allowance: vi.fn(),
  approve: vi.fn(),
};
vi.mock('../../src/contracts/useERC20', () => ({
  useERC20: (addr: string | null) => (addr ? erc20Mock : null),
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
  borrowerHolder: '',
  loading: false,
  error: null,
};
const reloadLoan = vi.fn();
vi.mock('../../src/hooks/useLoan', () => ({
  useLoan: () => ({ ...loanState, reload: reloadLoan }),
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

import Refinance from '../../src/pages/Refinance';

function renderPage(loanId = '11') {
  return render(
    <MemoryRouter initialEntries={[`/app/loans/${loanId}/refinance`]}>
      <ThemeProvider>
        <ModeProvider>
          <Routes>
            <Route
              path="/app/loans/:loanId/refinance"
              element={<Refinance />}
            />
            <Route path="/app/loans/:loanId" element={<div>loan-home</div>} />
            <Route path="/app" element={<div>app-home</div>} />
            <Route path="/app/create-offer" element={<div>create-offer</div>} />
          </Routes>
        </ModeProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function mkLoan(over: any = {}) {
  return {
    id: 11n,
    status: 0n,
    assetType: 0n,
    principal: 1_000_000_000_000_000_000n,
    principalAsset: '0xprincipal',
    interestRateBps: 500n,
    durationDays: 30n,
    borrowerTokenId: 2n,
    collateralAsset: '0xcol',
    collateralAssetType: 0n,
    prepayAsset: '0x0000000000000000000000000000000000000000',
    ...over,
  };
}

function mkTx(hash = '0xHASH') {
  return { hash, wait: vi.fn().mockResolvedValue({}) };
}

beforeEach(() => {
  loanState.loan = null;
  loanState.borrowerHolder = '';
  loanState.loading = false;
  loanState.error = null;
  walletMock.address = '0xME';
  Object.values(diamondMock).forEach((m: any) => m.mockReset && m.mockReset());
  erc20Mock.allowance.mockReset();
  erc20Mock.approve.mockReset();
  reloadLoan.mockReset();
});

describe('Refinance', () => {
  it('shows loading state', () => {
    loanState.loading = true;
    renderPage();
    expect(screen.getByText(/Loading loan #11/i)).toBeInTheDocument();
  });

  it('shows not-found on error', () => {
    loanState.error = 'boom';
    renderPage();
    expect(screen.getByRole('heading', { name: /Loan Not Found/i })).toBeInTheDocument();
  });

  it('rejects non-borrower caller', () => {
    loanState.loan = mkLoan();
    loanState.borrowerHolder = '0xOTHER';
    renderPage();
    expect(screen.getByRole('heading', { name: /Borrower only/i })).toBeInTheDocument();
  });

  it('warns when loan is not active', () => {
    loanState.loan = mkLoan({ status: 2n });
    loanState.borrowerHolder = '0xME';
    renderPage();
    expect(screen.getByText(/This loan is not active/i)).toBeInTheDocument();
  });

  it('warns when loan is not an ERC20 principal', () => {
    loanState.loan = mkLoan({ assetType: 1n });
    loanState.borrowerHolder = '0xME';
    renderPage();
    expect(
      screen.getByText(/Refinance is only supported for ERC-20 loans/i),
    ).toBeInTheDocument();
  });

  it('review disabled until offer ID entered', () => {
    loanState.loan = mkLoan();
    loanState.borrowerHolder = '0xME';
    renderPage();
    expect(
      screen.getByRole('button', { name: /Review Refinance/i }),
    ).toBeDisabled();
  });

  it('rejects invalid offer ID on Confirm', async () => {
    loanState.loan = mkLoan();
    loanState.borrowerHolder = '0xME';
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/i), 'abc');
    await userEvent.click(
      screen.getByRole('button', { name: /Review Refinance/i }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: /Confirm & Refinance/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/Enter a valid offer ID/i)).toBeInTheDocument(),
    );
  });

  it('rejects non-positive offer ID', async () => {
    loanState.loan = mkLoan();
    loanState.borrowerHolder = '0xME';
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/i), '0');
    await userEvent.click(
      screen.getByRole('button', { name: /Review Refinance/i }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: /Confirm & Refinance/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Offer ID must be a positive integer/i),
      ).toBeInTheDocument(),
    );
  });

  it('approves when allowance is below needed, then refinances', async () => {
    loanState.loan = mkLoan();
    loanState.borrowerHolder = '0xME';
    erc20Mock.allowance.mockResolvedValue(0n);
    erc20Mock.approve.mockResolvedValue(mkTx('0xAPPR'));
    diamondMock.refinanceLoan.mockResolvedValue(mkTx('0xREF'));
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/i), '42');
    await userEvent.click(
      screen.getByRole('button', { name: /Review Refinance/i }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: /Confirm & Refinance/i }),
    );
    await waitFor(() =>
      expect(diamondMock.refinanceLoan).toHaveBeenCalledWith(11n, 42n),
    );
    expect(erc20Mock.approve).toHaveBeenCalled();
  });

  it('skips approval when allowance >= MaxUint256', async () => {
    loanState.loan = mkLoan();
    loanState.borrowerHolder = '0xME';
    erc20Mock.allowance.mockResolvedValue(2n ** 256n - 1n);
    diamondMock.refinanceLoan.mockResolvedValue(mkTx());
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/i), '5');
    await userEvent.click(
      screen.getByRole('button', { name: /Review Refinance/i }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: /Confirm & Refinance/i }),
    );
    await waitFor(() =>
      expect(diamondMock.refinanceLoan).toHaveBeenCalledWith(11n, 5n),
    );
    expect(erc20Mock.approve).not.toHaveBeenCalled();
  });

  it('surfaces refinanceLoan failure', async () => {
    loanState.loan = mkLoan();
    loanState.borrowerHolder = '0xME';
    erc20Mock.allowance.mockResolvedValue(2n ** 256n - 1n);
    diamondMock.refinanceLoan.mockRejectedValue(new Error('revert!'));
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/i), '9');
    await userEvent.click(
      screen.getByRole('button', { name: /Review Refinance/i }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: /Confirm & Refinance/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/revert!/i)).toBeInTheDocument(),
    );
  });

  it('Back button returns to idle from review step', async () => {
    loanState.loan = mkLoan();
    loanState.borrowerHolder = '0xME';
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 42/i), '7');
    await userEvent.click(
      screen.getByRole('button', { name: /Review Refinance/i }),
    );
    await userEvent.click(screen.getByRole('button', { name: /^Back$/ }));
    expect(
      screen.getByRole('button', { name: /Review Refinance/i }),
    ).toBeInTheDocument();
  });

  it('Step 1 link carries expected query params', () => {
    loanState.loan = mkLoan();
    loanState.borrowerHolder = '0xME';
    renderPage();
    const link = screen.getByRole('link', {
      name: /Create Refinance Borrower Offer/i,
    }) as HTMLAnchorElement;
    expect(link.href).toContain('from=refinance');
    expect(link.href).toContain('loanId=11');
    expect(link.href).toContain('offerType=borrower');
    expect(link.href).toContain('collateralAssetType=erc20');
  });

  it('uses erc721 param when collateral is an ERC-721', () => {
    loanState.loan = mkLoan({ collateralAssetType: 1n });
    loanState.borrowerHolder = '0xME';
    renderPage();
    const link = screen.getByRole('link', {
      name: /Create Refinance Borrower Offer/i,
    }) as HTMLAnchorElement;
    expect(link.href).toContain('collateralAssetType=erc721');
  });

  it('uses erc1155 param when collateral is an ERC-1155', () => {
    loanState.loan = mkLoan({ collateralAssetType: 2n });
    loanState.borrowerHolder = '0xME';
    renderPage();
    const link = screen.getByRole('link', {
      name: /Create Refinance Borrower Offer/i,
    }) as HTMLAnchorElement;
    expect(link.href).toContain('collateralAssetType=erc1155');
  });
});
