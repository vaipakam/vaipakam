## Thread — ops/lz-watcher ws security pin (follow-up to #135)

Closed the last open Dependabot alert from the issue #135 audit-prep
sweep — `ws < 8.20.1` (GHSA-58qx-3vcg-4xpx, uninitialized-memory
disclosure) — by adding an `overrides` clause to
`ops/lz-watcher/package.json` pinning `ws` to `^8.20.1`.

The same advisory was fixed for the pnpm workspace in PR #137 via
`pnpm.overrides`, but `ops/lz-watcher` is intentionally outside that
workspace (the workspace yaml notes it's "a Cloudflare Worker but
deliberately separate for trust-boundary reasons" — internal ops
Telegram surface, distinct from the public-facing keeper Worker).
That separation means the pnpm-tree fix didn't reach it, so this
follow-up applies the equivalent fix in lz-watcher's own npm tree.

After `npm install` resolves the override, both vulnerable ws paths
(viem → ws 8.18.3 and miniflare → ws 8.18.0) consolidate to a single
ws@8.20.1; `npm audit` reports 0 vulnerabilities. `tsc --noEmit`
typechecks clean.

With this PR merged and the Dependabot rescan of the alpha
deletions in #143 settled, the open-alert count for the repo drops
to **zero** — the audit-prep deliverable for issue #135 is fully
closed.
