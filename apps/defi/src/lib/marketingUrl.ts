/**
 * Cross-domain URL builder for the public marketing site
 * (`labs.vaipakam.com` today; `vaipakam.com` / `www.vaipakam.com`
 * after cutover). The connected-app surface hosted by this app
 * links to the marketing site for the landing page, whitepaper,
 * help / overview / user-guide content, legal pages
 * (Terms / Privacy / Data Rights), Discord and the public Buy-VPFI
 * marketing explainer. None of those pages exist on the connected-
 * app domain after the apps/labs clone — they live exclusively on
 * the marketing site (industry pattern: each surface owns its own
 * URL space, cross-surface paths 404).
 *
 * Dev override: set `VITE_MARKETING_URL=http://localhost:5174` (or
 * whatever the local labs dev server uses) in the active `.env`
 * so cross-domain links resolve to the dev server during local
 * development.
 *
 * Mirrors the shape of `apps/labs/src/lib/defiUrl.ts` so the two
 * surfaces have a symmetric "the other domain" helper. The helper
 * trims a trailing slash on the configured base so call sites can
 * pass either `/whitepaper` or `whitepaper` and the joined URL
 * stays well-formed.
 */
const MARKETING_URL = (
  import.meta.env.VITE_MARKETING_URL ?? 'https://labs.vaipakam.com'
).replace(/\/$/, '');

export function marketingUrl(path: string): string {
  const normalised = path.startsWith('/') ? path : `/${path}`;
  return `${MARKETING_URL}${normalised}`;
}
