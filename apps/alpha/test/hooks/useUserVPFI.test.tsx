import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const ZERO = '0x0000000000000000000000000000000000000000';
const USER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const OTHER = '0xbbbbBbBbBbBbBbbBBbBbbbbBBBbbbbBbBBbBbBBB';
const TOKEN = '0xTokenTokenTokenTokenTokenTokenTokenToken';

// Module-scoped state the mocked ethers.Contract reads from. Tests push
// outgoing/incoming Transfer-event logs here; the Contract mock returns them
// via `queryFilter` keyed off its `filters.Transfer(from, to)` marker.
const tokenEvents = {
  outgoing: [] as any[],
  incoming: [] as any[],
  throwOnQuery: false as boolean | string,
};

vi.mock('ethers', () => {
  class Contract {
    target: string;
    runner: unknown;
    filters: Record<string, (...args: any[]) => unknown>;
    constructor(target: string, _abi: unknown, runner: unknown) {
      this.target = target;
      this.runner = runner;
      // Mark filters with (from, to) so queryFilter can route the right list.
      this.filters = {
        Transfer: (from: string | null, to: string | null) => ({ kind: 'Transfer', from, to }),
      };
    }
    async queryFilter(filter: any, _from?: unknown, _to?: unknown) {
      if (tokenEvents.throwOnQuery) {
        throw new Error(
          typeof tokenEvents.throwOnQuery === 'string' ? tokenEvents.throwOnQuery : 'rpc rate-limit',
        );
      }
      if (!filter || typeof filter !== 'object') return [];
      // `from=user` → outgoing; `to=user` → incoming
      if (filter.from && !filter.to) return tokenEvents.outgoing;
      if (filter.to && !filter.from) return tokenEvents.incoming;
      return [];
    }
  }
  return { Contract };
});

// Diamond read stub — each test overrides what these methods return.
const diamondMock: any = {
  getVPFIToken: vi.fn(),
  getVPFIBalanceOf: vi.fn(),
  getVPFITotalSupply: vi.fn(),
  getTreasury: vi.fn(),
  queryFilter: vi.fn(),
  runner: { isProvider: true },
};

const chainMock = {
  chainId: 11155111,
  diamondAddress: '0xDiamondDiamondDiamondDiamondDiamondDia',
  deployBlock: 10_000_000,
};

vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondRead: () => diamondMock,
  useReadChain: () => chainMock,
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
    index: over.index ?? 0,
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

  it('skips balance read and returns balance=0 when no wallet is connected', async () => {
    diamondMock.getVPFIToken.mockResolvedValue(TOKEN);
    diamondMock.getVPFITotalSupply.mockResolvedValue(100n * 10n ** 18n);
    diamondMock.getTreasury.mockResolvedValue('0xTreasury');
    diamondMock.queryFilter.mockResolvedValue([]);
    const { result } = renderHook(() => useUserVPFI(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot!.balance).toBe(0);
    expect(diamondMock.getVPFIBalanceOf).not.toHaveBeenCalled();
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
