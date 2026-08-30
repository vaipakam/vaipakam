/**
 * The marketing site's legal pages (#1961).
 *
 * These are absolute URLs to `apps/www`, not routes in this app: the
 * connected app has no Terms or Privacy page of its own, and the two
 * surfaces are separate origins.
 *
 * Extracted here because the ToS gate needs the same Terms URL the
 * in-flow consent label already used. A gate that blocks the app until
 * the user accepts terms, next to a second copy of where those terms
 * live, is exactly the shape that goes stale on one side only — the
 * consent label would keep working while the gate pointed somewhere
 * that no longer served the text being accepted.
 *
 * VERSIONED TERMS (#1998): `apps/www` serves every published Terms
 * version at a pinned route `/terms/v<N>` (frozen forever), with the
 * current version still at `/terms`. The gate asks a wallet to accept
 * a specific on-chain version and content hash, so it links the
 * PINNED route for the version it read from chain — during a rollout
 * (new page published before `setCurrentTos` executes, per the
 * runbook's ordering) `/terms` already shows N+1 while the gate asks
 * for N, and only the pinned link shows the text the acceptance
 * actually records. An unknown `/terms/v<N>` renders an honest
 * "not published here" explainer on `apps/www` (never a silent 404),
 * so linking a version ahead of a www deploy fails safe.
 */
export const LEGAL_URLS = {
  terms: 'https://vaipakam.com/terms',
  privacy: 'https://vaipakam.com/privacy',
} as const;

/**
 * The version-pinned Terms URL for an on-chain ToS version. Callers
 * fall back to `LEGAL_URLS.terms` when no version is known (the gate
 * before its read lands, or the dormant `currentTosVersion == 0`
 * state) — a pinned `/terms/v0` names nothing.
 */
export function termsUrlForVersion(version: number): string {
  return Number.isInteger(version) && version > 0
    ? `${LEGAL_URLS.terms}/v${version}`
    : LEGAL_URLS.terms;
}
