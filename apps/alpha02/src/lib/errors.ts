/**
 * ONE submit-error mapper for every write flow.
 *
 * Two rules, learned the hard way:
 *  - "User rejected" is detected from viem's error TYPE (walked up the
 *    cause chain) — never from message substrings. The old
 *    `/rejected|denied|cancel/i` regex matched the FUNCTION NAME inside
 *    viem's revert messages, so every pre-mine failure of `cancelOffer`
 *    read as "you cancelled in your wallet".
 *  - Everything else goes through @vaipakam/lib's decodeContractError,
 *    which maps known revert selectors to friendly copy and rewrites
 *    the #780 "exceeds max transaction gas limit" RPC trap.
 */
import { BaseError, UserRejectedRequestError } from 'viem';
import { decodeContractError } from '@vaipakam/lib';
import { copy } from '../content/copy';

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

export function submitErrorText(err: unknown): string {
  if (isUserRejection(err)) return copy.errors.txRejected;
  return decodeContractError(err, copy.errors.txFailed);
}

/** Strict decimal check for amount inputs — exactly what viem's
 *  parseUnits accepts minus signs/exponents ('1e18', '.', 'abc', '0x5'
 *  are all rejected). Use BEFORE enabling any button whose handler
 *  will call parseUnits/parseFloat. */
export function isPlainDecimal(value: string): boolean {
  return /^\d+(\.\d+)?$|^\.\d+$/.test(value);
}

/** True when `value` is a plain decimal AND > 0. */
export function isPositiveDecimal(value: string): boolean {
  return isPlainDecimal(value) && Number(value) > 0;
}
