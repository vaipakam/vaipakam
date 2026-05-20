# @vaipakam/lib

**Framework-agnostic shared utilities consumed by every Worker + frontend in the monorepo.**

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)

## What is this

The **lowest layer of shared off-chain code** — utilities that have no React / Vite / Worker-specific dependency, so every consumer can import them. Consumers today: `apps/defi`, `apps/www`, `apps/agent`, `apps/indexer`, `apps/keeper`.

Current scope (Stage 2a of the source-tree refactor):

- `multicall` — viem-based batched RPC helpers.
- `decodeContractError` — error normaliser for revert reasons across facets.
- `chainPlatforms` — `chainId → CoinGecko platform slug` mapping.
- `canonicalAssets` — per-chain ERC-20 allow-lists.
- `crossDomainPref` — parent-domain cookie helper for theme + language sync between `defi.vaipakam.com` and `www.vaipakam.com`.

**Non-goals:** anything that needs React (use `packages/ui`), anything that needs Vite env vars (stays in the consumer), anything contract-specific (use `packages/contracts`). Two candidate modules (`format` with i18n, `journeyLog` with contracts/config) are deferred until their Vite-coupled deps are extracted.

## How to run

No dev loop — pure library code, imported by consumers.

## How to test

```bash
pnpm --filter @vaipakam/lib exec tsc --noEmit
```

Per-function unit tests live alongside the source where they exist; the bar is "framework-agnostic, deterministic".

## Architecture

- Stage 2a source-tree refactor: [`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md).
- Extraction discipline: only move a module here once every consumer can import it without dragging in a framework-coupled transitive dep.

## Configuration

None — package is framework-agnostic by design.

## Related

- `packages/contracts` — for ABI / deployment data.
- `packages/ui` — for React-coupled shared primitives (sister package; this one is React-free).
- Every consumer under `apps/*`.
