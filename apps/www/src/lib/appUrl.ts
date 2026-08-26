/**
 * Cross-domain URL builder for the connected-app surface
 * (`app.vaipakam.com`). The marketing site hosted by this app links to a
 * handful of public-read tools that live on the connected-app
 * domain — analytics, NFT verifier, protocol console — plus the
 * "Launch App" CTA. None of those are co-located here because the
 * industry pattern (Uniswap, Morpho, dYdX, ...) keeps
 * read-only public dashboards on the app subdomain alongside the
 * wallet-bearing write flows.
 *
 * The coupling is a URL and nothing more: this site never imports from
 * the connected app, so rehoming that app is a one-line change here.
 * #1854 exercised exactly that — the connected app moved from
 * `defi.vaipakam.com` (the retired apps/defi) to `app.vaipakam.com`
 * (apps/app) and no call site below changed.
 *
 * Dev override: set `VITE_APP_URL=http://localhost:5173` (or
 * whatever the local connected-app dev server uses) in the active
 * `.env` so cross-domain links resolve to the dev server during local
 * development.
 *
 * The helper trims a trailing slash on the configured base so call
 * sites can pass either `/analytics` or `analytics` and the joined
 * URL stays well-formed.
 */
const APP_URL = (
  import.meta.env.VITE_APP_URL ?? 'https://app.vaipakam.com'
).replace(/\/$/, '');

export function appUrl(path: string): string {
  const normalised = path.startsWith('/') ? path : `/${path}`;
  return `${APP_URL}${normalised}`;
}
