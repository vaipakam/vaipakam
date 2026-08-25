# Cloudflare Staging Deploy Plan

**Status:** Active — refreshed 2026-05-08 to match the **3-Worker
split** that actually shipped (Stage 3 PR2-5 + the
architectural-rebalance commit). The original 2026-05-07 draft
proposed a 2-Worker shape (`agent` + `keeper`); the implemented
shape is a 3-Worker split (`keeper` + `indexer` + `agent`) with
the read-API + chain-event scan carved into a dedicated Worker
for resource isolation.
**Owner:** Vaipakam protocol team

## 1. Goal

Stand up parallel Worker deployments alongside the existing
production set so this branch's changes can be validated end-to-
end (frontend + indexer + keeper actions) **without touching prod
data**. If the validation goes well, the new workers replace the
existing ones via DNS / env-var swap; if not, prod stays
unaffected.

## 2. Worker / domain split — final 3-Worker shape

| Worker | Domain | What it does | Holds signing key? |
|---|---|---|---|
| **vaipakam-labs** | `labs.vaipakam.com` (today); `vaipakam.com` + `www.vaipakam.com` after cutover | Marketing site, docs, "Launch Vaipakam" button → `defi.vaipakam.com/`. Static, wallet-free. | No |
| **vaipakam-defi** | `defi.vaipakam.com` | The connected app — wallet connect, Dashboard at root, Offer Book, loan flows, Buy-VPFI, Claim Center, plus three wallet-free public-read tools (`/analytics`, `/nft-verifier`, `/protocol-console`). | No |
| **vaipakam-indexer** | `indexer.vaipakam.com` | Chain → D1 sync (chainIndexer.ts), cancelled-offer retention prune, public read-API: `/offers/*`, `/loans/*`, `/activity`, `/claimables/*` (open-CORS reads). **Also writes**: three POST endpoints that write D1, HMAC-authenticated inbound Alchemy webhooks, and authenticated outbound publication of **borrower-authorised, on-chain-bound** Seaport listings to OpenSea (posted with an empty `0x` signature; the vault's ERC-1271 check validates against a hash bound on-chain). | No on-chain key |
| **vaipakam-agent** | `agent.vaipakam.com` | Proactive notifications (periodic interest pre-notify, push + Telegram), public Farcaster Frame at `/frames/active-loans`, operator services (`/quote/0x`, `/quote/1inch`), Telegram bot webhook (`/tg/webhook`), diagnostics record (`/diag/record`), frontend-facing settings (`/thresholds`, `/link/telegram`). Also **deletes** diagnostics + support records on a schedule and **publishes** listings via `/opensea/listing`. | **No on-chain transaction key** — but holds `PUSH_CHANNEL_PK`, a real Ethereum key used to sign notifications, whose EOA owns the channel's 50 PUSH stake and gas |
| **vaipakam-keeper** | (no public domain — internal Worker, cron-only) | Active write-to-chain — HF watcher + autonomous liquidation (incl. flash-loan liquidation via a non-Diamond contract), daily oracle snapshot, **live** offer/intent matcher, auto-lifecycle extend/roll, keeper-tier writes, commitment batch + report, remit ack, reward-budget remit. See the signing inventory below — and treat it as a floor. | **YES** — single signing-key holder |

The split was **designed** around a read/index vs write/act axis. What it
actually achieves is narrower than that, and narrower than the "strict
least-privilege" this section used to claim: it places the **on-chain
signing key** on exactly one Worker. It does **not** isolate the other
two — both bind the same database scope the keeper reads, and both have
externally visible write effects of their own (see the indexer and agent
bullets, and #1722). Read the list below as *signing-key placement*, not
as a privilege boundary:

- `vaipakam-keeper` carries `KEEPER_PRIVATE_KEY` and is the
  ONLY Worker that signs on-chain transactions. **Eight** modules
  sign (`keeper`, `liquidityConfidence`, `matcher`, `autoLifecycle`,
  `dailyOracleSnapshot`, `commitmentReport`, `remitAck`,
  `rewardBudgetRemit`), covering at least thirteen state-changing
  calls: `triggerLiquidation` / `triggerLiquidationSplit` /
  `triggerPartialLiquidation`, `captureDailyPriceSnapshot`,
  `matchOffers` / `matchIntent`, `extendLoanInPlace` /
  `rollIntentLoan`, `setKeeperTier`, `submitCommitmentBatch`,
  `sendCommitmentReport`, `sendRemitAck`, `remitRewardBudget` — plus
  `liquidateViaAaveV3` / `liquidateViaBalancerV2` on the
  **FlashLoanLiquidator**, a contract that is not the Diamond
  (`keeper.ts:1150-1155`, when the discount path is enabled and a
  `liquidator` is configured).

  **Treat this list as a floor, not an inventory.** It said "three
  signing tasks: HF liquidation, daily oracle snapshot, **future**
  offer matching" while the matcher was already live and nine other
  signed calls existed. The correction that replaced it then missed the
  two flash-loan calls, because they are dispatched through a
  *variable* (`functionName: fnName`) and a grep for literal function
  names cannot see them. Re-derive from `writeContract` call sites and
  read each one's `functionName` expression — including the ones that
  resolve at runtime, and note that the `address` is not always the
  Diamond.
- `vaipakam-agent` holds no **on-chain transaction** key — which is not
  the same as "no signing key", as this bullet used to say.
  **`PUSH_CHANNEL_PK` is an Ethereum private key**, instantiated as an
  ethers `Wallet` (`apps/agent/src/push.ts:66`) to sign Push
  notifications as the channel. **That key** holds no PROTOCOL authority — but it is not fund-safe:
  `docs/ops/AdminKeysAndPause.md:227` records the channel-owner EOA as holding
  the 50 PUSH staking deposit and ~$50 of native gas, so possession of the
  private key exposes those wallet assets. It cannot move protocol funds — the
  subject is the key, not the Worker, which is a distinction this whole
  section exists to keep — and that is the claim worth making; "holds no signing key" overstates it and would
  lead a secret reviewer to skip key material that is real. The
  remaining tokens (`TG_BOT_TOKEN`) and aggregator API keys
  (`ZEROEX_API_KEY`, `ONEINCH_API_KEY`, the retired `BLOCKAID_API_KEY`,
  see §4.3) are operational secrets, not signing material.
- `vaipakam-indexer` is the **chain-read + API** Worker: RPC reads, D1
  writes, inbound Alchemy webhook verification, and **authenticated
  outbound publication of Seaport listings to OpenSea**
  (`openseaPublish.ts`). It binds **fifteen** Secrets Store entries: four
  non-RPC HTTP authentication secrets (`OPENSEA_API_KEY` plus three
  `ALCHEMY_WEBHOOK_SIGNING_KEY_*`) and eleven `RPC_*` URLs which
  themselves carry provider API keys and are used over HTTP. Both numbers
  matter — the four are what an auditor thinks of as credentials, the
  eleven are equally leakable and equally billable.

  **Count these from `wrangler.jsonc`'s `secrets_store_secrets` block, not
  from the `Env` interface.** `Env` is the RESOLVED downstream type and is a
  strict superset: it declares `RPC_ZKEVM`, which all three Workers' configs
  explicitly omit as out of scope. Counting the interface inflates every
  Worker's inventory by exactly one, and a provisioning or threat review that
  starts there will look for a secret that was never issued.

  These are counts of secrets BOUND; the reachable chain set is smaller
  still, because entries with no `deployments.json` record are dropped at the
  `getDeployment` gate.

  This bullet used to read "read-only — RPC reads, D1 writes, no
  HTTP-level secrets". Both halves were false, and the second is the
  kind of line an auditor reasonably relies on to skip a Worker's secret
  surface entirely.

  **The blast-radius ordering below does not survive contact with the
  shared D1 binding, and "cannot move funds" is not the boundary it
  looks like.** All three Workers bind the same `vaipakam-archive`
  database, and **a D1 binding is database-scoped, not table-scoped** —
  there is no per-table grant, so any Worker with the binding can write
  any table regardless of what its own code does today. Which Worker
  "owns" a table is a convention in our source, not an enforced
  boundary.

  That turns the keeper into a confused deputy. `liquidityConfidence.ts`
  walks a streak counter persisted in D1 and, once the threshold is met,
  signs `setKeeperTier` (`:768-771`) — a privileged risk-parameter
  write. An attacker holding the indexer can poison that persisted
  streak, and the signing Worker submits the transaction.

  **The bound on that attack is narrower than it first looks, and the
  precision matters.** Promotion is not fabricable from D1 alone:
  `runRelayForChain` computes a *fresh* `aggregatorConfirmedTier` each
  tick, skips the asset when every quote fails (`:722`), and
  `nextKeeperTier` promotes only when that live tier exceeds the current
  on-chain tier. So a D1 attacker still needs at least one qualifying
  live quote and can only accelerate to the next tier, not choose one.

  What they bypass is the **durability** requirement — the
  `LIQ_CONFIDENCE_MIN_CHECKS` consecutive ticks over
  `LIQ_CONFIDENCE_MIN_WINDOW_DAYS` that exist precisely so a single
  transient quote cannot move a risk parameter. That is still a real
  loss (the relay's whole purpose is defeated), but it is
  "promote on one lucky quote", not "promote from nothing".

  So the honest statement is: a compromised indexer cannot move funds
  **directly**, but it can (a) re-expose already-authorised listings on
  a live marketplace under the project's API key, (b) strip the
  time-based safety margin from a keeper-signed risk-parameter change,
  and (c) **suppress keeper work by asserting it is already done.**

  (c) is a distinct shape from (a) and (b) and this list omitted it
  through two rounds. Inserting a `(chain_id, day_id)` row into
  `keeper_commitment_day` makes `getCommitmentScanState` report that day
  resolved, and `runCommitmentReport` then takes its `continue` —
  a **zero-RPC skip with no on-chain verification** — so the commitment
  report never sends. Base waits on that report before reward
  remittance, so the effect is a stalled reward pipeline rather than a
  bad write. Corrupting shared state to make a signing Worker *do the
  wrong thing* is the obvious risk; making it *skip work it believes is
  finished* is the quieter one, and the `zero-RPC` fast paths are
  exactly where it lands. Audit every keeper pass that trusts a D1 row
  as a completion record, not just those that trust one as an input.

  Whether the answer
  is storage isolation, per-Worker databases, or the keeper validating
  D1 inputs it did not produce is a real architectural decision, tracked
  as **#1722** — not settled here, and deliberately not papered over
  with a cadence tweak.

"A buggy agent produces stale data; a buggy keeper loses funds.
Different blast radius justifies different deploy cadence + reviewer
sign-off." **That conclusion is suspended pending #1722, not restated
here.**

**Not even the bug case holds as stated.** An agent defect does not
stop at stale data: its scheduled passes *delete* diagnostics and
support records, `runPeriodicPreNotify` writes `loans` and sends
Push/Telegram messages to real users, and `/opensea/listing` publishes
borrower-authorised, on-chain-bound orders to a live marketplace. A bug on those paths means data
loss, mis-sent or leaked notifications, and publication to a live marketplace — bounded, and the bounds matter: `openseaPublish.ts` posts an **empty `0x` signature**, which OpenSea accepts only because the vault's ERC-1271 check recognises an order hash the borrower already bound **on-chain**. So a compromised Worker can re-expose an already-authorised listing and impose removal latency, but **cannot manufacture one** (no on-chain binding, no listing) and **cannot preserve one** (the borrower's `cancelPrepayListing` revokes the binding and OpenSea drops it on the next revalidation pass). An earlier version of this called it "irreversible upstream publication", which overstated the blast radius in both directions. None of it is "stale data" either. The only part of the
original sentence that survives unqualified is the narrow one: **the
agent and indexer do not sign on-chain transactions.**

The conclusion fails for the *compromise* case too, because the agent
and indexer share the keeper's
database-scoped D1 binding and can therefore corrupt state the keeper
acts on. Deploy cadence and reviewer sign-off are decided against the
compromise case, so the premise no longer carries the conclusion for
either non-signing Worker — not just the indexer this PR set out to
correct.

Until #1722 resolves the isolation question, treat the current
cadences as **inherited, not derived**: keep them, and do not cite
this paragraph as the reason a change to a non-signing Worker needs
less scrutiny.

## 3. Cloudflare provisioning state (as-deployed)

Operator has provisioned (verified via Cloudflare API
2026-05-08):

- `vaipakam-defi`        — `defi.vaipakam.com` ✓ bound
- `vaipakam-labs`        — `labs.vaipakam.com` ✓ bound
- `vaipakam-indexer`     — Worker exists; **`indexer.vaipakam.com` not yet bound**
- `vaipakam-agent`       — `agent.vaipakam.com` ✓ bound
- `vaipakam-keeper`      — Worker exists; no public domain (by design)

D1 databases:

- `vaipakam-alerts-db` (`50850eab-…`) — **PRODUCTION D1, untouched**
- `vaipakam-archive`   (`3cffebf5-…`) — staging D1 for the new
  Workers. Migrations not yet applied (one-time step).

Pre-existing primary infra (untouched until staging is proven):

- `vaipakam-hf-watcher`  — primary Worker on `api.vaipakam.com`,
  cron `* * * * *`, reads/writes `vaipakam-alerts-db`.
- `vaipakam`             — primary marketing Worker on
  `vaipakam.com` + `www.vaipakam.com`.

## 4. Per-Worker configuration

### 4.1 `vaipakam-defi` (frontend)

Static-asset deploy, build-time env vars (Vite injects at
`pnpm build`, baked into the JS bundle):

```
VITE_DEFAULT_CHAIN_ID=84532
VITE_BASE_SEPOLIA_RPC_URL=<provider URL>
VITE_<CHAIN>_RPC_URL=...
VITE_WALLETCONNECT_PROJECT_ID=...
VITE_INDEXER_ORIGIN=https://indexer.vaipakam.com   # NEW (staging) — replaces VITE_API_ORIGIN
VITE_AGENT_ORIGIN=https://agent.vaipakam.com       # NEW (staging) — replaces VITE_API_ORIGIN
```

NO secrets — the frontend bundle is static.

### 4.2 `vaipakam-indexer`

- **Custom domain:** `indexer.vaipakam.com` (binding pending —
  add to wrangler.jsonc `routes`).
- **D1:** `vaipakam-archive`, `migrations_dir: "migrations"`.
- **Cron:** `* * * * *` — chain-event scan + cancelled-offer
  retention prune.
- **Secrets** — all Secrets Store entries (§4.5(a)); this Worker has no
  per-Worker `secret_text`. Fifteen bindings, not the three this section
  used to list:
  ```
  RPC_BASE, RPC_ETH, RPC_ARB, RPC_OP, RPC_BNB,
  RPC_SEPOLIA, RPC_BASE_SEPOLIA, RPC_ARB_SEPOLIA,
  RPC_OP_SEPOLIA, RPC_BNB_TESTNET, RPC_POLYGON_AMOY
  OPENSEA_API_KEY
  ALCHEMY_WEBHOOK_SIGNING_KEY_84532
  ALCHEMY_WEBHOOK_SIGNING_KEY_421614
  ALCHEMY_WEBHOOK_SIGNING_KEY_97
  ```
  The `ALCHEMY_WEBHOOK_SIGNING_KEY_*` set is **not optional at deploy
  time**: `apps/indexer/wrangler.jsonc` notes that a binding can only
  exist once its secret does, because wrangler validates at deploy. A
  missing one fails `wrangler deploy` outright — it does not degrade.
  Add others as new chains come online, and keep this list matched to
  the `secrets_store_secrets` block rather than to the chain set.

### 4.3 `vaipakam-agent`

- **Custom domain:** `agent.vaipakam.com` ✓
- **D1:** `vaipakam-archive`. **Seven** tables reachable from live code
  (#1713): `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit`,
  `loans`, `support_tickets`, `telegram_links`, `user_thresholds`.
  **Not read-mostly** — the agent writes every table it touches,
  including the indexer-owned `loans`.

  `notify_state` is deliberately absent. `db.ts` contains both a SELECT
  and an INSERT against it, but their only callers (`getNotifyState`,
  `putNotifyState`) are unreferenced exports — the live agent never
  reaches that table. The keeper owns `notify_state`.

  (This entry previously read "read-mostly: link_codes, thresholds …";
  neither of those table names exists — they are `telegram_links` and
  `user_thresholds`.)
- **Cron:** `* * * * *` — periodic-interest pre-notify,
  diag retention, support-ticket retention
  (`pruneOldSupportTickets`, which ENFORCES the 12-month
  support-ticket deletion promise — disabling or misconfiguring
  this schedule stops that deletion happening).
  (#1651: `buy-watchdog` was scheduled here; #687-A removed it
  with the VPFI buy surface.)
- **Secrets:**
  ```
  RPC_*           — TWELVE bound. NOT the same set as the indexer:
                    the agent additionally binds RPC_POLYGON, which the
                    indexer does not. (Both bind RPC_POLYGON_AMOY.)
  TG_BOT_TOKEN    — STAGING bot token (NOT prod)
  PUSH_CHANNEL_PK — STAGING channel signer (NOT prod)
  ZEROEX_API_KEY  — for /quote/0x proxy
  ONEINCH_API_KEY — for /quote/1inch proxy
  OPENSEA_API_KEY — offer reads AND listing SUBMISSION. `openseaProxy.ts`
                    POSTs borrower-AUTHORISED orders (empty `0x` signature; the vault's
                    ERC-1271 validates a hash the borrower bound
                    on-chain — not a borrower signature) to OpenSea's
                    seaport/listings endpoint with this key, so it is a
                    write credential upstream, not a read-only one.
  DIAG_WALLET_HMAC_KEY — diagnostics wallet pseudonymisation
  # (#1651: BLOCKAID_API_KEY was listed here for a /scan/blockaid proxy.
  #  ET-001 dropped that proxy — index.ts states there is no transaction-scan
  #  proxy at all; the pre-sign preview is a frontend eth_call. Nothing to set.)
  ```
- **Vars (non-secret):**
  ```
  TG_BOT_USERNAME=<staging bot @-handle>
  FRONTEND_ORIGIN=https://defi.vaipakam.com,https://labs.vaipakam.com
  DIAG_SAMPLE_RATE=1.0
  DIAG_RETENTION_DAYS=90
  ```
- **Holds no ON-CHAIN transaction key.** That is the part of the §2
  statement that holds. It is NOT keyless: `PUSH_CHANNEL_PK` is an
  Ethereum private key instantiated as an ethers `Wallet`
  (`apps/agent/src/push.ts:66`) to sign Push notifications as the
  channel. No PROTOCOL-fund-moving authority — but not fund-safe: the
  channel-owner EOA holds the 50 PUSH staking deposit and ~$50 of native
  gas (`docs/ops/AdminKeysAndPause.md:227`), so possession of the key
  exposes those wallet assets. Real signing material a secret reviewer
  must not skip. This line read "Holds NO signing key", and then "No
  fund-moving authority" — the second wording survived the correction at
  §2 above (lines 69-72) and still told an operator reaching for this
  provisioning summary during an incident that no funds are at risk.

### 4.4 `vaipakam-keeper`

- No public domain (cron-only, no fetch handler).
- **D1:** `vaipakam-archive`. Writes **twelve** tables of its own
  (`hf_band_state`, `notify_state`, `pre_grace_notify_state`,
  `notifications`, `telegram_links`, `liquidity_confidence`,
  `oracle_snapshot_state`, and the `keeper_commitment_*` /
  `keeper_remit_ack*` families). Reads, without writing:
  `user_thresholds`, plus cross-Worker access to the indexer's `loans`,
  `offers` and `indexer_cursor` (#1713). Unlike the agent, this Worker
  does have a read-only surface.

  Two of those classifications turn on **reachability, not on the
  presence of SQL**, so they are easy to get wrong from a grep:

  - `user_thresholds` is read-only here even though `db.ts` contains an
    `INSERT INTO user_thresholds`. That writer (`upsertThresholds`) is
    an unreferenced export — live modules import only
    `listThresholdsForChain`. Three other db.ts exports are likewise
    dead (`issueTelegramLinkCode`, `consumeTelegramLinkCode`,
    `linkTelegram`).
  - `telegram_links` nonetheless **is** written, despite both its
    insert paths being among those dead exports: `sweepExpiredLinks`
    (live, called from `watcher.ts:60`) issues a `DELETE FROM
    telegram_links` to prune expired codes.

  (Previously written as "reads notify_state + thresholds";
  `thresholds` is not a table — it is `user_thresholds` — and
  `notify_state` is written here, not merely read.)
- **Cron:** `* * * * *` — HF watcher loop. The daily oracle
  snapshot pass internally pre-checks the 00:00–00:09 UTC
  window + a D1 last-day guard, so most ticks exit
  immediately.
- **Secrets:**
  ```
  KEEPER_PRIVATE_KEY  — single signing key, gas-funded on every
                        chain with an RPC_* set
  RPC_*               — TEN bound, and NOT the same set as either
                        sibling. The keeper binds neither Polygon
                        secret; the indexer binds RPC_POLYGON_AMOY but
                        not RPC_POLYGON (eleven); the agent binds both
                        (twelve). The three sets differ ONLY by those
                        Polygon entries, which have no deployment record
                        and are dropped at the getDeployment gate — so
                        all three REACH the same set — and it is far
                        smaller than either count. deployments.json holds
                        only 97 / 84532 / 421614, and getChainConfigs
                        requires BOTH an RPC value and a getDeployment hit,
                        so at most THREE chains are reachable today. The
                        other seven non-Polygon bindings are provisioned
                        ahead of their deployments. Provision from
                        each Worker's own wrangler.jsonc, not from this
                        row. (It previously read "same chains as indexer
                        + agent", which was wrong for both.)
  TG_BOT_TOKEN        — for HF-band-downgrade alerts (currently missing — sendMessage fail-soft)
  PUSH_CHANNEL_PK     — same (currently missing — sendPush fail-soft)
  ZEROEX_API_KEY      — for serverQuotes liquidation orchestration (currently missing — DEX-only fallback)
  ONEINCH_API_KEY     — same (currently missing)
  ```
- **Vars (non-secret):** `TG_BOT_USERNAME`, `FRONTEND_ORIGIN`, and the
  optional `LIQ_*` / `SPLIT_*` / `PARTIAL_LIQ_*` / `REWARD_*_LOOKBACK_DAYS`
  / `REWARD_REMIT_LANE_CAP` tuning knobs. Treat `apps/keeper/src/env.ts`
  as the exhaustive list rather than this one.

  **`FRONTEND_ORIGIN` is not optional in practice.** It is declared
  optional (`env.ts:69`) and falls back to the empty string, but
  `watcher.ts:156` and `preGraceWatcher.ts:433` interpolate it into the
  "view this loan" links in outgoing notifications. Unset, users receive
  a relative `/loans/123` that resolves nowhere from a Telegram or Push
  client.

  `KEEPER_ENABLED` used to be listed here as a var. It is **not** one —
  it is a per-Worker `secret_text`, provisioned `false` at step 4 and
  flipped to `true` at step 8. See §4.5(b) for the mechanism and why the
  distinction matters.

### 4.5 How to actually provision the secrets above — two mechanisms

The secrets in §4.1–§4.4 are **not** all created the same way, and the
wrong command completes successfully while leaving the binding empty at
runtime. Check which list a secret is in before running anything.

**(a) Secrets Store entries — everything declared under
`secrets_store_secrets`.** All `RPC_*`, `TG_BOT_TOKEN`,
`PUSH_CHANNEL_PK`, `ZEROEX_API_KEY`, `ONEINCH_API_KEY`,
`OPENSEA_API_KEY`, `DIAG_WALLET_HMAC_KEY`, `KEEPER_PRIVATE_KEY` and the
`ALCHEMY_WEBHOOK_SIGNING_KEY_*` set. These are **account-level** entries
in a Cloudflare Secrets Store, bound into a Worker by store ID + secret
name. `wrangler secret put` does **not** create or populate them — it
creates a separate per-Worker secret that nothing here reads. Use:

```bash
wrangler secrets-store secret create 1e66429d0fa24aa38a27bc05b7bcf63e \
  --name <SECRET_NAME> --scopes workers --remote
```

- `1e66429d0fa24aa38a27bc05b7bcf63e` is the store ID; all three Workers
  (`agent`, `keeper`, `indexer`) bind the **same** store, so a secret is
  created once and every Worker declaring it picks it up.
- `--scopes workers` is required (the flag has no default).
- `--remote` is required — it defaults to `false`, which writes to a
  *local* persistence directory and silently does nothing for a deploy.
- Omit `--value`; wrangler prompts for it. Passing it inline leaves the
  secret in shell history.
- The store is shared, so a secret two Workers declare (e.g. `RPC_BASE`,
  `TG_BOT_TOKEN`) must **not** be created twice.

**(b) Plain per-Worker secrets** (`secret_text`) — ordinary Worker
secrets, not store entries. These *do* use `wrangler secret put`, run
from the owning Worker's directory:

```bash
( cd apps/agent  && wrangler secret put TG_OPS_BOT_TOKEN )
( cd apps/agent  && wrangler secret put TG_OPS_CHAT_ID )
( cd apps/keeper && wrangler secret put KEEPER_ENABLED )   # prompts; enter: false
```

> **Enter `false` here — not `true`.** Step 5 deploys the keeper and
> activates its cron, so a keeper armed at step 4 starts liquidating
> before step 7's validation window, which that step assumes is running
> with `KEEPER_ENABLED=false`. The value is deliberately set now and
> flipped later: step 8 is where it becomes `true`, by re-running the
> same command and entering `true`.

- `TG_OPS_BOT_TOKEN` / `TG_OPS_CHAT_ID` (agent) — non-blocking for the
  rollout: while unset, support-ticket ops-notify skips and tickets
  still land in D1.
- **`KEEPER_ENABLED` (keeper) — blocking for step 8, provisioned
  `false` at step 4.** Step 8 arms the keeper by re-running the command
  above and entering `true`; there is no other mechanism to do so.
  Because it is a secret rather than a var, its value cannot be read
  back from the API or dashboard, so a missed `secret put` is
  indistinguishable from a deliberate "off" — the keeper stays dark and
  step 9's observation window looks quiet while nothing is running
  (#1475).
- `REWARD_REMIT_ENABLED` / `REWARD_COMMIT_ENABLED` (keeper) — same
  mechanism, optional. Both were **absent** on the live Worker as of the
  2026-07-30 readback (the reward passes are dark). Set them only if
  the rollout intends to arm those passes, and only after the keeper EOA
  is authorized on-chain.

> **Do not trust `apps/keeper/wrangler.jsonc`'s comment on these three.**
> It describes them as "operator-managed vars (non-secret config — plain
> `vars`)", but the committed `vars` block contains only
> `TG_BOT_USERNAME`, and `apps/keeper/src/env.ts:76-80` states they are
> `secret_text`. The mechanism above is the one verified against the live
> deployment and recorded in
> [`docs/ops/OffChainRestore.md`](../ops/OffChainRestore.md) ("because
> this document previously guessed, and guessed wrong"). Correcting that
> comment, and the separate question of whether the flags should be
> committed so the arming state is reviewable, is #1465 — not settled
> here.

## 5. Wrangler config layout

Single source-tree per Worker; no environment-flag gymnastics:

```
apps/
  defi/wrangler.jsonc           # vaipakam-defi
  labs/wrangler.jsonc           # vaipakam-labs
  indexer/wrangler.jsonc        # vaipakam-indexer
    migrations/                  # D1 schema migrations (moved from ops/hf-watcher)
  agent/wrangler.jsonc           # vaipakam-agent
  keeper/wrangler.jsonc          # vaipakam-keeper
```

Each `wrangler.jsonc` declares the right cron, D1 binding, vars,
and (for indexer + agent) custom-domain `routes`. The previous
`ops/hf-watcher/` monolith is decommissioned in source as part of
Stage 3 PR5.

## 6. Rollout sequence

| Step | Owner | What happens |
|---|---|---|
| 1 | Operator | Provision Cloudflare resources per §3 (DONE 2026-05-07) |
| 2 | Author | Patch wrangler.jsonc with `vaipakam-archive` D1 ID + `indexer.vaipakam.com` route (Stage 3 follow-up commit) |
| 3 | Operator | `cd apps/indexer && wrangler d1 migrations apply vaipakam-archive --remote` (one-time schema apply) |
| 4 | Operator | Provision **every declared binding on all three Workers** — §4.2 (indexer) + §4.3 (agent) + §4.4 (keeper), by the two mechanisms in §4.5. Do not skip the indexer: wrangler validates Secrets Store bindings at deploy, so a missing `ALCHEMY_WEBHOOK_SIGNING_KEY_*` fails step 5 rather than degrading. (NOT BLOCKAID; that proxy does not exist, #1651) |
| 5 | Operator | `wrangler deploy` for `apps/indexer`, and the packaged scripts **`pnpm --filter @vaipakam/agent run deploy`** and **`pnpm --filter @vaipakam/keeper run deploy`** for the other two — NOT a bare `wrangler deploy` for either (#1896): those scripts carry `--keep-vars`, and without it wrangler deletes every var absent from `wrangler.jsonc`. For the keeper that is the `FRONTEND_ORIGIN` and optional `LIQ_*` / `SPLIT_*` / `PARTIAL_LIQ_*` tuning §4.4 just provisioned; for the agent it is `RECIPIENT_VALIDATING_TOKENS` and `OPENSEA_OFFERS_MAX_PAGES`, which `apps/agent/src/env.ts` reads and its config does not declare — a bare deploy silently switches recipient-token validation off and resets OpenSea pagination. This activates crons + binds `indexer.vaipakam.com`. **HOLD (#1896): the keeper no longer has a cron to activate** — `apps/keeper/wrangler.jsonc` commits `"crons": []` deliberately, because the Worker was being terminated for exceeding CPU on ~100% of invocations. Deploying it is still correct (it keeps the script and bindings current); it simply leaves the keeper unscheduled. Do not "fix" the empty list here. |
| 6 | Operator | Update `apps/defi/.env.local` with `VITE_INDEXER_ORIGIN` + `VITE_AGENT_ORIGIN`; `pnpm build && wrangler deploy` `vaipakam-defi`. |
| 7 | Both | Smoke-test `defi.vaipakam.com` end-to-end against `agent.vaipakam.com` + `indexer.vaipakam.com`, with `KEEPER_ENABLED=false` (no autonomous liquidation). NOT fully alert-only: `runDailyOracleSnapshot` signs on `KEEPER_PRIVATE_KEY` alone and will broadcast on staging regardless — if the window must be write-free, remove the keeper's trigger in the Cloudflare dashboard (*Settings → Trigger Events*) — editing `wrangler.jsonc` after step 5 has already deployed the active schedule changes nothing live. Allow for propagation before treating it as stopped; see `apps/keeper/README.md` (#1466). **HOLD (#1896): skip this step's keeper-trigger actions entirely.** The keeper already has no trigger — step 5 deploys `"crons": []` — so there is nothing to remove, and the restore instruction below must NOT be followed: it would re-arm the every-minute invocation that #1896 exists to stop, defeating this hold and step 8. The window is write-free for the keeper by default. Original instruction, for after the hold lifts: **if you take that path, restore the trigger at the end of this step** — step 8 only flips `KEEPER_ENABLED`, so a Worker left with no schedule would make step 9's observation window look quiet while every pass is in fact disabled. |
| 8 | Operator | **HOLD (#1896): this step cannot pass while the keeper is unscheduled, and that is expected — not a failure to work around.** The canonical schedule is currently `[]`, so skip the readback and the `KEEPER_ENABLED` arming, and record the hold in the run log; step 9's window will be quiet for the keeper by design. Resume this step only after #1896's CPU work lands and the schedule is restored, following the re-enable sequence kept beside the empty list in `apps/keeper/wrangler.jsonc` (which includes `--keep-vars`, a trigger-aware readback, and the propagation wait). The original instruction, for when that happens: read back the keeper's cron and confirm it is the canonical `* * * * *` from `apps/keeper/wrangler.jsonc` — **not merely that some trigger exists**, since a hand-recreated daily schedule would pass a presence check while exercising the keeper far less than intended, leaving step 9's window just as falsely quiet. Only removed if step 7 took the write-free path. Then arm the keeper with `( cd apps/keeper && wrangler secret put KEEPER_ENABLED )`, entering `true` — it is a per-Worker secret, not a var, so there is no `--var` form (§4.5(b)). The flag alone arms nothing without a schedule to run on. |
| 9 | Both | Run for N days observing for divergence vs prod. |
| 10 | Both | If green: bind `vaipakam.com` + `www.vaipakam.com` to `vaipakam-labs` (replacing the older `vaipakam` Worker); decommission `vaipakam-hf-watcher` + unbind `api.vaipakam.com`. |
|   |   | If issues: revert (env-var rollback on `vaipakam-defi`); no prod impact. |

## 7. Open questions / known gaps

1. **`indexer.vaipakam.com`** — not yet bound in Cloudflare.
   Goes in alongside the wrangler config patch (§6 step 2).

2. **Bot/push-channel secrets on `vaipakam-agent`** — confirmed
   STAGING tokens (operator verified 2026-05-08).

3. **D1 cost** — running two D1 instances (`vaipakam-alerts-db`
   for prod + `vaipakam-archive` for staging) doubles the
   Workers Free Tier rows quota. Both have retention prunes
   (`CANCELLED_OFFER_RETENTION_DAYS=30`, `DIAG_RETENTION_DAYS=90`)
   so growth is bounded. If quota tightens, lower retention
   on the staging instance further.

4. **`KEEPER_ENABLED`** — set on `vaipakam-keeper` with initial value
   `"false"`. Flip to `"true"` only after §6 step 7's validation window
   passes. It is a per-Worker `secret_text`, **not** a var — an earlier
   revision of this section said otherwise. See §4.5(b).

## 8. Effort

| Stage | Effort |
|---|---|
| §3 Cloudflare provisioning | DONE |
| §6 step 2 (config patch) | 30 min author |
| §6 steps 3-6 (apply + deploy + frontend env flip) | 1 hr operator |
| §6 steps 7-9 (validation window) | N days observation |
| §6 step 10 (cutover) | 30 min operator |
