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
import { useCopy } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import { cleanUpAfterEffect, cleanUpAfterNoEffect } from './cleanUp';
import { summarize, type LegOutcome } from './outcome';
import { readRevertCause, revertSentence, type RevertReader } from './revertCause';
import { IllegalTransition, transition, type TxEvent } from './track';
import { useTxEntry, useTxStore, type Frozen, type Submission } from './txStore';
import { anchoredReader, type AnchoredReader } from './anchored';
import type { OwnStateSource } from '../../chain/ownRail';
import type { TxPhase } from './outcome';

export interface TrackedTxOptions {
  /** The action that owns this tracker, unique in the app ("home.faucet").
   *  The tracker is held in the app's transaction store under it, so it
   *  outlives the page that shows it. */
  key: string;
  chainId: number;
  account: `0x${string}`;
  /** The sender's own-rail sources (`own.sources`): the measurement reads
   *  through these, kept with the hash, so a resume after a switch still
   *  reads the sender's state. */
  sources: readonly OwnStateSource[];
  /** Ask the wallet; resolves with the hash once submitted. */
  send: () => Promise<`0x${string}`>;
  /** Read the chain back after the receipt: one leg per intended effect.
   *  Every read goes through `at`, pinned to the receipt's block, never
   *  through a client at "latest" (a lagging node would answer with the
   *  state from before the transaction). A leg the read-back cannot
   *  substantiate is `unknown`, never omitted. Not called for a reverted
   *  receipt: that transaction changed nothing, so nothing the chain shows
   *  afterwards (another transaction's work) can be read as its outcome. */
  measure: (receipt: TransactionReceipt, at: AnchoredReader) => Promise<readonly LegOutcome[]>;
  /** Undo what `send` left standing before the submitted call (an approval
   *  the call would have used), run by the tracker whenever that call did
   *  NOT take effect: the receipt reverted, or the wallet cancelled or
   *  replaced the transaction. Resolves with a leg saying what was put back
   *  or why it was not, or null when nothing was left standing. One seam,
   *  so no ending of the transaction can skip the clean-up. */
  unwind?: () => Promise<LegOutcome | null>;
  /** Take back what `send` granted for the call alone (an ERC-1155
   *  operator approval, which covers the whole collection and which no
   *  transfer clears), run by the tracker on EVERY ending the receipt
   *  settles: after the measurement when the call took effect, and after
   *  `unwind` when it did not. Resolves with a leg saying what was taken
   *  back or why it was not, or null when nothing was granted. */
  release?: () => Promise<LegOutcome | null>;
  /** Read once `send` returns: what it set up for the call that stands
   *  until the call settles and `release` runs, as the page says it (kept
   *  with the hash, shown while the receipt is pending or unknown). */
  held?: () => string | null;
}

export interface TrackedTx {
  key: string;
  phase: TxPhase;
  /** What the reader confirmed, from the moment the wallet was asked. */
  frozen: Frozen | null;
  /** The wallet step the flow is asking for now (set with `useTxNote`). */
  note: string | null;
  /** What stands until the submitted call settles (`TrackedTxOptions.held`). */
  held: string | null;
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
  const { text, format } = useCopy();

  // Every transition reads and writes the STORE, never a component's state,
  // so a promise still running after its page unmounted keeps recording.
  const apply = useCallback(
    (event: TxEvent) => {
      const next = transition(store.get(key).phase, event);
      store.update(key, (e) => (next.kind === 'idle' ? { ...e, phase: next, frozen: null, submission: null, note: null } : { ...e, phase: next }));
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
        const unwound = await cleanUpAfterNoEffect(ctx);
        apply({ type: 'superseded', submittedHash: hash, minedHash: receipt.transactionHash, reason, blockNumber: receipt.blockNumber, unwound });
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
      if (receipt.status === 'reverted') {
        // Reverted: one leg saying it changed nothing, whatever the chain
        // now shows, plus what the flow's clean-up put back.
        // Why, where the chain lets it be read (#3482): the gas spent, or a
        // replay on the state before its block. It explains; it never
        // changes the verdict.
        const cause = await readRevertCause(client as unknown as RevertReader, receipt);
        legs = [{ status: 'not-done', label: text('flow.revertedLabel'), reason: `${text('flow.reverted')} ${revertSentence(cause, format)}` }];
        legs = [...legs, ...(await cleanUpAfterNoEffect(ctx))];
      } else {
        try {
          legs = await ctx.measure(receipt, anchoredReader(ctx.sources, receipt.blockNumber));
        } catch (e) {
          legs = [{ status: 'unknown', label: 'outcome', reason: `The read-back failed: ${(e as Error).message}` }];
        }
        legs = [...legs, ...(await cleanUpAfterEffect(ctx))];
      }
      apply({ type: 'measured', hash: mined.hash, outcome: summarize(legs, Date.now()) });
    },
    [apply, config, text, format],
  );

  const run = useCallback(
    async (frozen: Frozen) => {
      apply({ type: 'sign' });
      store.update(key, (e) => ({ ...e, frozen, note: null }));
      let hash: `0x${string}`;
      try {
        hash = await opts.send();
      } catch (e) {
        apply({ type: 'failed', message: refusalFromError(e).reason });
        return;
      }
      const ctx: Submission = {
        chainId: opts.chainId,
        account: opts.account,
        sources: opts.sources,
        measure: opts.measure,
        unwind: opts.unwind,
        release: opts.release,
        held: opts.held?.() ?? null,
      };
      // The send's own steps are over; a clean-up after the hash names its own.
      store.update(key, (e) => ({ ...e, submission: ctx, note: null }));
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

  return { key, phase: entry.phase, frozen: entry.frozen, note: entry.note, held: entry.submission?.held ?? null, review, run, resume, reset };
}
