/**
 * Normalises the grab-bag of error shapes thrown by ethers + injected wallets
 * into a single user-facing string. Order of precedence:
 *
 *   1. `reason`   — ethers decodes this from the revert data for named errors.
 *   2. `shortMessage` — ethers v6 fallback when reason isn't available.
 *   3. `data.message` — some wallets nest the RPC error under `data`.
 *   4. `message`  — last resort; raw JS Error text.
 *   5. `fallback` — caller-supplied default when nothing above is present.
 *
 * Keep this tight: pages should not need to reach into `err?.reason || ...`
 * ladders at the call site anymore.
 */

import {
  ERROR_CATALOGUE,
  errorsByName,
  type ErrorCatalogueRow,
} from '@vaipakam/contracts/error-catalogue';
import {
  extractRevertData,
  extractRevertName,
  extractRevertSelector,
  type DecodableError,
} from './revertData';

// The revert-byte readers live in `./revertData`, which needs no catalogue, so
// a Node consumer (the e2e driver) can read revert bytes without loading the
// catalogue's JSON. Re-exported so existing imports keep working.
export { extractRevertData, extractRevertName, extractRevertSelector };
export type { DecodableError };


/**
 * Every contract error's copy comes from ONE place: the error catalogue in
 * `@vaipakam/contracts/error-catalogue` (#3916). It is generated from the
 * shipped interfaces (so every selector the platform can raise resolves to its
 * name) and from the hand-written `packages/contracts/errors/meanings.json`
 * (the plain message, who can act, whether the error is internal). The two
 * hand-kept tables this file used to carry (selector-keyed and name-keyed
 * copy, plus a hand-transcribed selector list guarded by a drift test) moved
 * there; apps keep only their translations, keyed as {@link contractErrorKey}
 * says.
 */
const ERROR_STRING_SELECTOR = '0x08c379a0';

/** Selector → `Name(types)` for every catalogued error but `Error(string)`
 *  (whose human text is the reason itself, carried in the base message). */
export const KNOWN_ERROR_SELECTORS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ERROR_CATALOGUE)
    .filter(([sel]) => sel !== ERROR_STRING_SELECTOR)
    .map(([sel, row]) => [sel, row.signature]),
);

/** Stable key + English copy for an INTERNAL error: one the catalogue marks as
 *  "should be impossible". It is shown as a fault of the platform, never as
 *  something the user did. */
export const INTERNAL_FAULT_KEY = '_internalFault';
const INTERNAL_FAULT_MESSAGE =
  'Something went wrong inside the platform. This is not something you did, ' +
  'and nothing was done. Please report it and share the diagnostics export ' +
  'with support.';

/**
 * Turn a PascalCase Solidity error name into a readable sentence fragment —
 * `MaxLendingAboveCeiling` → `Max lending above ceiling`. Used as the
 * universal fallback so an error with no curated copy is still legible
 * instead of a raw `Foo() (0x…)` / hex blob.
 */
export function humanizeErrorName(name: string): string {
  const words = name
    // split camel/Pascal boundaries, keeping acronym runs (HF, LTV, NFT, KYC)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/);
  // Sentence case: capitalise the first word, lower-case the rest, but keep
  // all-caps acronyms (HF, LTV, NFT, KYC) intact so they stay legible.
  return words
    .map((w, i) => {
      const isAcronym = w.length > 1 && w === w.toUpperCase();
      if (isAcronym) return w;
      if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      return w.toLowerCase();
    })
    .join(' ');
}

/**
 * Localizer hook: given a resolved error's STABLE key and its English copy,
 * return the display string (localized, or the English as-is). Passed in by a
 * frontend that wants translated revert copy; omitted everywhere else so the
 * decoder stays English-by-default (keeper bot, tests, servers). The English
 * text has one source, the error catalogue; an app localizes by key, it
 * does NOT re-list these strings.
 */
export type ContractErrorTranslator = (key: string, english: string) => string;

/** How many signatures each error name has across the catalogue. */
const SIGNATURES_PER_NAME: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (const row of Object.values(ERROR_CATALOGUE)) m.set(row.name, (m.get(row.name) ?? 0) + 1);
  return m;
})();

/**
 * The stable translation key of a catalogued error: its NAME when only one
 * error carries that name (readable, and unchanged by a parameter edit), else
 * its full signature, so two errors that share a name but mean different
 * things never share a translation.
 */
function contractErrorKey(row: ErrorCatalogueRow): string {
  return (SIGNATURES_PER_NAME.get(row.name) ?? 1) > 1 ? row.signature : row.name;
}

/** The catalogue row for a selector and/or a decoded name. A name with
 *  several signatures resolves only when they all carry the same copy. A
 *  caller that words a refusal itself reads `internal` here, so a fault of
 *  the platform is never presented as a refusal of the user's step. */
export function contractErrorRow(opts: { name?: string; selector?: string }): ErrorCatalogueRow | undefined {
  const sel = opts.selector?.toLowerCase();
  if (sel && sel !== ERROR_STRING_SELECTOR) {
    const row = ERROR_CATALOGUE[sel];
    if (row) return row;
  }
  if (!opts.name || opts.name === 'Error') return undefined;
  const rows = errorsByName(opts.name).map(([, r]) => r);
  if (rows.length === 1) return rows[0];
  if (rows.length > 1 && rows.every((r) => r.message === rows[0]!.message && !!r.internal === !!rows[0]!.internal)) return rows[0];
  return undefined;
}

/**
 * Resolve friendly copy + its stable key from an error NAME and/or 4-byte
 * selector, through the catalogue: an internal error gets the platform-fault
 * copy, an error with a written message gets that, any other catalogued error
 * its name turned into words, and a name the catalogue does not know its name
 * turned into words too. Returns `null` when nothing resolves (the caller
 * falls back to its own default).
 */
function resolveFriendly(opts: {
  name?: string;
  selector?: string;
}): { key: string; message: string } | null {
  const row = contractErrorRow(opts);
  if (row) {
    if (row.internal) return { key: INTERNAL_FAULT_KEY, message: INTERNAL_FAULT_MESSAGE };
    return { key: contractErrorKey(row), message: row.message ?? humanizeErrorName(row.name) };
  }
  if (opts.name && opts.name !== 'Error') return { key: opts.name, message: humanizeErrorName(opts.name) };
  return null;
}

/**
 * Resolve friendly copy from an error NAME and/or 4-byte selector. Returns
 * curated copy when available, else a humanized sentence from the name, else
 * `null` (caller falls back to its own default).
 *
 * Pass `translate` to localize the same way {@link decodeContractError} does —
 * it receives the resolved stable key + English copy. Omit it (the default)
 * for the English string. Used by the pre-sign simulation footer so its
 * friendly revert copy localizes alongside the submit-error banner.
 */
export function friendlyContractError(
  opts: { name?: string; selector?: string },
  translate?: ContractErrorTranslator,
): string | null {
  const r = resolveFriendly(opts);
  if (!r) return null;
  return translate ? translate(r.key, r.message) : r.message;
}

/**
 * Every contract-error string a translator should see, keyed by its STABLE
 * translation key — the source a frontend seeds its locale template from, so
 * the English lives in the catalogue ONCE and apps localize by key via the
 * `translate` hook.
 *
 * It holds: every catalogued error with a written message; every error the
 * catalogue marks `shownByName` (users reach it, and it still shows its name
 * turned into words, so that text must be translatable); the platform-fault
 * copy for internal errors; and the #780 gas-estimate rewrite. Any other
 * catalogued error resolves at runtime to its name turned into words, in
 * English, until it is given a message.
 */
export function contractErrorCatalog(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of Object.values(ERROR_CATALOGUE)) {
    if (row.internal) continue;
    if (row.message) out[contractErrorKey(row)] = row.message;
    else if (row.shownByName) out[contractErrorKey(row)] = humanizeErrorName(row.name);
  }
  out[INTERNAL_FAULT_KEY] = INTERNAL_FAULT_MESSAGE;
  out[GAS_ESTIMATE_UNAVAILABLE_KEY] = GAS_ESTIMATE_UNAVAILABLE_MESSAGE;
  return out;
}

/** Maps a 4-byte selector to a human-readable error name (e.g. `NFTMintFailed()`). */
export function namedRevertSelector(err: unknown): string | undefined {
  const sel = extractRevertSelector(err);
  if (!sel) return undefined;
  const name = KNOWN_ERROR_SELECTORS[sel];
  return name ? `${name} (${sel})` : sel;
}

/** Stable key + English copy for the #780 gas-estimate rewrite below, so it
 *  can be localized (via the `translate` hook) and seeded into an app's
 *  locale template alongside the curated selector/name copy. */
export const GAS_ESTIMATE_UNAVAILABLE_KEY = '_gasEstimateUnavailable';
const GAS_ESTIMATE_UNAVAILABLE_MESSAGE =
  'The wallet could not estimate this transaction, so it would most ' +
  'likely fail if signed. This is NOT a real gas shortage — if the ' +
  'review step flagged a specific reason, that is the actual cause. ' +
  'Otherwise the usual causes are a missing token approval (approve the ' +
  'exact amount and retry) or a stale app build whose call shape no ' +
  'longer matches the deployed contract (hard-reload to load the latest ' +
  'version). If it persists, share the diagnostics export with support.';

/** Options for {@link decodeContractError}. Passing a bare string keeps the
 *  historical `decodeContractError(err, 'fallback')` signature working. */
export interface DecodeContractErrorOptions {
  /** Generic message when nothing decodes. Default `'Transaction failed'`. */
  fallback?: string;
  /** Localizer for curated revert copy (see {@link ContractErrorTranslator}).
   *  Omit → English is returned unchanged (default for every non-frontend
   *  caller). */
  translate?: ContractErrorTranslator;
}

export function decodeContractError(
  err: unknown,
  fallbackOrOptions: string | DecodeContractErrorOptions = 'Transaction failed',
): string {
  const opts: DecodeContractErrorOptions =
    typeof fallbackOrOptions === 'string' ? { fallback: fallbackOrOptions } : fallbackOrOptions;
  const fallback = opts.fallback ?? 'Transaction failed';
  // Route curated copy through the caller's localizer when present, else
  // return the English as-is. The stable key drives the locale override.
  const localize = (key: string, english: string): string =>
    opts.translate ? opts.translate(key, english) : english;

  if (!err || typeof err !== 'object') return fallback;
  const e = err as DecodableError;

  // Prefer a human-friendly message when the revert selector is known. This
  // takes precedence over ethers' raw "unknown custom error" text so users
  // see "Insufficient token balance" instead of a hex blob. `resolveFriendly`
  // returns the curated SELECTOR copy first, then the name-keyed copy /
  // humanized fallback for any selector we can resolve to a known name — a
  // decodable custom-error selector is always more informative than the raw
  // `base` revert text ("execution reverted" / "unknown custom error 0x…").
  // Guarded on an actual selector so genuine Error(string) reverts (whose
  // human text lives in `base`) and the #780 gas-limit trap below are
  // untouched.
  const sel = extractRevertSelector(err);
  if (sel) {
    const r = resolveFriendly({ selector: sel });
    if (r) return localize(r.key, r.message);
  }

  // viem/libraries attach the DECODED custom-error name to the error without
  // raw selector bytes — on `err.revert.name`, or (the common viem shape)
  // several layers deep on `cause.data.errorName`. The selector path above
  // misses those, and the raw `base` text is only viem's generic "The
  // contract function ... reverted." Walk the graph for the name and consult
  // the name-keyed friendly map before falling back to `base` (#1094 Codex).
  const revertName = extractRevertName(err);
  if (revertName) {
    const r = resolveFriendly({ name: revertName });
    if (r) return localize(r.key, r.message);
  }

  const base =
    e.reason ??
    e.shortMessage ??
    (typeof e.data === 'object' ? e.data?.message : undefined) ??
    e.message ??
    fallback;

  // #780 — "exceeds max transaction gas limit" is what public RPCs surface
  // when `eth_estimateGas` reverts during simulation and the wallet then
  // falls back to a default gas ceiling (often ~30M) that overshoots the
  // chain's per-transaction cap. It reads like a gas shortage but the real
  // cause is almost always an upstream revert the estimator couldn't price —
  // most commonly a missing ERC-20 allowance (approve first), or a stale
  // frontend ABI whose calldata shape no longer matches the deployed facet
  // (the historical F-0001 accept-offer failure). Only reword when we could
  // NOT decode a concrete revert selector — a genuine named revert already
  // returned its friendly copy above. Distinguish it so users don't chase a
  // phantom gas problem.
  if (
    !sel &&
    /exceeds max (?:transaction )?gas limit/i.test(base)
  ) {
    return localize(GAS_ESTIMATE_UNAVAILABLE_KEY, GAS_ESTIMATE_UNAVAILABLE_MESSAGE);
  }

  // Unknown custom error + no friendly copy: append the selector name so
  // support can triage without shipping an ABI fix first.
  if (/unknown custom error/i.test(base)) {
    const named = namedRevertSelector(err);
    if (named) return `${base} — ${named}`;
  }
  return base;
}
