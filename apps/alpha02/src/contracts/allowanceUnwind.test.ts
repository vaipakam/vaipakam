/**
 * #1529 review — the allowance unwind must put back exactly what the
 * flow took, and must never touch an allowance somebody else has moved
 * since.
 *
 * Two distinct clobbering bugs were found by review in this helper pair
 * and both are pinned here, because neither is visible to the type
 * checker and both would silently destroy a user's standing grant:
 *
 *  1. Unwinding to ZERO destroys a pre-existing partial grant.
 *     `ensureAllowance` raises a non-zero-but-insufficient allowance, so
 *     the unwind has to restore the observed prior figure, not revoke.
 *  2. Restoring a stale `previous` over a value another tab, flow, or
 *     spender has since written is the same class of bug pointed the
 *     other way. The `wrote` guard is what stops it.
 *
 * Plus the case that motivated reporting each mined approve rather than
 * reading `ensureAllowance`'s return value: the zero-first reset lands,
 * the approve after it is rejected, and the function never returns — yet
 * the allowance IS now 0 and the prior grant needs putting back.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PublicClient, WalletClient } from 'viem';
import { ensureAllowance, restoreAllowance } from './erc20';

const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const OWNER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const SPENDER = '0xcccccccccccccccccccccccccccccccccccccccc' as const;

/**
 * A pair of viem clients over a single mutable allowance figure.
 * `approve` calls are recorded in order so a test can assert the exact
 * write sequence — including the zero-first reset — rather than just the
 * end state.
 */
function harness(opts: {
  allowance: bigint;
  rejectApproveOf?: (value: bigint) => boolean;
  /** Simulates a concurrent actor: called after each approve mines with
   *  the value just written; a returned bigint becomes the new live
   *  allowance, as if another tab wrote it in that window. */
  afterWrite?: (value: bigint) => bigint | undefined;
}) {
  let allowance = opts.allowance;
  const writes: bigint[] = [];

  const publicClient = {
    readContract: vi.fn(async () => allowance),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const })),
  } as unknown as PublicClient;

  const walletClient = {
    chain: undefined,
    writeContract: vi.fn(async ({ args }: { args: readonly unknown[] }) => {
      const value = args[1] as bigint;
      if (opts.rejectApproveOf?.(value)) throw new Error('user rejected');
      writes.push(value);
      allowance = value;
      const raced = opts.afterWrite?.(value);
      if (raced !== undefined) allowance = raced;
      return '0xdead' as `0x${string}`;
    }),
  } as unknown as WalletClient;

  return {
    publicClient,
    walletClient,
    writes,
    get allowance() {
      return allowance;
    },
  };
}

const base = (h: ReturnType<typeof harness>) => ({
  publicClient: h.publicClient,
  walletClient: h.walletClient,
  token: TOKEN,
  owner: OWNER,
  spender: SPENDER,
});

describe('restoreAllowance', () => {
  it('does nothing when the flow wrote nothing', async () => {
    const h = harness({ allowance: 500n });
    const tx = await restoreAllowance({ ...base(h), previous: 500n, wrote: null });
    expect(tx).toBeNull();
    expect(h.writes).toEqual([]);
    expect(h.allowance).toBe(500n);
  });

  it('does nothing when the value written equals the prior value', async () => {
    const h = harness({ allowance: 500n });
    const tx = await restoreAllowance({ ...base(h), previous: 500n, wrote: 500n });
    expect(tx).toBeNull();
    expect(h.writes).toEqual([]);
  });

  it('restores a pre-existing partial grant instead of revoking it', async () => {
    // The bug this exists for: previous 500, raised to 1000, unwound.
    // Revoking would leave 0 and break whatever relied on the 500.
    const h = harness({ allowance: 1_000n });
    await restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n });
    // Zero-first, because 1000 → 500 is a non-zero → non-zero approve.
    expect(h.writes).toEqual([0n, 500n]);
    expect(h.allowance).toBe(500n);
  });

  it('goes straight to zero when there was no prior grant', async () => {
    const h = harness({ allowance: 1_000n });
    await restoreAllowance({ ...base(h), previous: 0n, wrote: 1_000n });
    // No reset step needed — the target IS zero.
    expect(h.writes).toEqual([0n]);
    expect(h.allowance).toBe(0n);
  });

  it('leaves the allowance alone once someone else has moved it', async () => {
    // We wrote 1000; by unwind time it reads 250 (partly consumed, or
    // another tab lowered it). Writing our stale 500 back would be a
    // clobber, and would hand the spender MORE than it has now.
    const h = harness({ allowance: 250n });
    const tx = await restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n });
    expect(tx).toBeNull();
    expect(h.writes).toEqual([]);
    expect(h.allowance).toBe(250n);
  });

  it('leaves a raised allowance alone too, not just a lowered one', async () => {
    const h = harness({ allowance: 5_000n });
    const tx = await restoreAllowance({ ...base(h), previous: 0n, wrote: 1_000n });
    expect(tx).toBeNull();
    expect(h.writes).toEqual([]);
  });
});

describe('restoreAllowance — the second transaction is guarded too', () => {
  it('aborts the restore when someone claims the allowance after the reset', async () => {
    // previous 500, we wrote 1000, unwinding. The reset to 0 mines, and
    // in that window another tab grants 900. Writing our 500 over it
    // would be the same clobber the pre-flight guard prevents, just one
    // transaction later (#1529 review round 3).
    const h = harness({
      allowance: 1_000n,
      afterWrite: (v) => (v === 0n ? 900n : undefined),
    });
    const tx = await restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n });
    expect(tx).toBeNull();
    // The reset happened — it had to, to reach the race — but the
    // restore did NOT overwrite the newcomer's value.
    expect(h.writes).toEqual([0n]);
    expect(h.allowance).toBe(900n);
  });

  it('completes the restore when nothing intervenes', async () => {
    const h = harness({ allowance: 1_000n });
    await restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n });
    expect(h.writes).toEqual([0n, 500n]);
    expect(h.allowance).toBe(500n);
  });
});

describe('ensureAllowance onObserved', () => {
  it('reports the allowance it replaced, so the caller need not re-read', async () => {
    // The caller sampling separately is a second moment: anything moving
    // the allowance in between leaves the caller's figure stale, and the
    // unwind then restores a value that was never replaced (#1529 review
    // round 3). One read, one truth.
    const h = harness({ allowance: 250n });
    let observed: bigint | null = null;
    await ensureAllowance({
      ...base(h),
      amount: 1_000n,
      onObserved: (v) => {
        observed = v;
      },
    });
    expect(observed).toBe(250n);
  });

  it('reports even when the standing allowance already suffices', async () => {
    const h = harness({ allowance: 5_000n });
    let observed: bigint | null = null;
    const tx = await ensureAllowance({
      ...base(h),
      amount: 1_000n,
      onObserved: (v) => {
        observed = v;
      },
    });
    // Nothing written, but the observation still stands — and with
    // `wrote` null the restore is a no-op regardless.
    expect(tx).toBeNull();
    expect(observed).toBe(5_000n);
    expect(h.writes).toEqual([]);
  });
});

describe('ensureAllowance onWrote', () => {
  it('reports nothing when the standing allowance already covers', async () => {
    const h = harness({ allowance: 1_000n });
    const wrote = vi.fn();
    const tx = await ensureAllowance({ ...base(h), amount: 500n, onWrote: wrote });
    expect(tx).toBeNull();
    expect(wrote).not.toHaveBeenCalled();
  });

  it('reports both writes on the zero-first path', async () => {
    const h = harness({ allowance: 500n });
    const seen: bigint[] = [];
    await ensureAllowance({
      ...base(h),
      amount: 1_000n,
      onWrote: (v) => seen.push(v),
    });
    expect(seen).toEqual([0n, 1_000n]);
  });

  it('reports the zero-reset even when the approve after it is rejected', async () => {
    // The reason the caller cannot key its unwind on the return value:
    // this call throws, so there is no return value, but the user's
    // standing 500 has already been destroyed and needs putting back.
    const h = harness({ allowance: 500n, rejectApproveOf: (v) => v === 1_000n });
    let wrote: bigint | null = null;
    await expect(
      ensureAllowance({
        ...base(h),
        amount: 1_000n,
        onWrote: (v) => {
          wrote = v;
        },
      }),
    ).rejects.toThrow();
    expect(wrote).toBe(0n);
    expect(h.allowance).toBe(0n);

    // …and the unwind, told that, restores the grant.
    await restoreAllowance({ ...base(h), previous: 500n, wrote });
    expect(h.allowance).toBe(500n);
  });
});
