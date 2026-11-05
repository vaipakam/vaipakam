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
 */
import { useCallback, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { getPublicClient } from 'wagmi/actions';
import type { ReplacementReason, TransactionReceipt } from 'viem';
import { announceOwnChange } from '../reads/signals';
import { refusalFromError } from '../eligibility/refusal';
import { summarize, type LegOutcome, type TxPhase } from './outcome';
import { IllegalTransition, transition, type TxEvent } from './track';

export interface TrackedTxOptions {
  chainId: number;
  account: `0x${string}`;
  /** Ask the wallet; resolves with the hash once submitted. */
  send: () => Promise<`0x${string}`>;
  /** Read the chain back after the receipt: one leg per intended effect.
   *  A leg the read-back cannot substantiate is `unknown`, never omitted. */
  measure: (receipt: TransactionReceipt) => Promise<readonly LegOutcome[]>;
}

/** What a transaction was submitted with, kept with its hash. */
interface Submission {
  chainId: number;
  account: `0x${string}`;
  measure: TrackedTxOptions['measure'];
}

export interface TrackedTx {
  phase: TxPhase;
  /** From `idle`, `measured`, `failed` or `superseded`: start a review. */
  review: () => void;
  /** From `review`: sign, submit, wait, measure. Resolves when measured,
   *  failed, or left in `receipt-unknown`. */
  run: () => Promise<void>;
  /** From `receipt-unknown`: wait for the receipt again and measure. */
  resume: () => Promise<void>;
  /** From `measured`, `failed`, `superseded` or `receipt-unknown`: back to idle. */
  reset: () => void;
}

export function useTrackedTx(opts: TrackedTxOptions): TrackedTx {
  const [phase, setPhase] = useState<TxPhase>({ kind: 'idle' });
  const phaseRef = useRef(phase);
  const config = useConfig();
  /** The context of the transaction in flight: what it was submitted with. */
  const submittedWith = useRef<Submission | null>(null);

  const apply = useCallback((event: TxEvent) => {
    const next = transition(phaseRef.current, event);
    phaseRef.current = next;
    setPhase(next);
    return next;
  }, []);

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

  const run = useCallback(async () => {
    apply({ type: 'sign' });
    let hash: `0x${string}`;
    try {
      hash = await opts.send();
    } catch (e) {
      apply({ type: 'failed', message: refusalFromError(e).reason });
      return;
    }
    const ctx: Submission = { chainId: opts.chainId, account: opts.account, measure: opts.measure };
    submittedWith.current = ctx;
    apply({ type: 'submitted', hash, at: Date.now() });
    await track(hash, ctx);
  }, [apply, opts, track]);

  const resume = useCallback(async () => {
    const current = phaseRef.current;
    // The phase moves to `submitted` synchronously, before the wait, so a
    // second resume or a reset during it is refused by the transition rule.
    const ctx = submittedWith.current;
    if (current.kind !== 'receipt-unknown' || ctx === null) throw new IllegalTransition(current.kind, 'resume');
    apply({ type: 'resume', hash: current.hash });
    await track(current.hash, ctx);
  }, [apply, track]);

  return { phase, review, run, resume, reset };
}
