/**
 * #2572 r6 — a commitment-batch scan under the run deadline persists its
 * frontier, whether the read cutoff stops it or the send queue refuses a batch.
 * Thrown out of the scan instead, the frontier was never written and the next
 * run repeated the same scan.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitSide } from '../src/commitmentReport';
import { SendPastDeadline } from '../src/submissionQueue';

const USER = '0x00000000000000000000000000000000000000aa';

function fakeDb() {
  const writes: unknown[][] = [];
  const stmt = {
    bind: (...a: unknown[]) => {
      writes.push(a);
      return stmt;
    },
    run: async () => ({ success: true, meta: { changes: 1 } }),
  };
  return { db: { prepare: () => stmt }, writes };
}

/** A page of `n` entries, every one covering day 5 on side 0. */
function client(n: number) {
  const reads = { pages: 0 };
  return {
    reads,
    publicClient: {
      readContract: async () => {
        reads.pages += 1;
        return Array.from({ length: n }, () => ({ user: USER, perDayNumeraire18: 1n, startDay: 1, endDay: 10, side: 0 }));
      },
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('submitSide under the run deadline (#2572 r6)', () => {
  it('a refused batch leaves the frontier at its first id, and does not throw', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, writes } = fakeDb();
    const { publicClient } = client(250);
    const ctx = {
      wallet: {
        account: { address: USER },
        writeContract: async () => {
          throw Object.assign(new Error('wrapped'), { cause: new SendPastDeadline('refused') });
        },
      },
    };
    await submitSide(
      { KEEPER_DB: db } as never, publicClient as never, ctx as never, USER as never,
      84532, 5n, 0, 0n, undefined, { batches: 4, pages: 4 }, Date.now() + 60_000,
    );
    const frontier = writes.at(-1)!;
    expect(frontier[3]).toBe('1'); // the lowest unsubmitted covering id
  });

  it('inside the send reserve it reads no page and still records the frontier', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db, writes } = fakeDb();
    const { publicClient, reads } = client(10);
    const ctx = { wallet: { account: { address: USER }, writeContract: vi.fn() } };
    await submitSide(
      { KEEPER_DB: db } as never, publicClient as never, ctx as never, USER as never,
      84532, 5n, 0, 0n, undefined, { batches: 4, pages: 4 }, Date.now() + 5_000,
    );
    expect(reads.pages).toBe(0);
    expect(ctx.wallet.writeContract).not.toHaveBeenCalled();
    expect(writes.at(-1)![3]).toBe('1');
  });
});
