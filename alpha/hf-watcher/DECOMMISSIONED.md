# DECOMMISSIONED — frozen archive of the pre-Stage-3 monolithic watcher

This folder is a **frozen snapshot** of the historical
`ops/hf-watcher/` Cloudflare Worker, restored from
`main@f48c99fa5db2ff718344b929b62c5b7720590ae2` (the last main-
branch commit before the Stage 3 Worker decomposition landed).
The source was deleted from `ops/hf-watcher/` on 2026-05-08 in
commit `f29b31d` and re-introduced here under `alpha/hf-watcher/`
on 2026-05-09 to provide a code-side reference during the
Stage 3 / Stage 4 refactor cutover window. The archive lives
outside the pnpm workspace (top-level `alpha/`, sibling of
`apps/`, `ops/`, `contracts/`) so workspace-wide commands skip
it automatically.

## What replaced it

The single `vaipakam-hf-watcher` Worker that this folder used
to deploy was carved into three single-purpose Workers in the
2026-05-08 Stage 3 split:

| New Worker        | Responsibility                                             |
|-------------------|------------------------------------------------------------|
| `apps/keeper`     | HF watcher loop + autonomous liquidation submission + HF-band Telegram / Push alerts + daily oracle-snapshot signer (post-rebalance). Holds the only signing key in the new architecture. |
| `apps/indexer`    | chain → archive-database event ingestion + open-CORS public read API at `indexer.vaipakam.com` (the `/offers/*`, `/loans/*`, `/activity`, `/claimables/*` endpoints the connected app reads from). Read-only. |
| `apps/agent`      | proactive notifications + cross-chain monitoring + operator services (Frames, Telegram bot, /diag/record) + frontend-facing settings endpoints. Public-facing CORS surface. No signing key. |

The Stage 3 plan + classification matrix is documented in
`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`.

## Cloudflare-side state at archive time

The Cloudflare Worker `vaipakam-hf-watcher` is **still bound
and running** at archive time. The operator schedule is to
decommission it from Cloudflare's side a few weeks after the
new architecture stabilises — until then the live Worker
keeps doing its three historical jobs (HF watch, chain
ingest, public read API) in parallel with the three new
Workers that have taken over those jobs. Code-wise the new
Workers are the source of truth; the old Worker survives as
a hot fallback.

## Do NOT patch this folder

Emergency hotfixes go via redeploy from the new
`apps/{keeper,indexer,agent}` source — patching this archive
will NOT propagate to the live `vaipakam-hf-watcher` Worker
because the build pipeline that fed that Worker no longer
exists in the workspace (the `apps/` workspace defines the
new Workers; this `alpha/hf-watcher/` folder is outside
the workspace entirely and has no CI hookup).

If you find yourself wanting to edit a file here, stop and
ask: is the change actually needed against the new
architecture? If yes, edit `apps/keeper`, `apps/indexer`, or
`apps/agent` and let the new pipeline ship it. If you
genuinely need to touch the live legacy Worker, the
operational playbook is to decommission it from CF earlier
than scheduled, not to revive this folder's build pipeline.

## Removal schedule

The entire `alpha/` tree (this folder + `alpha/frontend/`)
is scheduled for full deletion from the repo once the new
architecture has been live for a few weeks without a
fallback being needed. Cleanup is a single `rm -rf alpha/`
commit on `main` once the operator gives the go-ahead.
The deletion will be a single mechanical commit when the
operator gives the go-ahead.
