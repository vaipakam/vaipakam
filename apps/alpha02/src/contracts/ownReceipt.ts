/**
 * Wait for the outcome of the transaction WE sent (#1529 review rounds
 * 10-12).
 *
 * viem's `waitForTransactionReceipt` follows REPLACEMENTS. When a
 * pending transaction is replaced at the same nonce, the wait does not
 * fail — it resolves with the REPLACEMENT's receipt, and for a cancel
 * that receipt reads `status: 'success'`. A transaction that did nothing
 * we asked for therefore presents exactly like one that did, and every
 * `status === 'success'` check in this codebase rested on that not
 * happening.
 *
 * But "the hash changed" is NOT the same as "our call did not happen",
 * and round 11's fix conflated them. viem distinguishes three
 * replacement reasons, and only two of them mean our call was lost:
 *
 *   - `repriced`  — Speed Up. viem classifies it by comparing `to`,
 *                   `value` AND `input` against the original, so the
 *                   replacement IS our call, at a higher gas price. The
 *                   effect happens. Rejecting it told a user their offer
 *                   had failed while it sat live on chain.
 *   - `cancelled` — a zero-value self-send at the same nonce. Our call
 *                   never executed.
 *   - `replaced`  — some different transaction took the nonce. Ours
 *                   never executed either.
 *
 * So the question is not "is this the hash I submitted?" but "did the
 * call I submitted execute?", and the answer carries the reason, because
 * callers act on it differently: a cancel is positive evidence that no
 * side effect exists and an unwind is therefore SAFE, while a lost
 * receipt is an unknown outcome where unwinding may destroy something a
 * counterparty can act on.
 *
 * Where the intended effect is itself cheaply observable — an allowance,
 * an approval flag — prefer reading that as well: state answers "did
 * what I wanted happen?" while a receipt only answers "did my call
 * execute?", and state additionally covers reorgs. See `ensureAllowance`.
 */
import type { PublicClient, TransactionReceipt } from 'viem';

/** Why the submitted call did not take effect. */
export type NotSettledReason =
  /** Replaced by a zero-value self-send at the same nonce. */
  | 'cancelled'
  /** A different transaction took the nonce. */
  | 'replaced'
  /** Our call executed and reverted. */
  | 'reverted';

export type SettledTx =
  | {
      ok: true;
      /** The receipt of the transaction that carried our call — the
       *  REPLACEMENT's when it was sped up, so callers must read logs
       *  and block numbers from here rather than re-fetching by the
       *  submitted hash, which may have no receipt at all. */
      receipt: TransactionReceipt;
      /** Our call, at a higher gas price, under a different hash. */
      repriced: boolean;
    }
  | { ok: false; reason: NotSettledReason; receipt: TransactionReceipt };

export async function settled(
  publicClient: PublicClient,
  hash: `0x${string}`,
): Promise<SettledTx> {
  // A box rather than a bare `let`: TypeScript's control-flow analysis
  // cannot see an assignment made from inside a callback, and narrows
  // the variable to its initializer at every later read.
  const seen: { reason: NotSettledReason | 'repriced' | null } = { reason: null };
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    onReplaced: (r) => {
      seen.reason = r.reason;
    },
  });
  // Belt and braces. `onReplaced` is the authoritative signal, but a
  // receipt under a hash we did not submit and no reason to explain it
  // is not something to wave through — treat the unexplained case as the
  // conservative one.
  const reason: NotSettledReason | 'repriced' | null =
    seen.reason ??
    (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()
      ? 'replaced'
      : null);
  if (reason === 'cancelled' || reason === 'replaced') {
    return { ok: false, reason, receipt };
  }
  // A repriced transaction is still our call, so it can still revert.
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'reverted', receipt };
  }
  return { ok: true, receipt, repriced: reason === 'repriced' };
}

/** Thrown by {@link assertSettled}. Carries the reason so a caller with
 *  a side effect to unwind can tell positive evidence of nothing having
 *  happened (safe to unwind) from an unknown outcome (not safe). */
export class TxNotSettledError extends Error {
  readonly reason: NotSettledReason;
  readonly hash: `0x${string}`;
  constructor(reason: NotSettledReason, hash: `0x${string}`, what: string) {
    super(
      reason === 'reverted'
        ? `${what} reverted (${hash})`
        : `${what} was ${reason === 'cancelled' ? 'cancelled' : 'replaced'}` +
          ` before it took effect (${hash})`,
    );
    this.name = 'TxNotSettledError';
    this.reason = reason;
    this.hash = hash;
  }
}

/** `settled`, raising for the common case where the caller has nothing
 *  to do but report failure. Returns the receipt of the transaction that
 *  carried the call, which for a Speed Up is not the submitted hash. */
export async function assertSettled(
  publicClient: PublicClient,
  hash: `0x${string}`,
  what: string,
): Promise<TransactionReceipt> {
  const r = await settled(publicClient, hash);
  if (!r.ok) throw new TxNotSettledError(r.reason, hash, what);
  return r.receipt;
}
