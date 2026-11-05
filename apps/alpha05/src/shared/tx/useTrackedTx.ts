/**
 * The transaction tracker (rulebook §3.2) as a hook: `run()` takes the flow
 * from review through signing and submission to the mined receipt, then
 * MEASURES the outcome by reading the chain back (the caller's `measure`,
 * which returns one leg per effect the receipt was meant to have) and
 * announces the own-state signal so every open tab re-reads (RB-REFRESH).
 * The phase is the only state a page renders; it never shows a receipt as a
 * success. A receipt that cannot be read leaves the flow in
 * `receipt-unknown` with its hash, and `resume()` tracks it again: the
 * transaction may still execute, so the hash is never dropped and no new
 * review is offered until the reader resets with it on screen. When the
 * wallet speeds the transaction up (repriced: the same call), the mined hash
 * is tracked and measured; when it cancels or replaces it with another call,
 * the flow ends `superseded` with both hashes, and the intended effects are
 * not measured, because they did not happen through this transaction.
 * The chain, account and measurement a transaction was SUBMITTED with are
 * kept with its hash, so a resume after the reader switched wallet or
 * network still polls the right chain and measures the sender's positions.
 * The tracker itself lives in the app's transaction store (`txStore`), so
 * none of this is lost when the page showing it unmounts.
 */
import { useCallback } from 'react';
import { useConfig } from 'wagmi';
import { getPublicClient } from 'wagmi/actions';
import type { ReplacementReason, TransactionReceipt } from 'viem';
import { announceOwnChange } from '../reads/signals';
import { refusalFromError } from '../eligibility/refusal';
import { summarize, type LegOutcome } from './outcome';
import { IllegalTransition, transition, type TxEvent } from './track';
import { useTxEntry, useTxStore, type Frozen, type Submission } from './txStore';
import type { TxPhase } from './outcome';

export interface TrackedTxOptions {
  /** The action that owns this tracker, unique in the app ("home.faucet").
   *  The tracker is held in the app's transaction store under it, so it
   *  outlives the page that shows it. */
  key: string;
  chainId: number;
  account: `0x${string}`;
  /** Ask the wallet; resolves with the hash once submitted. */
  send: () => Promise<`0x${string}`>;
  /** Read the chain back after the receipt: one leg per intended effect.
   *  A leg the read-back cannot substantiate is `unknown`, never omitted. */
  measure: (receipt: TransactionReceipt) => Promise<readonly LegOutcome[]>;
}

export interface TrackedTx {
  key: string;
  phase: TxPhase;
  /** What the reader confirmed, from the moment the wallet was asked. */
  frozen: Frozen | null;
  /** From `idle`, `measured`, `failed` or `superseded`: start a review. */
  review: () => void;
  /** From `review`: freeze what was confirmed, sign, submit, wait, measure.
   *  Resolves when measured, failed, or left in `receipt-unknown`. */
  run: (frozen: Frozen) => Promise<void>;
  /** From `receipt-unknown`: wait for the receipt again and measure. */
  resume: () => Promise<void>;
  /** From `review`, `measured`, `failed`, `superseded` or
   *  `receipt-unknown`: back to idle. */
  reset: () => void;
}

export function useTrackedTx(opts: TrackedTxOptions): TrackedTx {
  const store = useTxStore();
  const { key } = opts;
  const entry = useTxEntry(key);
  const config = useConfig();

  // Every transition reads and writes the STORE, never a component's state,
  // so a promise still running after its page unmounted keeps recording.
  const apply = useCallback(
    (event: TxEvent) => {
      const next = transition(store.get(key).phase, event);
      store.update(key, (e) => (next.kind === 'idle' ? { ...e, phase: next, frozen: null, submission: null } : { ...e, phase: next }));
      return next;
    },
    [store, key],
  );

  const review = useCallback(() => void apply({ type: 'review' }), [apply]);
  const reset = useCallback(() => void apply({ type: 'reset' }), [apply]);

  // From `submitted` or `receipt-unknown`: wait for the receipt, then
  // measure. A receipt that cannot be read keeps the hash in the phase.
  const track = useCallback(
    async (hash: `0x${string}`, ctx: Submission) => {
      const client = getPublicClient(config, { chainId: ctx.chainId });
      if (!client) {
        apply({ type: 'receipt-unknown', hash, message: 'No chain client for this network; the transaction was sent and its receipt is not tracked here.' });
        return;
      }
      let receipt: TransactionReceipt;
      let replacement: ReplacementReason | null = null;
      try {
        receipt = await client.waitForTransactionReceipt({ hash, onReplaced: (r) => void (replacement = r.reason) });
      } catch (e) {
        apply({ type: 'receipt-unknown', hash, message: `The receipt could not be read: ${(e as Error).message}` });
        return;
      }
      // Something mined from this account either way: every tab re-reads.
      announceOwnChange({ chainId: ctx.chainId, account: ctx.account, cause: 'receipt' });
      const reason = replacement as ReplacementReason | null;
      if (reason === 'cancelled' || reason === 'replaced') {
        apply({ type: 'superseded', submittedHash: hash, minedHash: receipt.transactionHash, reason, blockNumber: receipt.blockNumber });
        return;
      }
      const mined = apply({
        type: 'mined',
        submittedHash: hash,
        hash: receipt.transactionHash,
        repriced: reason === 'repriced',
        blockNumber: receipt.blockNumber,
        reverted: receipt.status === 'reverted',
      });
      if (mined.kind !== 'mined') return;
      let legs: readonly LegOutcome[];
      try {
        legs = await ctx.measure(receipt);
      } catch (e) {
        legs = [{ status: 'unknown', label: 'outcome', reason: `The read-back failed: ${(e as Error).message}` }];
      }
      apply({ type: 'measured', hash: mined.hash, outcome: summarize(legs, Date.now()) });
    },
    [apply, config],
  );

  const run = useCallback(
    async (frozen: Frozen) => {
      apply({ type: 'sign' });
      store.update(key, (e) => ({ ...e, frozen }));
      let hash: `0x${string}`;
      try {
        hash = await opts.send();
      } catch (e) {
        apply({ type: 'failed', message: refusalFromError(e).reason });
        return;
      }
      const ctx: Submission = { chainId: opts.chainId, account: opts.account, measure: opts.measure };
      store.update(key, (e) => ({ ...e, submission: ctx }));
      apply({ type: 'submitted', hash, at: Date.now() });
      await track(hash, ctx);
    },
    [apply, opts, store, key, track],
  );

  const resume = useCallback(async () => {
    const current = store.get(key);
    // The phase moves to `submitted` synchronously, before the wait, so a
    // second resume or a reset during it is refused by the transition rule.
    const ctx = current.submission;
    if (current.phase.kind !== 'receipt-unknown' || ctx === null) throw new IllegalTransition(current.phase.kind, 'resume');
    apply({ type: 'resume', hash: current.phase.hash });
    await track(current.phase.hash, ctx);
  }, [apply, store, key, track]);

  return { key, phase: entry.phase, frozen: entry.frozen, review, run, resume, reset };
}
