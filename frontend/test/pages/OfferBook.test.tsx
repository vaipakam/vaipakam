import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { id as keccakId } from 'ethers';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../utils';

const OFFER_CREATED_TOPIC0 = keccakId('OfferCreated(uint256,address,uint8)');

function offerLogs(ids: bigint[]) {
  const pad = (v: string) => '0x' + v.replace(/^0x/, '').padStart(64, '0').toLowerCase();
  return ids.map((id) => ({
    topics: [OFFER_CREATED_TOPIC0, pad('0x' + id.toString(16)), pad('0x0'), pad('0x0')],
    data: '0x',
  }));
}

const getLogsFn = vi.fn();
const diamondMock: any = {
  getOffer: vi.fn(),
  acceptOffer: vi.fn(),
  runner: { provider: { getBlockNumber: async () => 10_630_900, getLogs: getLogsFn } },
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

import OfferBook from '../../src/pages/OfferBook';

function mkOffer(over: any = {}) {
  return {
    id: 1n, creator: '0xCreator', offerType: 0n,
    lendingAsset: '0xLend', amount: 1_000_000_000_000_000_000n,
    interestRateBps: 500n,
    collateralAsset: '0xCol', collateralAmount: 2n * 10n ** 18n,
    durationDays: 30n, principalLiquidity: 0n, collateralLiquidity: 0n,
    accepted: false, assetType: 0n, tokenId: 0n,
    ...over,
  };
}

describe('OfferBook', () => {
  beforeEach(() => {
    walletMock.address = null;
    diamondMock.getOffer.mockReset();
    diamondMock.acceptOffer.mockReset();
    localStorage.clear();
    getLogsFn.mockReset();
    // Default: every test exposes offers #1 and #2 via the event index.
    getLogsFn.mockImplementation((filter: any) => {
      if (filter?.topics?.[0] === OFFER_CREATED_TOPIC0) return Promise.resolve(offerLogs([1n, 2n]));
      return Promise.resolve([]);
    });
  });

  it('shows empty state when no offers', async () => {
    diamondMock.getOffer.mockRejectedValue(new Error('done'));
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /No Open Offers/i })).toBeInTheDocument());
  });

  it('filters skipped: accepted or zero-creator', async () => {
    diamondMock.getOffer
      .mockResolvedValueOnce(mkOffer({ id: 1n, accepted: true }))
      .mockResolvedValueOnce(mkOffer({ id: 2n, creator: '0x0000000000000000000000000000000000000000' }))
      .mockRejectedValue(new Error('stop'));
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /No Open Offers/i })).toBeInTheDocument());
  });

  it('renders offers, filters by tab, and disables accept for own', async () => {
    walletMock.address = '0xCreator';
    diamondMock.getOffer
      .mockResolvedValueOnce(mkOffer({ id: 1n, offerType: 0n }))
      .mockResolvedValueOnce(mkOffer({ id: 2n, offerType: 1n, interestRateBps: 300n }))
      .mockRejectedValue(new Error('stop'));
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    expect(screen.getByText('#2')).toBeInTheDocument();

    // "Your Offer" badge shows since creator matches
    expect(screen.getAllByText(/Your Offer/i).length).toBeGreaterThan(0);

    // Filter to borrower-only tab — expect #2 in view, #1 hidden.
    await userEvent.click(screen.getByRole('button', { name: /Borrower Offers/i }));
    expect(screen.queryByText('#1')).not.toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();

    // Back to both-sides view — both ids visible again.
    await userEvent.click(screen.getByRole('button', { name: /Both Sides/i }));
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
  });

  it('shows Connect Wallet badge when no wallet', async () => {
    diamondMock.getOffer.mockResolvedValueOnce(mkOffer()).mockRejectedValue(new Error('stop'));
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    expect(screen.getAllByText(/Connect Wallet/i).length).toBeGreaterThan(0);
  });

  it('accepts an offer (success) — liquid offer needs only Confirm & Accept', async () => {
    walletMock.address = '0xOTHER';
    diamondMock.getOffer.mockResolvedValueOnce(mkOffer()).mockRejectedValue(new Error('stop'));
    diamondMock.acceptOffer.mockResolvedValue({ hash: '0xHASH', wait: vi.fn().mockResolvedValue(undefined) });
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    // Click the row-level Accept → opens the review modal.
    await userEvent.click(screen.getByRole('button', { name: /^Accept$/i }));
    // Review modal surfaces offer terms + black-swan warning for liquid offers;
    // no consent needed, Confirm & Accept is enabled immediately.
    expect(screen.getByText(/Review offer #1/i)).toBeInTheDocument();
    expect(screen.getByText(/Abnormal-market fallback/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Accept/i }));
    await waitFor(() => expect(screen.getByText(/Transaction submitted/i)).toBeInTheDocument());
    expect(diamondMock.acceptOffer).toHaveBeenCalledWith(1n, false);
  });

  it('shows error when accept fails', async () => {
    walletMock.address = '0xOTHER';
    diamondMock.getOffer.mockResolvedValueOnce(mkOffer()).mockRejectedValue(new Error('stop'));
    diamondMock.acceptOffer.mockRejectedValue({ reason: 'reverted' });
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Accept$/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Accept/i }));
    await waitFor(() => expect(screen.getByText(/reverted/i)).toBeInTheDocument());
  });

  it('illiquid offer requires explicit consent before Confirm & Accept', async () => {
    walletMock.address = '0xOTHER';
    diamondMock.getOffer
      .mockResolvedValueOnce(mkOffer({ principalLiquidity: 1n, collateralLiquidity: 1n }))
      .mockRejectedValue(new Error('stop'));
    diamondMock.acceptOffer.mockResolvedValue({ hash: '0xHASH', wait: vi.fn().mockResolvedValue(undefined) });
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Accept$/i }));
    // Illiquid offer: black-swan warning is replaced with the full-collateral
    // transfer warning, and Confirm & Accept is gated on the consent checkbox.
    expect(screen.getByText(/Illiquid leg — full collateral transfer/i)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: /Confirm & Accept/i });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/I consent to illiquid asset terms/i));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(diamondMock.acceptOffer).toHaveBeenCalledWith(1n, true));
  });
});
