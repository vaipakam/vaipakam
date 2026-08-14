# @vaipakam/agent

**Proactive notifications + operator-side service Worker. Holds aggregator + push + bot credentials. No ON-CHAIN transaction key — by design; it does hold `PUSH_CHANNEL_PK`, a real Ethereum key used to sign Push notifications.**

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)

## What is this

The **proactive-notifications + public-Frame + operator-services Worker**. Stage 3 PR4 of the Worker split (see [Stage3WorkerSplitPlan.md](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md)). Four responsibilities:

- **Proactive notifications** — periodic interest pre-notify; Push + Telegram dispatchers (`PUSH_CHANNEL_PK` + `TG_BOT_TOKEN`).
<!-- #1651: a "Cross-chain monitoring — buy-watchdog reconciliation across the CCIP buy flow" bullet stood here. #687-A removed that surface and its watchdog, and this Worker has no other cross-chain-monitoring concern, so the responsibility is gone rather than renamed. -->
- **Public Farcaster Frame** — `/frames/active-loans` GET + POST + image rendering.
- **Operator services** — server-side aggregator quote proxies at `/quote/{0x,1inch}`. (#1651: a Blockaid scan proxy at `/scan/blockaid` was listed here; ET-001 dropped it — `index.ts` documents that no transaction-scan proxy exists and the pre-sign preview is a frontend `eth_call`.)
- **Frontend-facing endpoints** — Telegram-bot webhook `/tg/webhook`; diagnostics record capture `/diag/record`; settings endpoints `/thresholds PUT` + `/link/telegram POST`; support-ticket capture `/support/ticket POST` (#1040 phase 1 — D1 row + ops-Telegram notify via `TG_OPS_BOT_TOKEN`/`TG_OPS_CHAT_ID`, plain `wrangler secret put` secrets; while unset the notify skips and tickets still land in D1).

**This Worker holds no ON-CHAIN transaction key.** The Stage 3 architectural-rebalance moved `KEEPER_PRIVATE_KEY` (and the daily oracle snapshot signer it powered) to `apps/keeper`, so this Worker **can't move funds directly** — that part of the staging plan §2 contract holds. Note the qualifier: it is not fund-safe. Via the shared database-scoped D1 binding it can corrupt state the signing Worker acts on (#1722), so the absence of its own transaction key establishes only the *direct* case.

Two things it used to say alongside that are **withdrawn**:

- **"holds NO signing key"** — `PUSH_CHANNEL_PK` is an Ethereum private key, instantiated as an ethers `Wallet` in `src/push.ts` to sign Push notifications as the channel. No **protocol** authority — it holds no Diamond role and can't move loan or treasury funds — but it is not authority-free either: `AdminKeysAndPause.md` records the channel-owner wallet as holding the 50 PUSH staking deposit and ~$50 of native gas, so a thief gets a funded EOA along with the right to push arbitrary notifications to every subscriber. Saying "no on-chain authority" of a key that owns an on-chain stake reads as *nothing on-chain to lose*, which is the wrong instruction for a responder. Real signing material a secret reviewer must not skip.
- **"a compromised agent produces stale data"** — it deletes diagnostics and support records on a schedule (`pruneOldSupportTickets` enforces the 12-month deletion promise), writes `loans`, sends Push/Telegram to real users, and publishes listings via `/opensea/listing`. A defect or compromise here means data loss, mis-sent notifications, and publication to a live marketplace — bounded, and the bounds matter: `openseaPublish.ts` posts an **empty `0x` signature**, which OpenSea accepts only because the vault's ERC-1271 check recognises an order hash the borrower already bound **on-chain**. So a compromised Worker can re-expose an already-authorised listing and impose removal latency, but **cannot manufacture one** (no on-chain binding, no listing) and **cannot preserve one** (the borrower's `cancelPrepayListing` revokes the binding and OpenSea drops it on the next revalidation pass). An earlier version of this called it "irreversible upstream publication", which overstated the blast radius in both directions.

  Separately, and unbounded by any of that: via the shared database-scoped D1 binding it can corrupt state the signing Worker acts on (#1722). None of this is "stale data".

**Non-goals:** no autonomous on-chain submissions (those belong to `apps/keeper`); no chain-event indexing into D1 (that belongs to `apps/indexer`).

**This Worker DOES expose user-facing writes** — `PUT /thresholds`, `POST /link/telegram`, `POST /support/ticket` and the diagnostics endpoints all mutate D1 or external state. This section used to claim "no user-facing write endpoints (writes happen via the connected app + a wallet signature)". Both halves were wrong. **Their authentication differs per route — do not assume one answer covers them:**

| Route | Proof required |
|---|---|
| `POST /link/telegram` | **EIP-191 ownership proof**, parsed and verified before a code is issued |
| `POST /unlink/telegram` | **EIP-191 ownership proof** (scoped to unlink). Note what this route *is*: clearing the wallet ↔ `tg_chat_id` link is an **alert-suppression** surface — a successful unlink silently stops every Telegram HF/interest alert for that wallet |
| `POST /telegram/test` | **EIP-191 ownership proof** (scoped to test-send). Sends a real message to the linked chat |
| `POST /tg/webhook` | **a one-time six-digit code**, not a signature and not a Telegram secret. Dispatched at `index.ts:166-167` **before** the Origin gate and with no webhook-secret header, so any caller may POST JSON; what bounds it is that the code was issued only after an EIP-191 proof on `/link/telegram` and is consumed on first use. It is the **completion half** of that handshake, and it writes the caller-supplied chat ID — so guessing a live code redirects a wallet's alerts. Do not count it among the unsigned routes below: those are open, this one holds a bearer secret |
| Diagnostics administration (legal-hold / erasure) | signature- or role-gated |
| `POST /support/ticket` | **none** — deliberately accepts no wallet identity |
| `POST /diag/record` | **none** — CORS + rate limiting only |
| `PUT /thresholds` (ordinary path) | **none** — signature-free |
| `POST /intent/fusion/post` | **none at request level** — origin + rate-limit are the enforced controls. The on-chain commitment check is **best-effort, not a control**: it runs only when `ONEINCH_API_KEY` is set and the chain has an RPC URL, and when the receipt fetch or the `getIntentCommit` read errors, `preflightCommitOnChain` returns `degraded` and the handler deliberately proceeds to Fusion. Only an affirmative `reject` stops a request. Reading it as authentication would credit this route with a gate that opens on RPC trouble. Mutates external resolver state |
| `POST /opensea/listing` | **none at request level** — origin + rate-limit. Publishes to a live marketplace under the project's `OPENSEA_API_KEY`; the vault's ERC-1271 check over a borrower-bound order hash is what actually authorises it |

An earlier version of this paragraph swung the other way and called the whole set "not wallet-signature-gated", which erased the real controls on the gated routes — `POST /link/telegram`, `POST /unlink/telegram`, `POST /telegram/test` and diagnostics administration. Name them rather than counting them: an earlier draft said "the first two", which silently went stale the moment the table grew.

Those last two are **credential-backed publication paths**: they change state
outside this project — a resolver network and a public marketplace — using the
project's own API keys rather than any user's signature. An earlier version of
this table omitted both, which preserved a false "unsigned three" count and hid
the two routes whose controls differ most from the rest.

**The unsigned routes are not uniformly protected either.** `POST /support/ticket`, `POST /diag/record`, `POST /intent/fusion/post` and `POST /opensea/listing` each have a rate-limit binding; **`PUT /thresholds` has none** — it is reached after the origin check and neither its dispatch nor `handlePutThresholds` calls a limiter, so unbounded threshold upserts are NOT mitigated. An earlier draft said the unsigned routes were protected by "origin checks and rate limits", which asserted a control that does not exist on that route. Check the specific route.

## How to run

```bash
pnpm --filter @vaipakam/agent dev       # local wrangler dev
pnpm --filter @vaipakam/agent run deploy    # wrangler deploy; uses `wrangler login` on the operator's machine
```

## How to test

```bash
pnpm --filter @vaipakam/agent typecheck
pnpm --filter @vaipakam/agent exec tsc -p . --noEmit
```

## Architecture

- Stage 3 Worker split: [`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md).
- Staging plan §2 signing-key placement — the load-bearing reason this Worker holds no ON-CHAIN transaction key. (It is not keyless: see `PUSH_CHANNEL_PK` above.)
- ADR-0004 (CCIP migration) — cross-chain context. (#1651: previously cited for the buy-watchdog responsibility, removed with #687-A.)

## Configuration

Worker `wrangler.jsonc:vars`:

- `FRONTEND_ORIGIN`, `TG_BOT_USERNAME`, `DIAG_*` knobs.

Worker secrets (via `wrangler secret put`):

| Secret | Purpose |
|---|---|
| `RPC_*` | Per-chain RPC URLs (carry API keys). |
| `TG_BOT_TOKEN` | Telegram bot credential (user-facing bot). |
| `TG_OPS_BOT_TOKEN` | Ops-internal bot credential — instant new-support-ticket alert (#1040 phase 1). While unset the alert skips (warn-logged) and tickets still land in D1; the nightly ops report's open-ticket count is the backstop. |
| `TG_OPS_CHAT_ID` | Operator chat the ops bot posts to. Same skip-while-unset behaviour. |
| `PUSH_CHANNEL_PK` | Push channel signing key — **an Ethereum private key**, loaded as an ethers `Wallet` in `src/push.ts`. This row used to say "not a chain key — a push protocol identity"; it is a real key, which is not the same thing. It carries no **protocol** authority (no Diamond role, no fund movement), but it is not authority-free: the channel-owner wallet holds the 50 PUSH staking deposit and ~$50 of native gas (`docs/ops/AdminKeysAndPause.md`). A revision of this row said "no on-chain authority", which tells a responder there is nothing on-chain at stake — there is. |
| `ZEROEX_API_KEY` / `ONEINCH_API_KEY` | Aggregator quote proxy credentials. |

No `KEEPER_PRIVATE_KEY` here — that's `apps/keeper` exclusively.

### D1 — shared `vaipakam-archive` (staging)

The `DB` binding in `wrangler.jsonc` points at the **`vaipakam-archive`** D1 database (id `3cffebf5-b652-4da7-953c-9e1d143ad2fe`), the **staging** database the Cloudflare staging deploy uses — see [`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md`](../../docs/DesignsAndPlans/CloudflareStagingDeployPlan.md) §3 for the staging-vs-primary split. The same db is **shared** with `apps/indexer` and `apps/keeper`.

Agent writes: `user_thresholds`, `notify_state`, `telegram_links`, `loans`, `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit`, `support_tickets` (#1040 phase 1 — `POST /support/ticket`).
Agent reads-only: (none — every table the agent reads, it also writes.)

**There is no `apps/agent/migrations/` directory by design.** The canonical schema for every table this Worker touches lives in [`apps/indexer/migrations/`](../indexer/migrations/) — the indexer owns the schema, the other two Workers share the database. Schema changes for tables only agent writes still land as a new `apps/indexer/migrations/NNNN_*.sql` file; applying it via `wrangler d1 migrations apply vaipakam-archive --remote` from inside `apps/indexer/` updates the live staging db for all three consumers.

## Related

- `apps/keeper` — sibling signing Worker; this one defers all on-chain submissions to it.
- `apps/indexer` — sibling read-API Worker; this Worker reads from there for stats it doesn't compute locally.
- `apps/defi` — primary consumer of `/quote/*`, `/diag/record`, `/thresholds`, `/link/telegram`.
- `packages/contracts` — ABI / deployment source.
