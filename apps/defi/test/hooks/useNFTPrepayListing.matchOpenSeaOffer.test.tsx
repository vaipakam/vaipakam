/**
 * T-086 Block D follow-up (#348) integration test — verifies the
 * `matchOpenSeaOffer` callback's signed-offer-fetch URL is built
 * correctly with the new `?fulfiller=<vaultAddress>&quantity=<lot>`
 * query params (PR #349), and that the hook short-circuits cleanly
 * when the borrower's vault isn't resolved yet.
 *
 * Focus: URL construction + happy-path bundle threading to the
 * diamond.matchOpenSeaOffer call. We don't exercise the full tx
 * receipt / indexer-refresh pipeline — those have their own paths
 * tested through the live workflows.
 *
 * **SKIPPED pending Issue #85** — the shared `test/setup.ts`'s
 * `afterEach(() => { localStorage.clear(); ... })` throws
 * `TypeError: localStorage.clear is not a function` against the
 * vitest 4 + jsdom 29 environment in this monorepo. The same
 * failure blocks the PublicDashboard + LoanDetails + a handful of
 * other tests; the whole vitest suite is intentionally NOT wired
 * into CI for this reason (see `.github/workflows/ci.yml` comment).
 * Once #85 lands, switch `describe.skip` → `describe` here so this
 * test runs alongside the rest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const DIAMOND_ADDR = '0x77A16D1807F43A12C1DBde0b06064058cb6FC4BD';
const VAULT_ADDR = '0xABCDABCDABCDABCDABCDABCDABCDABCDABCDABCD';
const BORROWER = '0x1111111111111111111111111111111111111111';
const COLLATERAL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BIDDER = '0x2222222222222222222222222222222222222222';
const ORDER_HASH =
  '0x' + 'cd'.repeat(32);

// vi.hoisted so the mock factories below — which run BEFORE the
// top-level `const` initializers — can reference the same state.
const hoisted = vi.hoisted(() => ({
  wallet: { address: '0x1111111111111111111111111111111111111111' as
    string | null },
  vault: { vault: '0xABCDABCDABCDABCDABCDABCDABCDABCDABCDABCD' as
    string | null },
  diamond: {
    matchOpenSeaOffer: vi.fn(),
    target: '0x77A16D1807F43A12C1DBde0b06064058cb6FC4BD',
  },
}));

vi.mock('../../src/context/WalletContext', () => ({
  useWallet: () => hoisted.wallet,
}));

vi.mock('../../src/hooks/useUserVaultAddress', () => ({
  useUserVaultAddress: () => hoisted.vault.vault,
}));

vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondContract: () => hoisted.diamond,
  useDiamondPublicClient: () => ({}),
  useReadChain: () => ({ chainId: 8453 }),
}));

vi.mock('../../src/contracts/config', () => ({
  DEFAULT_CHAIN: {
    chainId: 8453,
    diamondAddress: '0x77A16D1807F43A12C1DBde0b06064058cb6FC4BD',
    deployBlock: 1,
  },
}));

vi.mock('../../src/lib/journeyLog', () => ({
  beginStep: () => ({ success: vi.fn(), failure: vi.fn() }),
}));

vi.mock('../../src/lib/indexerClient', () => ({
  fetchLoanById: vi.fn().mockResolvedValue(null),
  postPrepayMatchSource: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/openseaPublish', () => ({
  publishPrepayListingToOpenSea: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@vaipakam/lib/decodeContractError', () => ({
  decodeContractError: () => null,
}));

// T-086 Block D #348 + Codex PR #352 round-1 P2 — the hook reads
// `import.meta.env.VITE_AGENT_ORIGIN` synchronously and short-
// circuits when it's empty. The repo doesn't ship a `.env.test`, so
// without an explicit stub Vitest sees `undefined` and the URL /
// fetch-failure tests never exercise the fetch path. Pin a known
// value via `vi.stubEnv` in `beforeEach` so the assertions match.
const AGENT_ORIGIN = 'https://agent.example.test';

const fetchMock = vi.fn();
beforeEach(() => {
  // Pin VITE_AGENT_ORIGIN so the hook's `import.meta.env`
  // short-circuit doesn't fire on a missing test env value. The
  // global `afterEach` in test/setup.ts already clears stubs via
  // `vi.unstubAllEnvs()` indirectly through `vi.clearAllMocks()`'s
  // reset; explicit `vi.unstubAllEnvs()` here would be redundant.
  vi.stubEnv('VITE_AGENT_ORIGIN', AGENT_ORIGIN);
  hoisted.wallet.address = BORROWER;
  hoisted.vault.vault = VAULT_ADDR;
  // Reset the matchOpenSeaOffer mock state + restore happy-path resolved
  // value (each test that wants a custom shape overrides locally).
  hoisted.diamond.matchOpenSeaOffer.mockReset();
  hoisted.diamond.matchOpenSeaOffer.mockResolvedValue({
    hash: '0xdeadbeef',
    wait: vi.fn().mockResolvedValue({
      transactionHash: '0xdeadbeef',
      blockNumber: 1n,
      logs: [],
    }),
  });
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

// Import AFTER mocks so the hook resolves them.
import { useNFTPrepayListing } from '../../src/hooks/useNFTPrepayListing';

// Blocked on Issue #85 — flip back to plain `describe(...)` once the
// shared test/setup.ts localStorage bug is fixed and the vitest suite
// re-joins CI.
describe.skip('useNFTPrepayListing.matchOpenSeaOffer (Block D #348)', () => {
  it('appends ?fulfiller=<vault>&quantity=<lot> to the signed-offer URL', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          orderHash: ORDER_HASH,
          parameters: { offerer: BIDDER },
          signature: '0xsig',
          extraData: '0xed',
          criteriaResolvers: [],
        }),
    });

    const { result } = renderHook(() => useNFTPrepayListing('42'));

    await act(async () => {
      const ok = await result.current.matchOpenSeaOffer(42n, {
        orderHash: ORDER_HASH as `0x${string}`,
        bidder: BIDDER as `0x${string}`,
        collateralContract: COLLATERAL as `0x${string}`,
        collateralTokenId: 7n,
        collateralQuantity: 3n,
      });
      // The diamond.matchOpenSeaOffer call resolves successfully via
      // mocked tx + receipt, so the success path returns true.
      expect(ok).toBe(true);
    });

    // Verify the URL passed to fetch carries the new query params.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe(
      `${AGENT_ORIGIN}/opensea/signed-offer/8453/` +
        COLLATERAL.toLowerCase() +
        '/7/' +
        ORDER_HASH +
        '?fulfiller=' +
        VAULT_ADDR.toLowerCase() +
        '&quantity=3',
    );

    // Verify the bundle is threaded to the diamond call.
    expect(hoisted.diamond.matchOpenSeaOffer).toHaveBeenCalledTimes(1);
    const callArgs = hoisted.diamond.matchOpenSeaOffer.mock.calls[0];
    expect(callArgs[0]).toBe(42n); // loanId
    expect(callArgs[1].signature).toBe('0xsig');
    expect(callArgs[1].extraData).toBe('0xed');
    expect(callArgs[2]).toBe(ORDER_HASH); // expectedBidderOrderHash
    expect(callArgs[3]).toEqual([]); // resolvers
  });

  it('short-circuits when the borrower vault is not yet resolved', async () => {
    hoisted.vault.vault = null;

    const { result } = renderHook(() => useNFTPrepayListing('42'));
    const ok = await result.current.matchOpenSeaOffer(42n, {
      orderHash: ORDER_HASH as `0x${string}`,
      bidder: BIDDER as `0x${string}`,
      collateralContract: COLLATERAL as `0x${string}`,
      collateralTokenId: 7n,
      collateralQuantity: 1n,
    });

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hoisted.diamond.matchOpenSeaOffer).not.toHaveBeenCalled();
  });

  it('returns false when the agent fetch is non-2xx', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: 'opensea-upstream' }),
    });

    const { result } = renderHook(() => useNFTPrepayListing('42'));
    const ok = await result.current.matchOpenSeaOffer(42n, {
      orderHash: ORDER_HASH as `0x${string}`,
      bidder: BIDDER as `0x${string}`,
      collateralContract: COLLATERAL as `0x${string}`,
      collateralTokenId: 7n,
      collateralQuantity: 1n,
    });

    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.diamond.matchOpenSeaOffer).not.toHaveBeenCalled();
  });

  it('returns false when the agent fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('DNS down'));

    const { result } = renderHook(() => useNFTPrepayListing('42'));
    const ok = await result.current.matchOpenSeaOffer(42n, {
      orderHash: ORDER_HASH as `0x${string}`,
      bidder: BIDDER as `0x${string}`,
      collateralContract: COLLATERAL as `0x${string}`,
      collateralTokenId: 7n,
      collateralQuantity: 1n,
    });

    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.diamond.matchOpenSeaOffer).not.toHaveBeenCalled();
  });
});
