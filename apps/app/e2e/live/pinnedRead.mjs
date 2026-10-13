/**
 * Read chain state AT A BLOCK THAT WAS JUST MINED, tolerating a node that
 * has not seen that block yet.
 *
 * A read pinned to a receipt's `blockNumber` is deterministic: the state
 * at a mined block never changes, so asking again can only return the same
 * answer or a first answer. What it cannot rely on is the endpoint knowing
 * the block the moment the receipt arrives. Base Sepolia's public RPC and a
 * keyed provider are both load balanced, and on the #2427 re-run both
 * answered "block not found" / "Request failed" for the claim's block
 * straight after it mined, then answered the same read correctly seconds
 * later. The drive reported UNDETERMINED for a loan that was in exactly the
 * state the check expects.
 *
 * So the failure is retried, and only the failure that means "no answer":
 * whether an error is the chain failing to answer is decided by
 * `isTransportFailure` (one rule, shared with the other drivers), with one
 * exclusion. A revert is the EVM answering, and at a fixed block it would
 * answer the same way every time, so retrying it buys nothing and only
 * delays the report. A defect in this drive (a bad argument, a malformed
 * request) is never transport by that rule and is rethrown at once.
 *
 * The retry is bounded. When it runs out, the last error is rethrown with
 * the attempt count, and the caller reports UNDETERMINED as before: this
 * narrows when the drive gives up, it never turns an unread state into a
 * verdict.
 */
import { classifyRpcFailure, isTransportFailure } from './rpc-verdict.mjs';

export const PINNED_READ_ATTEMPTS = 6;
export const PINNED_READ_DELAY_MS = 3_000;

/** Is this failure worth asking the same pinned question again? */
export function isRetryablePinnedFailure(err) {
  return isTransportFailure(err) && classifyRpcFailure(err) !== 'answered';
}

/**
 * @template T
 * @param {() => Promise<T>} read  the pinned read; called once per attempt
 * @param {{ attempts?: number, delayMs?: number, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function readPinned(read, opts = {}) {
  const attempts = opts.attempts ?? PINNED_READ_ATTEMPTS;
  const delayMs = opts.delayMs ?? PINNED_READ_DELAY_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      if (!isRetryablePinnedFailure(err)) throw err;
      if (attempt >= attempts) {
        err.message = `${err.message} (no answer after ${attempt} attempts, ${delayMs} ms apart)`;
        throw err;
      }
      await sleep(delayMs);
    }
  }
}
