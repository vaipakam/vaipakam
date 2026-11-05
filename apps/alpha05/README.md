# apps/alpha05 — the next connected app

The Vaipakam connected app rebuilt from `docs/FunctionalSpecs/` under the
rulebook in [`docs/DesignsAndPlans/Alpha05AppDesign.md`](../../docs/DesignsAndPlans/Alpha05AppDesign.md)
(epic #3180). It serves on its own Worker, `vaipakam-alpha05`, until it
reaches parity with `apps/app`, which keeps serving `app.vaipakam.com`; the
cutover conditions are the rulebook's §5. Nothing is extracted from
`apps/app`: that tree is a read-only reference for entry-point names and
edge cases.

## What this scaffold is

- The toolchain the other surfaces use: Vite + React 19, wagmi 2 / viem 2 /
  ConnectKit, TanStack Query, react-router 7, the shared i18n factory, the
  shared CSP plugins, ESLint with the hooks rules blocking from day one,
  vitest, and a Cloudflare Workers Static Assets deploy stamped with its
  commit (`pnpm run deploy`).
- Every route of the page map (rulebook §4), each rendering an honest
  "not built yet" page that names the matrix rows it will carry and links
  the current app. Routes are stable from the first deploy.
- The shared modules of §3.2 as typed contracts with minimal implementations:
  the capability service (reads the Diamond's routed selectors from the loupe;
  everything else `unknown` until read), the eligibility verdict (RB-ELIG) and
  switch classes (RB-SWITCH), three-valued transaction outcomes, identity-
  scoped read keys, the claim row model (RB-CLAIM), copy tiers with the
  word-budget guard (RB-TIERS), the "Why?" help link (RB-HELP) and the
  receipt / finish-card types (RB-CONFIDENCE).
- The own rail (RB-RAILS): `useOwnStateClient` reads a connected user's state
  through the wallet's provider first, the read-only proxy as fallback.

Not here yet, each owed by a later PR under #3180: the wallet control and the
first connected read (Home), the side-panel help, the indexer world rail, the
service worker, the e2e tier, and the user-guide sections the help panel
deep-links.

## Commands

```bash
pnpm --filter @vaipakam/alpha05 dev        # local dev server
pnpm --filter @vaipakam/alpha05 typecheck  # tsc + eslint + word-budget guard
pnpm --filter @vaipakam/alpha05 test       # vitest
pnpm --filter @vaipakam/alpha05 build      # production build (CSP completed from the build)
pnpm --filter @vaipakam/alpha05 deploy     # build + stamped wrangler deploy
```

Environment (`.env.local`, never committed): `VITE_INDEXER_ORIGIN`,
`VITE_AGENT_ORIGIN`, `VITE_RPC_PROXY_ORIGIN`, `VITE_WALLETCONNECT_PROJECT_ID`,
`VITE_DEFAULT_CHAIN_ID`. A per-chain RPC URL is refused by the build: it
would ship a provider key (#1724).

## Indexing and the deploy-lag check

Every response carries `X-Robots-Tag: noindex` and `robots.txt` disallows all
until the cutover. The Worker is listed in `deploy-lag.yml`'s
`DEPLOY_LAG_HELD` until a Cloudflare Workers Build exists for it; remove the
hold with the build.
