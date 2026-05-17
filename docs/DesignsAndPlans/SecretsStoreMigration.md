# Secrets Store Migration — Design (T-078)

**Card:** T-078 · **Issue:** [#31](https://github.com/vaipakam/vaipakam/issues/31)
**Status:** design — store provisioned, migration not yet implemented.

## 1. Context

Every Worker's secrets are set per-Worker with `wrangler secret put`.
Several are **duplicated across Workers** — rotating one means
updating each Worker that holds it. This migrates all Worker secrets
to the account-level **Cloudflare Secrets Store**: define once, bind
into the Workers that need it.

## 2. Store

Provisioned 2026-05-17:

- Name: `vaipakam-credentials`
- Store ID: `1e66429d0fa24aa38a27bc05b7bcf63e`
- Account: `f8d28a27e95d4eab69364d7b3341fa7d`

> Cloudflare Secrets Store is an **open beta**. Decision below (§4)
> accepts that for all secrets including signing keys.

## 3. Secret inventory

| Secret | Used by | Kind | Shared |
| --- | --- | --- | --- |
| `RPC_BASE/ETH/ARB/OP/ZKEVM/BNB/POLYGON` + `*_SEPOLIA` / `*_TESTNET` / `POLYGON_AMOY` | agent, keeper, indexer | RPC URL (carries an API key) | all 3 |
| `TG_BOT_TOKEN` | agent, keeper | Telegram bot token | yes |
| `ZEROEX_API_KEY` | agent, keeper | aggregator API key | yes |
| `ONEINCH_API_KEY` | agent, keeper | aggregator API key | yes |
| `PUSH_CHANNEL_PK` | agent, keeper | **signing key** (Push channel) | yes |
| `BLOCKAID_API_KEY` | agent | scanner API key | no |
| `DIAG_WALLET_HMAC_KEY` | agent | HMAC key | no — added by T-075 |
| `KEEPER_PRIVATE_KEY` | keeper | **on-chain signing key** (moves funds) | no |

**Not migrated** — non-secret config stays in `wrangler.jsonc`
`vars`: `TG_BOT_USERNAME`, `FRONTEND_ORIGIN`, `KEEPER_ENABLED`,
`DIAG_SAMPLE_RATE`, `DIAG_RETENTION_DAYS`,
`CANCELLED_OFFER_RETENTION_DAYS`, and the `LIQ_*` / `SPLIT_*` /
`PARTIAL_LIQ_*` keeper tuning knobs. These are configuration, not
secrets.

## 4. Decision (operator, 2026-05-17)

**Move all secrets — including the signing keys `KEEPER_PRIVATE_KEY`
and `PUSH_CHANNEL_PK` — into Secrets Store**, accepting Secrets
Store's open-beta status. One consistent mechanism, central
management, an audit log, single-point rotation for the shared
secrets.

## 5. Mechanics

- **Store** — one (`vaipakam-credentials`), done.
- **Secret values** — `wrangler secrets-store secret create
  1e66429d0fa24aa38a27bc05b7bcf63e --name <NAME> --remote` (prompts
  for the value). **The operator runs these** — the secret values
  are operator-held; this migration only wires bindings + code.
- **Binding** — per Worker, a `secrets_store_secrets` array in
  `wrangler.jsonc`: `{ binding, store_id, secret_name }` per secret.
- **Runtime** — a Secrets Store binding is read **asynchronously**:
  `await env.<BINDING>.get()` returns the value, versus today's
  synchronous `env.<NAME>` string.

## 6. The async ripple

`env.RPC_*` (and the rest) stop being plain strings. The load-bearing
consumer is `getChainConfigs(env)` — a **synchronous** function in
all three Workers' `env.ts` that reads `env.RPC_*` directly. It
becomes `async`, and every caller must `await` it. The quote / scan
proxies likewise read `env.ZEROEX_API_KEY` etc. inline.

**Containment pattern (recommended).** Rather than thread `await`
through every call site, resolve all of a Worker's secrets **once**
at the entry point (`fetch` / `scheduled`) into a plain
`ResolvedEnv` object — `await` every `.get()` up front — and pass
that resolved object down. Inner code stays synchronous; the async
boundary is one place per Worker. This keeps the diff small and
auditable.

## 7. Coordination with PR #29 (T-075)

PR #29 added `DIAG_WALLET_HMAC_KEY` + the `DIAG_LEGAL_DOCS` R2
binding to `apps/agent`'s `env.ts` + `wrangler.jsonc`. **PR #29
merged 2026-05-17** and this branch is rebased onto the merged
`main`, so the 3-way-merge risk is resolved:

- `apps/agent`'s phase folds `DIAG_WALLET_HMAC_KEY` into the Secrets
  Store set; it stays last (phase 3) only because it has the
  broadest secret surface.
- `apps/keeper` and `apps/indexer` have **no overlap** with PR #29 —
  they go first regardless.

## 8. Phasing

| Phase | Scope | Notes |
| --- | --- | --- |
| 0 | Store provisioned | ✓ done |
| 1 | `apps/indexer` | Smallest surface (`RPC_*` only) — establishes the binding + boundary-resolve pattern. |
| 2 | `apps/keeper` | `RPC_*`, `TG_BOT_TOKEN`, `ZEROEX/ONEINCH`, `PUSH_CHANNEL_PK`, `KEEPER_PRIVATE_KEY`. |
| 3 | `apps/agent` | After PR #29 merges. Adds `BLOCKAID_API_KEY` + `DIAG_WALLET_HMAC_KEY`. |

Each phase: operator creates that Worker's secrets in the store →
wire bindings + code → typecheck → deploy.

> The original T-078 sketch said "agent first as the pattern" — that
> is revised to **indexer-first**, because agent overlaps PR #29 and
> indexer's `RPC_*`-only surface is the cleanest place to prove the
> pattern.

## 9. Open verification (beta product)

Confirm against current Cloudflare docs before coding:

- the exact `secrets_store_secrets` `wrangler.jsonc` binding fields;
- the runtime `.get()` API (return shape, caching, error behaviour);
- local-dev behaviour — does `wrangler dev` still let a gitignored
  `.dev.vars` override the binding, or is there a Secrets Store local
  mode? Tests / `wrangler dev` must not need real production secrets.

## 10. Out of scope

- Frontend (`apps/defi`) — not a Worker; Secrets Store does not
  apply. Its `VITE_*` values are bundled + public by design; the
  separate rule (no real secret in a `VITE_*` var; sensitive calls
  proxy through a Worker) is verified, not migrated, here.
- Per-environment (testnet vs a future mainnet deploy) secret
  separation — revisit when a distinct mainnet Worker set exists;
  for now there is one set.
