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
import i18n from 'i18next';
import { BaseError, UserRejectedRequestError } from 'viem';
import { decodeContractError, extractRevertSelector } from '@vaipakam/lib';
import { copy } from '../content/copy';
import { recordLastError } from '../diagnostics/lastError';

/**
 * Localize a decoded contract-revert message. `@vaipakam/lib` owns the English
 * copy and hands us a STABLE key (the Solidity error name, or selector hex) +
 * that English; we override it from the active locale's `contractError.<key>`
 * bundle entry, falling back to the English default when a locale hasn't
 * translated it (or before i18next is ready). The keys are seeded into the
 * translators' `en.json` template from the lib catalog by the i18n:template
 * exporter — the English is NOT duplicated into copy.ts.
 */
export const translateContractError = (key: string, english: string): string =>
  i18n.isInitialized
    ? (i18n.t(`contractError.${key}`, { defaultValue: english }) as string)
    : english;

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
  return decodeContractError(err, {
    fallback: copy.errors.txFailed,
    translate: translateContractError,
  });
}

/** Flatten a raw error's human-readable text for signal detection that
 *  must run on the RAW error, before `decodeContractError` rewrites it.
 *  Walks the whole error graph — viem `BaseError` layers AND the nested
 *  provider shapes an injected wallet surfaces, e.g.
 *  `{ data: { message: 'exceeds max transaction gas limit' },
 *     message: 'Internal JSON-RPC error.' }` — so a gas-cap signal buried
 *  in `data.message` isn't missed (#1094 Codex). Mirrors the fields
 *  `decodeContractError` reads (`data.message`, `error.data`, the cause
 *  chain). Bounded depth + a seen-set guard against cyclic error graphs. */
function rawErrorText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number): void => {
    if (v == null || depth > 5) return;
    if (typeof v === 'string') {
      parts.push(v);
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    const o = v as Record<string, unknown>;
    // `reason` included: `decodeContractError` treats it as the PRIMARY text,
    // so a gas-cap signal a provider puts there must be seen here too (#1094).
    for (const k of ['reason', 'shortMessage', 'message', 'details'] as const) {
      if (typeof o[k] === 'string') parts.push(o[k] as string);
    }
    for (const k of ['data', 'error', 'cause', 'info'] as const) {
      if (o[k] != null) visit(o[k], depth + 1);
    }
  };
  visit(err, 0);
  return parts.join(' ');
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
  // A decodable revert selector ANYWHERE means the estimator did NOT strip it:
  // a real revert (which decodeContractError surfaces with concrete copy), NOT
  // the #780 gas-cap trap, even if the wrapper text also mentions the gas
  // limit. `extractRevertSelector` now walks the viem cause chain + nested
  // `data.data` / `.raw`, so this single check covers the deep shapes without
  // a parallel walker here (#1094 Codex).
  if (extractRevertSelector(err)) return false;
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
    // pathname + search — the deep-link state (?offer=, ?chain=) is the
    // reproducer support needs, and the rest of the diagnostics flow
    // (ErrorBoundary, the report builder) already records pathname+search.
    // The report builder redacts + caps this before anything leaves the
    // device (#1094 Codex).
    message: opts?.revertName ? `${message} [${opts.revertName}]` : message,
    path:
      typeof window !== 'undefined'
        ? window.location.pathname + window.location.search
        : 'unknown',
    at: Date.now(),
  });
  return message;
}

/** viem error names that mean the request never got a usable answer out
 *  of the node — the transport itself failed, so NOTHING can be
 *  concluded about the contract that was asked. */
const TRANSPORT_ERROR_NAMES = new Set([
  'HttpRequestError',
  'TimeoutError',
  'SocketClosedError',
  'WebSocketRequestError',
]);

/**
 * Did the NETWORK fail to ask, as opposed to the contract answering
 * something we couldn't use (Codex #1547 r15)?
 *
 * This is the discriminator for OPTIONAL reads — a call whose failure
 * has a safe fallback (an ERC-20 without `symbol()`, a token whose
 * `symbol()` returns `bytes32` instead of the ABI `string`). Anything
 * the node actually answered — a revert, empty data, or data the ABI
 * decoder chokes on — means the contract is what it is, and the caller
 * may take its fallback. A TRANSPORT failure proves nothing: taking a
 * fallback on it is how a passing RPC error once made an ordinary
 * 18-decimal token parse as raw base units, so a user who typed `1`
 * would have signed for a single base unit. Callers must fail the read
 * (and let the user retry) when this returns true.
 *
 * Detection mirrors `isUserRejection`: viem's stable error `name`
 * walked down the cause chain, never `instanceof`, because a pnpm
 * workspace can resolve more than one physical copy of viem.
 */
export function isTransportFailure(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; node != null && depth < 8; depth += 1) {
    if (typeof node !== 'object') break;
    const o = node as { name?: unknown; cause?: unknown };
    if (typeof o.name === 'string' && TRANSPORT_ERROR_NAMES.has(o.name)) {
      return true;
    }
    node = o.cause;
  }
  return false;
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
