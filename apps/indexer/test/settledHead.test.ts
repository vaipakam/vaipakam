/**
 * Where a head came from (#2201).
 *
 * The block number is the easy half. The load-bearing half is `settled` —
 * whether the CHAIN named this block, or we stepped back from the tip and
 * hoped. The bug was that the distinction did not survive the call — every
 * consumer got a bare `bigint` and could not have acted on it if it wanted
 * to. (Not "one consumer may act on a guess and one may not": the scan is
 * exposed too, since its cursor never revisits a reorganised-out block. It
 * is the correction that refuses today, and #2201 stays open for the rest.)
 *
 * So these cases are less about arithmetic than about a flag never being
 * optimistic. A resolver that answered `settled: true` on the fallback would
 * type-check, satisfy every caller, and quietly re-open the hole.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveSettledHead, SAFE_FALLBACK_BUFFER } from '../src/settledHead';

const TS = 1_700_000_000n;

/** A provider that answers the `safe` tag. */
const supportsSafe = (safeNumber: bigint) => ({
  getBlock: vi.fn(async (args: { blockTag?: 'safe'; blockNumber?: bigint }) => {
    if (args.blockTag === 'safe') return { number: safeNumber, timestamp: TS };
    return { number: args.blockNumber ?? null, timestamp: TS };
  }),
  getBlockNumber: vi.fn(async () => safeNumber + 40n),
});

/** A provider that rejects it, which is the whole reason a fallback exists. */
const rejectsSafe = (latest: bigint) => ({
  getBlock: vi.fn(async (args: { blockTag?: 'safe'; blockNumber?: bigint }) => {
    if (args.blockTag === 'safe') throw new Error('unsupported block tag: safe');
    return { number: args.blockNumber ?? null, timestamp: TS + 5n };
  }),
  getBlockNumber: vi.fn(async () => latest),
});

describe('a head the chain named', () => {
  it('is settled, and is the block the chain gave', async () => {
    const c = supportsSafe(900n);
    const head = await resolveSettledHead(c as never);
    expect(head).toEqual({ block: 900n, timestamp: TS, settled: true });
    // One read on the healthy path. This resolver replaced a call site that
    // cost exactly one, and a budgeted Worker notices the difference.
    expect(c.getBlock).toHaveBeenCalledTimes(1);
    expect(c.getBlockNumber).not.toHaveBeenCalled();
  });
});

describe('a head we guessed', () => {
  it('is NOT settled, and steps back by the buffer', async () => {
    const head = await resolveSettledHead(rejectsSafe(1000n) as never);
    expect(head.block).toBe(1000n - SAFE_FALLBACK_BUFFER);
    expect(head.settled).toBe(false);
  });

  it('carries the pinned block’s own timestamp, not the tip’s', async () => {
    // The recycling snapshot publishes this as the moment its amounts
    // describe. `latest`'s timestamp would be minutes off and would name a
    // block the snapshot is not pinned to.
    const c = rejectsSafe(1000n);
    const head = await resolveSettledHead(c as never);
    expect(head.timestamp).toBe(TS + 5n);
    expect(c.getBlock).toHaveBeenLastCalledWith({ blockNumber: 968n });
  });

  it('carries the provider’s OWN reason rather than an assumed one', async () => {
    // The catch is unconditional — a timeout from a provider that supports
    // the tag reaches the fallback exactly as an old node does. An operator
    // told "your RPC lacks `safe`" on a timeout goes and fixes something
    // that works, so the cause travels with the answer instead of being
    // inferred from the flag.
    const head = await resolveSettledHead(rejectsSafe(1000n) as never);
    expect(head.fallbackReason).toBe('unsupported block tag: safe');

    const timedOut = {
      getBlock: vi.fn(async (args: { blockTag?: 'safe'; blockNumber?: bigint }) => {
        if (args.blockTag === 'safe') throw new Error('request timed out');
        return { number: args.blockNumber ?? null, timestamp: TS };
      }),
      getBlockNumber: vi.fn(async () => 1000n),
    };
    expect((await resolveSettledHead(timedOut as never)).fallbackReason).toBe('request timed out');
  });

  it('says nothing about a reason when the head IS settled', async () => {
    // A reason on a settled head would be a field consumers learn to ignore.
    expect((await resolveSettledHead(supportsSafe(900n) as never)).fallbackReason).toBeUndefined();
  });

  it('does not underflow on a chain shorter than the buffer', async () => {
    const head = await resolveSettledHead(rejectsSafe(10n) as never);
    expect(head.block).toBe(0n);
    expect(head.settled).toBe(false);
  });

  it('names the numberless answer as its own reason, not as an error', async () => {
    const c = {
      getBlock: vi.fn(async (args: { blockTag?: 'safe'; blockNumber?: bigint }) =>
        args.blockTag === 'safe'
          ? { number: null, timestamp: TS }
          : { number: args.blockNumber ?? null, timestamp: TS },
      ),
      getBlockNumber: vi.fn(async () => 500n),
    };
    expect((await resolveSettledHead(c as never)).fallbackReason).toContain('no number');
  });

  it('treats a numberless answer as no answer rather than pinning to zero', async () => {
    // A provider that returns a block with a null number has not named a
    // safe block. Coercing that to `0n` would pin every read to genesis and
    // call it settled — the one failure worse than falling back.
    const c = {
      getBlock: vi.fn(async (args: { blockTag?: 'safe'; blockNumber?: bigint }) =>
        args.blockTag === 'safe'
          ? { number: null, timestamp: TS }
          : { number: args.blockNumber ?? null, timestamp: TS },
      ),
      getBlockNumber: vi.fn(async () => 500n),
    };
    const head = await resolveSettledHead(c as never);
    expect(head.block).toBe(500n - SAFE_FALLBACK_BUFFER);
    expect(head.settled).toBe(false);
  });
});
