import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../utils';

// #1076: OfferBook migrated ethers → viem AND changed behaviour materially:
//  - the page is now WALLET-GATED (no wallet → a "Connect Your Wallet"
//    screen; the offer list only renders for a connected wallet);
//  - offer ids come from the shared `useLogIndex` cache (+ indexer / pair
//    hooks), hydrated via a viem multicall with a per-id `getOffer` fallback;
//  - every accept binds an EIP-712 `AcceptTerms` signature (#662) and calls
//    `acceptOffer(id, terms, sig)` — the old `acceptOffer(id, consent)` shape
//    is gone;
//  - the liquid/illiquid consent split was replaced by ONE mandatory risk
//    consent checkbox on every offer ("single mandatory risk consent" policy),
//    so Confirm & Accept is gated on that checkbox for liquid offers too.
// The test drives the real page against those current contracts: the multicall
// stub throws (empty client) so `fetchBatch` falls back to `diamondRead.getOffer`,
// which the existing per-test vi.fns configure.

const diamondMock: any = {
  getOffer: vi.fn(),
  acceptOffer: vi.fn(),
  acceptOfferWithPermit: vi.fn(),
};

// viem PublicClient stub. `batchCalls` needs a real multicall, so it throws
// on this empty client → `fetchBatch` takes the per-id `getOffer` fallback.
// `readContract('allowance', …)` returns a saturated allowance so the classic
// accept path skips the approve tx (no wallet client needed in tests).
const publicClientStub: any = {
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'allowance') return 2n ** 200n;
    return null;
  },
  call: async () => ({ data: '0x' }),
};

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

// #1076: stable references — a fresh object per render would re-fire the
// page's load effects endlessly. The offer-id source for the legacy path.
const logIndexStub = {
  openOfferIds: [1n, 2n] as bigint[],
  closedOfferIds: [] as bigint[],
  recentAcceptedOfferIds: [] as bigint[],
  lastAcceptedOfferId: null,
  offerIds: [1n, 2n] as bigint[],
  events: [] as any[],
  getOwner: () => null,
  getLastOwner: () => null,
  getLoanInitiatedForToken: () => null,
  loading: false,
  error: null,
  reload: vi.fn(async () => {}),
};
vi.mock('../../src/hooks/useLogIndex', () => ({ useLogIndex: () => logIndexStub }));

// #1076: every mocked hook returns a STABLE singleton. A fresh object/array
// per render would change memo/effect deps every render — e.g.
// `useActiveOffersByAssetPairRanked().rankings` feeds the `sortedIds` memo,
// whose reset/load effects would then re-fire endlessly (infinite re-render).
// Indexer disabled → legacy on-chain path drives the list.
const indexedActiveOffersStub = { offers: null, source: 'fallback' as const, refetch: vi.fn() };
vi.mock('../../src/hooks/useIndexedActiveOffers', () => ({
  useIndexedActiveOffers: () => indexedActiveOffersStub,
}));
const onchainActiveOfferIdsStub = { ids: null };
vi.mock('../../src/hooks/useOnchainActiveOfferIds', () => ({
  useOnchainActiveOfferIds: () => onchainActiveOfferIdsStub,
}));
const pairRankedStub = { rankings: [] as any[], refresh: vi.fn() };
vi.mock('../../src/hooks/useActiveOffersByAssetPairRanked', () => ({
  useActiveOffersByAssetPairRanked: () => pairRankedStub,
}));
const protocolConfigStub = { config: null, loading: false, error: null, reload: vi.fn() };
vi.mock('../../src/hooks/useProtocolConfig', () => ({
  useProtocolConfig: () => protocolConfigStub,
}));

// Modal-support hooks — benign, non-blocking states so the review modal
// renders and Confirm is gated only on the consent checkbox.
const riskPreflightStub = {
  status: 'ok', blocked: false, hardBlock: false, softWarn: false,
  pending: false, reason: '', refresh: vi.fn(),
};
vi.mock('../../src/hooks/useRiskAccessPreflight', () => ({
  useRiskAccessPreflight: () => riskPreflightStub,
}));
vi.mock('../../src/hooks/useAssetLiquidity', () => ({ useAssetLiquidity: () => 'liquid' }));
const liquidityPreflightStub = { status: 'idle' };
vi.mock('../../src/hooks/useLiquidityPreflight', () => ({
  useLiquidityPreflight: () => liquidityPreflightStub,
}));
const permit2Stub = { sign: vi.fn(), canSign: false };
vi.mock('../../src/hooks/usePermit2Signing', () => ({
  usePermit2Signing: () => permit2Stub,
}));
// EIP-712 AcceptTerms signer (#662) — returns a stub terms + signature.
const signAcceptTerms = vi.fn(async () => ({ terms: { offerId: 1n }, signature: '0xsig' }));
const acceptTermsStub = { sign: signAcceptTerms };
vi.mock('../../src/hooks/useAcceptTermsSigning', () => ({
  useAcceptTermsSigning: () => acceptTermsStub,
}));

// Peripheral components / cells that pull their own hook chains (or the
// omitted watermark/freshness providers). Their own suites cover them.
vi.mock('../../src/components/app/SanctionsBanner', () => ({ SanctionsBanner: () => null }));
vi.mock('../../src/components/app/DataSyncStatus', () => ({ DataSyncStatus: () => null }));
vi.mock('../../src/components/app/PrincipalCell', () => ({ PrincipalCell: () => null }));
vi.mock('../../src/components/app/AssetPicker', () => ({ AssetPicker: () => null }));
vi.mock('../../src/components/app/LiquidityPreflightBanner', () => ({ LiquidityPreflightBanner: () => null }));
vi.mock('../../src/components/app/OwnOfferMidTierAck', () => ({ OwnOfferMidTierAck: () => null }));

const walletMock = { address: null as string | null };
vi.mock('../../src/context/WalletContext', async (orig) => {
  const actual = await orig<any>();
  return { ...actual, useWallet: () => ({ address: walletMock.address, chainId: 11155111 }) };
});

import OfferBook from '../../src/pages/OfferBook';

function mkOffer(over: any = {}) {
  return {
    id: 1n, creator: '0xCreator', offerType: 0n,
    lendingAsset: '0xLend', amount: 1_000_000_000_000_000_000n,
    amountMax: 1_000_000_000_000_000_000n,
    interestRateBps: 500n, interestRateBpsMax: 500n,
    collateralAsset: '0xCol', collateralAmount: 2n * 10n ** 18n,
    collateralAmountMax: 2n * 10n ** 18n,
    durationDays: 30n, principalLiquidity: 0n, collateralLiquidity: 0n,
    accepted: false, assetType: 0n, tokenId: 0n,
    allowsPartialRepay: false, useFullTermInterest: true, periodicInterestCadence: 0n,
    ...over,
  };
}

describe('OfferBook', () => {
  beforeEach(() => {
    walletMock.address = null;
    diamondMock.getOffer.mockReset();
    diamondMock.acceptOffer.mockReset();
    diamondMock.acceptOfferWithPermit.mockReset();
    signAcceptTerms.mockClear();
  });

  it('shows connect screen when no wallet', () => {
    // #1076: OfferBook is now wallet-gated (Phase 4) — the pre-connect
    // read-only list + per-row "Connect Wallet" badge were removed. No
    // wallet → the shared connect empty state.
    renderWithProviders(<OfferBook />);
    expect(screen.getByRole('heading', { name: /Connect Your Wallet/i })).toBeInTheDocument();
  });

  it('shows empty state when no offers', async () => {
    walletMock.address = '0xME';
    diamondMock.getOffer.mockRejectedValue(new Error('done'));
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /No Open Offers/i })).toBeInTheDocument());
  });

  it('filters skipped: accepted or zero-creator', async () => {
    walletMock.address = '0xME';
    diamondMock.getOffer
      .mockResolvedValueOnce(mkOffer({ id: 1n, accepted: true }))
      .mockResolvedValueOnce(mkOffer({ id: 2n, creator: '0x0000000000000000000000000000000000000000' }))
      .mockRejectedValue(new Error('stop'));
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /No Open Offers/i })).toBeInTheDocument());
  });

  it('renders offers, filters by tab, and shows Your Offer for own', async () => {
    walletMock.address = '0xCreator';
    diamondMock.getOffer
      .mockResolvedValueOnce(mkOffer({ id: 1n, offerType: 0n }))
      .mockResolvedValueOnce(mkOffer({ id: 2n, offerType: 1n, interestRateBps: 300n, interestRateBpsMax: 300n }))
      .mockRejectedValue(new Error('stop'));
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    expect(screen.getByText('#2')).toBeInTheDocument();

    // "Your Offer" badge shows since creator matches the connected wallet.
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

  it('accepts a liquid offer — mandatory consent, then Confirm & Accept', async () => {
    walletMock.address = '0xOTHER';
    diamondMock.getOffer.mockResolvedValueOnce(mkOffer()).mockRejectedValue(new Error('stop'));
    diamondMock.acceptOffer.mockResolvedValue({ hash: '0xHASH', wait: vi.fn().mockResolvedValue(undefined) });
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    // Row-level Accept → opens the review modal.
    await userEvent.click(screen.getByRole('button', { name: /^Accept$/i }));
    expect(screen.getByText(/Review offer #1/i)).toBeInTheDocument();
    // #1076: consent is now mandatory on EVERY offer (single-consent policy),
    // so Confirm is disabled until the risk-consent checkbox is checked.
    const confirm = screen.getByRole('button', { name: /Confirm & Accept/i });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(screen.getByText(/Transaction submitted/i)).toBeInTheDocument());
    // #1076: accept now binds an EIP-712 AcceptTerms — `acceptOffer(id, terms, sig)`.
    expect(diamondMock.acceptOffer).toHaveBeenCalledWith(1n, expect.anything(), expect.anything());
  });

  it('shows error when accept fails', async () => {
    walletMock.address = '0xOTHER';
    diamondMock.getOffer.mockResolvedValueOnce(mkOffer()).mockRejectedValue(new Error('stop'));
    diamondMock.acceptOffer.mockRejectedValue({ reason: 'reverted' });
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Accept$/i }));
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Confirm & Accept/i }));
    await waitFor(() => expect(screen.getByText(/reverted/i)).toBeInTheDocument());
  });

  it('illiquid offer surfaces the illiquid warning and still gates on consent', async () => {
    walletMock.address = '0xOTHER';
    diamondMock.getOffer
      .mockResolvedValueOnce(mkOffer({ principalLiquidity: 1n, collateralLiquidity: 1n }))
      .mockRejectedValue(new Error('stop'));
    diamondMock.acceptOffer.mockResolvedValue({ hash: '0xHASH', wait: vi.fn().mockResolvedValue(undefined) });
    renderWithProviders(<OfferBook />);
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Accept$/i }));
    // #1076: the illiquid-specific consent checkbox is gone; illiquid offers
    // now surface an illiquid-leg warning and gate on the SAME single consent.
    expect(screen.getByText(/Illiquid leg on this offer/i)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: /Confirm & Accept/i });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(diamondMock.acceptOffer).toHaveBeenCalledWith(1n, expect.anything(), expect.anything()),
    );
  });
});
