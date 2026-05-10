/**
 * Cross-domain URL builder for the connected-app surface
 * (`defi.vaipakam.com` today; would migrate when the connected app
 * is rehomed). The marketing site hosted by this app links to a
 * handful of public-read tools that live on the connected-app
 * domain — analytics, NFT verifier, protocol console — plus the
 * "Launch App" CTA. None of those are co-located here because the
 * industry pattern (Uniswap, Morpho, dYdX, ...) keeps
 * read-only public dashboards on the app subdomain alongside the
 * wallet-bearing write flows.
 *
 * Dev override: set `VITE_DEFI_URL=http://localhost:5173` (or
 * whatever the local defi dev server uses) in the active `.env`
 * so cross-domain links resolve to the dev server during local
 * development.
 *
 * The helper trims a trailing slash on the configured base so call
 * sites can pass either `/analytics` or `analytics` and the joined
 * URL stays well-formed.
 */
const DEFI_URL = (
  import.meta.env.VITE_DEFI_URL ?? 'https://defi.vaipakam.com'
).replace(/\/$/, '');

export function defiUrl(path: string): string {
  const normalised = path.startsWith('/') ? path : `/${path}`;
  return `${DEFI_URL}${normalised}`;
}
