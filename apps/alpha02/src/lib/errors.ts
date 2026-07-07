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
import { recordLastError } from '../diagnostics/lastError';

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

/** Flatten a raw error's human-readable text (viem `BaseError` layers +
 *  a plain `{message}`), for signal detection that must run on the RAW
 *  error, before `decodeContractError` rewrites it. */
function rawErrorText(err: unknown): string {
  if (err instanceof BaseError) {
    return [err.shortMessage, err.message, err.details]
      .filter(Boolean)
      .join(' ');
  }
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message ?? '');
  }
  return typeof err === 'string' ? err : '';
}

/** True when the failure is the #780 `eth_estimateGas` gas-cap trap —
 *  the "exceeds max transaction gas limit" RPC artefact that STRIPS the
 *  revert selector, so `submitErrorText` can only surface the generic
 *  gas-trap copy. This is the ONLY case where a pre-sign dry run's
 *  decoded reason is a better banner than the live submit error; a user
 *  rejection or a concrete decoded revert must NEVER be masked by the
 *  advisory sim (#1094 Codex). Keys on the same raw signal
 *  `decodeContractError` matches, not on the rewritten copy. */
export function isGasEstimationTrap(err: unknown): boolean {
  if (isUserRejection(err)) return false;
  return /exceeds max (?:transaction )?gas limit/i.test(rawErrorText(err));
}

/** Format a submit error for the banner AND record it in the diagnostics
 *  sink (the support report), in one call — so "capture every tx error"
 *  holds for every write path, not just offers (#1094 Codex). Every
 *  write-path `catch` should feed its banner through this instead of a
 *  bare `submitErrorText`. Pass `message` to override the banner text
 *  (e.g. a pre-sign dry-run reason) and/or `revertName` to tag the
 *  recorded entry for support; the returned string is always the
 *  user-facing banner message. Recording is best-effort — the sink
 *  swallows storage failures, so this never becomes a crash source. */
export function captureTxError(
  err: unknown,
  opts?: { message?: string; revertName?: string },
): string {
  const message = opts?.message ?? submitErrorText(err);
  recordLastError({
    message: opts?.revertName ? `${message} [${opts.revertName}]` : message,
    path: typeof window !== 'undefined' ? window.location.pathname : 'unknown',
    at: Date.now(),
  });
  return message;
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
