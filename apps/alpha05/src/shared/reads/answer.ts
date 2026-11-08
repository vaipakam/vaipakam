/**
 * The one rule for a contract read that may legitimately have no answer
 * (RB-RAILS): a revert, or no data where a view was expected, is the
 * contract's own answer and comes back `null`, said unread or absent by the
 * caller; any other failure (the source timed out, refused, rate-limited)
 * is thrown, so the own rail moves on to its next source instead of
 * settling on one that could not answer at all.
 */
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from 'viem';

/** Whether an error is the contract's own answer (a revert, or no code /
 *  no data where a view was expected), as opposed to a read that failed. */
export function isContractAnswer(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  return e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError) !== null;
}

/** `p`'s value, `null` when the contract answered with a revert, and a
 *  thrown error when the source itself failed. */
export async function answerOrNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (isContractAnswer(e)) return null;
    throw e;
  }
}
