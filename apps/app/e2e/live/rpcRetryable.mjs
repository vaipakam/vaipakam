/**
 * IS THIS RPC FAILURE WORTH ASKING AGAIN? (#2107 round 1)
 *
 * `writeConfirm.mjs` retries a read until its deadline and then reports
 * that no node would answer. That is the right account of a transport
 * drop, a rate limit or a node that lacks the pinned block. It is the
 * WRONG account of a getter that reverted or a payload that would not
 * decode: every node returns those identically, so waiting out the
 * deadline turns a contract or ABI regression into a report about the
 * endpoint — the same mislabelling the three-verdict change exists to
 * stop, one layer down.
 *
 * WHICH SIDE IS ENUMERATED, and why that way round. The retryable side
 * is open — transport failures, proxies, rate limiters and provider
 * quirks have no closed list, and a rule whose correctness depends on
 * enumerating an open set is wrong without knowing it (the lesson
 * #1995 and #2170 both recorded). The DETERMINISTIC side is small and
 * named by viem: a contract-level revert, and a decode of empty return
 * data. Anything unrecognised keeps retrying, which is exactly what the
 * code did before this existed, so an unknown error is no worse off
 * than it was and the two named classes stop being laundered.
 *
 * It lives apart from `writeConfirm.mjs` on purpose. That module makes
 * a decision and imports nothing, so its whole contract is testable
 * without a chain; this one knows one provider's error taxonomy. Mixing
 * them would put viem inside the decision and make the decision
 * untestable without it.
 */
import { AbiDecodingZeroDataError, ContractFunctionRevertedError } from 'viem';

/**
 * Whether asking another node could plausibly give a different answer.
 *
 * @param {unknown} err
 * @returns {boolean} false only for failures every node reproduces.
 */
export function rpcRetryable(err) {
  // viem nests the cause chain, so the revert is rarely the outermost
  // error — `walk` is how it is reached. A plain Error has no `walk`,
  // and an unrecognised shape retries.
  const walk = typeof err?.walk === 'function' ? err.walk.bind(err) : null;
  if (!walk) return true;
  if (walk((e) => e instanceof ContractFunctionRevertedError)) return false;
  if (walk((e) => e instanceof AbiDecodingZeroDataError)) return false;
  return true;
}
