# Off-Chain Data Resilience — Multi-Cloud Backup + Indexer Quorum

**Status:** Draft 2026-05-23. Closes the gap that issue
[#30 (T-077)](https://github.com/vaipakam/vaipakam/issues/30) opened in
the wake of the T-075 / `DIAG_WALLET_HMAC_KEY` durability discussion.

**Last updated:** 2026-05-23.

**Goal:** ensure the protocol's off-chain stack survives both a
Cloudflare account loss / lockout (availability) and a single-cloud
data tampering attack (integrity). Implemented in two stages so the
floor — restore-after-loss — lands pre-audit while the harder
multi-cloud quorum work lands in the post-audit / pre-mainnet window
with the audit findings already incorporated.

---

## 1. Why this matters

On-chain state is already decentralised by construction — the Diamond
contract and the VPFI token live on chain and survive any operator
incident. But the protocol relies on a small set of off-chain data
that, today, lives **only on Cloudflare**:

| Surface | Store | Owner | Re-derivable from chain? |
| --- | --- | --- | --- |
| `vaipakam-archive` D1 — `offers`, `loans`, `activity_events`, `oracle_snapshot_state`, `liquidity_confidence`, `indexer_cursor` | Cloudflare D1 | apps/indexer (writer), apps/keeper + apps/agent (readers / minor writers) | **Yes** — re-index from `block 0` reconstructs every row deterministically. |
| `vaipakam-archive` D1 — `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit`, `user_thresholds`, `notify_state`, `telegram_links`, `support_tickets` | Cloudflare D1 | apps/agent + apps/indexer (write paths) | **No** — born off-chain (frontend error captures, operator legal-hold actions, user-supplied HF thresholds + Telegram chat links + notification dedupe state). |
| `vaipakam-lz-alerts-db` D1 — `lz_alert_state`, `scan_cursor`, `oft_balance_history` | Cloudflare D1 | ops/lz-watcher | **Partly** — alerts are derived from chain logs, so re-running the watcher reconstructs them, but the alert dispatch history (who-was-notified-when) is born off-chain. **RETIRED 2026-07-28 (#1440).** The Worker was deleted post-T-068 and the nightly backup no longer exports this database — archives written from that date omit the `d1.lzAlerts` section. The dispatch history is deliberately NOT preserved: it is who-was-notified-when for a transport that no longer exists, and the database itself is scheduled for operator deletion. Nothing in Stage A depends on it. |
| `vaipakam-legal-vault` R2 bucket — uploaded legal-hold documents | Cloudflare R2 | apps/agent (uploads) | **No** — third-party documents uploaded by operators, not derivable from any external source. |

A Cloudflare account loss (compromised credentials, billing dispute,
lockout) wipes all of the above. The **re-derivable** subset (chain-
sourced) is recoverable but expensive — a fresh indexer + 6+ months of
chain history is hours of wall-clock to replay. The **born off-chain**
subset (legal docs, diagnostic stream) is
irrecoverable.

A subtler risk: a partial-credential compromise (e.g. CF account access
without full takeover) lets an attacker **tamper** with D1 rows live.
The indexer's offer-book rows have a frontend "verify on-chain"
affordance that catches outright fabrication, but users routinely skip
verification on fast paths. A single phantom offer in `vaipakam-archive`
could lure a user into a transaction the contract refuses, costing
gas — or worse, a tampered `status` flip ("accepted" → "active") could
trick a user into accepting an already-filled offer.

Both failure modes (availability AND integrity) need addressing.

---

## 2. Bifurcation — re-derivable vs born-off-chain

The single most useful insight is that the two halves of the off-chain
footprint have **completely different recovery requirements**:

- **Re-derivable** (offers / loans / activity / oracle snapshots / etc.)
  needs no real backup. A clean indexer pointed at block 0 reconstructs
  every row deterministically. Backup, if any, is a **performance**
  optimization (faster restore) not a **correctness** requirement.
- **Born off-chain** (diag_errors, legal-holds register + audit trail,
  R2 legal-vault) MUST be cross-cloud
  replicated because no external source-of-truth exists.

This bifurcation cuts the cross-replication surface roughly in half.

---

## 3. Stage A — Cross-cloud backup (pre-audit, NOW)

### 3.1 Scope

Schedule a Cloudflare Worker (`ops/offchain-data-archive`) that nightly:

1. Exports the **born off-chain** D1 tables — `diag_errors`,
   `diag_legal_holds`, `diag_legal_hold_audit`, `user_thresholds`,
   `notify_state`, `telegram_links`, `support_tickets` from `vaipakam-archive`.
   (Pre-#1440 this step also exported `vaipakam-lz-alerts-db`; see the
   surface table in §1 for why it no longer does.)
2. Exports the **re-derivable** D1 tables (`offers`, `loans`,
   `activity_events`, `oracle_snapshot_state`, `liquidity_confidence`,
   `indexer_cursor`) — as a *performance* optimisation only;
   restore can skip them in favour of a fresh re-index from block 0.
3. Mirrors every object in the `vaipakam-legal-vault` R2 bucket.
4. Pushes the encrypted-at-rest archive to a **Backblaze B2** bucket
   on a separate billing/credential boundary.

### 3.2 Backblaze B2 — why this provider

- **Cost**: $0.005/GB/mo storage, $0.01/GB egress, free B2 → CF egress
  via Bandwidth Alliance (no egress fee for restores). For the
  expected footprint (≤ 10 GB of D1 + R2 in year 1), the bill is
  **under $1/mo**.
- **API compatibility**: S3-compatible. The same export script works
  against AWS S3 / Storj / Wasabi if the user later wants to swap
  providers — no Worker code change beyond the endpoint URL.
- **Billing boundary**: separate account, separate credit card,
  separate 2FA from Cloudflare. A CF account loss does not propagate.
- **Mature for backup workflows**: Backblaze publishes restore-from-
  outage playbooks and offers Application Keys with restricted
  capability sets. The pipeline uses TWO scoped keys (see §3.3a):
  one write-only key for the nightly uploader, one read-only key
  for the weekly healthcheck. Splitting the keys bounds the blast
  radius of an **isolated single-key leak** (a B2-side or
  transcription leak of one key) to ONE of (corrupt future archives /
  read past ciphertext). It does **not** bound a Cloudflare-side
  compromise: both keys are bound to the same archive Worker, so a
  Workers Edit compromise yields both at once (see the withdrawn-
  claims note in §3.3a). The offline AES key blocks the plaintext
  on the read side in either case.

### 3.3a Two-key B2 access model

The original spec called for a single write-only Application Key
shared by both the nightly uploader and the weekly healthcheck —
but the healthcheck has to perform signed GETs to verify archives,
which a write-only key cannot do. The corrected spec uses two
bucket-scoped Application Keys:

- **`vaipakam-offchain-data-archive-write-only`** — `listBuckets` +
  `writeFiles`, which is what `setup-backblaze.mjs` actually provisions
  (`writeCaps = ['listBuckets', 'writeFiles']`). **NOT `listFiles`**, which an
  earlier revision of this line listed (#1450 r27) — and the omission is
  load-bearing, not incidental: withholding `listFiles` from this key is
  precisely what the naming-nonce guard was designed to rest on. Its being
  defeated anyway is the point of the note below, and mis-stating the
  inventory made the guard look intact. Used by the nightly cron.
  `deleteFiles` is absent, so an
  attacker who exfiltrates these credentials cannot tombstone the history —
  that part holds and is the load-bearing half.

  **Two claims that used to sit here have been withdrawn (#1450 r26).**
  (a) "The immutable-naming nonce prevents overwrite of existing ones" — the
  guard assumes the attacker cannot learn an existing nonce. True of the write
  key in isolation, but the Worker binds the READ key alongside it and that key
  carries `listFiles`, so one compromised environment yields enumeration plus
  write: the forgery lands at the genuine key and the original survives only as
  a hidden older version. (b) "The weekly healthcheck will detect the corrupt
  uploads via SHA-256 mismatch" — it detects corruption and blind overwrites,
  not an authenticated forgery: the same environment also yields
  `BACKUP_ENCRYPTION_KEY`, so a self-consistent archive+manifest pair passes
  every check it makes. Closing that is #1473; version-aware recovery is why
  the retention window exists at all (#1469).
- **`vaipakam-offchain-data-archive-read-only`** — `listBuckets` + `listFiles`
  + `readFiles`. Used by the weekly healthcheck. A CF compromise
  here yields AES-256-GCM ciphertext only; the offline encryption
  key blocks plaintext recovery.

Both keys are bucket-scoped (cannot touch any other bucket in the
same account) and the master Application Key never enters the
Worker — it lives in the operator's offline secret store and only
comes out for the one-time setup script (or explicit rotation).

### 3.3b Immutable archive object keys

Object keys carry a 32-hex-char (16-byte) cryptographic nonce
suffix per upload — `archives/YYYY-MM-DD/<nonce>.bin` and
`manifests/YYYY-MM-DD/<nonce>.json`.

**Scope (#1450 r28): everything this guarantee promises holds only
for an ISOLATED leak of the write key.** In that case an attacker
cannot learn an existing nonce, so a same-date re-upload lands at a
DIFFERENT object key, the original survives, and the healthcheck's
list-by-prefix + manifest-SHA verification catches the divergence.
In the deployed shape the read key — which carries `listFiles` — is
bound to the **same Worker** (§3.3a), so a Workers Edit compromise
defeats the enumeration-resistance this section rests on: the
attacker lists the genuine nonce, uploads at that exact key, and
the original survives only as a hidden older version for the
lifecycle retention window (see the withdrawn-claims note in §3.3a
and `docs/ops/OffChainRestore.md` §2).

The nonce still earns its place: without it, a single PUT to a
predictable key (e.g. `archives/2026-05-23.bin`) would silently
replace the previous night's data with **write-only credentials
alone** — the nonce forces an attacker to hold enumeration
capability too, which is what confines in-place overwrite to the
full-Worker-compromise case above.

### 3.3 Encryption + key management

- Each nightly archive is encrypted client-side (in the Worker) with
  **AES-256-GCM** using a key NOT stored in Cloudflare. The key lives
  in the operator's offline secret store (1Password / pass / similar)
  and is loaded into the Worker via `wrangler secret put`
  `BACKUP_ENCRYPTION_KEY` once. After that the key never leaves CF in
  plaintext — it stays in the encrypted-at-rest secret store.
- Why client-side encryption: B2's server-side encryption (B2 SSE-C)
  protects against B2-internal incidents but not against an attacker
  who steals the B2 API key. Client-side ensures even a fully
  compromised B2 account can't read the archives without the offline
  key.
- The encryption key is **never rotated automatically**. Manual
  rotation: encrypt past archives with the new key, store both keys
  offline during the migration window, then retire the old key.

### 3.4 Retention

- **30 days** of nightly archives (Backblaze lifecycle rule).
- **12 months** of monthly archives (one per month, retained by
  lifecycle rule).
- **Indefinite** for the first archive of each calendar year (for
  legal-hold audit trail durability).
- The monthly and yearly tiers are built as ONE separate payload
  that **excludes `support_tickets`** — the Privacy Policy promises
  ticket deletion no later than 12 months after submission; a ticket
  caught by a monthly cut would otherwise persist ~13 months, and an
  indefinite yearly copy forever. Ticket backup copies therefore
  live only in the 30-day daily tier (at most 30 days past D1
  deletion). The long-tier build runs AFTER the daily payload is
  uploaded and released, so the Worker never holds two ciphertexts
  at once.

### 3.5 Restore procedure

Documented in `docs/ops/OffChainRestore.md` (created in the
implementation PR). High level:

1. Stand up a fresh Cloudflare account + recreate the Workers / D1 /
   R2 from the `wrangler.jsonc` configs in the monorepo.
2. Download the most recent B2 archive locally, decrypt with the
   offline key, restore the **born off-chain** tables via
   `wrangler d1 execute --file=<dump.sql>` and the R2 legal-vault via
   `wrangler r2 object put` per object.
3. Re-bootstrap the indexer from block 0 (faster than restoring the
   `offers` / `loans` tables; correctness-equivalent).
4. Run the indexer event-coverage guardrail to confirm catch-up.
5. Run a smoke-test offer cycle on testnet before re-pointing the
   production frontend.

### 3.6 Operational checks

The Worker's single daily cron at 03:17 UTC runs the nightly backup
unconditionally. On Mondays the same cron tick ALSO runs a
healthcheck in parallel — two independent `ctx.waitUntil` calls, no
shared state, separate scoped B2 keys (write-only for backup,
read-only for healthcheck). The healthcheck:

- Lists the `manifests/<recent-date>/` prefix to discover the latest
  archive (looks back 0..2 days to tolerate a single missed nightly).
- Fetches that manifest + the sibling archive at the matching nonce.
- Verifies the archive's SHA-256 matches the manifest's stamp.
- Decrypts the archive locally to confirm the key + ciphertext are
  intact.
- Pages the operator on any failure via Telegram (`TG_OPS_CHAT_ID`).

The originally-planned shape was a separate Worker cron for the
healthcheck (running at 09:00 UTC every Monday), but the Cloudflare
Workers free plan caps an account at 5 cron triggers. TODAY four are
occupied — apps/keeper, apps/agent, apps/indexer and this Worker
itself — leaving one spare; `ops/mesh-watcher` takes that fifth on
its FIRST DEPLOY, and it is code-complete but undeployed (§4.5). So
the cap BINDS from that deploy onward rather than today, and this
Worker is designed for a single cron on that basis rather than
because the account is already full. (`ops/lz-watcher` held a slot
until #1440 removed it.) Folding the healthcheck into the
daily cron via a `getUTCDay() === 1` guard preserves the weekly
cadence at the cost of running the alert at 03:17 UTC instead of
09:00 UTC. Acceptable trade-off — ops alerts aren't real-time
actionable so the shifted hour doesn't matter; the Mondays-only
gating preserves the weekly cadence. If/when the account upgrades
to Workers Paid ($5/mo, removes the 5-cron cap), this can split
back into two crons cleanly.

This catches silent backup failure — the highest-frequency real-world
incident for nightly-backup systems.

---

## 4. Stage C — Multi-cloud indexer quorum (post-audit, PRE-MAINNET)

### 4.1 Threat model addressed

Stage A protects against *loss* but not against *live tampering*. The
attack surface today:

- An attacker who gets CF dashboard access can write directly to
  `vaipakam-archive` D1. A phantom offer (inserted row with valid
  shape) appears on the OfferBook and the user's `MyOffers`. A flipped
  `status` from `accepted` → `active` makes an already-filled offer
  re-appear as fillable. A mutated `amount_filled` hides partial fills.
- The frontend's "verify on-chain" affordance reads `getOffer(id)`
  directly and detects fabrication — but users skip verification on
  fast paths (clicking through their own MyOffers list, etc.).
- A compromised CF Worker (pushed via dashboard upload) is full game
  over; this design doesn't address that. Code-supply-chain integrity
  is the `required_signatures` rule on the *Protect main* GitHub
  ruleset (#74) plus the Codex / Slither / forge CI gate.

The defense: **three independent indexers across three cloud providers,
each reading the chain via three different RPC endpoints, writing to
three independent D1-equivalent stores**. A thin aggregator takes the
majority on every `getOffer(id)` / `getOffersByCreator(addr)` read.
Divergence is a security alarm.

### 4.2 Provider selection

| Slot | Provider | Worker runtime | DB | Cost/mo |
| --- | --- | --- | --- | --- |
| Primary | Cloudflare Workers | V8 isolates | D1 (SQLite) | ~$0 (free tier) |
| Mirror 1 | Fly.io | Firecracker microVM | SQLite-on-disk | ~$5 |
| Mirror 2 | Hetzner Cloud CX11 (or Railway) | Docker container | SQLite-on-disk | ~$5 |

Each runs the same `apps/indexer` codebase — a thin runtime adaptor
per provider abstracts away the binding differences (`env.DB` vs a
better-sqlite3 handle vs Railway's PostgreSQL). The chain-ingestion
logic, the schema (migrations 0001-0014), and the read-side REST
shape are identical across providers.

Distinct **RPC providers** per mirror so an RPC poisoning attack
doesn't bypass quorum:

| Slot | RPC provider |
| --- | --- |
| Primary | dRPC (current) |
| Mirror 1 | Alchemy |
| Mirror 2 | QuickNode |

### 4.3 Aggregator design

- A thin **read aggregator** sits in front of the three indexer
  endpoints. Sketched as a Cloudflare Worker today (the user's existing
  frontend already talks to a CF Worker); could move to a self-hosted
  edge node in the future.
- On every `/offers/...` read:
  1. Fan out the same request to all three indexers in parallel (4-s
     timeout each).
  2. Compute the **majority** on the result hash (SHA-256 of the
     normalised JSON body).
  3. If 2 of 3 agree → return that body. The 3rd indexer's divergence
     is logged + alerted but doesn't fail the read.
  4. If all 3 disagree → return 503 + alert. Frontend falls back to
     its own `lib/logIndex.ts` on-chain scan (the existing fallback
     path).
  5. If 2 of 3 timeout / 5xx → degrade to 1-of-1 from the surviving
     indexer + page the operator. Service stays up.
- Divergence detection is **stateful**: a divergence that lasts more
  than 30 minutes triggers a P0 page. Transient divergence (indexer
  catching up after a restart) doesn't.

### 4.4 Write paths (legal-hold register + diag_errors)

For the **born off-chain** data — the indexer doesn't write these
itself; `apps/agent` does (legal holds) and the frontend's error
capture path does (diag_errors). Three-way replication of writes
needs consensus, which is heavy.

Pre-mainnet decision: **write paths stay single-cloud** (Cloudflare
primary). The Stage A nightly backups to B2 cover loss; live
tampering of the diag_errors stream isn't user-impacting (the data is
operator-facing diagnostics, not consumed by the frontend). The
legal-hold register IS load-bearing — but it's append-only, mutated
only by a small number of operator actions, and the audit trail
(`diag_legal_hold_audit`) gives a second-layer detection surface.
Worth re-evaluating post-mainnet if write-side tampering becomes a
realistic threat.

### 4.5 Cold standby for other Workers

For `apps/keeper`, `apps/agent` and `ops/mesh-watcher`: **cold standby**,
not active-active. (`ops/mesh-watcher` is code-complete but UNDEPLOYED
today; the standby applies from its first deploy. `ops/lz-watcher` and
`ops/hf-watcher` were removed — #1440 and the Stage 3 split
respectively.) Same Worker code deployed to a second CF account
(different billing + 2FA) **paused**, with a 1-page runbook for the
operator to flip DNS / feature flag on primary failure. The protocol
survives keeper / agent downtime by design in the meantime (liquidations
are permissionless — anyone with the `vaipakam-keeper-bot` reference repo
can race for the bonus).

**The 5-minute figure applies to a Worker-level failure, NOT to losing the
account** — an earlier revision of this section said 5 minutes without that
distinction, and the distinction is the whole difficulty. `apps/keeper` and
`apps/agent` are NOT stateless with respect to the account: both hard-bind
the account-specific `vaipakam-archive` D1 (`database_id`) and the
account-specific Secrets Store (`store_id`) in their `wrangler.jsonc`. A
paused copy in a second account therefore either fails binding validation
or points at that account's EMPTY database and replacement credential
store. Flipping DNS or a feature flag makes it *reachable*, not *correct* —
it would run against no history and no signing key.

So on account loss the standby cutover is gated on the same shared-state
restore as everything else: §§4-7 of `OffChainRestore.md` must recreate the
D1 and repopulate it, and the Secrets Store must be rebuilt from the
offline copies, before flipping anything. The realistic figure there is
hours, matching the restore, and the standby saves only the deploy step.
**There is no case left where 5 minutes holds, so the figure is withdrawn
entirely (#1450 r26).** An earlier revision kept it for "account intact, Worker
or region lost", but the standby is by definition a copy in a SECOND account,
and the bindings above pin the FIRST account's resources — so the second-account
copy is bound to an empty database and an empty credential store whatever the
reason the primary became unavailable. The cause of the outage never changes
what the config addresses.

What the standby is actually worth: it removes the deploy step, and it proves
the code deploys cleanly somewhere else. Recovery time in every failure mode is
the shared-state restore, measured in hours. If a genuinely fast failover is
wanted, the prerequisite is per-account state — its own D1 kept in sync and its
own Secrets Store populated — which is a different design, not a runbook step.

**`ops/offchain-data-archive` is deliberately NOT part of this
mechanism**, and it was listed here in error. Cold standby works for the
Workers above because each has a DNS record or feature flag to flip at all
— but note the paragraph above: on ACCOUNT loss none of them is stateless
either, and the flip only becomes meaningful once the shared state is
restored.
The archive Worker is the opposite on both counts. Its `DB_ARCHIVE` and
`R2_LEGAL_VAULT` bindings can only address resources **in the account it
is deployed to**, so a paused copy in the second account is bound to that
account's empty D1 and R2 — it cannot read the lost account's data, which
is the only data that matters in this scenario. And unlike the others it
has no DNS record and no feature flag: there is nothing to flip.

Its recovery path is the restore, not a standby: the encrypted archives
live in B2, outside Cloudflare entirely and reachable with the offline
keys, so the Worker becomes useful only *after* replacement D1 and R2
resources exist and the archive has been restored into them. That is why
[`OffChainRestore.md`](../ops/OffChainRestore.md) deploys it **last**,
after the data is real — deploying it earlier lets its 03:17 cron write a
valid-looking backup of empty databases and present it as the newest
recovery candidate.

Active-active for these Workers would require non-trivial coordination
(nonce locking for keeper, deduplication for agent's Telegram /
Push dispatch, alert-rate-limit coordination for the watchers).
That's an engineering project to do **after** an actual outage proves
we need it.

---

## 5. Cost & engineering effort

| Stage | Cost/mo | Engineering effort | Defense |
| --- | --- | --- | --- |
| **A**: B2 backup | ~$1 | ~1 day | Restore-after-loss (CF lockout survival). |
| **C**: 2+1 indexer quorum + cold standby | ~$10-15 (Fly + Hetzner) | ~1-2 weeks | Live tampering detection + active-fallback. |

Stage A on its own already cuts the worst-case (CF lockout = total
loss). Stage C closes the integrity gap before mainnet.

---

## 6. Sequencing

1. **NOW (pre-audit)**: implement Stage A in `ops/offchain-data-archive`.
   Backup pipeline live, restore-runbook drafted, healthcheck
   alerting in place.
2. **Audit window**: design doc reviewed; auditors invited to flag any
   gaps in the threat model § 4.1.
3. **Post-audit, pre-mainnet**: implement Stage C in
   `apps/indexer-mirror-fly` + `apps/indexer-mirror-hetzner` (or
   whichever provider names the operator picks at implementation time)
   + `apps/aggregator`. Operational rollout: shadow mode for 2 weeks
   (aggregator reads quorum but frontend keeps reading primary;
   divergence alerts validate the setup), then cutover the frontend
   to read the aggregator.
4. **Mainnet**: aggregator is the production read path. CF stays as
   the primary write target until / unless write-side tampering
   becomes a real threat.

---

## 7. Out of scope

- **Multi-cloud writes** — see §4.4. Write-path consensus is a
  separate engineering project.
- **On-chain quorum** — Vaipakam's chain layer is already
  decentralised; this design only covers the off-chain layer.
- **Compute redundancy for keeper / agent** — covered as cold
  standby in §4.5, not active-active.
- **Cross-region within a single provider** — that's a CF-only
  resilience step; the whole point here is breaking the single-
  provider dependency.

---

## 8. Open questions

- **Provider concrete choice for Mirror 2**: Hetzner CX11 vs Railway
  vs DigitalOcean droplet. All three are ~$5/mo. Hetzner has the
  cleanest billing-boundary story (EU-resident, separate from US-
  hosted CF / Fly.io). To be decided at Stage C implementation time.
- **Aggregator hosting**: Cloudflare Worker (cheap, but reintroduces
  CF as a SPOF for the aggregator itself) vs a small self-hosted
  edge node. The aggregator is an integrity gate, not a data store —
  if it's down, the frontend falls back to its on-chain scan. So CF
  is acceptable; revisit if it becomes the bottleneck.
- **Sequencing of B2 encryption key rotation procedure**: should the
  Stage A PR include the rotation script, or is that a follow-up?
  Default: include in the Stage A PR (one less thing to remember).
