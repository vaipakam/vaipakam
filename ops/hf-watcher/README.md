# Vaipakam HF Watcher — Cloudflare Worker

Phase 8a.3 off-chain service that polls active Vaipakam loans across every
supported chain every 5 minutes, compares the live Health Factor to each
user's configured thresholds, and dispatches alerts via Telegram + Push
Protocol.

## Architecture

The Worker runs four independent passes per cron tick, each isolated
behind its own try/catch so a transient failure on one can't wedge
the others:

```
  Cron trigger (*/5 * * * *)
          │
          ├──▶ runWatcher(env)        — HF alert pipeline (this Worker's original job)
          ├──▶ pruneOldDiagErrors(env) — diag_errors retention prune
          ├──▶ runBuyWatchdog(env)    — cross-chain VPFI buy reconciliation
          └──▶ runChainIndexer(env)   — unified per-chain event indexer (T-041)
```

**HF alert pipeline (`runWatcher`):**

```
for each chain with RPC + Diamond configured:
  for each user with thresholds on that chain:
    getActiveLoansByUser(user)
    for each loan:
      calculateHealthFactor(loanId)
      classify band (healthy / warn / alert / critical)
      if band worsened since last tick:
        Telegram sendMessage(chatId, body) — if user linked
        Push Protocol notification         — if user subscribed
      upsert notify_state row
```

**Chain indexer (`runChainIndexer`):**

```
for each chain in getChainConfigs(env):           # multi-chain fan-out
  resume cursor (chain_id, kind='diamond') from D1
  ONE getContractEvents call across the full event allow-list
  bucket logs by event name → dispatch to per-domain handlers:
    - processOfferLogs       (offers table)
    - processLoanLogs        (loans table; JOINs offers for asset metadata)
    - recordActivityEvents   (unified activity_events ledger; every event lands here)
  refreshStaleOfferDetails    (one getOfferDetails per stale offer, batched 50/tick)
  refreshStaleLoanTokenIds    (one getLoanDetails per new loan, batched 50/tick)
  advance cursor atomically
```

A single shared cursor (`kind='diamond'`) means adding a new domain
in a future phase costs **zero extra RPC round trips per tick** — every
handler consumes the same scan output. The `chain_id` PK on every
table makes multi-chain coverage purely additive: configure another
chain's RPC secret + deployments.json entry, the next cron tick picks
it up.

HTTP endpoints on the same Worker:

**Settings + linking (CORS-locked to `FRONTEND_ORIGIN`):**

- `PUT  /thresholds`         — frontend Settings page writes the user's threshold config.
- `POST /link/telegram`      — frontend requests a 6-digit handshake code.
- `POST /tg/webhook`         — Telegram sends incoming DMs here; a 6-digit code message completes the link.

**Public chain-indexer reads (open CORS — every row is rederivable on-chain):**

- `GET /offers/stats`                 — aggregate active/accepted/cancelled counts + indexer cursor (drives the lag badge).
- `GET /offers/active`                — paginated active-offer list (newest-first, cursor-based).
- `GET /offers/:id`                   — single offer by id.
- `GET /offers/by-creator/:addr`      — wallet's offers regardless of status.
- `GET /loans/active`                 — paginated active-loan list.
- `GET /loans/:id`                    — single loan by id.
- `GET /loans/by-lender/:addr`        — loans where wallet currently holds the lender NFT (live `ownerOf` filter).
- `GET /loans/by-borrower/:addr`      — loans where wallet currently holds the borrower NFT (live `ownerOf` filter).
- `GET /activity?actor&loanId&offerId&kind&before` — unified event ledger; cursor on `(block, logIndex)`.
- `GET /claimables/:addr`             — open claim opportunities derived from `loans` JOIN `activity_events`, ownership-filtered live via `ownerOf`.

State lives in D1. Tables introduced over time:

- `user_thresholds` / `notify_state` / `telegram_links` (`migrations/0001_init.sql`) — alert-routing state.
- `user_locales` (`migrations/0002_user_locale.sql`) — preferred language for Telegram message bodies.
- `diag_errors` (`migrations/0003_diag_errors.sql`) — frontend `failure` event capture for support diagnostics.
- `offers` + `indexer_cursor` (`migrations/0004_offer_indexer.sql`) — chain-indexer schema for the offer book.
- `loans` + `activity_events` (`migrations/0005_loans_and_activity.sql`) — loan + unified event ledger.
- `loans.lender_token_id` / `borrower_token_id` / `interest_rate_bps` / `start_time` / `allows_partial_repay` columns (`migrations/0006_loan_token_ids.sql`) — bootstrap-only columns populated via one `getLoanDetails` call per new loan.

## Deploy (first time)

```bash
cd ops/hf-watcher
npm install

# 1. Create the D1 database. Copy the returned `database_id` into
#    wrangler.jsonc (replace the PLACEHOLDER string).
npx wrangler d1 create vaipakam-hf-watcher

# 2. Apply the schema.
npm run db:migrate

# 3. Set secrets (per chain as available). Mainnets + testnets are
#    both honored — the watcher silently skips chains where either
#    the RPC secret OR the deployments.json entry is missing.
#    RPC endpoints: use Alchemy / Infura / QuickNode — public RPCs
#    will rate-limit the cron tick on chain 2 or 3.
# Mainnets (set as deployments land):
npx wrangler secret put RPC_BASE
npx wrangler secret put RPC_ETH
npx wrangler secret put RPC_ARB
npx wrangler secret put RPC_OP
npx wrangler secret put RPC_ZKEVM
npx wrangler secret put RPC_BNB
# Testnets (pre-mainnet phase):
npx wrangler secret put RPC_BASE_SEPOLIA
npx wrangler secret put RPC_SEPOLIA
npx wrangler secret put RPC_ARB_SEPOLIA
npx wrangler secret put RPC_OP_SEPOLIA
npx wrangler secret put RPC_POLYGON_AMOY
npx wrangler secret put RPC_BNB_TESTNET

# 4. Telegram bot token (create the bot via @BotFather first; the
#    bot's username — e.g. `VaipakamBot` — is set as a plaintext
#    var in wrangler.jsonc, NOT here, because it is public info).
#    The TOKEN is the secret half: encrypted at rest, never logged,
#    never visible in the dashboard after upload.
npx wrangler secret put TG_BOT_TOKEN

# 5. Push Protocol channel private key. Create the channel via
#    push.org admin dashboard first, stake the deposit, then the
#    channel signer's privkey goes here.
npx wrangler secret put PUSH_CHANNEL_PK

# 6. Aggregator + scanner API keys (server-side proxies inject them
#    so the frontend never sees them — see #00003 for the regression
#    that prompted moving Blockaid behind /scan/blockaid).
npx wrangler secret put ZEROEX_API_KEY
npx wrangler secret put ONEINCH_API_KEY
npx wrangler secret put BLOCKAID_API_KEY

# 7. Set the diamond addresses in wrangler.jsonc vars (public info,
#    so no secret needed). Also update FRONTEND_ORIGIN if not
#    vaipakam.com, and confirm TG_BOT_USERNAME points at the
#    @BotFather-issued handle (default committed value: VaipakamBot).

# 8. Deploy.
npm run deploy
```

## Redeploy / migration upgrade path

When new D1 migrations land (e.g. T-041's `0004` / `0005` / `0006`)
on an already-deployed Worker:

```bash
cd ops/hf-watcher
npm install            # if package.json changed

# Apply any unapplied migrations against the live D1 database. Wrangler
# tracks the high-water mark, so re-running this command is a no-op
# once the migrations are caught up.
npm run db:migrate

# Redeploy the Worker bundle.
npm run deploy
```

**T-041 specific notes:**

- Migrations 0004 / 0005 / 0006 add the chain-indexer schema. Apply
  them in order — wrangler does this automatically.
- After deploy, the first cron tick will start filling `offers` /
  `loans` / `activity_events` from the chain-indexer cursor's deploy-
  block fallback. Backfill catches up over multiple ticks (capped per
  tick by `SCAN_LOOKBACK_BLOCKS * 4`); on Base ~17 minutes per tick at
  full pace.
- `loans.lender_token_id` / `borrower_token_id` / `interest_rate_bps`
  / `start_time` / `allows_partial_repay` start at `'0'` / `0` and
  populate via the `refreshStaleLoanTokenIds` batch (50 loans/tick,
  one `getLoanDetails` RPC each). On a chain with N loans, the
  bootstrap completes in ceil(N/50) ticks.
- The frontend's `IndexerStatusBadge` reads `indexer.updatedAt` from
  `/offers/stats` — ops can spot-check the cache age in any browser
  while monitoring rollout progress.

### Why `TG_BOT_TOKEN` is a secret but `TG_BOT_USERNAME` is a var

Two different threat surfaces:

- **`TG_BOT_TOKEN`** — gives anyone holding it the ability to send messages as the bot, read inbound webhook payloads, and rotate the bot's metadata. Treat as a high-sensitivity credential. `wrangler secret put` stores it encrypted; the Cloudflare dashboard's **Encrypt** toggle does the same thing through the UI. Plaintext exposure (in `wrangler.jsonc`, in the dashboard's "Variables" view, in a CI log, in a frontend `.env` file) is a compromise.
- **`TG_BOT_USERNAME`** — the public @-handle. Visible to every user who sees the deep link. Storing it as a `vars` entry in `wrangler.jsonc` is correct.

If you accidentally put `TG_BOT_TOKEN` into the plaintext `vars` block (or, worse, into `frontend/.env`), rotate the token immediately via @BotFather (`/revoke`) and re-issue.

## Register the Telegram webhook

Once deployed, point the bot at the Worker's webhook URL:

```bash
curl "https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook" \
     --data-urlencode "url=https://vaipakam-hf-watcher.<account>.workers.dev/tg/webhook"
```

Verify with:

```bash
curl "https://api.telegram.org/bot${TG_BOT_TOKEN}/getWebhookInfo"
```

## Telegram handshake flow

1. User opens Settings → Alerts on the frontend, enters wallet + threshold values, clicks "Link Telegram".
2. Frontend POSTs `/link/telegram` to the Worker. Worker returns a 6-digit code plus a `bot_url` deep-link built from `TG_BOT_USERNAME` (default `https://t.me/VaipakamBot?start=<code>`). When `TG_BOT_USERNAME` is unset, `bot_url` is `null` and the frontend falls back to a copy-the-code UX so users never get pointed at a placeholder bot.
3. Frontend renders the code plus the deep-link button.
4. User DMs the code to the bot. Telegram pushes a webhook update to the Worker's `/tg/webhook`.
5. Worker matches the code to the pending link row, writes the user's `chat_id` onto `user_thresholds.tg_chat_id`, and replies with a confirmation message.
6. Next cron tick starts alerting that chat id on band crossings.

Handshake codes expire after 10 minutes. Stale codes are swept at the start of every cron tick.

## Push Protocol wiring (TODO)

The `src/push.ts` file currently stubs the Push API call — it logs to console without actually dispatching. Replace the `sendPush` body with the real `@pushprotocol/restapi` channel send once:

1. The Vaipakam channel is created on push.org.
2. The channel signer's privkey is stored in `PUSH_CHANNEL_PK`.
3. `@pushprotocol/restapi` is added to `package.json` dependencies.

The SDK is Cloudflare-Worker-compatible from v1.6+.

## Local development

```bash
# 1. Copy the secrets template and fill in dev-tier values. The real
#    file is gitignored; never commit a populated `.dev.vars`.
cp .dev.vars.example .dev.vars

# 2. Apply schema to a local D1 replica.
npm run db:migrate:local

# 3. Run the Worker locally with a one-minute cron cycle for testing.
#    `wrangler dev` reads `.dev.vars` and exposes each KEY=VALUE on
#    the `env` object the same way `wrangler secret put KEY` does in
#    production.
npx wrangler dev --test-scheduled

# In another terminal, trigger the cron handler:
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

## Observability

Wrangler's built-in logs tail:

```bash
npx wrangler tail
```

Each cron tick logs:

- `[watcher] chain=... id=...` on chain entry
- `[watcher] user=... chain=...` on per-user failures
- Alert dispatch lines (chat id, status)
- D1 errors (rare — mostly schema mismatches during a migration)

## Rate limits & quotas

- Telegram Bot API: ~30 messages/second per bot. At 1000 subscribers with a 5-min cron, worst case ≈ 3 msg/sec during a global HF flash. No tuning needed.
- Cloudflare Workers free tier: 100,000 requests/day + 10ms CPU per request. The cron handler runs ~15–60s total CPU per tick — well within the paid tier's CPU budget, free tier needs an upgrade if chain count × user count × loan count gets large.
- D1 free tier: 5 million reads + 100k writes/day. Each cron tick does ~`users × loans × chains` reads + writes. Monitor `wrangler d1 insights`.

## Security notes

- `/thresholds` trusts the `wallet` field in the JSON body. That's fine for the current single-direction (wallet → alerts-to-chat-owned-by-wallet) flow. If future endpoints gate on-chain actions via this Worker, switch the wallet auth to an EIP-712 signed payload so msg.sender parity is cryptographic.
- `PUSH_CHANNEL_PK` must be stored via `wrangler secret put`, never in `wrangler.jsonc`. Leaking it = anyone can impersonate the Vaipakam channel.
- `TG_BOT_TOKEN` grants full control of the bot — same rule.
- `/tg/webhook` accepts any POST — Telegram's standard pattern. Optionally set a `secret_token` via the `setWebhook` call to gate, and compare against the `X-Telegram-Bot-Api-Secret-Token` header.
