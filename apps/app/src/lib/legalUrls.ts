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
 */
export const LEGAL_URLS = {
  terms: 'https://vaipakam.com/terms',
  privacy: 'https://vaipakam.com/privacy',
} as const;
