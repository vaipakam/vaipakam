/**
 * IS THIS RPC FAILURE WORTH ASKING AGAIN? (#2107 rounds 1-3)
 *
 * `writeConfirm.mjs` retries a read until its deadline and then reports
 * that no node would answer. That is the right account of a transport
 * drop, a rate limit or a node that lacks the pinned block. It is the
 * WRONG account of a getter that REVERTED: every node reverts
 * identically, so waiting out the deadline turns a contract regression
 * into a report about the endpoint — the same mislabelling the
 * three-verdict change exists to stop, one layer down.
 *
 * WHAT THIS NO LONGER TRIES TO DO, and why that is the whole point.
 * The first version listed `AbiDecodingZeroDataError`; review produced
 * `AbiDecodingDataSizeTooSmallError`. The second matched viem's
 * `Abi*Error` NAME family; review produced `InvalidBytesBooleanError`,
 * `SliceOffsetOutOfBoundsError` and `SizeExceedsPaddingSizeError`,
 * which are decoding failures that do not carry that name at all. Two
 * rounds, two shapes of the same mistake — which is this repo's
 * recorded signal to fix the seam rather than name another member.
 *
 * So decoding is no longer classified: it is no longer INSIDE the retry
 * boundary. `confirmWrite` fetches the raw reply under the retry and
 * decodes outside it, which makes "a reply that will not decode is never
 * worth retrying" true by construction instead of by enumeration. A
 * decode failure propagates on the spot, and `confirmWriteOrReport`
 * turns it into a named verdict immediately rather than ninety seconds
 * later.
 *
 * What is left here is ONE question — did the node answer with a revert
 * — over classes that have been stable across all three rounds and that
 * no round has produced a new member of. A list of one is not the shape
 * that failed twice.
 *
 * WHICH SIDE IS ENUMERATED is still deliberate. The retryable side is
 * open — transport failures, proxies, rate limiters and provider quirks
 * have no closed list, and a rule whose correctness depends on
 * enumerating an open set is wrong without knowing it (#1995, #2170).
 * Anything unrecognised keeps retrying, exactly as the code did before
 * any of this existed.
 *
 * It lives apart from `writeConfirm.mjs` on purpose. That module makes a
 * decision and imports nothing, so its whole contract is testable
 * without a chain; this one knows one provider's error taxonomy.
 */
import { ContractFunctionRevertedError, RawContractError } from 'viem';

/**
 * Whether asking another node could plausibly give a different answer.
 *
 * @param {unknown} err
 * @returns {boolean} false only for a revert, which every node reproduces.
 */
export function rpcRetryable(err) {
  // viem nests: the revert is normally the cause rather than the
  // outermost error, and `walk` is how it is reached. A plain Error has
  // no `walk`, and an unrecognised shape retries.
  //
  // BOTH classes, because the two read paths surface a revert
  // differently: `readContract` raises `ContractFunctionRevertedError`,
  // while a raw `call` carries `RawContractError`.
  const walk = typeof err?.walk === 'function' ? err.walk.bind(err) : null;
  if (!walk) return true;
  return !walk(
    (e) => e instanceof ContractFunctionRevertedError || e instanceof RawContractError,
  );
}
