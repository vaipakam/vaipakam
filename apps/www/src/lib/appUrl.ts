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
 * URL and nothing more — but it is a URL AND a route table, which is
 * what #1854 established the hard way. The two surfaces answer on
 * different paths, so rehoming the app is not a one-line change of a
 * host: call sites moved from raw paths to named destinations (`CTA`,
 * `Footer`, `Hero`, `Navbar`, `BuyVPFIMarketing`) precisely so the host
 * and the routes cannot be changed independently. Preserve that coupling
 * in any future cutover work.
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
 * legacy host. The host is now bound and serving (step 2 below), so what
 * remains is a deliberate hold, not a missing prerequisite — see step 3.
 * That deferral is only half the problem, and the half
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
 *   1. DONE — the Worker is deployed WITH operator env (`cd apps/app &&
 *      pnpm run deploy`, never a bare `build`; a build missing
 *      `VITE_INDEXER_ORIGIN` has no offer book, push rail or config
 *      snapshot, and the `deploy` script hard-fails on that where a
 *      plain build only warns).
 *   2. DONE — `app.vaipakam.com` is bound and serves `vaipakam-app`.
 *      Verified by asset-hash identity, not by status code: every path
 *      on both hosts returns the same 200 SPA shell, so probing a route
 *      proves nothing. The bound host served the exact
 *      `/assets/index-*.js` hash a local `pnpm run deploy` had just
 *      produced. Check it that way if you need to re-confirm.
 *   3. Set `APP_TARGET` to `'app'` here. Still OPEN — blocked only by
 *      step 7 below (the Vpfi deposit anchor), since flipping without it
 *      regresses the marketing CTA's promised landing position.
 *   4. Repoint the hard-coded recovery links in the ten
 *      `src/content/userguide/Advanced.*.md` files, which cannot call
 *      this helper — markdown has no access to it, so they are moved by
 *      hand and do NOT travel with `APP_TARGET`.
 *
 *      THESE MOVE LAST, WITH THE HOST RETIREMENT — not with the binding,
 *      and not with the rest of this list. `/recover` is the one flow
 *      carrying durable PER-ORIGIN safety state: `Recover.tsx`'s
 *      `pendingRecoveryStore` is browser storage, and its own comment
 *      calls the pending card the only safe landing for a broadcast
 *      whose receipt could not be read. Browser storage is same-origin,
 *      so a user mid-recovery on the legacy host who follows a repointed
 *      link arrives where that marker cannot be seen, meets a blank
 *      form, and can broadcast a SECOND recovery — the exact
 *      double-recovery the pending card exists to prevent.
 *
 *      The risk is asymmetric, which is what settles the ordering: a
 *      fresh user sent to the still-served legacy host loses nothing,
 *      while a mid-recovery user sent to the new one can lose real
 *      value. Confirming `/recover` RENDERS on the new host — it does —
 *      is not evidence of state continuity, and must not be read as it.
 *
 *      REDIRECTING THE LEGACY HOST IS NOT THE CONDITION EITHER, and an
 *      earlier revision of this note wrongly said it was. A redirect
 *      lands the user on the new origin, which still cannot read the old
 *      origin's storage — the identical blank form, the identical second
 *      broadcast. Two recoveries racing the same nonce means whichever
 *      mines first decides what executes and the other reverts having
 *      spent gas.
 *
 *      The condition is that no legacy attempt can still be in flight:
 *      every pending marker and every signed deadline on that origin has
 *      DRAINED and the legacy recovery flow is DISABLED — or a real
 *      cross-origin handoff exists. Host retirement is what that permits,
 *      not what proves it.
 *   5. Move the agent's `FRONTEND_ORIGIN` entry zero to the app host,
 *      together with the Frame paths in `frames.ts` — that CSV's first
 *      entry and those paths are the same coupling this file models.
 *   6. DONE — the discovery links in `apps/indexer/src/apiIndex.ts` and
 *      `apps/www/scripts/generate-llms.mjs`, which automated consumers
 *      read, now advertise `app.vaipakam.com`.
 *   7. Give the app's Vpfi page a deposit anchor equivalent to the
 *      legacy `#step-2`, then add it to the `app` route above — the
 *      marketing CTA promises that landing position.
 *
 * BLOCKERS — do not flip while any of these is open:
 *   - #1961 — CLEARED. `apps/app` now gates every routed surface on the
 *     in-force ToS version, failing closed on a pending or failed read
 *     (`apps/app/src/contracts/tosGate.ts`, `LegalGate.tsx`). The gate is
 *     inert while `currentTosVersion` is 0 and bites the moment governance
 *     installs one, which is what the flip needed.
 *   - #1960 — CLEARED. `apps/app` serves `/data-rights`
 *     (`App.tsx`), and it renders on the bound host. The concern was
 *     real and is spent: the marketing site's export/erase controls
 *     could never have stood in, because they run on THIS origin and
 *     browser storage is same-origin, so they can neither read nor clear
 *     what the app keeps (preferences, alert settings, notification
 *     cursors, pending transactions, diagnostics). The app now carries
 *     its own.
 *   - #1959: Analytics and the Protocol Console are not ported, which is
 *     why `legacyToolUrl` below exists. This does NOT block `APP_TARGET`
 *     — those two links do not travel through `appUrl` — but it does
 *     block retiring `defi.vaipakam.com`. See the note on
 *     `legacyToolUrl`.
 *
 * Steps 4-7 are the ones that get forgotten; they are listed here because
 * this file is where somebody will be standing when they do step 3.
 */
type AppTarget = 'legacy' | 'app';

/**
 * Which surface the links point at. `VITE_APP_TARGET` overrides it so a
 * preview or local build can aim at `apps/app` WITHOUT editing tracked
 * source — important because the override has to move the route table
 * too, not just the host. Pointing `VITE_APP_URL` at a local `apps/app`
 * dev server while this stayed `legacy` would emit `/nft-verifier` and
 * `/vpfi-vault` at an app that serves `/nft` and `/vpfi`: the exact
 * host/path drift this helper exists to prevent, reintroduced through
 * the dev path.
 *
 * Anything other than 'app' reads as 'legacy' — an unset or typo'd value
 * lands on the served surface rather than the unbound one.
 */
const APP_TARGET: AppTarget =
  import.meta.env.VITE_APP_TARGET === 'app' ? 'app' : 'legacy';

/** Per-surface routes. Same destinations, different paths. */
// Entries carry any FRAGMENT too, because the anchor is part of the
// destination and differs per surface. The legacy VPFI page keeps
// `id="step-2"` on its first actionable deposit card specifically as a
// deep-link target, and the marketing CTA promises that landing position;
// dropping the fragment silently lands users at the top of an
// educational page instead. The new app's Vpfi page has NO equivalent
// anchor yet — give it one before switching `vpfiVault` to the app
// target, or that CTA regresses at the cutover.
const ROUTES: Record<AppTarget, Record<AppDestination, string>> = {
  legacy: { home: '/', nftVerifier: '/nft-verifier', vpfiVault: '/vpfi-vault#step-2' },
  app: { home: '/', nftVerifier: '/nft', vpfiVault: '/vpfi' },
};

/** Where a link can point. Add a member here, not a raw path at a call site. */
export type AppDestination = 'home' | 'nftVerifier' | 'vpfiVault';

const DEFAULT_HOST =
  APP_TARGET === 'app' ? 'https://app.vaipakam.com' : 'https://defi.vaipakam.com';

/**
 * `VITE_APP_URL` overrides the HOST. Set `VITE_APP_TARGET=app` alongside
 * it when pointing at an `apps/app` dev server, so the route table moves
 * with the host.
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
