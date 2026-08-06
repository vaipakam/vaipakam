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

/** The block every mocked receipt reports. Named because the pinned-read
 *  modelling turns on "is this read at or before the block our write
 *  mined in". */
const RECEIPT_BLOCK = 100n;

/**
 * A pair of viem clients over a single mutable allowance figure.
 * `approve` calls are recorded in order so a test can assert the exact
 * write sequence — including the zero-first reset — rather than just the
 * end state.
 */
function harness(opts: {
  allowance: bigint;
  rejectApproveOf?: (value: bigint) => boolean;
  /** Simulates a concurrent actor whose write has MINED: called after
   *  each approve with the value just written; a returned bigint becomes
   *  the new live allowance, as if another tab landed it in that
   *  window. */
  afterWrite?: (value: bigint) => bigint | undefined;
  /** Simulates a concurrent transaction still IN FLIGHT — invisible to
   *  an allowance read, which answers from mined state. Modelled the way
   *  a chain reports it: pending nonce ahead of the mined one. A
   *  predicate so a test can have one APPEAR partway through a
   *  two-transaction sequence. */
  pendingTx?: () => boolean;
  /** Receipt observation fails (timeout / lost RPC) for this value,
   *  AFTER the transaction has been submitted and taken effect. */
  loseReceiptOf?: (value: bigint) => boolean;
  /** Nonce reads themselves fail. */
  nonceReadThrows?: boolean;
  /** The approve is mined but REVERTS — receipt status 'reverted', so the
   *  value never takes effect. Distinct from a lost receipt, where it
   *  does. */
  revertApproveOf?: (value: bigint) => boolean;
  /** The write is SUBMITTED but does not take effect until its receipt is
   *  awaited — the pending window an allowance read cannot see. */
  pendingUntilReceipt?: (value: bigint) => boolean;
  /** Every receipt wait throws (the pending write never resolves). */
  receiptAlwaysThrows?: boolean;
  /** The first N receipt waits throw; later ones succeed. Models the real
   *  sequence this exists for — ensureAllowance's own wait times out on a
   *  still-pending approve, and the unwind's retry then resolves it. */
  receiptThrowsFirst?: number;
  /** Receipt waits at these ZERO-BASED indices throw, others resolve.
   *  Needed when only a LATER wait must fail: `receiptThrowsFirst` is a
   *  prefix, so it cannot express "the reset confirmed, the second
   *  approve's wait timed out". */
  receiptThrowsAt?: number[];
  /** The approve is submitted and then CANCELLED in the wallet — a
   *  zero-value self-send at the same nonce. The allowance never moves,
   *  and viem's wait follows the replacement and resolves with ITS
   *  receipt: `status: 'success'`, a DIFFERENT hash. Round 11's point: a
   *  transaction that did nothing we asked for presents exactly like one
   *  that did, unless the replacement is detected. */
  replaceTxOf?: (value: bigint) => boolean;
  /** The approve is submitted and then SPED UP — viem's `repriced`. The
   *  hash changes, but viem classifies it that way only when `to`,
   *  `value` and `input` all match, so it IS our call and the allowance
   *  DOES move. Round 11's blanket hash check called this a failure and
   *  told the user their approval had not happened while it sat on
   *  chain; round 12 is the correction. */
  repriceTxOf?: (value: bigint) => boolean;
  /** The allowance read answers from PRE-transaction state for the first
   *  N reads taken after a receipt — the public-RPC lag `receiptSync`
   *  exists for. Distinct from a value another actor changed: it catches
   *  up on its own. */
  staleReadsAfterWrite?: number;
  /** A read pinned to a block number fails (no archive depth, or the
   *  provider rejects the parameter) — so the conclusive negative is
   *  unavailable and the caller must fall back. */
  pinnedReadThrows?: boolean;
  /** Only the read pinned to the RECEIPT block fails, while the head stays
   *  readable — an ordinary non-archive node, which serves recent blocks
   *  and the head but not older state. `pinnedReadThrows` cannot express
   *  it: that one fails EVERY pinned read, including the head-pinned one
   *  `confirmAllowanceStillLive` uses, so it can only ever produce
   *  "the present is unestablished". This is the shape that reaches
   *  `resetLanded === 'unknown'` with the live check still answering. */
  receiptBlockReadThrows?: boolean;
  /** The HEAD read fails, so `confirmAllowanceStillLive` can never find a
   *  node it can prove has our block and returns `unknown`. Distinct from
   *  `pinnedReadThrows`, which leaves the head answerable: this is the
   *  only way to reach "we could not establish the present at all", as
   *  opposed to "the present disagrees with us". */
  headReadThrows?: boolean;
  /** What a read PINNED TO THE RECEIPT BLOCK answers, when that differs
   *  from the value now. Models a third party moving the allowance after
   *  our write mined: history still says the value is ours, the present
   *  says otherwise. Without this the harness cannot tell the two
   *  questions apart, because every pinned read answers with the live
   *  figure — which is exactly the confusion round 16 found in the code.
   *  Setting it also advances the head past the receipt block, since a
   *  later change implies a later block. */
  valueAtReceiptBlock?: bigint;
}) {
  let allowance = opts.allowance;
  const writes: bigint[] = [];
  /** Submitted-but-unmined effects, keyed by hash. */
  const inFlight = new Map<string, bigint>();
  let receiptWaits = 0;

  /** Pre-transaction value a lagging node keeps serving, and how many
   *  more reads it will serve it for. */
  let stale: { value: bigint; left: number } | null = null;

  const publicClient = {
    readContract: vi.fn(async ({ blockNumber }: { blockNumber?: bigint }) => {
      if (blockNumber !== undefined) {
        // A pinned read either has the block — in which case it answers
        // about POST-transaction state, never the stale one — or fails.
        if (opts.pinnedReadThrows) throw new Error('missing trie node');
        if (opts.receiptBlockReadThrows && blockNumber <= RECEIPT_BLOCK) {
          throw new Error('missing trie node');
        }
        // Pinned to the RECEIPT block, it answers about that block, which
        // is not the same question as "what is it now".
        if (opts.valueAtReceiptBlock !== undefined && blockNumber <= RECEIPT_BLOCK) {
          return opts.valueAtReceiptBlock;
        }
        return allowance;
      }
      if (stale && stale.left > 0) {
        stale.left -= 1;
        return stale.value;
      }
      return allowance;
    }),
    getTransactionCount: vi.fn(async ({ blockTag }: { blockTag?: string }) => {
      if (opts.nonceReadThrows) throw new Error('rpc down');
      return blockTag === 'pending' && opts.pendingTx?.() ? 8 : 7;
    }),
    // A node that has our receipt block. A concurrent change happened
    // after it, so the head sits one block later.
    getBlockNumber: vi.fn(async () => {
      if (opts.headReadThrows) throw new Error('rpc down');
      return opts.valueAtReceiptBlock !== undefined || opts.receiptBlockReadThrows
        ? RECEIPT_BLOCK + 1n
        : RECEIPT_BLOCK;
    }),
    waitForTransactionReceipt: vi.fn(
      async ({
        hash,
        onReplaced,
      }: {
        hash: string;
        onReplaced?: (r: { reason: string }) => void;
      }) => {
        if (opts.receiptAlwaysThrows) throw new Error('receipt timeout');
        const waitIndex = receiptWaits++;
        if (waitIndex < (opts.receiptThrowsFirst ?? 0)) {
          throw new Error('receipt timeout');
        }
        if (opts.receiptThrowsAt?.includes(waitIndex)) {
          throw new Error('receipt timeout');
        }
        if (hash === '0xlost') throw new Error('receipt timeout');
        if (hash.startsWith('0xrevert')) {
          return { status: 'reverted' as const, transactionHash: hash, blockNumber: 100n };
        }
        if (hash.startsWith('0xreplaced')) {
          // viem followed a CANCEL: a different transaction's receipt,
          // and a successful one. Nothing we submitted took effect, and
          // the status alone cannot say so.
          onReplaced?.({ reason: 'cancelled' });
          return { status: 'success' as const, transactionHash: '0xcancel', blockNumber: 100n };
        }
        if (hash.startsWith('0xrepriced')) {
          // A Speed Up. The hash differs, but it is OUR call — viem only
          // says `repriced` when to/value/input all match — so the
          // effect landed and this must NOT read as a failure.
          onReplaced?.({ reason: 'repriced' });
          const landed = inFlight.get(hash);
          if (landed !== undefined) {
            allowance = landed;
            inFlight.delete(hash);
          }
          return { status: 'success' as const, transactionHash: '0xfaster', blockNumber: 100n };
        }
        // Awaiting the receipt is what lands a pending write.
        if (inFlight.has(hash)) {
          allowance = inFlight.get(hash)!;
          inFlight.delete(hash);
        }
        // The receipt of the transaction actually asked about.
        return { status: 'success' as const, transactionHash: hash, blockNumber: 100n };
      },
    ),
  } as unknown as PublicClient;

  const walletClient = {
    chain: undefined,
    writeContract: vi.fn(async ({ args }: { args: readonly unknown[] }) => {
      const value = args[1] as bigint;
      if (opts.rejectApproveOf?.(value)) throw new Error('user rejected');
      writes.push(value);
      if (opts.revertApproveOf?.(value)) {
        // Submitted, mined, reverted — the allowance is untouched.
        return `0xrevert${writes.length}` as `0x${string}`;
      }
      if (opts.replaceTxOf?.(value)) {
        // Submitted, then cancelled — the allowance is untouched, and
        // the wait will resolve successfully on somebody else's hash.
        return `0xreplaced${writes.length}` as `0x${string}`;
      }
      if (opts.repriceTxOf?.(value)) {
        // Submitted, then sped up — same call, new hash, real effect.
        const hash = `0xrepriced${writes.length}` as `0x${string}`;
        inFlight.set(hash, value);
        return hash;
      }
      if (opts.pendingUntilReceipt?.(value)) {
        // Submitted only — the chain does not show it yet.
        const hash = `0xpending${writes.length}` as `0x${string}`;
        inFlight.set(hash, value);
        return hash;
      }
      // Submitted AND took effect on chain — whether or not we get to
      // observe the receipt.
      const before = allowance;
      allowance = value;
      if (opts.staleReadsAfterWrite) {
        stale = { value: before, left: opts.staleReadsAfterWrite };
      }
      const raced = opts.afterWrite?.(value);
      if (raced !== undefined) allowance = raced;
      return (opts.loseReceiptOf?.(value) ? '0xlost' : '0xdead') as `0x${string}`;
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

describe('ensureAllowance — a REVERT retracts the optimistic report', () => {
  it('rolls the report back to the confirmed reset when the second approve reverts', async () => {
    // Zero-first: approve(0) mines, approve(1000) is SUBMITTED (so it is
    // reported optimistically) and then reverts. The allowance is 0, not
    // 1000. Leaving the stale 1000 in place made restoreAllowance read
    // "somebody else owns this" and walk away from a grant it had just
    // erased itself (#1529 review round 8).
    const h = harness({ allowance: 500n, revertApproveOf: (v) => v === 1_000n });
    const seen: (bigint | null)[] = [];
    await expect(
      ensureAllowance({ ...base(h), amount: 1_000n, onWrote: (v) => seen.push(v) }),
    ).rejects.toThrow();
    // Optimistic 1000, then corrected back to the confirmed 0.
    expect(seen).toEqual([0n, 1_000n, 0n]);
    expect(h.allowance).toBe(0n);

    // …and with the corrected value the unwind puts the 500 back.
    await restoreAllowance({ ...base(h), previous: 500n, wrote: seen.at(-1)! });
    expect(h.allowance).toBe(500n);
  });

  it('reports null when the FIRST approve reverts, since nothing landed', async () => {
    const h = harness({ allowance: 0n, revertApproveOf: () => true });
    const seen: (bigint | null)[] = [];
    await expect(
      ensureAllowance({ ...base(h), amount: 1_000n, onWrote: (v) => seen.push(v) }),
    ).rejects.toThrow();
    expect(seen).toEqual([1_000n, null]);
    // null → the unwind correctly does nothing at all.
    const tx = await restoreAllowance({ ...base(h), previous: 0n, wrote: seen.at(-1)! });
    expect(tx).toBeNull();
    expect(h.writes).toEqual([1_000n]);
  });
});

describe('restoreAllowance — a revert discovered LATE still restores', () => {
  it('falls back to the confirmed reset when the pending write turns out reverted', async () => {
    // The sequence round 8's fix did not cover: approve(0) CONFIRMS,
    // approve(1000) is submitted, and ensureAllowance's own receipt wait
    // TIMES OUT — so its revert-correction never runs and `wrote` stays
    // 1000. The unwind then waits on that hash itself, sees the revert,
    // and would compare the real allowance (0) against the stale 1000,
    // conclude the zero wasn't its doing, and leave the prior 500 erased
    // (#1529 review round 9).
    const h = harness({
      allowance: 500n,
      revertApproveOf: (v) => v === 1_000n,
      // Wait 0 is the reset (confirms). Wait 1 is ensureAllowance's own
      // wait on the second approve — it TIMES OUT, so the correction
      // never runs. Wait 2 is the unwind's own wait on that same hash,
      // which resolves and reveals the revert.
      receiptThrowsAt: [1],
    });
    let wrote: bigint | null = null;
    let wroteTx: `0x${string}` | null = null;
    let confirmed: bigint | null = null;
    await expect(
      ensureAllowance({
        ...base(h),
        amount: 1_000n,
        onWrote: (v, hsh) => {
          wrote = v;
          wroteTx = hsh;
        },
        onConfirmed: (v) => {
          confirmed = v;
        },
      }),
    ).rejects.toThrow();

    // The stale optimistic value survived, because the correction could
    // not run — this is exactly the state the fix has to cope with.
    expect(wrote).toBe(1_000n);
    expect(confirmed).toBe(0n);
    expect(h.allowance).toBe(0n);

    await restoreAllowance({
      ...base(h),
      previous: 500n,
      wrote,
      wroteTxHash: wroteTx,
      confirmed,
    });
    // The prior grant is back, rather than left at zero.
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

describe('restoreAllowance — a transaction in flight means abstain LOUDLY', () => {
  /**
   * Abstaining is right in every case here — a competing transaction
   * would mine first and ours would overwrite it at the next nonce
   * (#1529 review round 5). What changed in round 20 is that abstaining
   * now THROWS rather than returning null.
   *
   * The two are not interchangeable to a caller: `ObligationTransferFlow`
   * and `RefinanceFlow` both append `approvalCleanupFailed` on a throw
   * and treat null as a clean cleanup. Returning null while the flow's
   * payoff-sized approval is still live — or, after the reset, while the
   * user's prior grant sits erased at zero — showed them only the generic
   * transaction-failed banner for a wallet state they have to act on.
   *
   * The silent stand-down is retained exactly where the read is POSITIVE:
   * see "leaves the allowance alone once someone else has moved it".
   */
  it('reports rather than hides an abstain for a pending transaction', async () => {
    const h = harness({ allowance: 1_000n, pendingTx: () => true });
    await expect(
      restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n }),
    ).rejects.toThrow(/still standing/i);
    expect(h.writes).toEqual([]);
  });

  it('reports an abstain when the pending state cannot be read at all', async () => {
    // Fail closed on the WRITE, but not on the report: a failed nonce read
    // is not even evidence of a pending transaction, so treating it as a
    // clean cleanup is the least defensible version of this.
    const h = harness({ allowance: 1_000n, nonceReadThrows: true });
    await expect(
      restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n }),
    ).rejects.toThrow(/still standing/i);
    expect(h.writes).toEqual([]);
  });

  it('reports an abstain when a transaction appears after the reset', async () => {
    // Nothing in flight at the outset, so the reset proceeds — and only
    // THEN does a competing transaction appear. The prior grant is now
    // cleared and not put back, which is the worst of the three to report
    // as clean, and the message says so specifically.
    let resetDone = false;
    const h = harness({
      allowance: 1_000n,
      pendingTx: () => resetDone,
      afterWrite: (v) => {
        if (v === 0n) resetDone = true;
        return undefined;
      },
    });
    await expect(
      restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n }),
    ).rejects.toThrow(/could not be restored/i);
    // The reset went out; the restore behind it did not.
    expect(h.writes).toEqual([0n]);
    expect(h.allowance).toBe(0n);
  });
});

describe('ensureAllowance — a lost receipt still reports the write', () => {
  it('reports a write whose receipt is never observed', async () => {
    // The approve MINED; waitForTransactionReceipt timed out before
    // seeing it. A caller told nothing would leave the grant standing —
    // or, on the zero-first path, leave the prior grant erased (#1529
    // review round 5).
    // Scoped to the 1000 write: the unwind's own approve(0) must still be
    // observable, or the test would be exercising two failures at once.
    const h = harness({ allowance: 0n, loseReceiptOf: (v) => v === 1_000n });
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
    expect(wrote).toBe(1_000n);
    expect(h.allowance).toBe(1_000n);

    // …and the unwind, told that, takes the grant back down.
    await restoreAllowance({ ...base(h), previous: 0n, wrote });
    expect(h.allowance).toBe(0n);
  });

  it('reconciles to a no-op when the reported write never landed', async () => {
    // The optimistic report is not treated as fact: restoreAllowance
    // re-reads, and a submission that never took effect simply does not
    // match, so nothing is written.
    const h = harness({ allowance: 500n });
    const tx = await restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n });
    expect(tx).toBeNull();
    expect(h.writes).toEqual([]);
    expect(h.allowance).toBe(500n);
  });
});

describe('restoreAllowance — our own pending write is not somebody else\'s', () => {
  it('settles a still-pending write before judging ownership', async () => {
    // The receipt wait timed out while the approve was STILL PENDING, so
    // the allowance reads `previous`, not `wrote`. Without the hash that
    // is indistinguishable from "someone else moved it", and standing
    // down leaves a grant to appear later unattended (#1529 review round
    // 6). With the hash, the restore waits for that transaction and looks
    // again.
    const h = harness({
      allowance: 0n,
      // The 1000 grant is in flight; only awaiting its receipt lands it.
      pendingUntilReceipt: (v) => v === 1_000n,
      // ensureAllowance's OWN wait times out while it is still pending.
      receiptThrowsFirst: 1,
    });
    let submitted: { value: bigint | null; hash: `0x${string}` | null } | null = null;
    await expect(
      ensureAllowance({
        ...base(h),
        amount: 1_000n,
        onWrote: (value, hash) => {
          submitted = { value, hash };
        },
      }),
    ).rejects.toThrow(/receipt timeout/);

    // Submitted and reported, but the chain does not show it — this is
    // exactly the window an allowance read cannot distinguish from
    // "someone else moved it".
    expect(submitted).not.toBeNull();
    expect(h.allowance).toBe(0n);

    const tx = await restoreAllowance({
      ...base(h),
      previous: 0n,
      wrote: submitted!.value,
      wroteTxHash: submitted!.hash,
    });
    // It waited, found the grant, and took it back down to the prior zero.
    expect(tx).not.toBeNull();
    expect(h.allowance).toBe(0n);
  });

  it('stands down LOUDLY when the pending write never resolves', async () => {
    const h = harness({ allowance: 500n, receiptAlwaysThrows: true });
    await expect(
      restoreAllowance({
        ...base(h),
        previous: 500n,
        wrote: 1_000n,
        wroteTxHash: '0xstillpending',
      }),
    ).rejects.toThrow(/could not confirm/i);
    // Standing down is still right — we cannot confirm the grant is ours,
    // so nothing is written.
    expect(h.writes).toEqual([]);
    expect(h.allowance).toBe(500n);
    // But it must not read as a CLEAN cleanup. Returning null here (the
    // behaviour this test pinned until round 17) is the same value the
    // function returns for "there was nothing to undo", and both callers
    // append their wallet-state warning only on a throw — so the user was
    // shown the generic transaction-failed banner while a payoff-sized
    // approval was still live and might yet mine (#1529 review round 17).
  });
});

describe('restoreAllowance — "could not find out" is never "nothing to undo"', () => {
  /**
   * Round 17 established the rule for the lost-receipt case; round 20
   * found the same conflation on the two reconciliation reads, which had
   * been left on the old footing. In both, a null return would tell
   * `ObligationTransferFlow` / `RefinanceFlow` the cleanup was clean.
   *
   * The line between these and the silent stand-downs is whether the
   * answer is POSITIVE. `contradicted` — a node that demonstrably holds
   * our block saying the value is someone else's now — stays silent, and
   * the round-16 test above still pins that. `unknown` is not an answer.
   */
  it('reports when the write cannot be confirmed at its own block', async () => {
    // Pinned read unavailable (no archive depth) and the live value never
    // matches, so `confirmAllowanceValue` is `unknown`: our approve may
    // or may not be standing, and we cannot tell.
    const h = harness({ allowance: 500n, pinnedReadThrows: true });
    await expect(
      restoreAllowance({
        ...base(h),
        previous: 500n,
        wrote: 1_000n,
        wroteTxHash: '0xmined',
      }),
    ).rejects.toThrow(/could not confirm/i);
    expect(h.writes).toEqual([]);
  });

  it('reports when the present cannot be established after a confirmed write', async () => {
    // Our write IS confirmed at its block, but the head read fails, so
    // `confirmAllowanceStillLive` cannot prove it asked a node holding
    // that block. The live figure read at the outset (250) is not ours,
    // and before round 20 that mismatch quietly returned null — while the
    // payoff-sized approval might be exactly what is standing.
    const h = harness({
      allowance: 250n,
      valueAtReceiptBlock: 1_000n,
      headReadThrows: true,
    });
    await expect(
      restoreAllowance({
        ...base(h),
        previous: 500n,
        wrote: 1_000n,
        wroteTxHash: '0xmined',
      }),
    ).rejects.toThrow(/could not confirm/i);
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
    const seen: (bigint | null)[] = [];
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

describe('a REPLACED transaction is not a successful one (round 11)', () => {
  // viem's `waitForTransactionReceipt` follows replacements. Cancel a
  // pending approve in the wallet — a zero-value self-send at the same
  // nonce — and the wait does not fail: it resolves with the CANCEL's
  // receipt, and that receipt reads `status: 'success'`. Every
  // `status === 'success'` check in this codebase rested on that not
  // happening. Round 10 found it in one approve; round 11 found the same
  // unsound assumption in three more places. These pin the behaviour at
  // both ends of the pair, so the class cannot quietly come back.

  it('ensureAllowance rejects a cancelled approve rather than reporting it granted', async () => {
    const h = harness({ allowance: 0n, replaceTxOf: (v) => v === 1_000n });
    const seen: (bigint | null)[] = [];
    await expect(
      ensureAllowance({ ...base(h), amount: 1_000n, onWrote: (v) => seen.push(v) }),
    ).rejects.toThrow();
    // The allowance never moved…
    expect(h.allowance).toBe(0n);
    // …and the optimistic report was retracted to null, so the unwind is
    // told there is nothing of ours to put back.
    expect(seen).toEqual([1_000n, null]);
    const tx = await restoreAllowance({ ...base(h), previous: 0n, wrote: seen.at(-1)! });
    expect(tx).toBeNull();
  });

  it('restoreAllowance refuses to report a cancelled restore as done', async () => {
    // The mirror case, and the one that costs the user: the flow took a
    // 500 grant down, the unwind's put-back is cancelled in the wallet,
    // and a receipt-only check would return a hash — telling the caller
    // the grant is back while the allowance sits at zero.
    const h = harness({ allowance: 1_000n, replaceTxOf: (v) => v === 500n });
    await expect(
      restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n }),
    ).rejects.toThrow(/cancelled or replaced/);
    // The reset landed; the restore did not. Reported as a failure, which
    // is the point — silence here reads as "your approval is back".
    expect(h.writes).toEqual([0n, 500n]);
    expect(h.allowance).toBe(0n);
  });

  it('restoreAllowance treats OUR replaced write like a revert, not like a stranger', async () => {
    // `ensureAllowance` submitted 1000 and its own receipt wait timed out,
    // so `wrote` stayed at the optimistic 1000. The transaction was then
    // cancelled. The unwind waits on that hash itself: without the hash
    // check it sees `status: 'success'`, concludes 1000 really landed,
    // compares it against the live 0 and walks away — leaving the prior
    // 500 erased. Treating a replacement exactly as it treats a revert is
    // what puts the grant back.
    const h = harness({
      allowance: 500n,
      replaceTxOf: (v) => v === 1_000n,
      receiptThrowsAt: [1],
    });
    let wrote: bigint | null = null;
    let wroteTx: `0x${string}` | null = null;
    let confirmed: bigint | null = null;
    await expect(
      ensureAllowance({
        ...base(h),
        amount: 1_000n,
        onWrote: (v, hsh) => {
          wrote = v;
          wroteTx = hsh;
        },
        onConfirmed: (v) => {
          confirmed = v;
        },
      }),
    ).rejects.toThrow();
    expect(wrote).toBe(1_000n);
    expect(confirmed).toBe(0n);
    expect(h.allowance).toBe(0n);

    await restoreAllowance({
      ...base(h),
      previous: 500n,
      wrote,
      wroteTxHash: wroteTx,
      confirmed,
    });
    expect(h.allowance).toBe(500n);
  });
});

describe('a SPED UP transaction is our own (round 12)', () => {
  // Round 11 fixed "the hash changed" by rejecting every hash change,
  // and in doing so broke Speed Up. viem reports three replacement
  // reasons and only two mean our call was lost: it classifies a
  // replacement `repriced` only when `to`, `value` AND `input` all match
  // the original, which makes it OUR call at a higher gas price. The
  // effect happens. Treating it as failure told a user their approval
  // had not gone through while it sat on chain — a regression introduced
  // by the previous round's fix, which is why it is pinned here.

  it('ensureAllowance accepts a sped-up approve', async () => {
    const h = harness({ allowance: 0n, repriceTxOf: (v) => v === 1_000n });
    const seen: (bigint | null)[] = [];
    const tx = await ensureAllowance({
      ...base(h),
      amount: 1_000n,
      onWrote: (v) => seen.push(v),
    });
    expect(tx).not.toBeNull();
    expect(h.allowance).toBe(1_000n);
    // The VALUE is never retracted. It is re-reported once the receipt
    // names the replacement, to correct the hash — see the round-17 case
    // below — so the same figure appears twice and never becomes null.
    expect(seen).toEqual([1_000n, 1_000n]);
  });

  it('hands the unwind the MINED hash, not the replaced one', async () => {
    // A Speed Up mines under a different hash and providers stop serving
    // the original. The unwind re-waits on whatever hash it was given, so
    // reporting the submitted one leaves it waiting on a transaction the
    // node will never return — it times out and abandons a live
    // payoff-sized allowance (#1529 review round 17).
    const h = harness({ allowance: 0n, repriceTxOf: (v) => v === 1_000n });
    const wroteHashes: (string | null)[] = [];
    let confirmedHash: string | null = null;
    await ensureAllowance({
      ...base(h),
      amount: 1_000n,
      onWrote: (_v, hsh) => {
        wroteHashes.push(hsh);
      },
      onConfirmed: (_v, hsh) => {
        confirmedHash = hsh;
      },
    });
    // Last word wins: whatever the caller holds when the flow fails is
    // what reaches `restoreAllowance` as `wroteTxHash`.
    expect(wroteHashes.at(-1)).toBe('0xfaster');
    expect(confirmedHash).toBe('0xfaster');
  });

  it('restoreAllowance accepts a sped-up put-back', async () => {
    const h = harness({ allowance: 1_000n, repriceTxOf: (v) => v === 500n });
    await restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n });
    expect(h.writes).toEqual([0n, 500n]);
    expect(h.allowance).toBe(500n);
  });
});

describe('a lagging RPC is not evidence that nothing landed (round 12)', () => {
  // A public RPC routinely answers the allowance read taken immediately
  // after a receipt from PRE-transaction state. Reading one stale answer
  // as "the approve did not land" retracts a write that DID land — and
  // the caller's unwind, told nothing was written, then leaves the
  // approval standing. The two are not symmetric: an unknown must never
  // overturn our own successful receipt.

  it('retries past a stale read rather than retracting a mined approve', async () => {
    const h = harness({
      allowance: 0n,
      staleReadsAfterWrite: 2,
      // Force the fallback path: no conclusive pinned answer available.
      pinnedReadThrows: true,
    });
    const seen: (bigint | null)[] = [];
    const tx = await ensureAllowance({
      ...base(h),
      amount: 1_000n,
      onWrote: (v) => seen.push(v),
    });
    expect(tx).not.toBeNull();
    expect(seen).toEqual([1_000n]);
    expect(h.allowance).toBe(1_000n);
  });

  it('an unresolvable read still lets the mined approve stand', async () => {
    // The node never catches up within the budget. We hold a successful
    // receipt for our own approve, so it stands — and crucially the
    // optimistic report is NOT rolled back to null, since a later unwind
    // has to know a write happened in order to reason about it.
    const h = harness({
      allowance: 0n,
      staleReadsAfterWrite: 99,
      pinnedReadThrows: true,
    });
    const seen: (bigint | null)[] = [];
    const tx = await ensureAllowance({
      ...base(h),
      amount: 1_000n,
      onWrote: (v) => seen.push(v),
    });
    expect(tx).not.toBeNull();
    expect(seen).toEqual([1_000n]);
  });

  it('a node that HAS the block is believed when it disagrees', async () => {
    // The conclusive case, and the reason the pinned read exists: asking
    // at the block our transaction mined in, a node either answers about
    // post-transaction state or errors. A disagreement there is real.
    const h = harness({
      allowance: 0n,
      // Mined, then immediately moved by someone else — so the pinned
      // read (which sees live state in this harness) disagrees.
      afterWrite: (v) => (v === 1_000n ? 7n : undefined),
    });
    await expect(
      ensureAllowance({ ...base(h), amount: 1_000n }),
    ).rejects.toThrow(/does not read back as approved/);
  });
});

describe('a cancelled zero-reset is not a competing grant (round 12)', () => {
  it('reports the failure instead of standing down', async () => {
    // The reset is cancelled, so the allowance stays at this flow's own
    // `wrote` value. Round 11 read that as "somebody else owns this now"
    // and returned quietly — leaving the payoff-sized approval live
    // behind a failed handover, which is the opposite of what the unwind
    // was called to do. Nothing else claimed the slot: the value sitting
    // there is ours.
    const h = harness({ allowance: 1_000n, replaceTxOf: (v) => v === 0n });
    // Named as the RESET, not the restore — the two failures leave the
    // wallet in opposite states and the message is an instruction the
    // user is being asked to act on.
    await expect(
      restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n }),
    ).rejects.toThrow(/allowance reset was cancelled or replaced/);
    // The restore was never attempted — correctly, since a zero-first
    // token would revert on it.
    expect(h.writes).toEqual([0n]);
    expect(h.allowance).toBe(1_000n);
  });

  it('still stands down for a genuine competing grant', async () => {
    // The distinction that matters: here the reset DID land and another
    // tab then granted 900. That is a third party's decision to defer
    // to, and the unwind must not overwrite it.
    const h = harness({
      allowance: 1_000n,
      afterWrite: (v) => (v === 0n ? 900n : undefined),
    });
    const tx = await restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n });
    expect(tx).toBeNull();
    expect(h.writes).toEqual([0n]);
    expect(h.allowance).toBe(900n);
  });
});

describe('the two unwind steps report themselves distinctly', () => {
  // `restoreAllowance` sends up to two transactions and they fail into
  // opposite states: a cancelled RESET leaves the flow's oversized
  // approval standing, a cancelled RESTORE leaves the allowance at zero.
  // The message is an instruction the user is being asked to act on, so
  // a shared sentence naming the wrong step is a wrong instruction.

  it('names the restore, not the reset, when the put-back is cancelled', async () => {
    const h = harness({ allowance: 1_000n, replaceTxOf: (v) => v === 500n });
    await expect(
      restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n }),
    ).rejects.toThrow(/allowance restore was cancelled or replaced/);
    // The reset DID land — so unlike the cancelled-reset case, what is
    // left behind is zero rather than the oversized grant.
    expect(h.writes).toEqual([0n, 500n]);
    expect(h.allowance).toBe(0n);
  });
});

describe('history is not the present (round 16)', () => {
  // The reconciliation confirms a pending write by reading PINNED to its
  // receipt block. That answers "did our approve take effect when it
  // mined" — and pinned at our own block the answer stays yes forever,
  // whatever anyone does afterwards. Using it to overwrite the live read
  // marched straight past the guard whose only job is to notice that
  // somebody else owns the allowance now.

  it('does not re-grant over an allowance another tab revoked', async () => {
    // Our approve(1000) mined at the receipt block. Then the user
    // revoked it to zero in another tab. The unwind must leave that
    // alone: putting `previous` back would hand the spender an
    // authorisation the user had just deliberately taken away.
    const h = harness({
      allowance: 0n, // revoked since
      valueAtReceiptBlock: 1_000n, // but ours at the block it mined in
    });
    const tx = await restoreAllowance({
      ...base(h),
      previous: 500n,
      wrote: 1_000n,
      wroteTxHash: '0xok',
    });
    expect(tx).toBeNull();
    expect(h.writes).toEqual([]);
    expect(h.allowance).toBe(0n);
  });

  it('still unwinds when the live value IS ours — the lag case', async () => {
    // The companion, and the reason this cannot simply stand down on any
    // mismatch: here nobody else touched anything. The first read was
    // merely taken before the node caught up, the value is still ours,
    // and the unwind must proceed — otherwise the payoff-sized approval
    // stays live behind a failed flow, which is the round-13 bug.
    const h = harness({ allowance: 1_000n, staleReadsAfterWrite: 0 });
    const tx = await restoreAllowance({
      ...base(h),
      previous: 500n,
      wrote: 1_000n,
      wroteTxHash: '0xok',
    });
    expect(tx).not.toBeNull();
    expect(h.writes).toEqual([0n, 500n]);
    expect(h.allowance).toBe(500n);
  });
});

describe('history cannot clear the restore, on EITHER write (round 18)', () => {
  // Round 16 established the rule on the first write: a read pinned at
  // our own receipt block answers about that block forever, so it can
  // say "our write landed" but never "the value is still ours". These
  // are the two sibling sites where the same confusion survived.

  it('does not put back over a grant that mined after the reset', async () => {
    const h = harness({
      allowance: 1_000n,
      // Another tab's approve MINES in the window between our reset and
      // our restore. Invisible to a read pinned at the reset's own block,
      // and invisible to the pending-nonce check too — it has mined, so
      // pending equals latest again.
      afterWrite: (v) => (v === 0n ? 777n : undefined),
      valueAtReceiptBlock: 0n,
    });
    const tx = await restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n });
    expect(tx).toBeNull();
    // The reset went out; the put-back did NOT.
    expect(h.writes).toEqual([0n]);
    // Their grant survives untouched — the whole point.
    expect(h.allowance).toBe(777n);
  });

  it('restores the reset when the approve after it did not stick', async () => {
    // The zero-first reset landed and was confirmed; the approve after it
    // returned a successful receipt whose value a node holding the block
    // contradicts. `ensureAllowance` throws with `confirmed = 0`, leaving
    // the user's prior grant erased by our own reset — so this is exactly
    // the case the unwind exists for, and it was returning null (read as
    // a clean cleanup by both callers) instead of putting the grant back.
    const h = harness({ allowance: 0n });
    const tx = await restoreAllowance({
      ...base(h),
      previous: 500n,
      wrote: 1_000n,
      wroteTxHash: '0xdead',
      confirmed: 0n,
    });
    expect(tx).not.toBeNull();
    expect(h.writes).toEqual([500n]);
    expect(h.allowance).toBe(500n);
  });
});

describe('a reset that did not stick is not a competing grant (round 21)', () => {
  // The rule round 17 established and round 20 spread to three more sites:
  // an outcome we could not ESTABLISH is never reported as "nothing to
  // undo". Here it is on the last branch still holding the old shape —
  // the live re-check after the zero reset, which read any non-zero value
  // as a third party's grant and stood down silently.

  it('reports a reset undone after its own receipt confirmed it', async () => {
    const h = harness({
      // The reset mines and IS confirmed at its own block — then the
      // allowance is back at our flow's value: reorged out, or a token
      // whose approve returned success without moving anything. The live
      // check is the first read positioned to see it.
      allowance: 1_000n,
      afterWrite: (v) => (v === 0n ? 1_000n : undefined),
      valueAtReceiptBlock: 0n,
    });
    await expect(
      restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n }),
    ).rejects.toThrow(/reset did not take effect/i);
    // The put-back never went out, and the payoff-sized approval is still
    // live — which is exactly why the caller has to be told.
    expect(h.writes).toEqual([0n]);
    expect(h.allowance).toBe(1_000n);
  });

  it('reports it on the unknown-pinned-read route too', async () => {
    // Codex's reported route: the pinned confirmation is unavailable, so
    // `resetLanded` is `unknown` and proceeds on our receipt alone —
    // skipping the earlier re-read entirely. The live check then meets the
    // same predicament with no prior branch having filtered it.
    const h = harness({
      allowance: 1_000n,
      afterWrite: (v) => (v === 0n ? 1_000n : undefined),
      receiptBlockReadThrows: true,
    });
    await expect(
      restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n }),
    ).rejects.toThrow(/reset did not take effect/i);
    expect(h.writes).toEqual([0n]);
  });

  it('still stands down silently for a genuine competing grant', async () => {
    // The case this branch was written for has to keep working: a value
    // that is NOT ours is a positive read of someone else's decision, and
    // deferring to it quietly is right.
    const h = harness({
      allowance: 1_000n,
      afterWrite: (v) => (v === 0n ? 777n : undefined),
      valueAtReceiptBlock: 0n,
    });
    const tx = await restoreAllowance({ ...base(h), previous: 500n, wrote: 1_000n });
    expect(tx).toBeNull();
    expect(h.writes).toEqual([0n]);
    expect(h.allowance).toBe(777n);
  });
});
