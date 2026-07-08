/**
 * Drift guard for the hand-maintained error-selector tables in
 * `decodeContractError.ts` (#68).
 *
 * The `KNOWN_ERROR_SELECTORS` table is transcribed by hand ("selectors
 * computed offline with `cast sig`") so it doesn't pull a keccak lib into the
 * runtime bundle. That hand-transcription is exactly where drift creeps in —
 * the table shipped with `0x94280d62` labelled `ERC20InvalidSender` when that
 * selector is really `ERC20InvalidSpender`, so a real `ERC20InvalidSender`
 * revert fell through to raw hex. This suite makes the table self-verifying:
 *
 *   Layer 1 — every selector key must equal `toFunctionSelector(signature)`,
 *             so a key that doesn't hash from its own signature fails CI.
 *   Layer 2 — every mapped name the Diamond can actually revert with must
 *             carry the compiled ABI's exact signature, so a Solidity-side
 *             param change surfaces here instead of silently mis-decoding.
 */
import { describe, it, expect } from 'vitest';
import { toFunctionSelector, type AbiParameter } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import {
  KNOWN_ERROR_SELECTORS,
  FRIENDLY_ERROR_MESSAGES,
} from './decodeContractError';

// Structural shape of an ABI error item — viem re-exports `AbiParameter` but
// not `AbiError`, so we don't name that type directly.
type AbiErrorItem = { name: string; inputs: readonly AbiParameter[] };

/** `ErrorName(type1,type2)` — the canonical selector-signature of an ABI error. */
function abiErrorSignature(e: AbiErrorItem): string {
  return `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
}

/** The `Name` portion of a `Name(types)` signature. */
function errorName(sig: string): string {
  const i = sig.indexOf('(');
  return i === -1 ? sig : sig.slice(0, i);
}

/** name → set of ABI signatures the compiled Diamond can revert with. */
function diamondErrorSignaturesByName(): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const item of DIAMOND_ABI_VIEM) {
    if (item.type !== 'error') continue;
    let sigs = byName.get(item.name);
    if (!sigs) byName.set(item.name, (sigs = new Set()));
    sigs.add(abiErrorSignature(item));
  }
  return byName;
}

const SELECTOR_RE = /^0x[0-9a-f]{8}$/;

describe('KNOWN_ERROR_SELECTORS drift guard (#68)', () => {
  const entries = Object.entries(KNOWN_ERROR_SELECTORS);

  it('is a non-trivial table', () => {
    expect(entries.length).toBeGreaterThan(100);
  });

  it('every selector key is lower-case 4-byte hex', () => {
    const bad = entries.map(([sel]) => sel).filter((sel) => !SELECTOR_RE.test(sel));
    expect(bad).toEqual([]);
  });

  // Layer 1 — the load-bearing self-consistency check. A selector that isn't
  // the real keccak of its signature (a fat-fingered `cast sig` copy, or a
  // name/selector swap like the ERC20InvalidSender/Spender bug) fails here.
  it('every selector key equals toFunctionSelector(signature)', () => {
    const mismatches = entries
      .filter(([sel, sig]) => toFunctionSelector(sig).toLowerCase() !== sel.toLowerCase())
      .map(([sel, sig]) => `${sig}: mapped ${sel}, real ${toFunctionSelector(sig)}`);
    expect(mismatches).toEqual([]);
  });

  // Layer 2 — agreement with the compiled contract surface. Any mapped name
  // the Diamond can revert with must match the ABI's signature exactly; a
  // param added/removed contract-side (which changes the selector) is drift.
  // Names absent from the Diamond ABI (OZ token errors, Diamond-internal
  // errors) are validated by Layer 1 alone and skipped here.
  it('mapped names agree with the compiled Diamond ABI signature', () => {
    const abiByName = diamondErrorSignaturesByName();
    expect(abiByName.size).toBeGreaterThan(50); // sanity: ABI actually loaded

    const drift = entries
      .filter(([, sig]) => abiByName.has(errorName(sig)))
      .filter(([, sig]) => !abiByName.get(errorName(sig))!.has(sig))
      .map(
        ([, sig]) =>
          `${sig} — Diamond ABI declares ${[...abiByName.get(errorName(sig))!].join(' | ')}`,
      );
    expect(drift).toEqual([]);
  });
});

/**
 * Friendly selectors with no identified error name — the `check-event-coverage`
 * `DELIBERATELY_NOT_HANDLED` idiom: each entry carries a one-line reason and
 * new orphans still fail the coverage check below.
 *
 * Currently empty: the sole entry (`0x0857e728`) was retired in #1108 once it
 * was confirmed to match no error anywhere in the contract surface. New
 * genuinely-unidentified selectors may be added here with a reason.
 */
const UNRESOLVED_FRIENDLY_SELECTORS: Record<string, string> = {};

describe('FRIENDLY_ERROR_MESSAGES coverage (#68)', () => {
  const selectors = Object.keys(FRIENDLY_ERROR_MESSAGES);

  it('every friendly selector key is lower-case 4-byte hex', () => {
    expect(selectors.filter((sel) => !SELECTOR_RE.test(sel))).toEqual([]);
  });

  // Curated copy keys off a selector; if that selector isn't also in
  // KNOWN_ERROR_SELECTORS the decoder can't name it for support triage, so the
  // two tables would have drifted apart. Consciously-unresolved selectors are
  // allowlisted above with a reason; a NEW orphan still fails here.
  it('every friendly selector resolves to a KNOWN_ERROR_SELECTORS name', () => {
    const orphans = selectors.filter(
      (sel) => !(sel in KNOWN_ERROR_SELECTORS) && !(sel in UNRESOLVED_FRIENDLY_SELECTORS),
    );
    expect(orphans).toEqual([]);
  });

  // The allowlist can't rot into a free pass: an entry that has since been
  // given a proper KNOWN_ERROR_SELECTORS name must be removed from it.
  it('the unresolved-selector allowlist has no stale (now-resolved) entries', () => {
    const stale = Object.keys(UNRESOLVED_FRIENDLY_SELECTORS).filter(
      (sel) => sel in KNOWN_ERROR_SELECTORS,
    );
    expect(stale).toEqual([]);
  });

  // The allowlist can't outlive the copy it excuses: an entry whose friendly
  // message has been removed (as #1108 did for 0x0857e728) is dead and must be
  // dropped from the allowlist too.
  it('every allowlisted selector still has a FRIENDLY_ERROR_MESSAGES entry', () => {
    const dead = Object.keys(UNRESOLVED_FRIENDLY_SELECTORS).filter(
      (sel) => !(sel in FRIENDLY_ERROR_MESSAGES),
    );
    expect(dead).toEqual([]);
  });
});
