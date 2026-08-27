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

/**
 * Link builder for the public-read tools that have NOT been ported to
 * the connected app yet — currently Analytics and the Protocol Console.
 *
 * #1854 renamed the connected app and rehomed it, but it did not port
 * every surface the retired one served: `apps/app` defines no
 * `/analytics` and no `/protocol-console` route, so pointing these
 * links at the new host lands users on the app's in-shell NotFound
 * page. They keep resolving to the legacy surface, which still serves
 * them, until the tools are ported.
 *
 * Two consequences worth stating plainly, because they are easy to get
 * wrong later:
 *
 *  - `defi.vaipakam.com` CANNOT be retired — or blanket-redirected to
 *    `app.vaipakam.com` — while it is the only host serving these two
 *    tools. Port them first, then retire.
 *  - When they are ported, delete this helper and move the call sites
 *    back to `appUrl`. It exists to be removed, not to become a second
 *    permanent surface.
 *
 * The NFT Verifier is deliberately NOT here: it WAS ported, as `/nft`,
 * so its links use `appUrl('/nft')`.
 */
const LEGACY_TOOL_URL = (
  import.meta.env.VITE_LEGACY_TOOL_URL ?? 'https://defi.vaipakam.com'
).replace(/\/$/, '');

export function legacyToolUrl(path: string): string {
  const normalised = path.startsWith('/') ? path : `/${path}`;
  return `${LEGACY_TOOL_URL}${normalised}`;
}
