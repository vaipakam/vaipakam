# @vaipakam/ui

**Shared React components — framework-decoupled primitives only.**

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)

## What is this

React-coupled primitives shared between `apps/defi` (the connected app) and `apps/www` (the marketing site). The scope is deliberately narrow — **only components that have NO defi-only dependencies** (no `WalletContext`, no `useEnsName`, no `useTokenMeta`, no `coingecko` hooks, no Vite-env-aware modules) live here.

Current scope (Stage 2b of the source-tree refactor):

- `InfoTip` — info-icon tooltip pattern used in every form.
- `TokenIcon` — per-asset icon component (no on-chain reads; pure rendering).

Plus the `ChainPicker` component (consumed by both surfaces).

**Non-goals:** most candidate components in `apps/defi/src/components/` couple to defi-only hooks. Each will migrate here in a follow-up Stage 2c after its dependency chain is extracted. Don't add a component here if any of its imports need to be defi-specific.

## How to run

No dev loop — components are imported by consumers.

## How to test

```bash
pnpm --filter @vaipakam/ui exec tsc --noEmit
```

Visual / interaction testing happens in the consuming app's surface (Storybook is on the backlog for post-mainnet).

## Architecture

- Stage 2b source-tree refactor: [`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md).
- Extraction discipline: a component only moves here once it has zero defi-coupled imports. If a candidate has a `WalletContext` usage, leave it in `apps/defi/src/components/` until the dependency is broken.

## Configuration

None — primitives don't need configuration.

## Related

- `packages/lib` — sister package; framework-agnostic utilities.
- `apps/defi` — the connected app; primary consumer.
- `apps/www` — the marketing site; secondary consumer.
