## Thread — Delete dead alpha/ + ops/lz-watcher/ trees (PR #<n>)

Removed the two legacy directories whose functional replacements have
been live for weeks but whose `package-lock.json` files were still
generating Dependabot security alerts.

`alpha/` (451 git-tracked files) carried the original v1
React/Vite frontend and a first-generation Cloudflare-Worker
HF-watcher that pre-dated the Stage 3 source-tree refactor. The live
versions live under `apps/defi`, `apps/keeper`, `apps/indexer`, and
`apps/agent` — they reuse none of the alpha code, only the design
ideas — and the whitepaper that briefly lived under `alpha/` was
already re-homed to `apps/www/src/content/whitepaper/`. Six
Dependabot alerts on `alpha/frontend/package-lock.json` and one on
`alpha/hf-watcher/package-lock.json` are closed by removing the
manifests.

`ops/lz-watcher/` (16 git-tracked files) was the LayerZero-era
keeper that T-068's CCIP migration replaced with the receive-side
in `apps/keeper`. After the migration merged in May 2026 the
directory has been unreachable from any live import or workflow;
the single Dependabot alert on `ops/lz-watcher/package-lock.json`
disappears with it.

This is Phase 4 of issue #135 — closing the last 8 of the 366
open Dependabot alerts the audit-prep triage started from. No
runtime change; the deletion is git-tracked-only and reversible
from history if the legacy code ever needs to be re-checked. The
sibling `ops/{subgraph,tenderly}/` directories stay — both are
operationally live (subgraph indexer config, Tenderly observability
config). The `dependabot.yml` config does not need an update — once
the manifests are gone Dependabot stops scanning them.

Closes #135.
