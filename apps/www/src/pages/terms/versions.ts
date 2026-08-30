/**
 * The Terms-of-Service version registry (#1998).
 *
 * Every version of the Terms this site has ever served, in ascending
 * order. The connected app's acceptance gate records a wallet's
 * acceptance against a specific on-chain (version, content-hash)
 * pair and links the user to the VERSION-PINNED route
 * `/terms/v<version>` — so the text a version number resolves to
 * must never change once published. That is the whole contract of
 * this file:
 *
 * - a published entry is FROZEN — its body component, effective date
 *   and canonical hash are never edited;
 * - a Terms change is a NEW entry (new body file, new hash), never a
 *   rewrite of an old one;
 * - `/terms` always serves the LAST entry, and every entry stays
 *   reachable at its pinned route forever, so an acceptance recorded
 *   years ago still resolves to the exact text that was accepted.
 *
 * `canonicalMdKeccak256` is the keccak256 over the exact bytes of the
 * version's FROZEN Markdown source (`v<N>.md` beside this file — a
 * byte-copy of `docs/Terms/TermsOfService.md` at the commit that
 * published the version), which is also the text the page RENDERS —
 * the derivation the governance runbook proposes for the on-chain
 * `setCurrentTos` hash. `scripts/check-terms-canonical-hash.ts`
 * (wired into `typecheck`) recomputes every entry's hash from its
 * frozen file, cross-checks the registry and the file set in both
 * directions, and requires the current entry's frozen file to be
 * byte-identical to the canonical document — so neither this
 * constant, the rendered text, nor the canonical doc can silently
 * drift from one another.
 *
 * This module is deliberately pure data (no JSX, no React) so the
 * check script can import it without dragging component modules in;
 * the version → source mapping is a glob in `TermsPage.tsx`.
 */

export interface TermsVersionMeta {
  /** The on-chain ToS version this entry publishes. */
  version: number;
  /** Effective date shown in the page header, ISO `YYYY-MM-DD`. */
  effective: string;
  /**
   * keccak256 over the exact bytes of this version's frozen source
   * `v<N>.md` (a byte-copy of the canonical
   * `docs/Terms/TermsOfService.md` when the version was published).
   * FROZEN once published — the guard script recomputes EVERY
   * entry's hash from its frozen file, and additionally requires
   * the current entry's file to equal the canonical document, whose
   * `docs/` copy is superseded in place when the next version lands.
   */
  canonicalMdKeccak256: `0x${string}`;
}

export const TERMS_VERSION_METAS: readonly TermsVersionMeta[] = [
  {
    version: 1,
    effective: '2026-04-24',
    canonicalMdKeccak256:
      '0x536d38b08f2f0aef33256f8b9b298bf5d066e541c396bb3f18414a4baac881a7',
  },
];

export const CURRENT_TERMS_VERSION =
  TERMS_VERSION_METAS[TERMS_VERSION_METAS.length - 1]!.version;

/** Look up a version's metadata, or null when this site has never
 *  published it (a future version the chain knows but this deploy
 *  does not yet serve, or a malformed slug). */
export function termsVersionMeta(version: number): TermsVersionMeta | null {
  return TERMS_VERSION_METAS.find((m) => m.version === version) ?? null;
}

/**
 * Parse a `/terms/:versionSlug` path segment. Only the exact shape
 * `v<positive integer>` addresses a version — anything else is
 * unknown, and renders the honest not-published explainer rather
 * than a silent 404.
 */
export function parseTermsVersionSlug(slug: string): number | null {
  const m = /^v([1-9][0-9]*)$/.exec(slug);
  return m ? Number(m[1]) : null;
}
