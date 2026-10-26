/**
 * The OpenSea publish offers only the loan's LIVE listing (#1481).
 *
 * Every other read the publish makes is pinned to the post transaction's
 * block, so on their own they rebuild a perfectly valid order for a listing
 * the borrower has since cancelled, replaced or sold through. An ingest
 * catching up on old blocks — or the block-zero replay after a restore —
 * hands the publish exactly those events. These cases pin the check that
 * stops it: the Diamond's current listing hash is read first, and an order
 * that is not it never reaches OpenSea, nor costs another chain read.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { indexerPublishPrepayListing, type IndexerPublishInput } from '../src/openseaPublish';
import type { Env } from '../src/env';

const ORDER = `0x${'ab'.repeat(32)}` as const;
const OTHER = `0x${'cd'.repeat(32)}` as const;
const ZERO = `0x${'00'.repeat(32)}` as const;

function inputWith(liveHash: `0x${string}`) {
  const readContract = vi.fn(async (args: { functionName: string }) => {
    if (args.functionName === 'getPrepayListingOrderHash') return liveHash;
    throw new Error(`unexpected read ${args.functionName}`);
  });
  const getTransactionReceipt = vi.fn(async () => {
    throw new Error('receipt read after a dead listing');
  });
  const publicClient = { readContract, getTransactionReceipt } as unknown as PublicClient;
  const input: IndexerPublishInput = {
    publicClient,
    diamondAddress: `0x${'11'.repeat(20)}`,
    chainId: 8453,
    loanId: 7n,
    txHash: `0x${'22'.repeat(32)}`,
    askPrice: 1n,
    salt: 1n,
    conduitKey: ZERO,
    executor: `0x${'33'.repeat(20)}`,
    expectedOrderHash: ORDER,
  };
  return { input, readContract, getTransactionReceipt };
}

const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
const env = { OPENSEA_API_KEY: 'test-key', fetchFn } as unknown as Env;

describe('OpenSea publish — live listing only (#1481)', () => {
  it('refuses an order the Diamond has since replaced', async () => {
    const { input, getTransactionReceipt } = inputWith(OTHER);
    const result = await indexerPublishPrepayListing(input, env);
    expect(result).toEqual({ published: false, error: 'listing-not-live' });
    expect(getTransactionReceipt).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses an order whose loan has no listing any more', async () => {
    const { input, getTransactionReceipt } = inputWith(ZERO);
    const result = await indexerPublishPrepayListing(input, env);
    expect(result).toEqual({ published: false, error: 'listing-not-live' });
    expect(getTransactionReceipt).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reads the live hash for this loan from this Diamond, at the head', async () => {
    const { input, readContract } = inputWith(OTHER);
    await indexerPublishPrepayListing(input, env);
    expect(readContract).toHaveBeenCalledTimes(1);
    const call = readContract.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(call.functionName).toBe('getPrepayListingOrderHash');
    expect(call.address).toBe(input.diamondAddress);
    expect(call.args).toEqual([7n]);
    // No block pin: a read at the post block would see the order as live.
    expect(call.blockNumber).toBeUndefined();
    expect(call.blockTag).toBeUndefined();
  });

  it('goes on to rebuild the order when it is the live listing (case-insensitive)', async () => {
    const { input, getTransactionReceipt } = inputWith(ORDER.toUpperCase().replace('0X', '0x') as `0x${string}`);
    const result = await indexerPublishPrepayListing(input, env);
    // The stub's receipt read throws, so reaching it proves the guard let the
    // live order through; the failure is the stub's, reported, never thrown.
    expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(result.published).toBe(false);
    expect(result.error).not.toBe('listing-not-live');
  });
});
