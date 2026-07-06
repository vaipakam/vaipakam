/**
 * Shared error-shape helpers for the write flows.
 *
 * Ported from apps/alpha02 (#1031): "user rejected" is detected from
 * viem's error TYPE (walked up the cause chain) — never from message
 * substrings. A `/rejected|denied|cancel/i` regex would match the
 * FUNCTION NAME inside viem's revert messages, so every pre-mine
 * failure of `cancelOffer` would read as "you cancelled in your
 * wallet". A bare top-level `code === 4001` check misses the common
 * case where the provider's rejection is wrapped inside a viem
 * `BaseError` cause chain (e.g. TransactionExecutionError →
 * UserRejectedRequestError).
 */
import { BaseError, UserRejectedRequestError } from 'viem';

export function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError) {
    return (
      err.walk((e) => e instanceof UserRejectedRequestError) !== null ||
      // Some injected providers surface the EIP-1193 code without the
      // viem class — 4001 is "User Rejected Request".
      err.walk((e) => (e as { code?: number })?.code === 4001) !== null
    );
  }
  return (err as { code?: number })?.code === 4001;
}
