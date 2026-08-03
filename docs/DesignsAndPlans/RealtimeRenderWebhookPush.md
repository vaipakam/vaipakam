# Near-real-time render — inbound chain webhook + DO single-writer + browser push (#757)

**Status:** Phase A shipped (PR #764). **Phase B shipped (PR #783)** — the DO is
now a Hibernatable WebSocket hub: a dapp opens `GET /ws/chain/:chainId`, and after
each scan's D1 write the DO pushes coarse invalidation keys
(`offer.created` · `offer.changed` · `loan.created` · `loan.updated` ·
`activity.appended`) that nudge the dapp's watermark to refetch the changed slice.
Additive + degradable: with no WS / DO-ingest off, the dapp keeps polling. v1
uses coarse per-category keys (not per-id) and does NOT yet back off the poll
cadence when live — both are follow-ups. Architecture is **owner-locked**
(issue #757, sign-off 2026-06-27) for the *trigger* (Alchemy webhook) and the
*push* (Cloudflare Durable Object + Hibernation). This doc is the *implementation*
design.

> **Design evolution (PR #759 review history).** Early drafts had the webhook
> **Worker** write D1 directly, concurrently with the cron. Codex review showed
> that concurrent ingest needs a deep concurrency-hardening of the existing
> indexer (a lock, then a per-row high-water-mark, then per-field-group
> watermarks + tombstones…) — because the handlers were written for a **single,
> in-order writer**. The fix is not to *tolerate* concurrency but to *remove*
> it: make a **per-chain Durable Object the single serialized ingest writer**.
> The DO's input gate processes one request at a time, so cron-triggered and
> webhook-triggered scans can never overlap; the existing handlers stay valid
> unchanged. The DO is also the Phase B push fan-out, so Phase A and Phase B
> unify into one component. The only residual is a pre-existing single-writer
> bug — partial-failure **re-scan** double-applies delta handlers — fixed
> **first** and separately as **#760** (idempotent block-pinned handlers).

## 1. Goal & non-goals

**Goal.** Cut render staleness from "up to N minutes" (N = number of indexed
chains; the cron processes one chain per tick, round-robin) to **seconds**,
**without weakening the decentralized fallback chain**.

**Non-goals / invariants (do not regress).**

- Indexer stays a **cache, not an oracle**: the dapp reads it indexer-first and
  falls back to in-browser log-scan (`apps/defi/src/lib/logIndex.ts`) → direct
  RPC. Every new layer degrades to today's behaviour.
- Reads stay on **dRPC (paid)**; Alchemy is **trigger-only** (push), never read
  through.
- Push (Phase B) carries an **invalidation key only**, never authoritative data.
  Time-based states (offer expiry) are not event-driven and stay owned by the
  client clock + the cron/DO sweep.

## 2. Today's ingest (what we reuse)

`scheduled()` → `runChainIndexer(env)` → round-robin one chain → 
`runChainIndexerForChain(env, chain)`: read `indexer_cursor` → scan
`[cursor+1, safeHead]` (head at `blockTag:'safe'`, reorg-proof) → chunked
`getLogs({address: diamond})` → decode against `EVENT_ABI` → dispatch to
`processOfferLogs`/`processLoanLogs`/`recordActivityEvents` **in log order** →
advance cursor. Single-threaded, in-order; the handlers rely on that. **We keep
this scan/decode/dispatch code verbatim** — we change only *who calls it* and
*how often*.

## 3. The architecture: a per-chain Durable Object is the single ingest writer

### 3.1 Why a DO — collapse ingest to a single in-memory writer

A Cloudflare **Durable Object is a single addressable instance**: all requests
for `idFromName(chainId)` land on one object, in one location. That gives us a
single place to run an **explicit single-flight queue** so only one scan for a
chain runs at a time — which is precisely the assumption the existing handlers
already satisfy. No lock, no watermark, no tombstones, no per-field-group
columns: the whole concurrency-hardening tax the Worker-writes-D1 approach
incurred does not arise.

> **Important (Codex r7 P1): the DO input gate is NOT enough on its own.** The
> input gate serializes request *delivery* and closes during *storage*
> operations, but it is **open across awaited network work**. Our scan awaits
> dRPC reads for seconds before the cursor advances, so a second trigger could
> be delivered mid-scan, read the same cursor, and start an overlapping scan.
> So the DO must run an **explicit single-flight guard** (§3.4): a `scanning`
> flag + a coalesced `pendingTarget`, persisted in **DO storage** (so it
> survives hibernation), gates all scans. A trigger that arrives while a scan is
> running only *raises* `pendingTarget` and returns; the in-flight loop picks it
> up. This — not the input gate — is what guarantees the single writer.

The DO is *also* the component the locked Phase B architecture already mandates
(inbound WebSocket + Hibernation for browser push). So we are not adding new
infrastructure for Phase A — we are putting the ingest **and** the push on the
one DO the design already requires, which is cleaner than "Worker writes D1,
then notifies a separate DO."

### 3.2 Topology

```
                 ┌─────────── cron (scheduled, every 1 min) ───────────┐
                 │  for each indexed chain: stub(chainId).fetch(trigger)│
                 ▼                                                       │
Alchemy webhook ─► indexer Worker /hooks/chain-event                     │
  (HMAC + body-cap + per-delivery dedupe)                                │
                 │ stub(chainId).fetch({ targetBlock: H })              │
                 ▼                                                       ▼
        ┌──────────────────────  ChainIngestDO(chainId)  ──────────────────────┐
        │  SINGLE-THREADED. Triggers (cron + webhook) are serialized by the     │
        │  input gate. On a trigger:                                            │
        │    • runChainIndexerForChain(env, chain)  ← the cron's UNCHANGED scan │
        │      (cursor-derived, safe-head-bounded, in-order, writes shared D1)  │
        │    • if targetBlock H not yet safe / backlog remains → setAlarm(+~3s)  │
        │      to re-scan (the "catch-up / wait-for-safe" loop, alarm-driven)    │
        │    • after the D1 write → broadcast invalidation to its WS clients     │
        │      (Phase B)                                                         │
        │  Holds the browser WebSockets (inbound + Hibernation).                │
        └───────────────────────────────────────────────────────────────────────┘
                 ▼
        shared D1 (vaipakam-archive)  — the DO is the only EVENT-PROJECTION writer per chain
```

- **One DO per chain** via `idFromName(String(chainId))`. The webhook Worker and
  the cron both resolve the same stub and `fetch` it; the DO serializes them.
- The DO binds the **shared D1** and reads **dRPC** (same `chain.rpc`); Alchemy
  is never read through. The scan logic is `runChainIndexerForChain`, moved to
  run **inside** the DO (it already takes `(env, chain)` and only needs the D1
  binding + RPC — both available to a DO).
- The cron's `scheduled()` stops scanning inline; it just **pings each chain's
  DO** every minute. (Bonus: every chain is serviced each minute rather than one
  per round-robin tick, so baseline staleness drops to ~1 min even with **no**
  webhook; the webhook makes it seconds.)
- **Retention pass** (`pruneOldCancelledOffers`) touches **disjoint** rows (old
  cancelled rows past the retention window), not the live event projection, so it
  may stay on the cron Worker.
- **`sweepUnpublishedListings` is NOT disjoint (Codex r7 P2)** — it selects and
  updates `prepay_listings` (the OpenSea publish marker) which the chain handlers
  also write. So it must run **through the chain's DO** (so it's serialized with
  ingest), not on the cron Worker. The cron pings the DO to run both its scan and
  its listing-republish for that chain.

### 3.3 The webhook route (`POST /hooks/chain-event`)

Receives the Alchemy POST, authenticates, and forwards to the chain's DO. It
does **not** write D1 itself.

- **Dispatch BEFORE the global `resolveEnv`.** `index.ts` calls `resolveEnv` at
  the top of `fetch`, fetching every RPC/OpenSea secret for *any* request. The
  webhook route is matched first and reads **only** `ALCHEMY_WEBHOOK_SIGNING_KEY`
  from the raw `WorkerEnv`, so an unauthenticated POST never triggers Secrets-
  Store work.
- **Body cap → 413** before any hashing (`Content-Length` / bounded read,
  `MAX_WEBHOOK_BODY ≈ 64 KiB`); bounds the pre-auth cost of this public route.
- **HMAC-SHA256 over the raw body**, constant-time via Web Crypto
  `crypto.subtle.verify` (same primitive as `apps/agent/src/diagHash.ts`),
  hex-decoding `X-Alchemy-Signature`. **Fail-closed**: secret unset / header
  missing-malformed / verify fails → **401**, no forward. New secret
  `ALCHEMY_WEBHOOK_SIGNING_KEY` (Secrets Store binding).
- **Payload → (chainId, max block H)**, hint only: map the Alchemy network →
  `chainId`; extract the max delivered block `H` as the DO's catch-up **target**
  (it bounds *how long the DO waits for finality*, never what gets written — the
  scan range stays cursor-derived and every row is a fresh dRPC re-read).
  Unknown network / unconfigured chain → 200 no-op.
- **Durable forward, then ack (Codex r7 P2 ×2).** Forwarding must not be
  fire-and-forget: the Worker `await`s `stub.fetch(chainId, { targetBlock: H })`,
  whose DO handler is **enqueue-only** — it durably records `pendingTarget` in DO
  storage (§3.4) and returns a fast ack *before* running the scan. Only **after**
  that durable enqueue-ack does the Worker (a) `INSERT OR IGNORE` the
  `webhook_deliveries(delivery_id PK, seen_at)` dedupe row and (b) return **200**.
  Ordering matters: dedupe-after-enqueue means a delivery whose forward failed is
  **not** marked seen, so Alchemy's retry re-forwards it (rather than hitting a
  dedupe row and 200-ing without forwarding — which would drop the trigger). The
  whole thing still returns a prompt 2xx because the DO ack is enqueue-only (the
  scan runs async in the DO via its alarm/loop).

### 3.4 The DO's single-flight catch-up loop (storage-backed, alarm-driven)

Alchemy fires on the just-mined tip, so `H` is often **above** the safe head. The
DO must wait for `H` to finalize, not scan once and stop — and must run **one
scan at a time** (§3.1) with state that **survives hibernation** (Codex r7 P2).

- **Storage-backed single-flight.** The DO keeps `pendingTarget` and a
  `scanning` flag in **DO storage** (not just instance memory — hibernation
  resets memory and the alarm can fire after a reset). An enqueue (from the
  webhook forward or the cron ping): `pendingTarget = max(pendingTarget, H)`
  persisted; if `scanning` is already true, return immediately (the in-flight
  loop will chase the raised target); else set `scanning = true` and `setAlarm`.
- **The loop (alarm handler).** Read `pendingTarget` from storage; read the
  current safe head (1 subrequest). If `H > safeHead`, the tip isn't final yet —
  re-`setAlarm(now + ~3s)` and return (cheap wait). Else run **one**
  `runChainIndexerForChain` (clamped to the current safe head). If `cursor <
  pendingTarget` (backlog beyond one scan's ~2000-block cap), `setAlarm` again;
  when `cursor >= pendingTarget` or a bounded attempt budget is hit, clear
  `scanning`. Alarms (not a pinned `waitUntil`) keep the DO Hibernation-friendly
  and bound the work; the `scanning` flag guarantees the single writer across the
  awaited dRPC reads the input gate alone would not.
- **Latency (honest, Codex r7 P2).** The guarantee is "**within seconds of the
  block being reported `safe`**", which is *not* always seconds after mining: an
  L2 `safe` head is tied to L1 batch posting / finality, so on production
  Base/OP/Arbitrum the safe lag can be **minutes**, not seconds, even when the
  webhook arrives instantly. We deliberately keep the reorg-proof `blockTag:
  'safe'` clamp (never cache reorg-able state), so the realtime win is "remove
  the round-robin delay; ingest within seconds of *safe*". A fast-finality
  **testnet** (short safe lag) demonstrates seconds-after-mining; production L2
  latency tracks each chain's real safe-finality, and Ethereum mainnet (~13 min)
  and deep backlog finalize alarm/cron-paced. (If a future product decision wants
  sub-safe "pending" invalidation for UI, that's a separate confirmation policy —
  explicitly out of scope here because it would cache reorg-able state.)

### 3.5 Prerequisite (#760, broadened): make a sequential RE-SCAN fully deterministic

A single writer removes *concurrency*, but **sequential re-scan** still exists:
`runChainIndexerForChain` writes rows before advancing the cursor, so a
partial-failure scan re-runs the range — possibly **after later blocks have been
seen** by a subsequent scan. For the projection to converge, *every* write a
re-scan can repeat must be deterministic. **#760 lands first and covers all of
it** (Codex r7 widened the scope beyond the delta handlers):

1. **Delta / current-row handlers → absolute block-pinned writes** (the core
   corruption bug). `InternalMatchExecuted` (`-= notional` on the D1 row) and
   `OfferMatched` (`amount_filled` from the current `amount_max`) now write
   absolute values read at `{blockNumber: log.blockNumber}`. *(Done in PR #761.)*
2. **Block-pin EVERY replayed chain read, not just the deltas** (Codex r7 L164).
   Other handlers also do live RPC reads — the `OfferCreated`/stub-heal
   `getOfferDetails` path and the prepay `grace_period_end` resolution
   (`_resolveGraceEnd`). At `latest` head, a re-scan of an *old* range after
   later blocks would write **post-`scanTo`** state for an old event. Pin those
   reads to `log.blockNumber` too. *(Follow-on within #760, not yet in #761.)*
3. **External side-effects must be replay-safe** (Codex r7 L163). The prepay
   handlers `_maybePublishToOpenSea` **before** the cursor advances; a re-scan
   re-POSTs the same order and can flip `opensea_published_at` back to NULL on a
   non-2xx. Guard with an **atomic `INSERT OR IGNORE` published-marker** keyed by
   order hash before the external call; only the winner publishes; a transient
   failure leaves the marker absent so the legitimate republish sweep still runs.
4. **Same-block, same-row ordering** (Codex r7 L166). The dispatch buckets events
   by type, not strictly by chain log order, so two same-block events on one row
   could apply in bucket order. With (1)+(2) every value write is an absolute
   end-of-block snapshot (order-independent — they all converge to the same
   end-of-block state); the residual is **status flips that read the event, not
   chain** (`OfferAccepted`/`Canceled` vs a match). Cover them by dispatching
   same-row events in **log order** *or* by deriving status from a block-pinned
   read — to be settled in #760's implementation.

(Block-pin is "end-of-block"; combined with absolute snapshots + the chosen
ordering rule, the final state is the highest-log event's end-of-block snapshot
= correct.) **#757 depends on #760 (all four) landing first**; with it, the DO
re-scan is deterministic, and *none* of the watermark/lock/tombstone machinery is
needed. The `webhook_deliveries` dedupe table gets its **own** prune in the
scheduled retention path (Codex r7 P3 — the existing sweep only prunes cancelled
offers).

### 3.6 Monotonic cursor (small hardening)

Keep the cursor advance **monotonic** — `ON CONFLICT DO UPDATE SET last_block =
excluded.last_block WHERE excluded.last_block > last_block`. With the DO as sole
writer this is rarely contended, but it cheaply prevents a cursor regression
(e.g. an alarm re-scan to an earlier safe head) from undoing catch-up progress.

### 3.7 Why this is safe (replay / reorg / ordering)

| Hazard | Why it's handled |
|---|---|
| **Concurrency** (cron vs webhook vs webhook) | DO input gate serializes all triggers per chain → one writer, never overlapping |
| **Sequential re-scan** (partial failure) | Handlers idempotent via absolute block-pinned writes (**#760**) |
| **Reorg-able blocks** | Scan reads `blockTag:'safe'` — unchanged from the cron |
| **Same-block ordering** | Single-writer in-order processing → later log overwrites earlier |
| **Replayed webhook delivery** | Per-delivery dedupe drops it; even if not, the DO just re-scans forward idempotently |
| **Forged POST / oversized body** | HMAC fail-closed (401) + body cap (413), before any work |
| **Push outage / unconfigured chain** | Degrades to cron-paced ingest; no user-facing error |

No new contract events, no ABI change → `check-event-coverage` unaffected.

## 4. Why this beats the lock / watermark alternatives

| | Lock (best-effort or strict) | Per-field-group watermark | **DO single-writer (this)** |
|---|---|---|---|
| Concurrency model | Tolerate + serialize via D1 lease | Tolerate + converge per row/group | **Remove** (input gate) |
| Existing handlers | Mostly unchanged, but lease must be strict | **Rewritten** (absolute + watermark guards on every mutating write) + schema migration + tombstones | **Unchanged** (only #760's idempotency, which is a real bug anyway) |
| New schema | lock table | watermark columns ×N tables + tombstones + delivery table | delivery table only |
| Phase B fit | separate DO later | separate DO later | **same DO** — A+B unified |
| Failure tail surfaced in review | TTL overrun, migration ordering | partial-field-drop, delete tombstones, multi-row, fail-soft reads, activity enrichment, … | none of these arise |

## 5. Operator configuration

1. `ALCHEMY_WEBHOOK_SIGNING_KEY` in the Secrets Store + `wrangler.jsonc`.
2. Declare the `ChainIngestDO` Durable Object binding + migration in
   `wrangler.jsonc` (new-SQLite-class DO, free plan).
3. Apply the migration for `webhook_deliveries` (and the monotonic-cursor write
   is code-only). **#760's** handler-idempotency fix is a **prerequisite deploy**.
4. Create the Alchemy webhook (Custom Webhook for full log coverage incl.
   `OfferCreated`/`OfferCanceled`; else Address Activity + cron backstop),
   filtered to the Diamond address, target `…/hooks/chain-event`, payload
   carrying the network id.
5. No contract change, no ABI re-export, **no new contract events**. Degrades to
   cron-paced when the webhook is unconfigured.

## 6. Verification

- `pnpm --filter @vaipakam/indexer typecheck` (`tsc` + `check-event-coverage`).
- DO single-writer: a concurrent cron-trigger + webhook-trigger for one chain
  produce exactly one serialized scan sequence (no interleaved writes).
- Re-scan idempotency: covered by **#760** (re-run a scan over a delta-bearing
  range → row equals single-pass).
- Backstop: with the webhook unconfigured, the cron-pinged DOs still ingest
  within ~1 min.
- Latency: on a fast-finality testnet, D1 reflects an on-chain repay/match
  within seconds of the block becoming safe.

## 7. Phase B + UX (now naturally adjacent — the DO already exists)

- **Phase B**: the ingest DO, right after its D1 write, **broadcasts** a typed
  invalidation key (`offer.created` · `offer.cancelled` · `offer.accepted` ·
  `loan.updated` · `activity.appended` · `indexer.watermark.updated`) to its
  Hibernating inbound WebSocket clients; the client refetches the affected slice
  via existing REST. Because ingest and fan-out are the **same** DO, "notify the
  DO after the D1 write" is not a cross-component hop — it's a local call.
- **UX**: extend `DataFreshnessContext` / `IndexerStatusBadge` /
  `ChainDiagnosticsPanel` with an orthogonal **transport** dimension (Live /
  Polling / Reconnecting) composed with the existing **freshness** dimension;
  numbers in the drawer, not the badge; a transient "updated" pulse on the
  affected card; adaptive poll cadence.

## 8. Acceptance criteria (Phase A slice)

- [ ] **#760 landed first**: the read-modify-write/delta handlers write absolute
      block-pinned values → a sequential re-scan is idempotent.
- [ ] `POST /hooks/chain-event` dispatched **before** `resolveEnv`; body-capped
      (413) then HMAC-verified (signing key from raw env), fail-closed (401);
      per-delivery dedupe; forwards `{chainId, targetBlock H}` to the DO; 200 ack.
- [ ] `ChainIngestDO(chainId)` is the **sole** event-projection writer per chain;
      cron + webhook triggers are serialized by the DO; the scan logic is the
      unchanged `runChainIndexerForChain`; reads via dRPC only.
- [ ] Alarm-driven catch-up waits for `H` to become safe, then scans until
      `cursor >= H` or a bounded budget; cursor advance is monotonic.
- [ ] Backstop: webhook unconfigured → cron-pinged DOs still ingest (~1 min);
      no user-facing error; no new contract events (`check-event-coverage`
      unaffected).
- [ ] On a fast-finality testnet, D1 reflects an on-chain repay/match within
      seconds of the block becoming safe.

## 9. Implementation notes folded from review (Codex #759 round 8)

These are build-time requirements for the #757 implementation (the design is
settled; these are details the implementation's own review will verify):

- **DO scan-failure handling (P1).** The alarm loop holds the persisted
  `scanning` flag true across the awaited `runChainIndexerForChain`. If the scan
  **throws** (e.g. #760's fail-closed RPC abort), the handler MUST clear
  `scanning` (or re-arm a retry alarm) in a `finally`, else the DO is stuck
  "scanning" forever and never processes the next trigger.
- **Re-read `pendingTarget` after the scan.** An enqueue can raise the stored
  target *during* the awaited scan; re-read it from storage before deciding to
  clear `scanning`, so a target raised mid-scan isn't dropped.
- **Bind the FULL indexer env inside the DO**, not just D1 + RPC — the scan path
  reaches the prepay OpenSea publish (`OPENSEA_API_KEY`) and any rate-limit
  bindings. The DO needs the same resolved `Env` the cron `scheduled()` builds.
- **Retryable publish marker, not pre-call success marker.** The OpenSea
  published-marker (§3.5 part 3) must be cleared / left absent on a non-2xx so
  the existing republish sweep still retries — a pre-call "success" marker would
  permanently skip a failed publish (mirror #761's fail-closed pattern).
- **Early dedupe check.** Check the `webhook_deliveries` dedupe row *before*
  forwarding to the DO (an exact-seen short-circuit), in addition to recording
  it after a durable enqueue — so a tight retdelivery storm doesn't repeatedly
  forward.
- **Topology wording.** The single-writer guarantee is the explicit `scanning`
  single-flight (§3.1/§3.4), NOT the input gate — any remaining "the DO
  serializes them" phrasing means the single-flight guard.
- **Broaden the part-2 block-pin to the LOAN heal paths too** (`LoanInitiated`
  `getLoanDetails` heal), and source same-block *deleted* offers from the
  companion event rather than an end-of-block read (tracked under #763).
- **Acceptance must require all four #760 parts** (§3.5), not just the delta
  handlers — parts 1 (done #761), 3 (OpenSea marker) in the pragmatic slice;
  parts 2 (#763) and 4 (#762) tracked as follow-ups per the agreed scope.
