# Vaipakam — frozen archive root

This top-level `alpha/` folder is the **frozen reference snapshot
root**, kept for the few-week transition window after the
labs → www / Stage 3-4 source-tree refactor cutover. Everything
under `alpha/` is intentionally outside the pnpm workspace so:

1. `pnpm install` doesn't resolve the archive's pinned
   dependency tree (which differs from the live workspace's
   versions and produced peer-dep warnings on every install).
2. Workspace-wide commands (`pnpm -r typecheck`, `pnpm -r build`)
   skip the archive automatically — no `--filter '!@vaipakam/alpha'`
   flag needed.
3. The "do not patch — emergency hotfixes go via the live
   `apps/{www,defi,keeper,indexer,agent}` source" intent is
   reinforced by the archive sitting outside the active
   workspace altogether. Same precedent as `contracts/`
   (Foundry, also outside the workspace) and
   `ops/{lz-watcher,subgraph,tenderly}` (active platform tooling
   on non-Cloudflare deploys).

## Source pin

Every file under `alpha/` (except this README) is restored from:

```
main@f48c99fa5db2ff718344b929b62c5b7720590ae2
```

This is the last main-branch commit before the apps/ + packages/
workspace split landed.

## What's archived here

- **`alpha/frontend/`** — the pre-Stage-4 monolithic frontend.
  Combined the marketing surface (Landing, Whitepaper, Overview,
  User Guide, Buy-VPFI marketing, Discord, legal pages) AND the
  connected-app surface (Dashboard, OfferBook, CreateOffer,
  LoanDetails, etc.) into a single Vite SPA. The 2026-05-08
  Stage 4 refactor split this into `apps/www` (marketing) and
  `apps/defi` (connected app).

  Bound to `alpha.vaipakam.com` via the existing `vaipakam-alpha`
  Cloudflare Worker. `public/robots.txt` disallows every crawler
  so the archive doesn't compete with the canonical
  `vaipakam.com` for SEO ranking.

- **`alpha/hf-watcher/`** — the pre-Stage-3 monolithic ops
  Worker. Combined the HF watcher loop, chain → archive-database
  ingestion, public read API, daily oracle-snapshot signer, and
  buy-watchdog reconciliation into one Worker. The 2026-05-08
  Stage 3 refactor carved this into `apps/keeper`,
  `apps/indexer`, and `apps/agent`.

  The Cloudflare Worker `vaipakam-hf-watcher` is **still bound
  and running** in parallel with the new Workers (operator
  decommission scheduled a few weeks out). See
  `alpha/hf-watcher/DECOMMISSIONED.md` for the migration
  table and the do-not-deploy warning.

## What's NOT archived (intentionally)

- **`contracts/`** — the Solidity tree was unchanged by the
  Stage 3 / Stage 4 refactor (only the JS/TS source tree
  moved). The canonical `contracts/` folder on `main` HEAD
  *still has* every file as it stood at the cutover commit;
  duplicating it here would cache hundreds of files of byte-
  identical Solidity inside git for no purpose. To reconstruct
  contracts at the cutover state:

  ```bash
  # View a single file at the cutover
  git show f48c99fa5db2ff718344b929b62c5b7720590ae2:contracts/src/facets/OfferFacet.sol

  # Pull the entire cutover tree into a temporary worktree
  git worktree add /tmp/vaipakam-cutover f48c99fa5db2ff718344b929b62c5b7720590ae2

  # Diff current contracts against the cutover
  git diff f48c99fa5db2ff718344b929b62c5b7720590ae2..HEAD -- contracts/
  ```

  After the few-week archive window closes, this README's commit-
  pin is the only thing the operator needs to reconstruct the
  contracts at the cutover — git itself preserves the rest.

- **`packages/{contracts, lib, ui}`** — these packages didn't
  exist at the cutover commit (they were created by Stage 1b/c/d
  of the refactor). Nothing to archive.

- **`ops/{lz-watcher, subgraph, tenderly}`** — active production
  tooling, not deprecated. Stays under `ops/` on main.

## Removal schedule

The entire `alpha/` tree is scheduled for full deletion once the
new architecture has been live for a few weeks without a fallback
being needed. Operator gives the go-ahead; cleanup is a single
`rm -rf alpha/` commit on `main`.

Cloudflare-side, the operator separately decommissions the
`vaipakam-alpha` and `vaipakam-hf-watcher` Workers + unbinds
their custom domains at the same time.

## Do not patch

If you find yourself wanting to edit a file under `alpha/`,
stop and ask: is the change needed against the live
architecture? If yes — edit `apps/{www,defi,keeper,indexer,agent}`,
`packages/*`, or `contracts/`, and let the live build pipeline
ship it. If you genuinely need to redeploy from this archive
(emergency rollback), the operational playbook is to roll the
live Workers back to a known-good earlier commit on `main`, not
to revive the archive's build pipeline.
