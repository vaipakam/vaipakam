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
 * KNOWN GAP — #1998, raised by Codex on #1997 and deferred there because
 * the fix belongs to `apps/www`. `/terms` is a single MUTABLE page with
 * no version-pinned route, while the gate asks a wallet to accept a
 * specific version and content hash. Publishing the next Terms page and
 * calling `setCurrentTos` cannot be simultaneous and the runbook orders
 * the page first, so during that window the gate correctly asks for
 * version N while this link already serves N+1 — the user reads one text
 * and records acceptance of another. Linking to `/terms/vN` from here
 * before `apps/www` serves it would produce a 404, which is worse; the
 * fix is versioned hosting, tracked in #1998.
 */
export const LEGAL_URLS = {
  terms: 'https://vaipakam.com/terms',
  privacy: 'https://vaipakam.com/privacy',
} as const;
