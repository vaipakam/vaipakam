/**
 * Did a failed contract read come back as a REVERT, or did it never get an
 * answer at all?
 *
 * The distinction decides real behaviour and the two are opposite facts: a
 * revert is the chain's authoritative "no" — no such loan, a burned position
 * NFT, a not-claimable side — while a transport failure means nothing was
 * established and the caller must not act as though it had.
 *
 * This lives here because two surfaces need the SAME answer and disagreeing
 * would be worse than either choice. The connected app's Claim Center has
 * always pruned a side whose `ownerOf` reverts while treating a transport
 * failure as unknown; the indexer's #2101 repair needs exactly that rule
 * when deciding whether a position token is burned or merely unreadable
 * (#2190 r6 `4007752763`). An indexer that cleared an owner on a transport
 * blip would hide a live holder's claim; one that never cleared a burned
 * one would keep publishing a claim already taken.
 *
 * It is deliberately NARROW. A related effort (#2107) spent four review
 * rounds trying to classify which failures are futile to RETRY and got it
 * wrong every time, because that predicate is unbounded. This one is not
 * the same question: it asks only whether the node executed the call and
 * answered, which viem models with two concrete error classes.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from 'viem';

/** True when a failed read is a contract REVERT / empty-data (an
 *  authoritative "no") rather than a transport error. */
export function isRevert(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    (e.walk((x) => x instanceof ContractFunctionRevertedError) !== null ||
      e.walk((x) => x instanceof ContractFunctionZeroDataError) !== null)
  );
}
