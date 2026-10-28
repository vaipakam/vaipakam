# @vaipakam/agent

**Proactive notifications + operator-side service Worker. Holds aggregator + push + bot credentials. No ON-CHAIN transaction key — by design; it does hold `PUSH_CHANNEL_PK`, a real Ethereum key used to sign Push notifications.**

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)

## What is this

The **proactive-notifications + public-Frame + operator-services Worker**. Stage 3 PR4 of the Worker split (see [Stage3WorkerSplitPlan.md](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md)). Four responsibilities:

- **Proactive notifications** — periodic interest pre-notify; Push + Telegram dispatchers (`PUSH_CHANNEL_PK` + `TG_BOT_TOKEN`).
<!-- #1651: a "Cross-chain monitoring — buy-watchdog reconciliation across the CCIP buy flow" bullet stood here. #687-A removed that surface and its watchdog, and this Worker has no other cross-chain-monitoring concern, so the responsibility is gone rather than renamed. -->
- **Public Farcaster Frame** — `/frames/active-loans` GET + POST + image rendering.
- **Operator services** — the server-side 1inch quote proxy at `/quote/1inch`, the 1inch order-book post at `/intent/fusion/post`, and the `/opensea/*` proxies; all spend operator-held keys (see "Key-spending routes" below). (#1651: a Blockaid scan proxy at `/scan/blockaid` was listed here; ET-001 dropped it — `index.ts` documents that no transaction-scan proxy exists and the pre-sign preview is a frontend `eth_call`. #2755 removed `/quote/0x`, which had no caller.)
- **Frontend-facing endpoints** — Telegram-bot webhook `/tg/webhook`; diagnostics record capture `/diag/record`; settings endpoints `/thresholds PUT` + `/link/telegram POST`; support-ticket capture `/support/ticket POST` (#1040 phase 1 — D1 row + ops-Telegram notify via `TG_OPS_BOT_TOKEN`/`TG_OPS_CHAT_ID`, the two per-Worker `wrangler secret put` secrets; while unset the notify skips and tickets still land in D1).

**This Worker holds no ON-CHAIN transaction key.** The Stage 3 architectural-rebalance moved `KEEPER_PRIVATE_KEY` (and the daily oracle snapshot signer it powered) to `apps/keeper`, so this Worker **can't move funds directly** — that part of the staging plan §2 contract holds. Note the qualifier: it is not fund-safe. Via the shared database-scoped D1 binding it can corrupt state the signing Worker acts on (#1722), so the absence of its own transaction key establishes only the *direct* case.

Two things it used to say alongside that are **withdrawn**:

- **"holds NO signing key"** — `PUSH_CHANNEL_PK` is an Ethereum private key, instantiated as an ethers `Wallet` by the shared Push rail (`packages/push`) to sign Push notifications as the channel. No **protocol** authority — it holds no Diamond role and can't move loan or treasury funds — but it is not authority-free either: `AdminKeysAndPause.md` records the channel-owner wallet as holding the 50 PUSH staking deposit and ~$50 of native gas, so a thief gets a funded EOA along with the right to push arbitrary notifications to every subscriber. Saying "no on-chain authority" of a key that owns an on-chain stake reads as *nothing on-chain to lose*, which is the wrong instruction for a responder. Real signing material a secret reviewer must not skip.
- **"a compromised agent produces stale data"** — it deletes diagnostics and support records on a schedule (`pruneOldSupportTickets` enforces the 12-month deletion promise), writes `loans`, sends Push/Telegram to real users, and publishes listings via `/opensea/listing`. A defect or compromise here means data loss, mis-sent notifications, and publication to a live marketplace — bounded, and the bounds matter: `openseaPublish.ts` posts an **empty `0x` signature**, which OpenSea accepts only because the vault's ERC-1271 check recognises an order hash the borrower already bound **on-chain**. So a compromised Worker can re-expose an already-authorised listing and impose removal latency, but **cannot manufacture one** (no on-chain binding, no listing) and **cannot preserve one** (the borrower's `cancelPrepayListing` revokes the binding and OpenSea drops it on the next revalidation pass). An earlier version of this called it "irreversible upstream publication", which overstated the blast radius in both directions.

  Separately, and unbounded by any of that: via the shared database-scoped D1 binding it can corrupt state the signing Worker acts on (#1722). None of this is "stale data".

**Non-goals:** no autonomous on-chain submissions (those belong to `apps/keeper`); no chain-event indexing into D1 (that belongs to `apps/indexer`).

**This Worker DOES expose user-facing writes** — `PUT /thresholds`, `POST /link/telegram`, `POST /support/ticket` and the diagnostics endpoints all mutate D1 or external state. This section used to claim "no user-facing write endpoints (writes happen via the connected app + a wallet signature)". Both halves were wrong. **Their authentication differs per route — do not assume one answer covers them:**

| Route | Proof required |
|---|---|
| `PUT /thresholds` | **EIP-191 ownership proof over what the save changes** (#2754): the bands, the due-date reminder choice and a Push opt-in, each named or marked unchanged. The agent rebuilds the message from the body it received, so a signature covers that save and no other. It was signature-free except for a due-date opt-out until #2754 |
| `POST /link/telegram` | **EIP-191 ownership proof**, parsed and verified before a code is issued |
| `POST /unlink/telegram` | **EIP-191 ownership proof** (scoped to unlink). Note what this route *is*: clearing the wallet ↔ `tg_chat_id` link is an **alert-suppression** surface — a successful unlink silently stops every Telegram HF/interest alert for that wallet |
| `POST /telegram/test` | **EIP-191 ownership proof** (scoped to test-send). Sends a real message to the linked chat |
| `POST /tg/webhook` | **Telegram's webhook secret, then a one-time link code** (#2753). A request without the `X-Telegram-Bot-Api-Secret-Token` header Telegram sends (the secret is derived from the bot token; `scripts/register-telegram-webhook.mjs` registers it) is refused 401 before its body is read. The code is the completion half of the `/link/telegram` handshake: issued only after an EIP-191 proof there, 24 symbols (120 bits) from the Web Crypto generator, valid ten minutes and consumed on first use. It writes the sending chat's ID, so it is a bearer secret; it was a guessable six-digit number until #2753 |
| Diagnostics administration (legal-hold / erasure) | signature- or role-gated |
| `POST /support/ticket` | **none** — deliberately accepts no wallet identity |
| `POST /diag/record` | **none** — CORS + rate limiting only |
| `POST /intent/fusion/post` | **none at request level** — the Origin gate, the caller budget and the 1inch credential budget are the enforced controls (#2755). The on-chain commitment check is **best-effort, not a control**: it runs only when `ONEINCH_API_KEY` is set and the chain has an RPC URL, and when the receipt fetch or the `getIntentCommit` read errors, `preflightCommitOnChain` returns `degraded` and the handler deliberately proceeds to Fusion. Only an affirmative `reject` stops a request. Reading it as authentication would credit this route with a gate that opens on RPC trouble. Mutates external resolver state |
| `POST /opensea/listing` | **none at request level, but bound to protocol state** (#2755) — the Origin gate and both budgets, and the order is published only when Seaport's hash of the submitted components is one the Diamond's listing executor reports live (`src/openseaListingBinding.ts`); a chain read that fails refuses the post. Publishes to a live marketplace under the project's `OPENSEA_API_KEY`; the vault's ERC-1271 check over a borrower-bound order hash is what authorises the order itself |

An earlier version of this paragraph swung the other way and called the whole set "not wallet-signature-gated", which erased the real controls on the gated routes — `PUT /thresholds` (since #2754), `POST /link/telegram`, `POST /unlink/telegram`, `POST /telegram/test` and diagnostics administration. Name them rather than counting them: an earlier draft said "the first two", which silently went stale the moment the table grew.

Those last two are **credential-backed publication paths**: they change state
outside this project — a resolver network and a public marketplace — using the
project's own API keys rather than any user's signature. An earlier version of
this table omitted both, which preserved a false "unsigned three" count and hid
the two routes whose controls differ most from the rest.

**The four signed alert routes share one entry and two more controls** (#2754, #2753). `PUT /thresholds`, `POST /link/telegram`, `POST /unlink/telegram` and `POST /telegram/test` all authorise through `authoriseAlertRequest` (`src/linkAuth.ts`): it verifies the signature, then claims the exact signed message once in the shared D1 ledger `signed_request_use`, so a captured request cannot be presented a second time (409 `request-already-used`; 503 while that table's migration is pending, never an unrecorded acceptance). A per-IP limiter (`ALERT_WRITE_RATELIMIT`, 20 a minute) runs at the router before any signature work. Until #2754 `PUT /thresholds` had no limiter and no signature, so any caller could rewrite any wallet's bands and Push opt-in.

**The unsigned routes are not uniformly protected either.** `POST /support/ticket`, `POST /diag/record`, `POST /intent/fusion/post` and `POST /opensea/listing` each have a rate-limit binding. An earlier draft said the unsigned routes were protected by "origin checks and rate limits" while one of them had no limiter, which asserted a control that did not exist on that route. Check the specific route.

### Key-spending routes and the one limiter rule (#2755)

`/quote/1inch`, `/intent/fusion/post` and the four `/opensea/*` proxies call a third party with a key this Worker holds. Each is gated three ways, in order:

1. **The Origin gate** (`FRONTEND_ORIGIN`). It stops another site's page from spending the key through a visitor's browser. It does NOT stop a scripted caller, which can send any `Origin` header, so it is not authentication.
2. **A caller budget** per client IP, taken at the router before the route does any work (`callerBudgetFor` in `src/index.ts`).
3. **A credential budget** per key — `ONEINCH_UPSTREAM_RATELIMIT` (shared by both 1inch routes) and `OPENSEA_UPSTREAM_RATELIMIT` (shared by every OpenSea route) — charged one slot immediately before each upstream call, so a request pays for the calls it makes. The OpenSea offers walk used to charge `1 + 2 × MAX_PAGES` slots before its first call; it now charges per call. A leg holding a partial list (the page ceiling with a cursor left, a later page failing, or a slot not taken) says `truncated`, and a leg the budget stopped carries `stoppedBy` with the refusal's name (`upstream-quota` for a spent budget, a 503 name for a limiter that could not count).

Every limiter in this Worker, these and the others, goes through one rule in `@vaipakam/lib/rateLimit` (since #2756 shared with the indexer; `src/rateLimit.ts` adds this Worker's CORS answer and credential budgets on top): a binding that is missing or throws REFUSES (503 `rate-limit-binding-missing` / `rate-limit-unavailable`), a spent budget answers 429. Callers keep the outcome rather than reduce it to yes/no: the wallet-signature chain path (`SIG_VERIFY_RATELIMIT`) answers a spent budget 429 and a limiter that could not count 503 (`limitedRefusal` in `src/walletSigVerify.ts`). Before #2755 most routes let a request through in both cases. `test/rateLimit.test.ts` pins that every binding the code reads is declared in `wrangler.jsonc`; `packages/lib/src/publicEndpointRules.test.ts` pins, for every Worker, that no source file calls a limiter binding or names a limiter failure itself.

### Bounded request bodies (#2756)

Every body this Worker accepts is read through `@vaipakam/lib/requestBody`, up to a cap stated beside its handler: 4 KiB for a quote, 16 KiB for a signed alert request, a Fusion post, a fee-recipient preflight, a frame post or a diagnostics record, 32 KiB for an OpenSea listing, 64 KiB for a support ticket, 256 KiB for a Telegram update, and a legal-hold upload's document cap plus 64 KiB for its form. A declared length over the cap is refused 413 `body-too-large` without reading; a body that streams past it is refused at the first chunk over. A body that is not JSON is 400 `invalid-json` on every route. Before #2756 each handler called `req.json()`, which buffers whatever arrives. The same test file pins that no Worker source reads a request body any other way.

`/intent/fusion/post` answers an unsupported chain and an unset key with its queued acknowledgement BEFORE the on-chain preflight, so neither case spends an RPC call (it used to run the preflight first).

What the budgets do not do: Cloudflare counts each namespace per location, eventually consistently, so a credential budget bounds the key's spend per location; it is not an exact global meter. The 1inch key is the same Secrets Store entry the keeper quotes liquidations with, which is why this Worker's 1inch budget sits well below the key's tier.

`POST /opensea/listing` is also bound to protocol state (table above). None of the `/opensea/*` routes has a caller today: OpenSea serves mainnets only, Vaipakam has no mainnet deployment, and `apps/app` has not ported the OpenSea surfaces from the retired `apps/defi`.

## How to run

```bash
pnpm --filter @vaipakam/agent dev       # local wrangler dev
pnpm --filter @vaipakam/agent run deploy    # verifies the shared D1 schema, then wrangler deploy; uses `wrangler login` on the operator's machine
```

**The deploy verifies the shared D1 schema first** (#2409). This Worker binds the shared `vaipakam-warm` database, whose schema `apps/indexer` owns, so `run deploy` runs `apps/indexer/scripts/deploy-shared-d1.mjs verify` before publishing: a read-only check that every migration the build carries is recorded. It waits up to ten minutes for the indexer's deploy to apply pending ones, then refuses to publish onto an older schema. It never applies migrations itself. So the token needs **D1 read** as well as Worker publish rights, and on a release that carries a migration, **deploy the indexer first**. `run deploy` takes no arguments; a dry run is `run deploy:dry`, which never touches the database.


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
- `PUSH_CHANNEL_ADDRESS` (optional, #1456) — the Push channel the signer posts for. Unset, the channel is the signer's own address; set, `PUSH_CHANNEL_PK` signs as that channel's delegate. `GET /push/status` reports the channel the rail will use, and the app's subscribe link reads it from there. Since #2667 it also covers the keeper's rail, as the keeper last published it to the shared `push_rail_status` row: `scope: 'service'` while that row is under 15 minutes old (both rails must be able to send, on the same channel), `scope: 'agent'` otherwise. Every answer also carries `billedChainIds` (#2723), the chains on which this service charges the paid-Push notification fee. It is a constant in code, not a setting, and it is empty because no sender here calls `markNotifBilled`. The app offers the on-chain agreement to pay only on a listed chain, and withdrawing that agreement everywhere.

Credentials. Most are **account-level Secrets Store** bindings (store `vaipakam-credentials`, declared under `secrets_store_secrets` in `wrangler.jsonc`), set with `wrangler secrets-store secret update`. Two are plain **per-Worker** secrets, set with `wrangler secret put`. The two commands are not interchangeable: `wrangler secret put` on a Secrets Store name succeeds and creates a separate per-Worker value that this Worker never reads, so the binding stays empty or stale (#1725). Rotation for each is in [`docs/ops/AdminKeysAndPause.md`](../../docs/ops/AdminKeysAndPause.md).

| Secret | Kind | Purpose |
|---|---|---|
| `RPC_*` | Secrets Store | Per-chain RPC URLs (carry API keys). The bound set is the `RPC_*` entries in `wrangler.jsonc`. |
| `TG_BOT_TOKEN` | Secrets Store | Telegram bot credential (user-facing bot). |
| `PUSH_CHANNEL_PK` | Secrets Store | Push channel signing key — **an Ethereum private key**, loaded as an ethers `Wallet` by the shared Push rail (`packages/push`). This row used to say "not a chain key — a push protocol identity"; it is a real key, which is not the same thing. It carries no **protocol** authority (no Diamond role, no fund movement), but it is not authority-free: the channel-owner wallet holds the 50 PUSH staking deposit and ~$50 of native gas (`docs/ops/AdminKeysAndPause.md`). A revision of this row said "no on-chain authority", which tells a responder there is nothing on-chain at stake — there is. |
| `ONEINCH_API_KEY` | Secrets Store | 1inch credential for `/quote/1inch` and `/intent/fusion/post`. The agent holds no 0x key since #2755 (the keeper has its own). |
| `OPENSEA_API_KEY` | Secrets Store | OpenSea credential for `POST /opensea/listing`. Unset, listing publication has no upstream credential. |
| `DIAG_WALLET_HMAC_KEY` | Secrets Store | Keys the per-wallet hash diagnostics records are stored under, so a wallet can have them erased (T-075). Unset, a record from a connected wallet is not written (rather than written as one nobody can erase), and the erasure routes answer `503 erasure_not_configured`. |
| `TG_OPS_BOT_TOKEN` | per-Worker | Ops-internal bot credential — instant new-support-ticket alert (#1040 phase 1). While unset the alert skips (warn-logged) and tickets still land in D1; the nightly ops report's open-ticket count is the backstop. |
| `TG_OPS_CHAT_ID` | per-Worker | Operator chat the ops bot posts to. Same skip-while-unset behaviour. |

No `KEEPER_PRIVATE_KEY` here — that's `apps/keeper` exclusively.

### D1 — shared `vaipakam-warm` (staging)

The `DB` binding in `wrangler.jsonc` points at the **`vaipakam-warm`** D1 database (id `e5e927cf-56c3-42c7-9820-179a235cc84f`), the **staging** database the Cloudflare staging deploy uses — see [`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md`](../../docs/DesignsAndPlans/CloudflareStagingDeployPlan.md) §3 for the staging-vs-primary split. The same db is **shared** with `apps/indexer` and `apps/keeper`.

Agent writes: `user_thresholds` (`PUT /thresholds`), `telegram_links` (issue, consume and the expired-code sweep), `loans` (only the periodic pre-notify pass's `period_pre_notified_at` mark), `prenotify_pass` (that pass's lap record), `indexer_cursor` (one row only: the pre-notify rotation start, under a sentinel id that names no chain), `signed_request_use` (replay guard for signed requests), `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit`, `support_tickets` (#1040 phase 1 — `POST /support/ticket`). It does **not** write `notify_state`: the keeper owns that table, and `src/db.ts`'s `getNotifyState` / `putNotifyState` have no caller here (#1725).
Agent reads-only: `push_rail_status` (#2667 — the keeper's published Push rail readiness, read by `GET /push/status` and the `PUT /thresholds` opt-in check; the keeper writes it).

**There is no `apps/agent/migrations/` directory by design.** The canonical schema for every table this Worker touches lives in [`apps/indexer/migrations/`](../indexer/migrations/) — the indexer owns the schema, the other two Workers share the database. Schema changes for tables only agent writes still land as a new `apps/indexer/migrations/NNNN_*.sql` file; applying it via `wrangler d1 migrations apply vaipakam-warm --remote` from inside `apps/indexer/` updates the live staging db for all three consumers.

**Scheduled work waits for the schema (#2410).** This Worker auto-deploys on merge, so a build can be live before the indexer's deploy has applied the migrations it was written against. Each cron tick therefore first checks that every migration in [`packages/lib/src/sharedD1Migrations.json`](../../packages/lib/src/sharedD1Migrations.json) is recorded in `d1_migrations`. Until then the tick runs no pass and logs `[vaipakam-agent] this tick declined: D1 migration(s) … not applied`, and it resumes by itself on the first tick after they land. HTTP routes are not gated: a route that reads or writes a new column must tolerate the previous schema itself.

## Related

- `apps/keeper` — sibling signing Worker; this one defers all on-chain submissions to it.
- `apps/indexer` — sibling read-API Worker; this Worker reads from there for stats it doesn't compute locally.
- `apps/app` — consumes `/thresholds`, `/link/telegram` and the
  support-ticket endpoint.
- `apps/app` calls `/quote/readiness` and `/quote/1inch` from the
  forced-close card (`src/data/closeOutRoute.ts`). `/diag/record`,
  `/intent/fusion/post` and the `/opensea/*` routes have NO consumer in
  `apps/app`: their only clients were in the retired `apps/defi`. Check
  that before reconfiguring or retiring them (#1854).
- `packages/contracts` — ABI / deployment source.
