# @vaipakam/ui

**Shared React components — framework-decoupled primitives only.**

> **ORPHANED as of #1854.** No source file imports this package any more:
> `apps/defi`, which had eleven importers, was deleted; `apps/app` neither
> declares nor imports it; `apps/www` retains an unused dependency entry.
> Nothing compiles `src/` either — the `typecheck` script runs ESLint only
> (no tsconfig, no `typescript` dep), so consumer builds and tests do NOT
> protect edits here. Whether the package gets real typechecking or is
> retired is #1963; treat the consumer list below as historical until that
> is decided.

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)

## What is this

React-coupled primitives, written to be shared between the connected app and `apps/www` (the marketing site) — though as noted above nothing imports them today. The scope is deliberately narrow — **only components that have NO defi-only dependencies** (no `WalletContext`, no `useEnsName`, no `useTokenMeta`, no `coingecko` hooks, no Vite-env-aware modules) live here.

Current scope (Stage 2b of the source-tree refactor):

- `InfoTip` — info-icon tooltip pattern used in every form.
- `TokenIcon` — per-asset icon component (no on-chain reads; pure rendering).

Plus the `ChainPicker` component (consumed by both surfaces).

**Non-goals:** most candidate components in `apps/app/src/components/` couple to defi-only hooks. Each will migrate here in a follow-up Stage 2c after its dependency chain is extracted. Don't add a component here if any of its imports need to be defi-specific.

## How to run

No dev loop — components are imported by consumers.

## How to test

```bash
pnpm --filter @vaipakam/ui exec tsc --noEmit
```

Visual / interaction testing happens in the consuming app's surface (Storybook is on the backlog for post-mainnet).

## Architecture

- Stage 2b source-tree refactor: [`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md).
- Extraction discipline: a component only moves here once it has zero defi-coupled imports. If a candidate has a `WalletContext` usage, leave it in `apps/app/src/components/` until the dependency is broken.

## Configuration

None — primitives don't need configuration.

## Related

- `packages/lib` — sister package; framework-agnostic utilities.
- `apps/app` — the connected app; primary consumer.
- `apps/www` — the marketing site; secondary consumer.
