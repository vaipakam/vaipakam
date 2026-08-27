/**
 * Cross-domain URL builder for the connected-app surface.
 *
 * The marketing site links to a handful of public-read tools that live
 * on the connected-app domain — analytics, NFT verifier, protocol
 * console — plus the "Launch App" CTA. None are co-located here
 * because the industry pattern (Uniswap, Morpho, dYdX, ...) keeps
 * read-only public dashboards on the app subdomain alongside the
 * wallet-bearing write flows.
 *
 * This site never imports from the connected app, so the coupling is a
 * URL and nothing more. #1854 exercised that: the app moved from
 * `defi.vaipakam.com` to `apps/app`, and no call site changed — only
 * this file. What #1854 also showed is that the coupling is a URL AND
 * a route table, which is what the switch below now models.
 *
 * Dev override: `VITE_APP_URL=http://localhost:5173` in the active
 * `.env` points these links at a local dev server. See the note on
 * that constant — it moves the host only.
 */

/**
 * THE CUTOVER SWITCH — host and paths move together, on purpose.
 *
 * The rename landed before `app.vaipakam.com` served a
 * production-configured build, so these links still resolve to the
 * legacy host. That deferral is only half the problem, and the half
 * that is easy to miss: the two surfaces do not agree on paths. The
 * verifier is `/nft-verifier` on the legacy app and `/nft` on the new
 * one; the VPFI vault is `/vpfi-vault` and `/vpfi`. Deferring the host
 * while leaving new-app paths in the call sites produces exactly the
 * same breakage as flipping the host too early — an earlier revision
 * of this file did precisely that.
 *
 * So call sites name a DESTINATION, never a path, and one constant
 * selects the host and the route table as a pair. They cannot drift.
 *
 * TO COMPLETE THE CUTOVER, in this order:
 *   1. Deploy the Worker WITH operator env — `cd apps/app && pnpm run
 *      deploy`, never a bare `build`. A build missing
 *      `VITE_INDEXER_ORIGIN` has no offer book, push rail or config
 *      snapshot; the `deploy` script hard-fails on that, a plain build
 *      only warns.
 *   2. Bind `app.vaipakam.com` to it and verify the routes below.
 *   3. Set `APP_TARGET` to `'app'` here.
 *   4. Repoint the hard-coded recovery links in the ten
 *      `src/content/userguide/Advanced.*.md` files, which cannot call
 *      this helper — markdown has no access to it.
 *
 * Step 4 is the one that gets forgotten; it is listed here because
 * this file is where somebody will be standing when they do step 3.
 */
type AppTarget = 'legacy' | 'app';

// `as AppTarget` widens the literal on purpose: without it TypeScript
// narrows this to 'legacy' and reports the comparisons below as dead
// code, which is exactly the check we want live when it is flipped.
const APP_TARGET = 'legacy' as AppTarget;

/** Per-surface routes. Same destinations, different paths. */
const ROUTES: Record<AppTarget, Record<AppDestination, string>> = {
  legacy: { home: '/', nftVerifier: '/nft-verifier', vpfiVault: '/vpfi-vault' },
  app: { home: '/', nftVerifier: '/nft', vpfiVault: '/vpfi' },
};

/** Where a link can point. Add a member here, not a raw path at a call site. */
export type AppDestination = 'home' | 'nftVerifier' | 'vpfiVault';

const DEFAULT_HOST =
  APP_TARGET === 'app' ? 'https://app.vaipakam.com' : 'https://defi.vaipakam.com';

/**
 * `VITE_APP_URL` overrides the HOST only — the route table still follows
 * `APP_TARGET`. Pointing this at a local `apps/app` dev server therefore
 * also wants `APP_TARGET = 'app'`, or the links carry legacy paths.
 */
const APP_URL = (import.meta.env.VITE_APP_URL ?? DEFAULT_HOST).replace(/\/$/, '');

export function appUrl(destination: AppDestination): string {
  return `${APP_URL}${ROUTES[APP_TARGET][destination]}`;
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
 * The NFT Verifier is deliberately NOT here: it WAS ported, so its
 * links use `appUrl('nftVerifier')`, which resolves to `/nft-verifier`
 * or `/nft` depending on the cutover target above.
 */
const LEGACY_TOOL_URL = (
  import.meta.env.VITE_LEGACY_TOOL_URL ?? 'https://defi.vaipakam.com'
).replace(/\/$/, '');

export function legacyToolUrl(path: string): string {
  const normalised = path.startsWith('/') ? path : `/${path}`;
  return `${LEGACY_TOOL_URL}${normalised}`;
}
