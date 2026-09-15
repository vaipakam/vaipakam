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

/**
 * A provider that rejects it, which is the whole reason a fallback exists.
 *
 * The thrown error is viem-shaped ON PURPOSE: a class name, a JSON-RPC code,
 * and a message carrying the request URL — including its API key, which is
 * how every hosted RPC in this deployment is addressed.
 */
const rpcError = () =>
  Object.assign(
    new Error(
      'HTTP request failed. URL: https://base-sepolia.example.com/v2/SUPER_SECRET_KEY ' +
        'Body: {"method":"eth_getBlockByNumber"}',
    ),
    { name: 'RpcRequestError', code: -32601, status: 400 },
  );

const rejectsSafe = (latest: bigint) => ({
  getBlock: vi.fn(async (args: { blockTag?: 'safe'; blockNumber?: bigint }) => {
    if (args.blockTag === 'safe') throw rpcError();
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

  it('NEVER carries the provider’s error message, which holds the API key', async () => {
    // #2211 r1 `4011103040`. `chain.rpc` embeds a credential on every hosted
    // provider here, and viem puts the whole request URL in the message — so
    // quoting it would print the key into the operator log on every tick of
    // a provider whose settled read is failing. The one place this string is
    // built is the one place that has to be right.
    const head = await resolveSettledHead(rejectsSafe(1000n) as never);
    expect(head.fallbackReason).not.toContain('SUPER_SECRET_KEY');
    expect(head.fallbackReason).not.toContain('https://');
  });

  it('still distinguishes the two cases an operator has to tell apart', async () => {
    // Bounded fields are not a lesser version of the message — they are the
    // identifying part. An unsupported method and a timeout need different
    // remedies, and neither a class name nor a numeric code can hold a
    // secret.
    const unsupported = await resolveSettledHead(rejectsSafe(1000n) as never);
    expect(unsupported.fallbackReason).toContain('RpcRequestError');
    expect(unsupported.fallbackReason).toContain('-32601');

    const timedOut = {
      getBlock: vi.fn(async (args: { blockTag?: 'safe'; blockNumber?: bigint }) => {
        if (args.blockTag === 'safe') {
          throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        }
        return { number: args.blockNumber ?? null, timestamp: TS };
      }),
      getBlockNumber: vi.fn(async () => 1000n),
    };
    expect((await resolveSettledHead(timedOut as never)).fallbackReason).toBe('TimeoutError');
  });

  it('redacts and bounds even the class name, which arrives from a dependency', async () => {
    // A bare identifier is a convention, not a guarantee. The belt-and-braces
    // pass is what makes "no secret can reach the log from here" a property
    // of this function rather than of viem's naming habits.
    const nasty = {
      getBlock: vi.fn(async (args: { blockTag?: 'safe'; blockNumber?: bigint }) => {
        if (args.blockTag === 'safe') {
          throw Object.assign(new Error('x'), {
            name: `Err https://host/v2/KEY ${'z'.repeat(200)}`,
          });
        }
        return { number: args.blockNumber ?? null, timestamp: TS };
      }),
      getBlockNumber: vi.fn(async () => 1000n),
    };
    const reason = (await resolveSettledHead(nasty as never)).fallbackReason ?? '';
    expect(reason).not.toContain('KEY');
    expect(reason).toContain('<redacted url>');
    expect(reason.length).toBeLessThanOrEqual(80);
  });

  it('says something rather than nothing when a non-Error is thrown', async () => {
    const odd = {
      getBlock: vi.fn(async (args: { blockTag?: 'safe'; blockNumber?: bigint }) => {
        if (args.blockTag === 'safe') throw 'just a string';
        return { number: args.blockNumber ?? null, timestamp: TS };
      }),
      getBlockNumber: vi.fn(async () => 1000n),
    };
    expect((await resolveSettledHead(odd as never)).fallbackReason).toContain('non-Error');
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
