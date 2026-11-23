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
 * - `indexer`: only the indexer was asked, and it failed. `reference` is
 *   null when nothing answered (a network failure or timeout).
 * - `chain`: only the chain was asked, and it failed.
 * - `both`: the indexer failed and the chain fallback failed too. A hook
 *   whose fallback SUCCEEDED shows no unavailable state, so it has no
 *   failure to report.
 *
 * Memory only: never written to browser storage, never to the app's error
 * record.
 */
import { BaseError, ContractFunctionRevertedError } from 'viem';

export type FailedRead =
  | { source: 'indexer'; reference: string | null }
  | { source: 'chain' }
  | { source: 'both'; indexerReference: string | null };

/** Told the reference of a failed indexer read (null when nothing answered). */
export type IndexerFailureSink = (reference: string | null) => void;

/**
 * The failures of ONE read, which may make several indexer requests (pages,
 * two endpoints): the first failure's reference is the one kept, since any
 * one failed request makes the whole read unavailable.
 */
export class ReadFailures {
  private failed = false;
  private reference: string | null = null;

  /** Pass to every indexer fetch the read makes. */
  readonly indexer: IndexerFailureSink = (reference) => {
    if (this.failed) return;
    this.failed = true;
    this.reference = reference;
  };

  get indexerFailed(): boolean {
    return this.failed;
  }

  /** The failure to show for an unavailable result. `chainFailed`: the chain
   *  was asked and failed. Null when no request failed (for example a build
   *  with no indexer, which made no request). */
  verdict(chainFailed: boolean): FailedRead | null {
    if (this.failed && chainFailed) return { source: 'both', indexerReference: this.reference };
    if (this.failed) return { source: 'indexer', reference: this.reference };
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
