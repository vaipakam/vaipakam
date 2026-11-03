/**
 * #2814 — automatic extension as the loan page and Claims read it: the
 * executor's intersection of both sides' limits, the setter arguments per
 * side, the funding cover, and the reserve discovery and reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseError, ContractFunctionRevertedError, type Address, type PublicClient } from 'viem';

const pages = vi.hoisted(() => ({
  calls: [] as { actor?: string; kinds?: readonly string[]; limit?: number; before?: string }[],
  responses: [] as ({ events: { loanId: number | null }[]; nextBefore: string | null } | null)[],
}));

vi.mock('./indexer', () => ({
  fetchActivity: vi.fn(
    async (_chainId: number, opts: { actor?: string; kinds?: readonly string[]; limit?: number; before?: string }) => {
      pages.calls.push(opts);
      return pages.responses.shift() ?? null;
    },
  ),
}));

import {
  capsArgs,
  consentBand,
  fundingCover,
  keeperVerdict,
  readAutoExtendState,
  readReserveRow,
  reserveLoanIds,
  setByEarlierHolder,
  windowPhase,
  withdrawWholeReserve,
  type ExtendCaps,
} from './autoExtend';

const DIAMOND = '0x000000000000000000000000000000000000d1a0' as Address;
const ME = '0x00000000000000000000000000000000000000aA' as Address;
const OTHER = '0x00000000000000000000000000000000000000bb' as Address;
const USDC = '0x0000000000000000000000000000000000000001' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

const on = (over: Partial<ExtendCaps> = {}): ExtendCaps => ({
  enabled: true,
  minRateBps: 0,
  maxRateBps: 10_000,
  maxNewExpiry: 2_000_000_000,
  setter: ME,
  ...over,
});
const off = (over: Partial<ExtendCaps> = {}): ExtendCaps => ({ ...on(over), enabled: false });

function revert(): BaseError {
  const r = new ContractFunctionRevertedError({ abi: [], functionName: 'x' });
  Object.assign(r, { data: { errorName: 'LoanNotActive', args: [] } });
  return new BaseError('reverted', { cause: r });
}

describe('consentBand', () => {
  it('is the lender’s minimum to the lower maximum, ending at the earlier latest end', () => {
    expect(
      consentBand(on({ maxRateBps: 900, maxNewExpiry: 300 }), on({ minRateBps: 500, maxRateBps: 10_000, maxNewExpiry: 200 })),
    ).toEqual({ kind: 'both', minRateBps: 500, maxRateBps: 900, latestEnd: 200 });
  });

  it('says when both are in force but admit no rate', () => {
    expect(consentBand(on({ maxRateBps: 400 }), on({ minRateBps: 500 })).kind).toBe('noOverlap');
  });

  it('names the side whose limits are not in force', () => {
    expect(consentBand(off(), on())).toEqual({ kind: 'missing', borrower: true, lender: false });
    expect(consentBand(on(), off())).toEqual({ kind: 'missing', borrower: false, lender: true });
  });
});

describe('setByEarlierHolder', () => {
  it('is true only for limits someone else set', () => {
    expect(setByEarlierHolder(off({ setter: OTHER }), ME)).toBe(true);
    expect(setByEarlierHolder(off({ setter: ME.toLowerCase() as Address }), ME)).toBe(false);
    expect(setByEarlierHolder(off({ setter: ZERO }), ME)).toBe(false);
  });
});

describe('windowPhase', () => {
  const w = { opensAt: 100, closesAt: 200 };
  it('is inclusive at both ends', () => {
    expect(windowPhase(99, w)).toBe('before');
    expect(windowPhase(100, w)).toBe('open');
    expect(windowPhase(200, w)).toBe('open');
    expect(windowPhase(201, w)).toBe('closed');
  });
});

describe('capsArgs', () => {
  it('bounds the borrower’s rate from above and the lender’s from below', () => {
    expect(capsArgs('borrower', 7, { enabled: true, rateBps: 900, latestEnd: 123 }, 10_000)).toEqual([7n, true, 0, 900, 123n]);
    expect(capsArgs('lender', 7, { enabled: true, rateBps: 500, latestEnd: 123 }, 10_000)).toEqual([7n, true, 500, 10_000, 123n]);
  });
  it('turns a side off with nothing else set', () => {
    expect(capsArgs('lender', 7, { enabled: false, rateBps: 500, latestEnd: 123 }, 10_000)).toEqual([7n, false, 0, 0, 0n]);
  });
});

describe('fundingCover', () => {
  const f = { asset: USDC, reserved: 30n, otherFree: 10n, chargeNow: 20n, chargeAtGraceEnd: 50n };
  it('counts the reserve and other free balance together', () => {
    expect(fundingCover(f)).toEqual({ available: 40n, coversNow: true, coversWindow: false, shortWindow: 10n });
    expect(fundingCover({ ...f, chargeAtGraceEnd: 40n }).coversWindow).toBe(true);
    expect(fundingCover({ ...f, chargeNow: 41n }).coversNow).toBe(false);
  });
});

describe('keeperVerdict', () => {
  const K1 = '0x00000000000000000000000000000000000000C1';
  const K2 = '0x00000000000000000000000000000000000000C2';
  const on = { [K1.toLowerCase()]: true, [K2.toLowerCase()]: true };

  it('is ready when a keeper switched on for the loan has the extend permission', () => {
    expect(keeperVerdict({ enabled: true, keepers: [{ keeper: K1, actions: 0x20 }] }, on)).toBe('ready');
    expect(keeperVerdict({ enabled: true, keepers: [{ keeper: K1, actions: null }, { keeper: K2, actions: 0x21 }] }, on)).toBe('ready');
  });

  it('is unknown, never none, while a keeper switched on for the loan has an unread permission', () => {
    expect(keeperVerdict({ enabled: true, keepers: [{ keeper: K1, actions: null }, { keeper: K2, actions: 0x01 }] }, on)).toBe('unknown');
  });

  it('is none when access is off, or no keeper on for the loan may extend', () => {
    expect(keeperVerdict({ enabled: false, keepers: [{ keeper: K1, actions: 0x20 }] }, on)).toBe('none');
    expect(keeperVerdict({ enabled: true, keepers: [{ keeper: K1, actions: 0x20 }] }, {})).toBe('none');
    expect(keeperVerdict({ enabled: true, keepers: [{ keeper: K1, actions: 0x01 }] }, on)).toBe('none');
    // An unread keeper that is not on for this loan cannot send it either.
    expect(keeperVerdict({ enabled: true, keepers: [{ keeper: K1, actions: null }] }, {})).toBe('none');
  });
});

function clientFor(over: {
  window?: unknown;
  status?: number;
  owner?: unknown;
  reserved?: bigint;
} = {}) {
  const blocks: unknown[] = [];
  const client = {
    getBlock: vi.fn(async () => ({ number: 42n, timestamp: 1_000n })),
    getBlockNumber: vi.fn(async () => 42n),
    readContract: vi.fn(async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      blocks.push(blockNumber);
      switch (functionName) {
        case 'paused':
          return false;
        case 'getAutoExtendEnabled':
          return true;
        case 'keepersPaused':
          return false;
        case 'getAutoExtendBorrowerCaps':
          return { enabled: true, minRateBps: 0, maxRateBps: 900, maxNewExpiry: 5_000n, setter: ME };
        case 'getAutoExtendLenderCaps':
          return { enabled: false, minRateBps: 500, maxRateBps: 10_000, maxNewExpiry: 5_000n, setter: OTHER };
        case 'getAutoExtendWindow':
          if (over.window instanceof Error) throw over.window;
          return [900n, 1_100n];
        case 'getExtendFunding':
          return [USDC, over.reserved ?? 7n, 3n, 2n, 4n];
        case 'getLoanDetails':
          return { status: over.status ?? 0, borrowerTokenId: 11n };
        case 'ownerOf':
          if (over.owner instanceof Error) throw over.owner;
          return over.owner ?? ME;
      }
      throw new Error(`unexpected ${functionName}`);
    }),
  } as unknown as PublicClient;
  return { client, blocks };
}

describe('readAutoExtendState', () => {
  it('reads every part at one block', async () => {
    const { client, blocks } = clientFor();
    const s = await readAutoExtendState({ client, diamond: DIAMOND }, 3);
    expect(s).toMatchObject({
      paused: false,
      switchOn: true,
      keepersPaused: false,
      window: { opensAt: 900, closesAt: 1_100 },
      now: 1_000,
      borrower: { enabled: true, maxRateBps: 900, maxNewExpiry: 5_000 },
      lender: { enabled: false, setter: OTHER },
    });
    expect(blocks.every((b) => b === 42n)).toBe(true);
  });

  it('has no window once the loan is not active, and fails on any other error', async () => {
    expect((await readAutoExtendState({ client: clientFor({ window: revert() }).client, diamond: DIAMOND }, 3)).window).toBeNull();
    await expect(
      readAutoExtendState({ client: clientFor({ window: new Error('rpc down') }).client, diamond: DIAMOND }, 3),
    ).rejects.toThrow('rpc down');
  });
});

describe('reserve discovery', () => {
  beforeEach(() => {
    pages.calls = [];
    pages.responses = [];
  });

  it('asks for this wallet’s reserve deposits and follows the pages', async () => {
    pages.responses = [
      { events: [{ loanId: 5 }, { loanId: 5 }], nextBefore: 'c1' },
      { events: [{ loanId: 2 }], nextBefore: null },
    ];
    expect(await reserveLoanIds(84532, ME)).toEqual({ loanIds: [5, 2], truncated: false });
    expect(pages.calls[0]).toMatchObject({ actor: ME, kinds: ['ExtendReserveFunded'], limit: 200 });
    expect(pages.calls[1].before).toBe('c1');
  });

  it('is null when the indexer cannot answer', async () => {
    pages.responses = [null];
    expect(await reserveLoanIds(84532, ME)).toBeNull();
  });
});

describe('readReserveRow', () => {
  const ctx = (c: PublicClient) => ({ client: c, diamond: DIAMOND });

  it('says the reserve is kept while this wallet holds the active loan’s borrower position', async () => {
    expect(await readReserveRow(ctx(clientFor().client), 4, ME)).toEqual({ loanId: 4, asset: USDC, reserved: 7n, use: 'kept' });
  });

  it('says nothing draws it once the position moved on or the loan ended', async () => {
    expect((await readReserveRow(ctx(clientFor({ owner: OTHER }).client), 4, ME))?.use).toBe('notHolder');
    expect((await readReserveRow(ctx(clientFor({ owner: revert() }).client), 4, ME))?.use).toBe('notHolder');
    expect((await readReserveRow(ctx(clientFor({ status: 1 }).client), 4, ME))?.use).toBe('ended');
  });

  it('is null when nothing is reserved, and throws when a read fails', async () => {
    expect(await readReserveRow(ctx(clientFor({ reserved: 0n }).client), 4, ME)).toBeNull();
    await expect(readReserveRow(ctx(clientFor({ owner: new Error('rpc down') }).client), 4, ME)).rejects.toThrow('rpc down');
  });
});

describe('withdrawWholeReserve', () => {
  it('screens, reads the reserve live and withdraws all of it for the account', async () => {
    const { client } = clientFor({ reserved: 9n });
    const write = vi.fn(async () => ({ receipt: { logs: ['l'] } }));
    const screen = vi.fn(async () => {});
    const logs = await withdrawWholeReserve({ client, diamond: DIAMOND, account: ME, loanId: 6, write, screen });
    expect(screen).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('withdrawExtendReserve', [ME, 6n, 9n]);
    expect(logs).toEqual(['l']);
  });

  it('sends nothing when the reserve is already gone', async () => {
    const { client } = clientFor({ reserved: 0n });
    const write = vi.fn();
    expect(
      await withdrawWholeReserve({ client, diamond: DIAMOND, account: ME, loanId: 6, write, screen: async () => {} }),
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});
