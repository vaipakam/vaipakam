# vaipakam-lz-watcher

Internal-only Cloudflare Worker that watches Vaipakam's LayerZero V2
surface for security drift. Three checks run on a 5-minute cron:

1. **DVN-count drift** — every (chain, OApp, peer eid) `endpoint.getConfig`
   readback must report `requiredDVNCount=3`, `optionalDVNCount=2`,
   `optionalDVNThreshold=1`. Catches an accidental `setConfig` regression
   or a delegate-key compromise weakening the policy.
2. **OFT mint/burn imbalance** — the canonical Base adapter's locked
   VPFI must equal the sum of every mirror chain's `totalSupply()`.
   Any drift means cross-chain messaging integrity has failed.
3. **Oversized VPFI flow** — any single ERC20 `Transfer` event on
   VPFI / VPFIMirror with `value > FLOW_THRESHOLD_VPFI` (default
   100,000 VPFI). Catches a successful forge that mints to an
   attacker.

Alerts go to a single Telegram chat — separate from the public-facing
hf-watcher Worker which doubles as a competitive keeper surface.
Co-locating ops alerts on the same chat as user notifications would
risk leaking incident state to the world.

## First-time deploy

```bash
cd ops/lz-watcher
npm install

# 1. Create the D1 database — capture the printed database_id and
#    paste it into wrangler.jsonc's `database_id` field.
wrangler d1 create vaipakam-lz-alerts-db

# 2. Apply the schema migration.
npm run db:migrate

# 3. Set the secrets (per-chain RPC URLs + Telegram bot token).
#    Use Alchemy / QuickNode / Infura — public RPCs rate-limit
#    aggressively and the eth_getLogs calls will get throttled.
wrangler secret put RPC_BASE
wrangler secret put RPC_ETH
wrangler secret put RPC_ARB
wrangler secret put RPC_OP
wrangler secret put RPC_ZKEVM
wrangler secret put RPC_BNB
wrangler secret put TG_BOT_TOKEN

# 4. Edit wrangler.jsonc's `vars` block — paste the LZ V2 endpoint
#    address, ULN302 send/receive library addresses, and every
#    Vaipakam OApp deployed on each chain. Plus the ops chat id
#    (TG_OPS_CHAT_ID) and the optional FLOW_THRESHOLD_VPFI override.

# 5. Deploy.
npm run deploy
```

## How to verify it's actually running

After deploy, send a test alert by intentionally degrading something
in a forked deploy (e.g. `setConfig` with `requiredDVNCount=1`).
Within 5 minutes you should see a Telegram message in the ops chat
with the offending OApp + peer eid + side.

To inspect the per-tick log without an alert, tail the Worker log:

```bash
wrangler tail vaipakam-lz-watcher
```

Empty ticks log `[lz-watcher] tick clean — no alerts`. Per-watcher
errors log on their own line so a single bad RPC doesn't silently
kill detection on the rest.

## Free-tier sizing

Free Workers tier (as of 2026):

- 100,000 requests/day → 5-min cron uses 1,440/day (1.4%)
- 10ms CPU per invocation → idle tick ≈ 2ms; per-packet decode
  + encoding adds <1ms each
- 50 subrequests per invocation → steady state ≈ 18-25 calls
  (6 chains × 3 RPC calls baseline; per-OApp checks add 2-4)
- D1: 5GB storage, 50K writes/day → we write ~10/day

If volume grows past those limits, upgrade to Workers Standard
($5/mo) for 1000 subrequests + 30s CPU.

## Alert dedup

Alerts are deduped via the `lz_alert_state` D1 table:

- First time a (kind, key) goes bad: fire immediately, record.
- Same (kind, key) still bad with same value: re-fire after 1h.
- Same (kind, key) still bad with new value: fire immediately.
- (kind, key) recovers: send recovery alert, clear the row.

This keeps Telegram noise low even when a bad config persists for
days. Tune `ALERT_REPEAT_AFTER_SEC` in `db.ts` if 1 hour is wrong.

## Local dev

```bash
npm run dev   # wrangler dev — invokes the scheduled() handler on Ctrl+L
```

Set local env vars in a `.dev.vars` file (gitignored).
