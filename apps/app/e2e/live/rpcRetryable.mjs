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
 * #1995 and #2170 both recorded). The DETERMINISTIC side is the one
 * worth naming. Anything unrecognised keeps retrying, which is exactly
 * what the code did before this existed, so an unknown error is no
 * worse off than it was.
 *
 * AND THE ABI SIDE IS NAMED BY FAMILY, NOT BY CLASS — which is the
 * second attempt at this and the reason for the first one's failure.
 * The first listed `AbiDecodingZeroDataError`, and review immediately
 * produced `AbiDecodingDataSizeTooSmallError`, which a `0x01` reply for
 * a `uint256` raises (#2107 round 2). viem exports SEVENTEEN `Abi*Error`
 * classes and gives them no common ancestor — every one extends
 * `BaseError` directly — so an `instanceof` list is open by
 * construction and would have grown by one per review round. That is
 * the seam this repo's round-cap directive says to fix at the root
 * rather than patch again.
 *
 * The family is closed by viem's own naming: an error whose name
 * matches `Abi…Error` is about the shape of an ABI or of a reply
 * decoded against it, which is a function of the ABI and the bytes and
 * not of which node answered. All seventeen qualify.
 *
 * A name test is only as good as the convention it trusts, so it is not
 * trusted silently: `rpcRetryable.test.mjs` enumerates every `Abi*Error`
 * viem actually exports and requires each to be classified
 * deterministic. If viem renames one or adds one outside the
 * convention, that fails loudly instead of the classifier quietly
 * retrying it for ninety seconds.
 *
 * It lives apart from `writeConfirm.mjs` on purpose. That module makes
 * a decision and imports nothing, so its whole contract is testable
 * without a chain; this one knows one provider's error taxonomy. Mixing
 * them would put viem inside the decision and make the decision
 * untestable without it.
 */
import { ContractFunctionRevertedError } from 'viem';

/** viem's ABI-shape errors, by the convention it names them under.
 *  Anchored at both ends so it cannot match a name that merely
 *  CONTAINS one — `NotAnAbiErrorAtAll` is not a member. */
export const ABI_ERROR_NAME = /^Abi[A-Za-z]*Error$/;

/**
 * Whether asking another node could plausibly give a different answer.
 *
 * @param {unknown} err
 * @returns {boolean} false only for failures every node reproduces.
 */
export function rpcRetryable(err) {
  // viem nests: the deterministic error is normally the cause rather
  // than the outermost error, and `walk` is how it is reached. A plain
  // Error has no `walk`, and an unrecognised shape retries.
  const walk = typeof err?.walk === 'function' ? err.walk.bind(err) : null;
  if (!walk) return true;
  return !walk(
    (e) => e instanceof ContractFunctionRevertedError || ABI_ERROR_NAME.test(String(e?.name ?? '')),
  );
}
