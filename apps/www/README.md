# @vaipakam/www

**Marketing + docs site — vaipakam.com. Vite SPA, no wallet, no wagmi, no on-chain reads.**

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)
[![Contracts docs deploy](https://github.com/vaipakam/vaipakam/actions/workflows/contracts-docs.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/contracts-docs.yml)

## What is this

The **public marketing + docs surface** served at `vaipakam.com` (apex; `www.vaipakam.com` 301-redirects to apex via a Cloudflare Bulk Redirect rule). Pure-marketing Vite SPA — Landing, BuyVPFI Marketing, Whitepaper, Overview, User Guide, Terms, Privacy, Data Rights, Discord, Help Search.

**Non-goals (deliberate dependency tightening):**

- NO wallet connect / wagmi / `wallet_*` JSON-RPC.
- NO on-chain reads (every value the page shows is statically content-baked or sourced from a sibling Worker, not from a chain RPC).
- NO connectkit / react-query / per-action permissioning.
- Public-read tools that live on the connected-app domain by industry convention (analytics, NFT verifier, protocol console) are linked out via `defiUrl()` to `defi.vaipakam.com` rather than duplicated here.

This deliberate dependency-surface narrowing means a marketing-only change has a tighter blast radius — `apps/www` can't accidentally regress the connected app, and vice versa.

**Canonical whitepaper** lives at [`src/content/whitepaper/Whitepaper.en.md`](src/content/whitepaper/Whitepaper.en.md). This is the file the website renders; repo navigation and audit-intake docs should link to this file directly when they need the technical specification.

## History

Folder, package name, Worker name were all switched together at the labs → www cutover:

- Folder `apps/labs` → `apps/www`.
- Package `@vaipakam/labs` → `@vaipakam/www`.
- Cloudflare Worker `vaipakam-labs` → `vaipakam-www`.

## How to run

```bash
pnpm --filter @vaipakam/www dev       # local Vite dev server
pnpm --filter @vaipakam/www build     # Vite production build
pnpm --filter @vaipakam/www deploy    # wrangler deploy; uses `wrangler login` on the operator's machine
```

## How to test

```bash
pnpm --filter @vaipakam/www typecheck
pnpm --filter @vaipakam/www build
```

No on-chain test surface — by design.

## Architecture

- Stage 4 source-tree refactor (labs → www): [`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md).
- Whitepaper authoring + sync: [`docs/internal/ProjectProcedures.md` §6.5](../../docs/internal/ProjectProcedures.md).
- Cloudflare static-assets deploy shape: same as `apps/defi`, dependency-trimmed.

## Configuration

Worker `wrangler.jsonc:vars`: site-wide constants (canonical origin, analytics keys).

No secrets — there's nothing here that requires server-side credentials. `apps/agent`'s `FRONTEND_ORIGIN` does reference this Worker's origin for CORS configuration.

## Related

- `apps/defi` — the connected app at `defi.vaipakam.com`. Shares a marketing-content base; the connected app overlays wallet + on-chain reads on top.
- `packages/ui` — primitives shared between `apps/defi` + `apps/www`.
- `packages/lib` — `crossDomainPref` (parent-domain cookie helper for theme + language sync between this domain and `defi.vaipakam.com`).
