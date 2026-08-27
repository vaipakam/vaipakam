# Cloudflare Staging — Provisioned State

**Provisioned:** 2026-05-07
**Account:** `Support@vaipakam.com's Account`
**Account ID:** `f8d28a27e95d4eab69364d7b3341fa7d`
**Zone (vaipakam.com):** `3c8cfa6740c6fed1277e58d2214bdde4`

## D1

| Database | ID | Region | Schema owner | Other binders |
|---|---|---|---|---|
| `vaipakam-archive` | `3cffebf5-b652-4da7-953c-9e1d143ad2fe` | APAC | `apps/indexer` (canonical `migrations/`) | `apps/keeper`, `apps/agent` |

**Topology**: single shared D1, owned by indexer. The keeper and agent
Workers bind to the same `database_id`; they intentionally have no
`migrations/` directory of their own. Per-Worker table access (from a
source survey, distinguishing writes from reads):

- **keeper writes**: `user_thresholds`, `notify_state`, `telegram_links`, `liquidity_confidence`, `oracle_snapshot_state`.
- **keeper reads-only**: `loans`, `offers`.
- **agent writes**: `user_thresholds`, `notify_state`, `telegram_links`, `loans`, `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit`.
- **agent reads-only**: (none — every table the agent reads, it also writes.)

Apply schema changes with `wrangler d1 migrations apply vaipakam-archive
--remote` from inside `apps/indexer/`.

## Workers

> **This section mixes two vintages — read the labels.** Everything
> unmarked is the 2026-05-07 provisioning snapshot; anything marked
> "verified 2026-08-27" was re-checked against the account and is
> current. The heading used to assert that every Worker served a
> placeholder 503, which was true at provisioning and is not true now:
> `vaipakam.com`, `defi.vaipakam.com` and `indexer.vaipakam.com` all
> answer **200**. `app.vaipakam.com` does not resolve at all — it is not
> bound.
>
> **`agent.vaipakam.com` answers 403 `Forbidden` to EVERYTHING, and that
> is a discrepancy to investigate, not a status to bless (#1971).** An
> earlier version of this banner called it "correct for an authenticated
> API"; the Worker's code refutes that. `apps/agent/src/index.ts` has no
> global authentication gate and ends with
> `new Response('Not found', { status: 404 })`, so an unmatched path
> should 404 — yet `/`, the defined `/thresholds` route and a nonsense
> path all return the same 403 with a 9-byte `Forbidden` body the Worker
> never produces. Something in front of the Worker is answering. It is
> not a blanket block on the observing client either: the other three
> hostnames on this zone answer 200 through the same egress.
>
> **Reconciled for #1854.** The dApp Worker is
> now `vaipakam-app`, built from `apps/app`; its intended hostname is
> `app.vaipakam.com` but that binding does NOT exist yet, so the Worker is
> reachable only on its emitted `workers.dev` URL
> (`@vaipakam/app`).
>
> **RE-VERIFIED 2026-08-27** against the account's Workers custom-domain
> inventory — the check this banner used to defer to an operator. The
> `defi.vaipakam.com` binding is still live and still the same one:
> binding id `a6475e83…`, matching the row recorded on 2026-05-07 below.
> All four retired-source Workers are still bound and still serving —
> `defi`, `alpha02`, `alpha` and `alpha01` all answer 200 — so deleting
> `apps/defi`, `apps/alpha` and `apps/alpha01` from the tree did not
> retire anything in Cloudflare. Their retirement remains an operator
> action, and `defi.vaipakam.com` in particular CANNOT be retired while
> it is the only host serving `/analytics` and `/protocol-console`
> (#1959).

| Worker | Domain | Lane | Cron | D1 binding |
|---|---|---|---|---|
| `vaipakam-www` | `vaipakam.com` (apex, canonical) ✅ + `www.vaipakam.com` → 301 to apex ✅ | Marketing static site (renamed from `vaipakam-labs` at the labs → www cutover). **`labs.vaipakam.com` is retired, not redirected** — verified 2026-08-27: no Workers binding and NO DNS record, so nothing resolves and no redirect rule can fire. This row previously said it served a 301 Bulk Redirect to www; a redirect needs a proxied DNS record, and there is none | none | none |
| `vaipakam-defi` | `defi.vaipakam.com` (cert provisioning) | dApp frontend | none | none |
| `vaipakam-agent` | `agent.vaipakam.com` (cert provisioning) | D1 → users (REST, Telegram, Push, frames) | every minute | yes |
| `vaipakam-indexer` | (no public domain — cron only) | Chain → D1 | every minute | yes |
| `vaipakam-keeper` | (no public domain — cron only) | Chain writes | **NONE — `"crons": []`, #1896** (was `* * * * *`; the "5-min HF + 00:05 UTC daily oracle" this row used to claim was already wrong) | yes |

Workers default URLs (for direct reachability before custom-domain SSL is fully live):
- https://vaipakam-www.dawn-fire-139e.workers.dev
- https://vaipakam-defi.dawn-fire-139e.workers.dev
- https://vaipakam-agent.dawn-fire-139e.workers.dev
- https://vaipakam-indexer.dawn-fire-139e.workers.dev
- https://vaipakam-keeper.dawn-fire-139e.workers.dev

## Custom domain bindings

| Hostname | Binding ID | Cert ID | Status |
|---|---|---|---|
| ~~`labs.vaipakam.com`~~ | ~~`08853b930e2701479ca2cb9e3597d52a2ee5578c`~~ | ~~`aedaca43-5223-4acd-af0f-559ed28a181b`~~ | **REMOVED.** Verified 2026-08-27: absent from the account's Workers custom-domain bindings and absent from DNS. Ids kept struck through so an operator matching an old dashboard screenshot can see this row was retired rather than mislaid |
| `defi.vaipakam.com` | `a6475e83ae6888e8f4d9e3e0f0b25609e283cb57` | `95999728-53b0-4229-9111-d624a7cdb320` | **live** — verified 2026-08-27 in the Workers custom-domain inventory (same binding id as provisioned) and serving 200. Was "cert provisioning (~5–10 min)" at the May snapshot |
| `agent.vaipakam.com` | `13dec781889c1b1ac6d68a34adc48b19356b5987` | `cc9e32be-5019-4d0a-bc13-d63349480ad2` | **live** — verified 2026-08-27, serving 403 to a bare `GET /`, which is the correct answer for an authenticated API and NOT an outage. Was "cert provisioning" at the May snapshot |

## Pending — operator action

- [ ] Set `KEEPER_PRIVATE_KEY` on `vaipakam-keeper` (encrypted secret) — wallet pays gas for
      auto-liq + daily oracle snapshot
- [ ] Set `RPC_*` per chain on `vaipakam-indexer` and `vaipakam-keeper`
- [ ] Set `TG_BOT_TOKEN`, `PUSH_CHANNEL_PK`, aggregator API keys on `vaipakam-agent`
- [ ] Set `KEEPER_ENABLED=false` on `vaipakam-keeper` initially. **#1896: flipping it
      true is NO LONGER sufficient to start the keeper, and must not be done yet.**
      The Worker has no cron (`"crons": []`), so the flag alone arms nothing — every
      pass stays stopped. Restoring the schedule is a prerequisite and has its own
      sequence, kept beside the empty list in `apps/keeper/wrangler.jsonc`; that
      sequence begins by setting this flag to `false` explicitly, because a secret's
      value cannot be read back and "it should still be off" is not a check.

## Pending — author action

**All DONE, and the first item has since been superseded twice.** Kept as
the record of what was outstanding in May; do not action this list.

- [x] Source-tree refactor: `frontend/` → `apps/defi/`, `ops/hf-watcher/` → split into
      `apps/agent/` + `apps/indexer/` + `apps/keeper/`
      — the Worker split shipped; `apps/defi` itself was then retired by
      #1854 and the connected app is now `apps/app`
- [x] Per-app `wrangler.jsonc` with this state's IDs
- [x] Apply migrations to `vaipakam-archive`
- [x] Add `0011_offers_cancelled_at.sql` migration for cancelled-offer D1 capture
      — this is the migration whose duplicated `0011` prefix is
      grandfathered in `apps/indexer/scripts/check-migration-prefixes.mjs`
- [x] Update chainIndexer.ts: UPDATE-on-OfferCanceled instead of DELETE
