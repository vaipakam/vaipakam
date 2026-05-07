import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { id as keccakId } from 'ethers';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../utils';

const LOAN_INITIATED_TOPIC0 = keccakId('LoanInitiated(uint256,uint256,address,address)');

function loanLogs() {
  const pad = (v: string) => '0x' + v.replace(/^0x/, '').padStart(64, '0').toLowerCase();
  const mk = (id: bigint) => ({
    topics: [LOAN_INITIATED_TOPIC0, pad('0x' + id.toString(16)), pad('0x0'), pad('0x0')],
    data: pad('0x0'),
  });
  return [mk(1n), mk(2n), mk(3n)];
}

const getLogsFn = vi.fn().mockImplementation((filter: any) => {
  const t0: string | undefined = filter?.topics?.[0];
  if (t0 !== LOAN_INITIATED_TOPIC0) return Promise.resolve([]);
  return Promise.resolve(loanLogs());
});

const diamondMock: any = {
  getLoanDetails: vi.fn(),
  ownerOf: vi.fn(),
  getClaimable: vi.fn(),
  claimAsLender: vi.fn(),
  claimAsBorrower: vi.fn(),
  runner: {
    provider: {
      getBlockNumber: async () => 10_630_900,
      getLogs: getLogsFn,
    },
  },
};
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
}));

const walletMock = { address: null as string | null };
vi.mock('../../src/context/WalletContext', async (orig) => {
  const actual = await orig<any>();
  return { ...actual, useWallet: () => ({ address: walletMock.address }) };
});

import ClaimCenter from '../../src/pages/ClaimCenter';

function mkLoan(over: any = {}) {
  return {
    id: 1n, status: 1, // Repaid
    lenderTokenId: 1n, borrowerTokenId: 2n,
    principalAsset: '0xPRIN', collateralAsset: '0xCOL',
    ...over,
  };
}

describe('ClaimCenter', () => {
  beforeEach(() => {
    walletMock.address = null;
    Object.values(diamondMock).forEach((m: any) => m.mockReset && m.mockReset());
    // Re-arm the default loan index for each test.
    getLogsFn.mockImplementation((filter: any) => {
      const t0: string | undefined = filter?.topics?.[0];
      if (t0 !== LOAN_INITIATED_TOPIC0) return Promise.resolve([]);
      return Promise.resolve(loanLogs());
    });
  });

  it('shows connect prompt when no wallet', () => {
    renderWithProviders(<ClaimCenter />);
    expect(screen.getByRole('heading', { name: /Connect Your Wallet/i })).toBeInTheDocument();
  });

  it('empty state when no claims', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails.mockRejectedValue(new Error('done'));
    renderWithProviders(<ClaimCenter />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /No Claimable Funds/i })).toBeInTheDocument());
  });

  it('skips active loans and not-holders', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails
      .mockResolvedValueOnce(mkLoan({ id: 1n, status: 0 })) // active → skip
      .mockResolvedValueOnce(mkLoan({ id: 2n, status: 1 }))
      .mockRejectedValue(new Error('stop'));
    diamondMock.ownerOf.mockResolvedValue('0xNOTME');
    renderWithProviders(<ClaimCenter />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /No Claimable Funds/i })).toBeInTheDocument());
  });

  it('shows claim row and completes claim (lender)', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails
      .mockResolvedValueOnce(mkLoan({ id: 5n, status: 1 }))
      .mockRejectedValue(new Error('stop'));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 1n ? '0xME' : '0xOTHER');
    diamondMock.getClaimable.mockResolvedValue({
      asset: '0xPRIN', amount: 1_000_000_000_000_000_000n, claimed: false,
      assetType: 0n, tokenId: 0n, quantity: 0n, heldForLender: 0n, hasRentalNFTReturn: false,
    });
    diamondMock.claimAsLender.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderWithProviders(<ClaimCenter />);
    await waitFor(() => expect(screen.getByText(/Loan #\d+/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Claim$/i }));
    await waitFor(() => expect(screen.getByText(/Claim submitted/i)).toBeInTheDocument());
  });

  it('treats claimed=true as not claimable', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails
      .mockResolvedValueOnce(mkLoan({ id: 3n, status: 1 }))
      .mockRejectedValue(new Error('stop'));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 2n ? '0xME' : '0xX');
    diamondMock.getClaimable.mockResolvedValue({ asset: '0xC', amount: 1n, claimed: true, assetType: 0n, tokenId: 0n, quantity: 0n, heldForLender: 0n, hasRentalNFTReturn: false });
    renderWithProviders(<ClaimCenter />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /No Claimable Funds/i })).toBeInTheDocument());
  });

  it('borrower claim path', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails
      .mockResolvedValueOnce(mkLoan({ id: 7n, status: 2 }))
      .mockRejectedValue(new Error('stop'));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 2n ? '0xME' : '0xOTHER');
    diamondMock.getClaimable.mockResolvedValue({ asset: '0xCOL', amount: 5n, claimed: false, assetType: 0n, tokenId: 0n, quantity: 0n, heldForLender: 0n, hasRentalNFTReturn: false });
    diamondMock.claimAsBorrower.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderWithProviders(<ClaimCenter />);
    await waitFor(() => expect(screen.getByText(/Loan #\d+/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Claim$/i }));
    await waitFor(() => expect(diamondMock.claimAsBorrower).toHaveBeenCalled());
  });

  it('shows error on failed claim', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails.mockResolvedValueOnce(mkLoan({ status: 1 })).mockRejectedValue(new Error('stop'));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 1n ? '0xME' : '0xX');
    diamondMock.getClaimable.mockResolvedValue({ asset: '0xA', amount: 1n, claimed: false, assetType: 0n, tokenId: 0n, quantity: 0n, heldForLender: 0n, hasRentalNFTReturn: false });
    diamondMock.claimAsLender.mockRejectedValue({ message: 'bad' });
    renderWithProviders(<ClaimCenter />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Claim$/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Claim$/i }));
    await waitFor(() => expect(screen.getByText(/bad/i)).toBeInTheDocument());
  });
});
