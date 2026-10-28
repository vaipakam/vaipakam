/**
 * #126 slice 2 — what a batch listing reports per loan. Listed only when
 * the transaction's own logs say so (a later lock read could not tell this
 * batch's listing from one made elsewhere); every other outcome is read
 * from the chain, and a pending send never reads as "not listed".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeEventTopics, type Log, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../content/copy';
import { LoanStatus } from '../lib/types';

const reads = vi.hoisted(() => ({
  status: {} as Record<number, number | 'unreadable'>,
  simulate: null as unknown,
  blocks: [] as (bigint | undefined)[],
}));

vi.mock('../contracts/loanLive', () => ({
  LOAN_STATUS_ACTIVE: 0,
  readLoanLive: vi.fn(async (_c: unknown, _d: unknown, loanId: number, block?: bigint) => {
    reads.blocks.push(block);
    const status = reads.status[loanId];
    if (status === 'unreadable') throw new Error('rpc down');
    return { status };
  }),
}));

import { listingsInLogs, readBackListings } from './batchSale';
import type { SaleListingCtx } from './saleListingPlan';

const DIAMOND = '0x000000000000000000000000000000000000d1a0' as const;
const OTHER = '0x000000000000000000000000000000000000beef' as const;
const ctx: SaleListingCtx = {
  publicClient: {
    simulateContract: async () => {
      if (reads.simulate) throw reads.simulate;
      return { result: undefined };
    },
  } as unknown as PublicClient,
  diamond: DIAMOND,
  holder: '0x00000000000000000000000000000000000000b0',
};
const TERMS = { rateBps: 1_000, listingSeconds: 86_400n };
const plan = (loanId: number) => ({ loanId, bounds: { minSellerNet: 1n, maxHeld: 0n } });

const linkedLog = (address: `0x${string}`, loanId: bigint, saleOfferId: bigint): Log =>
  ({
    address,
    topics: encodeEventTopics({
      abi: DIAMOND_ABI_VIEM,
      eventName: 'LoanSaleOfferLinked',
      args: { loanId, saleOfferId },
    } as never),
    data: '0x',
    blockNumber: 9n,
    logIndex: 0,
    transactionIndex: 0,
    transactionHash: `0x${'cd'.repeat(32)}`,
    blockHash: `0x${'ef'.repeat(32)}`,
    removed: false,
  }) as unknown as Log;

beforeEach(() => {
  reads.status = {};
  reads.simulate = null;
  reads.blocks = [];
});

describe('listingsInLogs', () => {
  it('maps each listed loan to its sale offer, from the Diamond’s logs only', () => {
    const listed = listingsInLogs(
      [linkedLog(DIAMOND, 4n, 40n), linkedLog(OTHER, 5n, 50n), linkedLog(DIAMOND, 6n, 60n)],
      DIAMOND,
    );
    expect([...listed.entries()]).toEqual([
      [4, '40'],
      [6, '60'],
    ]);
  });
});

describe('readBackListings', () => {
  it('reports listed from the logs, and reads the rest at the transaction’s block', async () => {
    reads.status = { 5: LoanStatus.Repaid, 6: LoanStatus.Active };
    reads.simulate = new Error('SaleRelistCooldownActive');
    const out = await readBackListings(ctx, [plan(4), plan(5), plan(6)], TERMS, {
      block: 9n,
      logs: [linkedLog(DIAMOND, 4n, 40n)],
    });
    expect(out[0]).toEqual({ loanId: 4, kind: 'listed', offerId: '40' });
    expect(out[1]).toEqual({ loanId: 5, kind: 'changed' });
    expect(out[2]).toMatchObject({ loanId: 6, kind: 'open' });
    expect(reads.blocks).toEqual([9n, 9n]);
  });

  it('says a skipped loan can be listed now when its call would pass', async () => {
    reads.status = { 6: LoanStatus.Active };
    const out = await readBackListings(ctx, [plan(6)], TERMS, { block: 9n, logs: [] });
    expect(out).toEqual([{ loanId: 6, kind: 'open', reason: copy.batchSale.skippedRetry }]);
  });

  it('is pending, never open, for an active loan behind a pending send', async () => {
    reads.status = { 6: LoanStatus.Active, 7: LoanStatus.Defaulted };
    const out = await readBackListings(ctx, [plan(6), plan(7)], TERMS, { pending: true });
    expect(out).toEqual([
      { loanId: 6, kind: 'pending' },
      { loanId: 7, kind: 'changed' },
    ]);
    expect(reads.blocks).toEqual([undefined, undefined]);
  });

  it('carries the send’s failure, and is unknown when the loan cannot be read', async () => {
    reads.status = { 6: LoanStatus.Active, 7: 'unreadable' };
    const out = await readBackListings(ctx, [plan(6), plan(7)], TERMS, { failure: 'rejected' });
    expect(out).toEqual([
      { loanId: 6, kind: 'open', reason: 'rejected' },
      { loanId: 7, kind: 'unknown' },
    ]);
  });
});
