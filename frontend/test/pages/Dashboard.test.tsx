import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { id as keccakId } from 'ethers';
import { renderWithProviders } from '../utils';

const LOAN_INITIATED_TOPIC0 = keccakId('LoanInitiated(uint256,uint256,address,address)');

const getUserEscrowFn: any = vi.fn();
// Dashboard now reads escrow via .staticCall to avoid a wallet-sign prompt.
getUserEscrowFn.staticCall = getUserEscrowFn;
const diamondMock: any = {
  getUserEscrow: getUserEscrowFn,
  getLoanDetails: vi.fn(),
  ownerOf: vi.fn(),
  // Event-indexed loan list consumed by `useLogIndex`. `logIndex` now filters
  // by topic hash, so we synthesize raw Log shapes (topics + data).
  runner: {
    provider: {
      getBlockNumber: async () => 10_630_900,
      // `logIndex` now uses `provider.getLogs` directly with topic-hash filters.
      getLogs: vi.fn().mockImplementation((filter: any) => {
        const t0: string | undefined = filter?.topics?.[0];
        if (t0 !== LOAN_INITIATED_TOPIC0) return Promise.resolve([]);
        const pad = (v: string) => '0x' + v.replace(/^0x/, '').padStart(64, '0').toLowerCase();
        const mk = (id: bigint) => ({
          topics: [LOAN_INITIATED_TOPIC0, pad('0x' + id.toString(16)), pad('0x0'), pad('0x0')],
          data: pad('0x0'),
        });
        return Promise.resolve([mk(1n), mk(2n), mk(3n)]);
      }),
    },
  },
};
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondContract: () => diamondMock,
  useDiamondRead: () => diamondMock,
  useReadChain: () => ({
    chainId: 11155111,
    chainIdHex: '0xaa36a7',
    name: 'Sepolia',
    shortName: 'sep',
    rpcUrl: 'https://rpc.sepolia.org',
    blockExplorer: 'https://sepolia.etherscan.io',
    diamondAddress: '0x77A16D1807F43A12C1DBde0b06064058cb6FC4BD',
    deployBlock: 10672636,
    isCanonicalVPFI: false,
    lzEid: 40161,
    testnet: true,
  }),
}));

const walletMock = { address: null as string | null };
vi.mock('../../src/context/WalletContext', async (orig) => {
  const actual = await orig<any>();
  return { ...actual, useWallet: () => ({ address: walletMock.address }) };
});

import Dashboard from '../../src/pages/Dashboard';

function mkLoan(over: any = {}) {
  return {
    id: 1n, principal: 1_000_000_000_000_000_000n, principalAsset: '0xPA',
    interestRateBps: 500n, durationDays: 30n, startTime: 1_700_000_000n,
    status: 0, lender: '0xLENDER', borrower: '0xBORROWER',
    collateralAsset: '0xCOL', collateralAmount: 2n * 10n ** 18n,
    lenderTokenId: 1n, borrowerTokenId: 2n,
    ...over,
  };
}

describe('Dashboard', () => {
  beforeEach(() => {
    walletMock.address = null;
    diamondMock.getUserEscrow.mockReset();
    diamondMock.getLoanDetails.mockReset();
    diamondMock.ownerOf.mockReset();
  });

  it('shows connect-wallet empty state without address', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByRole('heading', { name: /Connect Your Wallet/i })).toBeInTheDocument();
  });

  it('renders loans where user is the current NFT holder', async () => {
    walletMock.address = '0xHOLDER';
    diamondMock.getUserEscrow.mockResolvedValue('0xESCROW');
    diamondMock.getLoanDetails.mockImplementation(async (id: bigint) => {
      if (id === 1n) return mkLoan({ id: 1n });
      throw new Error('stop');
    });
    diamondMock.ownerOf.mockImplementation(async (tokenId: bigint) =>
      tokenId === 1n ? '0xHOLDER' : '0xOTHER',
    );
    renderWithProviders(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/Your Loans/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText(/#1/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Lender/).length).toBeGreaterThan(0);
    expect(screen.getByText(/0xESCROW/i)).toBeInTheDocument();
  });

  it('renders empty state when user holds no position NFTs', async () => {
    walletMock.address = '0xNOBODY';
    diamondMock.getUserEscrow.mockResolvedValue('0x0000000000000000000000000000000000000000');
    diamondMock.getLoanDetails.mockResolvedValueOnce(mkLoan()).mockRejectedValue(new Error('done'));
    diamondMock.ownerOf.mockResolvedValue('0xSOMEONE');
    renderWithProviders(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/No Loans Yet/i)).toBeInTheDocument());
  });

  it('swallows getUserEscrow errors and still renders', async () => {
    walletMock.address = '0xX';
    diamondMock.getUserEscrow.mockRejectedValue(new Error('nope'));
    diamondMock.getLoanDetails.mockRejectedValue(new Error('stop'));
    renderWithProviders(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/No Loans Yet/i)).toBeInTheDocument());
  });
});
