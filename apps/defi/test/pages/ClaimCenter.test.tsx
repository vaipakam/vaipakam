import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../utils';

// #1076: ClaimCenter migrated off ethers → viem. `useClaimables` now walks
// the wallet's position-loan set via `publicClient.readContract(...)` (viem)
// and the shared `useLogIndex` cache — NOT ethers `getLoanDetails`/`ownerOf`
// on a diamond handle. We keep the REAL `useClaimables` under test (so its
// skip-active / not-holder / claimed=true filtering is still exercised) and
// stub the viem `PublicClient.readContract` dispatch, delegating each
// contract read to the same per-test vi.fns the assertions configure.

// The wallet's authoritative on-chain position-loan id set. `useClaimables`
// seeds its walk-set from `getUserPositionLoansPaginated`; these are the ids
// that get hydrated via `getLoanDetails` below (mirrors the old loan-log set).
const candidateIds = [1n, 2n, 3n];

const diamondMock: any = {
  getLoanDetails: vi.fn(),
  ownerOf: vi.fn(),
  getClaimable: vi.fn(),
  claimAsLender: vi.fn(),
  claimAsBorrower: vi.fn(),
};

// #1076: viem PublicClient stub — routes `readContract({ functionName })`
// to the per-test diamond vi.fns so the existing test bodies (which arm
// `getLoanDetails`/`ownerOf`/`getClaimable`) drive the real hook unchanged.
const publicClientStub: any = {
  readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
    switch (functionName) {
      case 'getUserPositionLoansPaginated':
        // [loanIds, statuses, total] — single page, total == count so the
        // hook's pagination loop terminates after one round-trip.
        return [candidateIds, candidateIds.map(() => 0n), BigInt(candidateIds.length)];
      case 'getUserPositionLoans':
        return [candidateIds, candidateIds.map(() => 0n)];
      case 'getLoanDetails':
        return diamondMock.getLoanDetails(args?.[0]);
      case 'ownerOf':
        return diamondMock.ownerOf(args?.[0]);
      case 'getClaimable':
        return diamondMock.getClaimable(args?.[0], args?.[1]);
      case 'getBorrowerLifRebate':
        return [0n, 0n];
      case 'isSanctionedAddress':
        return false;
      default:
        return null;
    }
  },
};

// #1076: return STABLE references from every mocked hook — a fresh object
// literal per render would change `useClaimables`' `load` useCallback deps
// every render → effect re-fires → setState → infinite re-render (hang).
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

// #1076: `useLogIndex` pulls in `useOfferStats` → `useLiveWatermark`, which
// needs WatermarkProvider (omitted from the harness for its WS/timer side
// effects). Stub it to a STABLE empty index so the walk-set comes purely
// from the authoritative on-chain paginated read above.
const logIndexStub = {
  loans: [] as Array<{ loanId: bigint; lender: string; borrower: string }>,
  getOwner: () => null,
  loading: false,
  reload: vi.fn(async () => {}),
};
vi.mock('../../src/hooks/useLogIndex', () => ({
  useLogIndex: () => logIndexStub,
}));

// #1076: the indexer HTTP holder-projection is a cache that can only ADD
// candidates; stub to null so the test drives the on-chain path only.
vi.mock('../../src/lib/indexerClient', async (orig) => {
  const actual = await orig<any>();
  return { ...actual, fetchLoansByCurrentHolder: async () => null };
});

// #1076: peripheral cards pull the watermark/freshness/reward hook chains
// (WatermarkProvider / DataFreshnessProvider omitted from the harness).
// They have their own tests; stub to null so ClaimCenter's claim-list
// logic is what's under test here.
vi.mock('../../src/components/app/DataSyncStatus', () => ({ DataSyncStatus: () => null }));
vi.mock('../../src/components/app/InteractionRewardsClaim', () => ({ InteractionRewardsClaim: () => null }));

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
    diamondMock.getLoanDetails.mockReset();
    diamondMock.ownerOf.mockReset();
    diamondMock.getClaimable.mockReset();
    diamondMock.claimAsLender.mockReset();
    diamondMock.claimAsBorrower.mockReset();
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
      assetType: 0n, tokenId: 0n, quantity: 0n, heldForLender: 0n, hasRentalNftReturn: false,
    });
    diamondMock.claimAsLender.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderWithProviders(<ClaimCenter />);
    // #1076: the loan id renders as a deep-link (`Loan` text + a separate
    // `<Link>#N</Link>`), so `/Loan #N/` can't match a single element.
    // Target the loan-id link — its presence proves the claim row rendered.
    await waitFor(() => expect(screen.getByRole('link', { name: '#1' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Claim$/i }));
    await waitFor(() => expect(screen.getByText(/Claim submitted/i)).toBeInTheDocument());
  });

  it('treats claimed=true as not claimable', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails
      .mockResolvedValueOnce(mkLoan({ id: 3n, status: 1 }))
      .mockRejectedValue(new Error('stop'));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 2n ? '0xME' : '0xX');
    diamondMock.getClaimable.mockResolvedValue({ asset: '0xC', amount: 1n, claimed: true, assetType: 0n, tokenId: 0n, quantity: 0n, heldForLender: 0n, hasRentalNftReturn: false });
    renderWithProviders(<ClaimCenter />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /No Claimable Funds/i })).toBeInTheDocument());
  });

  it('borrower claim path', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails
      .mockResolvedValueOnce(mkLoan({ id: 7n, status: 2 }))
      .mockRejectedValue(new Error('stop'));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 2n ? '0xME' : '0xOTHER');
    diamondMock.getClaimable.mockResolvedValue({ asset: '0xCOL', amount: 5n, claimed: false, assetType: 0n, tokenId: 0n, quantity: 0n, heldForLender: 0n, hasRentalNftReturn: false });
    diamondMock.claimAsBorrower.mockResolvedValue({ hash: '0xTX', wait: vi.fn().mockResolvedValue(undefined) });
    renderWithProviders(<ClaimCenter />);
    // #1076: loan-id-as-link — see the lender test above.
    await waitFor(() => expect(screen.getByRole('link', { name: '#1' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Claim$/i }));
    await waitFor(() => expect(diamondMock.claimAsBorrower).toHaveBeenCalled());
  });

  it('shows error on failed claim', async () => {
    walletMock.address = '0xME';
    diamondMock.getLoanDetails.mockResolvedValueOnce(mkLoan({ status: 1 })).mockRejectedValue(new Error('stop'));
    diamondMock.ownerOf.mockImplementation(async (t: bigint) => t === 1n ? '0xME' : '0xX');
    diamondMock.getClaimable.mockResolvedValue({ asset: '0xA', amount: 1n, claimed: false, assetType: 0n, tokenId: 0n, quantity: 0n, heldForLender: 0n, hasRentalNftReturn: false });
    diamondMock.claimAsLender.mockRejectedValue({ message: 'bad' });
    renderWithProviders(<ClaimCenter />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Claim$/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Claim$/i }));
    await waitFor(() => expect(screen.getByText(/bad/i)).toBeInTheDocument());
  });
});
