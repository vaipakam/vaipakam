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
 * `canonicalMdKeccak256` is the keccak256 over the exact committed
 * bytes of the canonical Markdown source
 * (`docs/Terms/TermsOfService.md` at the commit that published the
 * version) — the derivation the governance runbook proposes for the
 * on-chain `setCurrentTos` hash. It is pinned by
 * `scripts/check-terms-canonical-hash.ts` (wired into `typecheck`),
 * which recomputes it from the tree for the CURRENT version, so this
 * constant cannot silently drift from the text it claims to cover.
 *
 * This module is deliberately pure data (no JSX, no React) so the
 * check script can import it without dragging component modules in;
 * the version → body mapping lives in `TermsPage.tsx`.
 */

export interface TermsVersionMeta {
  /** The on-chain ToS version this entry publishes. */
  version: number;
  /** Effective date shown in the page header, ISO `YYYY-MM-DD`. */
  effective: string;
  /**
   * keccak256 over the exact committed bytes of the canonical
   * `docs/Terms/TermsOfService.md` for this version. FROZEN once the
   * entry is published — the guard script checks only the current
   * (last) entry against the working tree, because older versions'
   * canonical files are superseded in `docs/` while their hashes
   * remain the record of what was published.
   */
  canonicalMdKeccak256: `0x${string}`;
}

export const TERMS_VERSION_METAS: readonly TermsVersionMeta[] = [
  {
    version: 1,
    effective: '2026-04-24',
    canonicalMdKeccak256:
      '0x61d9f54cd3ace1109e784dcd9e761478d10327205467925e51b8e9fa0e68904e',
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
