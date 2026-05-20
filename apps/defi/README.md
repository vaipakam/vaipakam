# @vaipakam/defi

**The connected app — `defi.vaipakam.com`. React + Vite SPA. Wallet, on-chain reads, every user-facing action.**

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)
[![CodeQL](https://github.com/vaipakam/vaipakam/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/codeql.yml)

## What is this

The **wallet-connected user surface** of Vaipakam. Where lenders post offers, borrowers accept them, holders manage their loans, claimants withdraw their proceeds, and the protocol console exposes its diagnostic + admin views. Served at `defi.vaipakam.com`.

Architecturally:

- Vite SPA (React 18 + TypeScript), deployed as a Cloudflare Workers Static-Assets shape.
- Wallet via wagmi v2 + ConnectKit (`injected({ target: "metaMask" })` + `coinbaseWallet()` + `walletConnect()` + `safe()`).
- Chain reads via the Vaipakam Diamond + per-facet ABIs from `@vaipakam/contracts`.
- Indexer / analytics reads via `apps/indexer` at `VITE_INDEXER_ORIGIN`.
- Operator services (aggregator quote proxies, Blockaid scan, settings endpoints) via `apps/agent` at `VITE_AGENT_ORIGIN`.

**Non-goals:** no signing-key handling (every tx flows through the user's connected wallet); no chain-event indexing (delegated to `apps/indexer`); no autonomous on-chain submissions (delegated to `apps/keeper`); no notification dispatch (delegated to `apps/agent`). This Worker is the **interactive surface**; other Workers are the autonomous + read-API surfaces.

## How to run

```bash
pnpm --filter @vaipakam/defi dev       # local Vite dev server with hot reload
pnpm --filter @vaipakam/defi build     # production build
pnpm --filter @vaipakam/defi deploy    # via .github/workflows/deploy-workers.yml
```

A `.env.local` is required for the dev loop — see Configuration below.

## How to test

```bash
pnpm --filter @vaipakam/defi exec tsc -b --noEmit     # typecheck (CI-equivalent)
pnpm --filter @vaipakam/defi test                     # vitest run (when applicable)
pnpm --filter @vaipakam/defi build                    # smoke-build
```

Note: `apps/defi` doesn't have a `typecheck` npm script — the canonical typecheck is `tsc -b --noEmit` per `CLAUDE.md`. Per-workspace `pnpm -r typecheck` would silently SKIP `apps/defi`; use the explicit form above.

## Architecture

- Connected-app surface design: across multiple `docs/DesignsAndPlans/` docs by feature area.
- Wallet connector decisions: [`src/lib/wagmiConfig.ts`](src/lib/wagmiConfig.ts) header comment.
- Permit2 try-fallback (Phase 8b): [`docs/ReleaseNotes/`](../../docs/ReleaseNotes/) recent entries.
- Source-tree refactor history: [`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md).

## Configuration

`.env.local` (frontend env — see [`CLAUDE.md` § "Deployments sync"](../../CLAUDE.md) for the canonical list):

| Variable | Purpose |
|---|---|
| `VITE_*_RPC_URL` (per chain) | RPC URLs with API keys. |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect v2 project ID. |
| `VITE_DEFAULT_CHAIN_ID` | Default chain on first load. |
| `VITE_LOG_CHUNK_SIZE` / `VITE_LOG_FROM_BLOCK` | Indexer-aware tuning. |
| `VITE_PUSH_CHANNEL_ADDRESS` | Push channel discovery for HF alerts. |
| `VITE_FEATURE_*` | Feature flags. |
| `VITE_INDEXER_ORIGIN` | The `apps/indexer` Worker URL. |
| `VITE_AGENT_ORIGIN` | The `apps/agent` Worker URL. |

No signing keys here — the connected wallet is the signer for every action.

## Related

- `apps/www` — marketing site at `vaipakam.com`; this is the connected app at `defi.vaipakam.com`. Shares marketing-content base; this Worker overlays wallet + chain reads.
- `apps/indexer` — chain → D1 indexer + public read-API; this app's primary data source for offer / loan listings.
- `apps/agent` — proactive-notifications + operator-services Worker; this app's source for aggregator quotes, Blockaid scans, settings endpoints.
- `apps/keeper` — autonomous Worker; not user-facing but works in concert (liquidations affect loans this app displays).
- `packages/contracts` — ABI / deployment data; consumed at `@vaipakam/contracts/abis`.
- `packages/lib` — framework-agnostic utilities (multicall, decodeContractError, cross-domain prefs).
- `packages/ui` — shared React primitives.
