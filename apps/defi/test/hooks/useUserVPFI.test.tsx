import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/hooks/useLiveWatermark', () => ({
  // #1076: watermark needs WatermarkProvider (excluded from the test
  // harness for its WS/timer side-effects); stub it for hook tests.
  useLiveWatermark: () => ({ version: 0, snapshot: null, status: 'unreachable' }),
}));

import { renderHook, waitFor } from '@testing-library/react';

const ZERO = '0x0000000000000000000000000000000000000000';
const USER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const OTHER = '0xbbbbBbBbBbBbBbbBBbBbbbbBBBbbbbBbBBbBbBBB';
const TOKEN = '0xTokenTokenTokenTokenTokenTokenTokenToken';

// #1076: useUserVPFI migrated to viem. Module-scoped state the mocked
// publicClient reads from. Tests push outgoing/incoming Transfer logs
// here; the `getLogs` stub routes them by the indexed-arg filter
// (`args.from` → outgoing, `args.to` → incoming), mirroring the hook's
// two-sided `fetchTransferHistory` fan-out.
const tokenEvents = {
  outgoing: [] as any[],
  incoming: [] as any[],
  throwOnQuery: false as boolean | string,
};

// Diamond read stub — each test overrides what these methods return. The
// method names are unchanged from the ethers era on purpose: they're the
// vi.fns the assertions count calls on. The viem `publicClient.readContract`
// dispatch below simply routes each `functionName` to the matching fn, and
// `getContractEvents` (VPFIMinted mint history) routes to `queryFilter` — so
// every existing `diamondMock.*.mockResolvedValue(...)` / `.toHaveBeenCalled`
// assertion keeps working against the migrated read path.
const diamondMock: any = {
  getVPFIToken: vi.fn(),
  getVPFIBalanceOf: vi.fn(),
  getVPFITotalSupply: vi.fn(),
  getTreasury: vi.fn(),
  queryFilter: vi.fn(),
};

const publicClientStub = {
  readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
    switch (functionName) {
      case 'getVPFIToken':
        return diamondMock.getVPFIToken();
      case 'getVPFIBalanceOf':
        return diamondMock.getVPFIBalanceOf(...((args ?? []) as unknown[]));
      case 'getVPFITotalSupply':
        return diamondMock.getVPFITotalSupply();
      case 'getTreasury':
        return diamondMock.getTreasury();
      default:
        return null;
    }
  },
  // Protocol-level VPFIMinted history. Routed to `queryFilter` so tests keep
  // driving it via `diamondMock.queryFilter.mockResolvedValue/mockRejectedValue`.
  getContractEvents: async ({ eventName }: { eventName: string }) => {
    if (eventName === 'VPFIMinted') return diamondMock.queryFilter();
    return [];
  },
  // Token-level Transfer logs. Indexed-arg filter picks the list: `from=user`
  // → outgoing, `to=user` → incoming (matches the hook's two getLogs calls).
  getLogs: async ({ args }: { args?: { from?: string; to?: string } }) => {
    if (tokenEvents.throwOnQuery) {
      throw new Error(
        typeof tokenEvents.throwOnQuery === 'string' ? tokenEvents.throwOnQuery : 'rpc rate-limit',
      );
    }
    if (args?.from && !args?.to) return tokenEvents.outgoing;
    if (args?.to && !args?.from) return tokenEvents.incoming;
    return [];
  },
};

const chainMock = {
  chainId: 11155111,
  diamondAddress: '0xDiamondDiamondDiamondDiamondDiamondDia',
  deployBlock: 10_000_000,
};

vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondPublicClient: () => publicClientStub,
  useReadyDiamond: () => diamondMock,
  useDiamondRead: () => diamondMock,
  useReadChain: () => chainMock,
}));

// vpfiDecimals defaults to 18 when config hasn't loaded — the hook's own
// fallback — so a null config keeps the 1e18 scale the fixtures assume.
vi.mock('../../src/hooks/useProtocolConfig', () => ({
  useProtocolConfig: () => ({ config: null }),
}));

// `beginStep` logs the flow in production — the stub keeps the hook happy
// without needing real journey-log plumbing.
vi.mock('../../src/lib/journeyLog', () => ({
  beginStep: () => ({ success: () => {}, failure: () => {} }),
}));

import { useUserVPFI, __clearUserVPFICache } from '../../src/hooks/useUserVPFI';

function mkTransfer(over: any = {}) {
  return {
    args: {
      from: over.from ?? OTHER,
      to: over.to ?? USER,
      value: over.value ?? 10n ** 18n,
    },
    blockNumber: over.blockNumber ?? 1,
    transactionHash: over.txHash ?? '0xdead',
    // viem exposes the log's position as `logIndex` (ethers used `index`).
    logIndex: over.index ?? 0,
  };
}

function mkMint(over: any = {}) {
  return {
    args: {
      to: over.to ?? '0xTreasury',
      amount: over.amount ?? 5n * 10n ** 18n,
    },
    blockNumber: over.blockNumber ?? 2,
    transactionHash: over.txHash ?? '0xmint',
  };
}

beforeEach(() => {
  __clearUserVPFICache();
  tokenEvents.outgoing = [];
  tokenEvents.incoming = [];
  tokenEvents.throwOnQuery = false;
  diamondMock.getVPFIToken.mockReset();
  diamondMock.getVPFIBalanceOf.mockReset();
  diamondMock.getVPFITotalSupply.mockReset();
  diamondMock.getTreasury.mockReset();
  diamondMock.queryFilter.mockReset();
  chainMock.chainId = 11155111;
  chainMock.diamondAddress = '0xDiamondDiamondDiamondDiamondDiamondDia';
  chainMock.deployBlock = 10_000_000;
});

describe('useUserVPFI', () => {
  it('returns an unregistered snapshot when the Diamond has no VPFI token bound', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(ZERO);
    diamondMock.getVPFITotalSupply.mockResolvedValue(0n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue([]);
    const { result } = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot).not.toBeNull();
    expect(result.current.snapshot!.registered).toBe(false);
    expect(result.current.snapshot!.balance).toBe(0);
    expect(result.current.snapshot!.recentTransfers).toEqual([]);
    expect(result.current.snapshot!.recentMints).toEqual([]);
    // Unregistered short-circuits the token contract call entirely.
    expect(diamondMock.getVPFIBalanceOf).not.toHaveBeenCalled();
  });

  it('reads balance and share-of-supply on the happy path', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFIBalanceOf.mockResolvedValue(25n * 10n ** 18n);
    diamondMock.getVPFITotalSupply.mockResolvedValue(100n * 10n ** 18n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue([]);
    const { result } = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(result.current.snapshot?.registered).toBe(true));
    const snap = result.current.snapshot!;
    expect(snap.token).toBe(TOKEN);
    expect(snap.balance).toBe(25);
    expect(snap.shareOfCirculating).toBeCloseTo(0.25, 5);
    expect(snap.treasury).toBe('0xTreasury');
  });

  it('treats zero total supply as zero share (no divide-by-zero)', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFIBalanceOf.mockResolvedValue(0n);
    diamondMock.getVPFITotalSupply.mockResolvedValue(0n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue([]);
    const { result } = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot!.shareOfCirculating).toBe(0);
  });

  it('skips the diamond read entirely and returns a null snapshot when no wallet is connected', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFITotalSupply.mockResolvedValue(100n * 10n ** 18n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue([]);
    const { result } = renderHook(() => useUserVPFI(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Pre-connect the hook short-circuits to a NULL snapshot rather than a
    // balance-0 one — caching a phantom zero under the current cacheKey would
    // otherwise serve it for the whole STALE_MS window once the wallet lands.
    expect(result.current.snapshot).toBeNull();
    expect(diamondMock.getVPFIBalanceOf).not.toHaveBeenCalled();
    // The whole diamond read is skipped, not just the balance leg.
    expect(diamondMock.getVPFIToken).not.toHaveBeenCalled();
  });

  it('classifies Transfer directions (in/out/mint/burn/self) and sorts newest-first', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFIBalanceOf.mockResolvedValue(10n * 10n ** 18n);
    diamondMock.getVPFITotalSupply.mockResolvedValue(100n * 10n ** 18n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue([]);

    // `incoming` = logs where to=USER; `outgoing` = logs where from=USER.
    tokenEvents.incoming = [
      mkTransfer({ from: OTHER, to: USER, blockNumber: 10, txHash: '0xin', index: 0 }),
      mkTransfer({ from: ZERO, to: USER, blockNumber: 11, txHash: '0xmint', index: 1 }),
      // self-transfer: shows up in both lists — dedupe must collapse it.
      mkTransfer({ from: USER, to: USER, blockNumber: 12, txHash: '0xself', index: 2 }),
    ];
    tokenEvents.outgoing = [
      mkTransfer({ from: USER, to: OTHER, blockNumber: 9, txHash: '0xout', index: 3 }),
      mkTransfer({ from: USER, to: ZERO, blockNumber: 8, txHash: '0xburn', index: 4 }),
      mkTransfer({ from: USER, to: USER, blockNumber: 12, txHash: '0xself', index: 2 }),
    ];

    const { result } = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(result.current.snapshot?.recentTransfers.length).toBeGreaterThan(0));

    const transfers = result.current.snapshot!.recentTransfers;
    expect(transfers).toHaveLength(5);
    // Newest block first, ties broken by logIndex desc.
    expect(transfers[0]).toMatchObject({ direction: 'self', blockNumber: 12 });
    expect(transfers[1]).toMatchObject({ direction: 'mint', blockNumber: 11 });
    expect(transfers[2]).toMatchObject({ direction: 'in', blockNumber: 10 });
    expect(transfers[3]).toMatchObject({ direction: 'out', blockNumber: 9 });
    expect(transfers[4]).toMatchObject({ direction: 'burn', blockNumber: 8 });
    // self counted exactly once
    expect(transfers.filter((t) => t.direction === 'self')).toHaveLength(1);
  });

  it('caps Transfer history at 20 entries', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFIBalanceOf.mockResolvedValue(0n);
    diamondMock.getVPFITotalSupply.mockResolvedValue(1n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue([]);
    tokenEvents.incoming = Array.from({ length: 30 }, (_, i) =>
      mkTransfer({ from: OTHER, to: USER, blockNumber: i + 1, txHash: `0x${i}`, index: i }),
    );
    const { result } = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(result.current.snapshot?.recentTransfers.length).toBe(20));
    // Most-recent block at the top.
    expect(result.current.snapshot!.recentTransfers[0].blockNumber).toBe(30);
  });

  it('returns mints sorted newest-first and capped at 10', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFIBalanceOf.mockResolvedValue(0n);
    diamondMock.getVPFITotalSupply.mockResolvedValue(1n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) =>
        mkMint({ blockNumber: i + 1, txHash: `0xm${i}`, amount: BigInt(i + 1) * 10n ** 18n }),
      ),
    );
    const { result } = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(result.current.snapshot?.recentMints.length).toBe(10));
    expect(result.current.snapshot!.recentMints[0].blockNumber).toBe(15);
  });

  it('swallows mint-query RPC errors and returns empty mints (snapshot still succeeds)', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFIBalanceOf.mockResolvedValue(0n);
    diamondMock.getVPFITotalSupply.mockResolvedValue(1n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockRejectedValue(new Error('range too wide'));
    const { result } = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot!.recentMints).toEqual([]);
  });

  it('swallows token-transfer-query errors and returns empty transfers', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFIBalanceOf.mockResolvedValue(0n);
    diamondMock.getVPFITotalSupply.mockResolvedValue(1n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue([]);
    tokenEvents.throwOnQuery = 'rate-limited';
    const { result } = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot!.recentTransfers).toEqual([]);
  });

  it('surfaces an error when the primary Diamond read rejects', async () => {
    diamondMock.getVPFIToken.mockRejectedValue(new Error('diamond down'));
    diamondMock.getVPFITotalSupply.mockResolvedValue(0n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    const { result } = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error!.message).toMatch(/diamond down/);
  });

  it('caches across remounts for the same (chainId, diamond, user) key', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFIBalanceOf.mockResolvedValue(2n * 10n ** 18n);
    diamondMock.getVPFITotalSupply.mockResolvedValue(10n * 10n ** 18n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue([]);

    const first = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(first.result.current.snapshot?.balance).toBe(2));
    const callsAfterFirst = diamondMock.getVPFIToken.mock.calls.length;

    const second = renderHook(() => useUserVPFI(USER));
    // Cache hit — no extra Diamond reads, snapshot available synchronously.
    expect(second.result.current.snapshot?.balance).toBe(2);
    expect(diamondMock.getVPFIToken.mock.calls.length).toBe(callsAfterFirst);
  });

  it('invalidates the cache on chain switch (different chainId key)', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFIBalanceOf.mockResolvedValue(1n * 10n ** 18n);
    diamondMock.getVPFITotalSupply.mockResolvedValue(10n * 10n ** 18n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue([]);
    const first = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(first.result.current.snapshot?.balance).toBe(1));
    const callsBeforeSwitch = diamondMock.getVPFIToken.mock.calls.length;

    // Simulate chain switch
    chainMock.chainId = 8453;
    chainMock.diamondAddress = '0xBaseDiamondBaseDiamondBaseDiamondBase';
    diamondMock.getVPFIBalanceOf.mockResolvedValue(7n * 10n ** 18n);

    const second = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(second.result.current.snapshot?.balance).toBe(7));
    expect(diamondMock.getVPFIToken.mock.calls.length).toBeGreaterThan(callsBeforeSwitch);
  });

  it('reload() clears the cache and re-fetches fresh data', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFIBalanceOf.mockResolvedValue(1n * 10n ** 18n);
    diamondMock.getVPFITotalSupply.mockResolvedValue(10n * 10n ** 18n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue([]);
    const { result } = renderHook(() => useUserVPFI(USER));
    await waitFor(() => expect(result.current.snapshot?.balance).toBe(1));
    const callsBefore = diamondMock.getVPFIToken.mock.calls.length;

    diamondMock.getVPFIBalanceOf.mockResolvedValue(9n * 10n ** 18n);
    await result.current.reload();
    await waitFor(() => expect(result.current.snapshot?.balance).toBe(9));
    expect(diamondMock.getVPFIToken.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
