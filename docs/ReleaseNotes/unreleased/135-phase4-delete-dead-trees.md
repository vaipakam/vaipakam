## Thread — Delete the dead alpha/ archive (PR #<n>)

Removed the `alpha/` archive — the v1 React/Vite frontend and the
first-generation Cloudflare-Worker HF watcher that pre-dated the
Stage 3 source-tree refactor — whose `package-lock.json` files had
been the source of seven open Dependabot security alerts. The
deletion had been scheduled in `pnpm-workspace.yaml`'s archive
block ("Scheduled for full removal once the new architecture has
been live for a few weeks without a fallback being needed (single
`rm -rf alpha/` commit)"); this PR is that commit.

The live successors are `apps/defi` (in place of `alpha/frontend`)
and `apps/keeper`/`apps/indexer`/`apps/agent` (the Stage-3 Worker
split that subsumed `alpha/hf-watcher`). The Cloudflare Workers
that the archive sources last built — `vaipakam-alpha` and
`vaipakam-hf-watcher` — are operator-managed and have to be
undeployed via the Cloudflare dashboard separately; that's a runtime
action, not a repo change. If a fallback is ever needed,
`git checkout <this-commit>~ -- alpha` restores the tree byte-for-
byte from history.

The `pnpm-workspace.yaml` comment block that documented the archive
was replaced with a one-paragraph pointer to this commit so the
workspace layout doc stays self-describing.

Closes 7 Dependabot alerts (6 on `alpha/frontend/package-lock.json`,
1 on `alpha/hf-watcher/package-lock.json`).

What this PR does **NOT** touch:

- `ops/lz-watcher/` stays — it is **active production tooling**, a
  5-minute-cron Cloudflare Worker that watches the LayerZero V2 surface
  for DVN-count drift, OFT mint/burn imbalance, and oversized VPFI flow
  (alerts to the internal ops Telegram channel). Its single Dependabot
  alert (`ws < 8.20.1`) is the same advisory the workspace overrides in
  PR #137 closed for the pnpm tree — it will be addressed in a separate
  pass that extends the override or the Dependabot scope to that Worker.
- `ops/{subgraph,tenderly}/` stay — both are operationally live.

Closes part of #135 (Phase 4 of 4 — alpha only; the lz-watcher alert
is the one remaining open after this lands, tracked as a follow-up).
