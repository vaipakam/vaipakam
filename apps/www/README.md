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
- Public-read tools that live on the connected-app domain by industry convention (analytics, NFT verifier, protocol console) are linked OUT rather than duplicated here. Since #1854 that routing is SPLIT across two helpers in `src/lib/appUrl.ts`, and the split is deliberate:
  - `appUrl(destination)` — the cutover-aware builder. Takes a named destination, never a raw path, and one `APP_TARGET` constant selects the host AND the route table together (the two surfaces disagree on paths: `/nft-verifier` vs `/nft`, `/vpfi-vault#step-2` vs `/vpfi`). The NFT Verifier goes through this.
  - `legacyToolUrl(path)` — Analytics and the Protocol Console, which were NOT ported to `apps/app` (#1959) and so still resolve to the surface that serves them. It exists to be deleted once they are ported.
  Note the connected app's own hostname is not bound yet, so `appUrl` currently resolves to the legacy host too; the cutover checklist lives beside `APP_TARGET`.

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
pnpm --filter @vaipakam/www run deploy    # wrangler deploy; uses `wrangler login` on the operator's machine
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
- Cloudflare static-assets deploy shape: same as `apps/app`, dependency-trimmed.

## Configuration

Worker `wrangler.jsonc:vars`: site-wide constants (canonical origin, analytics keys).

No secrets — there's nothing here that requires server-side credentials. `apps/agent`'s `FRONTEND_ORIGIN` does reference this Worker's origin for CORS configuration.

## Related

- `apps/app` — the connected app. An INDEPENDENT tree, not an overlay: it was developed separately and shares no source with this one (which is why, as noted above, neither can regress the other). The only coupling is the cross-domain links in `src/lib/appUrl.ts`. The "overlay on a shared marketing base" description belonged to the app this one replaced.
- `packages/ui` — React primitives, ORPHANED since #1854: nothing imports them (this app keeps only an unused dependency entry), and nothing typechecks the package either. See its README and #1963.
- `packages/lib` — `crossDomainPref` (parent-domain cookie helper for preference sync across the two surfaces). LANGUAGE-only in practice today: the connected app reads the language cookie but not the theme one (see the note in `src/context/ThemeContext.tsx`).
