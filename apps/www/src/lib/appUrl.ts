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
 * THE CUTOVER IS DONE for every destination this helper builds:
 * `APP_TARGET` now defaults to `'app'`, so all six resolve to
 * `app.vaipakam.com`. The switch is KEPT rather than inlined, because
 * the property it guarantees outlives the migration — the host and the
 * route table can still only move as a pair, and a rollback is one
 * constant rather than a hunt through call sites.
 *
 * The half that was easy to miss, and still is: the two surfaces do not
 * agree on paths. The
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
 *   3. DONE — `APP_TARGET` defaults to `'app'`. The sense of the
 *      override is INVERTED with it: `VITE_APP_TARGET=legacy` now opts
 *      OUT. That direction matters — an unset or typo'd value must land
 *      on the surface users are meant to be on, and after the flip that
 *      is the app.
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
 *   7. DONE — the app's Vpfi page carries `id="deposit"` on its first
 *      actionable deposit card, and the `app` route above resolves
 *      `vpfiVault` to `/vpfi#deposit`. The legacy name `step-2` was an
 *      artifact of a card that rendered as "Step 1"; the new id says
 *      what it is.
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
 *   - #1959 — CLEARED. `apps/app` now serves both `/analytics` (with the
 *     `#transparency` section the footer deep-links) and
 *     `/protocol-console`, so `legacyToolUrl` is deleted and all six
 *     destinations travel through `appUrl`. This was the last thing
 *     keeping `defi.vaipakam.com` alive for LINK reasons.
 *
 * WHAT REMAINS: steps 4 and 5. Step 4 (the ten `/recover` guide links)
 * is NOT unblocked by the port — it turns on cross-origin pending state,
 * not on a missing route, and a redirect does not satisfy it either.
 * Step 5 (the agent's `FRONTEND_ORIGIN` entry zero) is coupled to the
 * `frames.ts` paths and changes live notification deep links.
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
 * Anything other than 'legacy' reads as 'app'. The sense is INVERTED
 * from the pre-cutover version, and deliberately so: an unset or typo'd
 * value must land on the surface users are meant to be on, and that is
 * now the app. Before the flip the same reasoning pointed the other way.
 * `VITE_APP_TARGET=legacy` is the explicit opt-out, kept so a rollback
 * needs no code change.
 */
const APP_TARGET: AppTarget =
  import.meta.env.VITE_APP_TARGET === 'legacy' ? 'legacy' : 'app';

/** Per-surface routes. Same destinations, different paths. */
// Entries carry any FRAGMENT too, because the anchor is part of the
// destination and differs per surface. The legacy VPFI page keeps
// `id="step-2"` on its first actionable deposit card specifically as a
// deep-link target, and the marketing CTA promises that landing position;
// dropping the fragment silently lands users at the top of an
// educational page instead. The app's Vpfi page carries `id="deposit"`
// for the same reason, on BOTH its connected and disconnected branches —
// most CTA arrivals have no wallet, so anchoring only the connected view
// would drop the majority at the top of the page. The page also
// re-scrolls once its async availability read settles, because a lazy
// route resolves the fragment against a shell that does not yet contain
// the element. Keep all three properties together: the id, both
// branches, and the re-scroll. (This note used to say the app had no
// equivalent anchor and to give it one before switching `vpfiVault` —
// #1959 did both, and the instruction outlived the work.)
const ROUTES: Record<AppTarget, Record<AppDestination, string>> = {
  legacy: {
    home: '/',
    nftVerifier: '/nft-verifier',
    vpfiVault: '/vpfi-vault#step-2',
    analytics: '/analytics',
    analyticsTransparency: '/analytics#transparency',
    protocolConsole: '/protocol-console',
  },
  app: {
    home: '/',
    nftVerifier: '/nft',
    // The app's deposit card carries `id="deposit"`; the legacy name
    // `step-2` was an artifact of a card that rendered as "Step 1".
    vpfiVault: '/vpfi#deposit',
    analytics: '/analytics',
    analyticsTransparency: '/analytics#transparency',
    protocolConsole: '/protocol-console',
  },
};

/** Where a link can point. Add a member here, not a raw path at a call site. */
export type AppDestination =
  | 'home'
  | 'nftVerifier'
  | 'vpfiVault'
  | 'analytics'
  | 'analyticsTransparency'
  | 'protocolConsole';

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

/*
 * `legacyToolUrl` USED TO LIVE HERE, and its removal is the point.
 *
 * It existed for the two surfaces #1854 rehomed but did not port —
 * Analytics and the Protocol Console — pinning their links to the one
 * deployment that served them while every other destination followed
 * `APP_TARGET`. Its own docstring said it existed to be removed rather
 * than to become a second permanent surface. Both tools are now ported
 * (#1959), so it is gone and all six destinations move together.
 *
 * That was also the last thing keeping `defi.vaipakam.com` alive: it can
 * now be retired or redirected as far as THESE links are concerned.
 *
 * ONE EXCEPTION, and it is not about links. The ten user-guide
 * `/recover` links still point at the legacy host, and repointing them
 * is NOT unblocked by this change. `/recover` carries durable
 * per-origin browser state — the pending-recovery marker — and a user
 * mid-recovery who follows a repointed link arrives where that marker
 * cannot be read, meets a blank form, and can broadcast a SECOND
 * recovery racing the first. A redirect does not help: it lands on the
 * new origin, which still cannot read the old one's storage. Those links
 * move only when no legacy attempt can still be in flight. See step 4.
 */
