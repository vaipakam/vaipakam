/**
 * The transaction tracker (rulebook §3.2) as a hook: `run()` takes the flow
 * from review through signing and submission to the mined receipt, then
 * MEASURES the outcome by reading the chain back (the caller's `measure`,
 * which returns one leg per effect the receipt was meant to have) and
 * announces the own-state signal so every open tab re-reads (RB-REFRESH).
 * The phase is the only state a page renders; it never shows a receipt as a
 * success.
 */
import { useCallback, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import type { TransactionReceipt } from 'viem';
import { announceOwnChange } from '../reads/signals';
import { refusalFromError } from '../eligibility/refusal';
import { summarize, type LegOutcome, type TxPhase } from './outcome';
import { transition, type TxEvent } from './track';

export interface TrackedTxOptions {
  chainId: number;
  account: `0x${string}`;
  /** Ask the wallet; resolves with the hash once submitted. */
  send: () => Promise<`0x${string}`>;
  /** Read the chain back after the receipt: one leg per intended effect.
   *  A leg the read-back cannot substantiate is `unknown`, never omitted. */
  measure: (receipt: TransactionReceipt) => Promise<readonly LegOutcome[]>;
}

export interface TrackedTx {
  phase: TxPhase;
  /** From `idle`, `measured` or `failed`: start a review. */
  review: () => void;
  /** From `review`: sign, submit, wait, measure. Resolves when measured or failed. */
  run: () => Promise<void>;
  /** From `measured` or `failed`: back to idle. */
  reset: () => void;
}

export function useTrackedTx(opts: TrackedTxOptions): TrackedTx {
  const [phase, setPhase] = useState<TxPhase>({ kind: 'idle' });
  const phaseRef = useRef(phase);
  const client = usePublicClient({ chainId: opts.chainId });

  const apply = useCallback((event: TxEvent) => {
    const next = transition(phaseRef.current, event);
    phaseRef.current = next;
    setPhase(next);
    return next;
  }, []);

  const review = useCallback(() => void apply({ type: 'review' }), [apply]);
  const reset = useCallback(() => void apply({ type: 'reset' }), [apply]);

  const run = useCallback(async () => {
    apply({ type: 'sign' });
    let hash: `0x${string}`;
    try {
      hash = await opts.send();
    } catch (e) {
      apply({ type: 'failed', stage: 'signing', message: refusalFromError(e).reason });
      return;
    }
    apply({ type: 'submitted', hash, at: Date.now() });
    if (!client) {
      apply({ type: 'failed', stage: 'submission', message: 'No chain client for this network; the transaction was sent and its outcome is not tracked here.' });
      return;
    }
    let receipt: TransactionReceipt;
    try {
      receipt = await client.waitForTransactionReceipt({ hash });
    } catch (e) {
      apply({ type: 'failed', stage: 'submission', message: `The receipt could not be read: ${(e as Error).message}` });
      return;
    }
    apply({ type: 'mined', hash, blockNumber: receipt.blockNumber, reverted: receipt.status === 'reverted' });
    announceOwnChange({ chainId: opts.chainId, account: opts.account, cause: 'receipt' });
    let legs: readonly LegOutcome[];
    try {
      legs = await opts.measure(receipt);
    } catch (e) {
      legs = [{ status: 'unknown', label: 'outcome', reason: `The read-back failed: ${(e as Error).message}` }];
    }
    apply({ type: 'measured', hash, outcome: summarize(legs, Date.now()) });
  }, [apply, client, opts]);

  return { phase, review, run, reset };
}
