# Cloudflare Staging — Provisioned State

**Provisioned:** 2026-05-07
**Account:** `Support@vaipakam.com's Account`
**Account ID:** `f8d28a27e95d4eab69364d7b3341fa7d`
**Zone (vaipakam.com):** `3c8cfa6740c6fed1277e58d2214bdde4`

## D1

| Database | ID | Region |
|---|---|---|
| `vaipakam-archive` | `3cffebf5-b652-4da7-953c-9e1d143ad2fe` | APAC |

Migrations not yet applied — will run from `apps/agent/` once the
source-tree split lands.

## Workers (all currently serving placeholder 503)

| Worker | Domain | Lane | Cron | D1 binding |
|---|---|---|---|---|
| `vaipakam-www` | `www.vaipakam.com` ✅ + `vaipakam.com` (apex) ✅ | Marketing static site (renamed from `vaipakam-labs` at the labs → www cutover; `labs.vaipakam.com` now serves a 301 Bulk Redirect to www) | none | none |
| `vaipakam-defi` | `defi.vaipakam.com` (cert provisioning) | dApp frontend | none | none |
| `vaipakam-agent` | `agent.vaipakam.com` (cert provisioning) | D1 → users (REST, Telegram, Push, frames) | every minute | yes |
| `vaipakam-indexer` | (no public domain — cron only) | Chain → D1 | every minute | yes |
| `vaipakam-keeper` | (no public domain — cron only) | Chain writes | 5-min HF + 00:05 UTC daily oracle | yes |

Workers default URLs (for direct reachability before custom-domain SSL is fully live):
- https://vaipakam-www.dawn-fire-139e.workers.dev
- https://vaipakam-defi.dawn-fire-139e.workers.dev
- https://vaipakam-agent.dawn-fire-139e.workers.dev
- https://vaipakam-indexer.dawn-fire-139e.workers.dev
- https://vaipakam-keeper.dawn-fire-139e.workers.dev

## Custom domain bindings

| Hostname | Binding ID | Cert ID | Status |
|---|---|---|---|
| `labs.vaipakam.com` | `08853b930e2701479ca2cb9e3597d52a2ee5578c` | `aedaca43-5223-4acd-af0f-559ed28a181b` | live (HTTP/2 503 confirmed) |
| `defi.vaipakam.com` | `a6475e83ae6888e8f4d9e3e0f0b25609e283cb57` | `95999728-53b0-4229-9111-d624a7cdb320` | cert provisioning (~5–10 min) |
| `agent.vaipakam.com` | `13dec781889c1b1ac6d68a34adc48b19356b5987` | `cc9e32be-5019-4d0a-bc13-d63349480ad2` | cert provisioning (~5–10 min) |

## Pending — operator action

- [ ] Set `KEEPER_PRIVATE_KEY` on `vaipakam-keeper` (encrypted secret) — wallet pays gas for
      auto-liq + daily oracle snapshot
- [ ] Set `RPC_*` per chain on `vaipakam-indexer` and `vaipakam-keeper`
- [ ] Set `TG_BOT_TOKEN`, `PUSH_CHANNEL_PK`, aggregator API keys on `vaipakam-agent`
- [ ] Set `KEEPER_ENABLED=false` on `vaipakam-keeper` initially (flip true after validation)

## Pending — author action

- [ ] Source-tree refactor: `frontend/` → `apps/defi/`, `ops/hf-watcher/` → split into
      `apps/agent/` + `apps/indexer/` + `apps/keeper/`
- [ ] Per-app `wrangler.jsonc` with this state's IDs
- [ ] `.github/workflows/deploy-workers.yml` matrix
- [ ] Apply migrations to `vaipakam-archive`
- [ ] Add `0011_offers_cancelled_at.sql` migration for cancelled-offer D1 capture
- [ ] Update chainIndexer.ts: UPDATE-on-OfferCanceled instead of DELETE
