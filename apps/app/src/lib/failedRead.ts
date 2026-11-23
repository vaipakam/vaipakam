/**
 * What a failed read can be quoted by (#3922, design option A).
 *
 * A read the app shows as unavailable came from one or two sources: the
 * indexer, whose answer carries a request reference (the indexer makes one
 * for every read, and keeps it in its log line and service error record),
 * and the chain, read through a node that gives none. So an unavailable
 * state says which source failed, shows the indexer's reference when it has
 * one, and says plainly when there is none, rather than leaving it blank.
 *
 * - `indexer`: only the indexer was asked, and it failed. Whether a
 *   response arrived is kept apart from whether it carried a reference, so
 *   an answer without one never reads as no answer.
 * - `chain`: only the chain was asked, and it failed.
 * - `both`: the indexer failed and the chain fallback failed too. A hook
 *   whose fallback SUCCEEDED shows no unavailable state, so it has no
 *   failure to report.
 *
 * Memory only: never written to browser storage, never to the app's error
 * record.
 */
import { BaseError, ContractFunctionRevertedError } from 'viem';

/** How a failed indexer request ended. `answered`: a response arrived (an
 *  error status, or a body that was not JSON), as against no response at
 *  all (a network failure or timeout). `reference`: the reference that
 *  response carried, null when it carried no valid one or none arrived. */
export interface IndexerFailure {
  readonly answered: boolean;
  readonly reference: string | null;
}

export type FailedRead =
  | { source: 'indexer'; indexer: IndexerFailure }
  | { source: 'chain' }
  | { source: 'both'; indexer: IndexerFailure };

/** Told how a failed indexer request ended. */
export type IndexerFailureSink = (failure: IndexerFailure) => void;

/**
 * The failures of ONE read, which may make several indexer requests (pages,
 * two endpoints): the first failure's reference is the one kept, since any
 * one failed request makes the whole read unavailable.
 */
export class ReadFailures {
  private first: IndexerFailure | null = null;

  /** Pass to every indexer fetch the read makes. */
  readonly indexer: IndexerFailureSink = (failure) => {
    if (this.first) return;
    this.first = { answered: failure.answered, reference: failure.reference };
  };

  get indexerFailed(): boolean {
    return this.first !== null;
  }

  /** The failure to show for an unavailable result. `chainFailed`: the chain
   *  was asked and failed. Null when no request failed (for example a build
   *  with no indexer, which made no request). */
  verdict(chainFailed: boolean): FailedRead | null {
    if (this.first && chainFailed) return { source: 'both', indexer: this.first };
    if (this.first) return { source: 'indexer', indexer: this.first };
    if (chainFailed) return { source: 'chain' };
    return null;
  }
}

/** A query result that is unavailable, with what failed. Cached in place of
 *  `null` so the failure travels with the result; hooks unwrap it back to
 *  `null` (see {@link unwrapRead}), so callers keep the null contract. */
export interface UnavailableRead {
  readonly unavailable: FailedRead | null;
}

export function unavailable(failed: FailedRead | null): UnavailableRead {
  return { unavailable: failed };
}

function isUnavailable(v: unknown): v is UnavailableRead {
  return typeof v === 'object' && v !== null && 'unavailable' in v && Object.keys(v).length === 1;
}

/** Split a cached result into the caller's value (`null` when unavailable)
 *  and what failed. */
export function unwrapRead<T>(data: T | UnavailableRead | undefined): {
  data: T | null | undefined;
  failedRead: FailedRead | null;
} {
  if (data === undefined) return { data: undefined, failedRead: null };
  if (isUnavailable(data)) return { data: null, failedRead: data.unavailable };
  return { data: data as T, failedRead: null };
}

/** True when a chain read REVERTED: the chain answered (for example, no such
 *  loan), so it is not a failed read. Any other error is a failed read. */
export function chainAnswered(e: unknown): boolean {
  return e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null;
}
