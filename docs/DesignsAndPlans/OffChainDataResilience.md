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
| `vaipakam-archive` D1 — `offers`, `loans`, `activity`, `oracle_snapshot_state`, `liquidity_confidence_*`, `current_holder` | Cloudflare D1 | apps/indexer (writer), apps/keeper + apps/agent (readers / minor writers) | **Yes** — re-index from `block 0` reconstructs every row deterministically. |
| `vaipakam-archive` D1 — `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit` | Cloudflare D1 | apps/agent + apps/indexer (write paths) | **No** — born off-chain (frontend error captures, operator legal-hold actions). |
| `vaipakam-lz-alerts-db` D1 — `lz_alerts`, `lz_cursor` | Cloudflare D1 | ops/lz-watcher | **Partly** — alerts are derived from chain logs, so re-running the watcher reconstructs them, but the alert dispatch history (who-was-notified-when) is born off-chain. |
| `vaipakam-legal-vault` R2 bucket — uploaded legal-hold documents | Cloudflare R2 | apps/agent (uploads) | **No** — third-party documents uploaded by operators, not derivable from any external source. |

A Cloudflare account loss (compromised credentials, billing dispute,
lockout) wipes all of the above. The **re-derivable** subset (chain-
sourced) is recoverable but expensive — a fresh indexer + 6+ months of
chain history is hours of wall-clock to replay. The **born off-chain**
subset (legal docs, diagnostic stream, alert dispatch history) is
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
  R2 legal-vault, lz-alerts dispatch history) MUST be cross-cloud
  replicated because no external source-of-truth exists.

This bifurcation cuts the cross-replication surface roughly in half.

---

## 3. Stage A — Cross-cloud backup (pre-audit, NOW)

### 3.1 Scope

Schedule a Cloudflare Worker (`ops/cloud-backup`) that nightly:

1. Exports the **born off-chain** D1 tables (`diag_errors`,
   `diag_legal_holds`, `diag_legal_hold_audit`, plus `lz_alerts` /
   `lz_cursor` from the lz-watcher DB).
2. Exports the **re-derivable** D1 tables (`offers`, `loans`,
   `activity`, `oracle_snapshot_state`, etc.) — as a *performance*
   optimisation only; restore can skip them in favour of a fresh
   re-index.
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
  radius of a CF compromise to ONE of (corrupt future archives /
  read past ciphertext); the offline AES key blocks the plaintext
  on the read side.

### 3.3a Two-key B2 access model

The original spec called for a single write-only Application Key
shared by both the nightly uploader and the weekly healthcheck —
but the healthcheck has to perform signed GETs to verify archives,
which a write-only key cannot do. The corrected spec uses two
bucket-scoped Application Keys:

- **`vaipakam-offchain-data-archive-write-only`** — `listBuckets` + `listFiles`
  + `writeFiles`. Used by the nightly cron. A CF compromise that
  exfiltrates these credentials can corrupt FUTURE archives only —
  immutable-naming nonce (see §3.3b) prevents overwrite of existing
  ones, and `deleteFiles` is absent so the attacker can't tombstone
  the history. The weekly healthcheck will detect the corrupt
  uploads via SHA-256 mismatch.
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
`manifests/YYYY-MM-DD/<nonce>.json`. Same date written twice (e.g.
an attacker re-uploading garbage) produces two DIFFERENT object
keys, so the original archive survives and the healthcheck's
list-by-prefix + manifest-SHA verification catches the divergence.
Without the nonce, a single PUT to a predictable key (e.g.
`archives/2026-05-23.bin`) would silently replace the previous
night's data — write-only credentials alone don't defend against
in-place overwrite, only against read/delete.

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

- A second Cloudflare Worker cron (`ops/cloud-backup/healthcheck`)
  runs **weekly** to:
  - HEAD the most recent B2 archive.
  - Decrypt + verify the SHA-256 manifest matches the expected
    schema.
  - Page the operator (Telegram + Push) on any missing / corrupt
    archive.

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

For `apps/keeper`, `apps/agent`, `ops/lz-watcher`, `ops/hf-watcher`:
**cold standby**, not active-active. Same Worker code deployed to a
second CF account (different billing + 2FA) **paused**, with a 1-page
runbook for the operator to flip DNS / feature flag on primary
failure. Pre-mainnet a 5-minute manual recovery is fine; the protocol
survives keeper / agent downtime by design (liquidations are
permissionless — anyone with the `vaipakam-keeper-bot` reference repo
can race for the bonus).

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

1. **NOW (pre-audit)**: implement Stage A in `ops/cloud-backup`.
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
