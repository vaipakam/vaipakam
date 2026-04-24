# Vaipakam HF Watcher — Cloudflare Worker

Phase 8a.3 off-chain service that polls active Vaipakam loans across every
supported chain every 5 minutes, compares the live Health Factor to each
user's configured thresholds, and dispatches alerts via Telegram + Push
Protocol.

## Architecture

```
  Cron trigger (*/5 * * * *)
          │
          ▼
  scheduled() handler
          │
          ▼
  for each chain with RPC + Diamond configured:
    for each user with thresholds on that chain:
      getActiveLoansByUser(user)
      for each loan:
        calculateHealthFactor(loanId)
        classify band (healthy / warn / alert / critical)
        if band worsened since last tick:
          Telegram sendMessage(chatId, body) — if user linked
          Push Protocol notification      — if user subscribed
        upsert notify_state row
```

Three HTTP endpoints also live on the same Worker:

- `PUT  /thresholds`       — frontend Settings page writes the user's threshold config.
- `POST /link/telegram`    — frontend requests a 6-digit handshake code.
- `POST /tg/webhook`       — Telegram sends incoming DMs here; a 6-digit code message completes the link.

State lives in D1 (three tables, see `migrations/0001_init.sql`):

- `user_thresholds`  — per-user per-chain thresholds + rail config (`tg_chat_id`, `push_channel`).
- `notify_state`     — per-loan idempotency state (`last_band`, `last_hf_milli`, `last_sent_ts`).
- `telegram_links`   — transient handshake codes (10-minute TTL).

## Deploy (first time)

```bash
cd ops/hf-watcher
npm install

# 1. Create the D1 database. Copy the returned `database_id` into
#    wrangler.jsonc (replace the PLACEHOLDER string).
npx wrangler d1 create vaipakam-hf-watcher

# 2. Apply the schema.
npm run db:migrate

# 3. Set secrets (per chain as available).
#    RPC endpoints: use Alchemy / Infura / QuickNode — public RPCs
#    will rate-limit the cron tick on chain 2 or 3.
npx wrangler secret put RPC_BASE
npx wrangler secret put RPC_ETH
npx wrangler secret put RPC_ARB
npx wrangler secret put RPC_OP
npx wrangler secret put RPC_ZKEVM
npx wrangler secret put RPC_BNB

# 4. Telegram bot token (create via @BotFather first).
npx wrangler secret put TG_BOT_TOKEN

# 5. Push Protocol channel private key. Create the channel via
#    push.org admin dashboard first, stake the deposit, then the
#    channel signer's privkey goes here.
npx wrangler secret put PUSH_CHANNEL_PK

# 6. Set the diamond addresses in wrangler.jsonc vars (public info,
#    so no secret needed). Also update FRONTEND_ORIGIN if not
#    vaipakam.com.

# 7. Deploy.
npm run deploy
```

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
2. Frontend POSTs `/link/telegram` to the Worker. Worker returns a 6-digit code.
3. Frontend renders "DM `<code>` to @vaipakam_alerts_bot" plus a one-click Telegram deep-link.
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
# Apply schema to a local D1 replica.
npm run db:migrate:local

# Run the Worker locally with a one-minute cron cycle for testing.
# (Production cron is 5 minutes; Wrangler's `--test-scheduled` fires
# the scheduled handler on demand.)
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
