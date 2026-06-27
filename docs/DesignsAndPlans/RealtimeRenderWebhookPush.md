# Near-real-time render — inbound chain webhook + browser push (#757)

**Status:** design — Phase A detailed for build; Phase B + UX summarized for
context. Architecture is **owner-locked** (issue #757, sign-off 2026-06-27);
this doc is the *implementation* design that slots that architecture into the
existing `apps/indexer` ingest, not a re-litigation of the architecture.

> **Design evolution.** This design went through several Codex review rounds on
> PR #759. The early drafts tried to keep the webhook ingest "clever" (a window
> around the delivered block) and then "safe via a per-chain lock". Review
> showed both were fragile under reorg, replay, out-of-order, and concurrent
> processing — because the existing indexer handlers were written for
> single-threaded, in-order, never-replayed processing. The final design makes
> the indexer **convergent by construction** with a **per-row `(block,
> log_index)` high-water-mark** on every mutated table; the webhook then just
> runs the cron's own scan immediately. The advisory lock is dropped (the
> watermark, not a lock, is the correctness mechanism).

## 1. Goal & non-goals

**Goal.** Cut render staleness from "up to N minutes" (N = number of indexed
chains, because the cron processes one chain per tick, round-robin) to
**seconds**, **without weakening the decentralized fallback chain**.

**Non-goals / invariants (do not regress).**

- The indexer stays a **cache, not an oracle**: the dapp reads it
  indexer-first and falls back to in-browser log-scan
  (`apps/defi/src/lib/logIndex.ts`) → direct RPC. Push/webhook are *additive*
  acceleration layers; every one degrades to today's behaviour.
- The **cron** (`* * * * *`, one chain/tick, cursor-advancing) remains the
  **authoritative backstop**. Correctness must never depend on the webhook.
- Reads stay on **dRPC (paid)**; Alchemy is **trigger-only** (push), never
  read through.
- Push (Phase B) carries an **invalidation key only**, never authoritative
  data. Time-based states (offer expiry) are **not** event-driven and stay
  owned by the client clock + the cron sweep.

## 2. Today's ingest (what Phase A reuses)

`apps/indexer/src/index.ts` → `scheduled()` → `runChainIndexer(env)`
([chainIndexer.ts:134](../../apps/indexer/src/chainIndexer.ts)):

1. **Round-robin chain pick** via the `indexer_cursor` sentinel row
   `(chain_id=0, kind='roundrobin')`, whose `last_block` column is the pointer.
2. `runChainIndexerForChain(env, chain)` (chainIndexer.ts:350):
   - read cursor `SELECT last_block FROM indexer_cursor WHERE chain_id=? AND
     kind='diamond'`; `scanFrom = last_block + 1`;
   - `scanTo = min(scanFrom + SCAN_LOOKBACK_BLOCKS*4, safeHead)` (≤ ~2000
     blocks/tick); head read at `blockTag:'safe'` (reorg-proof);
   - chunked `client.getLogs({ address: diamond, fromBlock, toBlock })` at
     `MAX_RANGE_PER_CALL = 5000`; **address-only filter**, client-side decode
     against `EVENT_ABI` (derived from `DIAMOND_ABI_VIEM`, deduped by event
     signature — never hand-typed);
   - dispatch the decoded logs to `processOfferLogs` / `processLoanLogs` /
     `recordActivityEvents` (all internal to chainIndexer.ts), **in log order**;
   - side-lane heals (`refreshStubOffers` / `refreshStubLoans`);
   - **advance cursor** to `scanTo` after every step succeeds.

`recordActivityEvents` is **append-only** — `INSERT OR IGNORE` keyed by
`(chain_id, block_number, log_index, tx_hash)`, already idempotent. The domain
tables (`offers`, `loans`, `prepay_listings`, `swap_to_repay_intents`) are
**mutated** by status flips, fill updates, balance changes — those are what the
high-water-mark protects.

**RPC client**: `createPublicClient({ transport: http(chain.rpc) })`, where
`chain.rpc` is the dRPC URL from `getChainConfigs(env)`.

## 3. Phase A — `POST /hooks/chain-event`

### 3.1 Flow

```
Alchemy Custom Webhook ──POST (HMAC-signed body)──▶ /hooks/chain-event
   │ 1. dispatch BEFORE global resolveEnv; cap body size (413); verify
   │    X-Alchemy-Signature with the signing key from raw env (401, fail-closed)
   │ 2. per-delivery throttle (dedupe id / (network,H)) — drop replays
   │ 3. parse payload → chainId + max block H (hint: which chain + loop target)
   │ 4. ctx.waitUntil( catch-up loop: run the cron's scan for that chain )
   │ 5. return 200 ack immediately
   ▼
runChainIndexerForChain(env, chain)  (the cron's own scan — UNCHANGED control flow)
   read cursor → scan [cursor+1, SAFE head] via dRPC → decode → dispatch
   (same handlers, log order) → advance cursor.   Every mutating write is
   gated by the per-row (block, log_index) HIGH-WATER-MARK (§3.3).
```

### 3.2 The webhook triggers the cron's own scan (no second ingest shape)

The webhook handler, for the hinted chain, calls the **existing**
`runChainIndexerForChain(env, chain)` immediately, out of round-robin order. It
inherits the cron's safe-head reorg-safety, full cursor-gap coverage (no
bounded-window blind spot), in-order dispatch, and cursor advancement. The
payload's block `H` is used **only** to pick the chain and as the catch-up
loop's finish line — never to derive the scan range or write data.

**Bounded catch-up / wait-for-safe loop** (inside `ctx.waitUntil`), two phases
per iteration:

1. **Cheap wait-for-safe poll** — read just the current safe head (1 RPC
   subrequest). If `H > safeHead`, the hinted block hasn't finalized; sleep
   ~2-3 s and loop. (Alchemy fires on the just-mined tip, so `H` is often above
   safe head; we must wait for it, not scan once and stop.)
2. **Scan when safe** — once `H <= safeHead`, run `runChainIndexerForChain`
   (each internal scan still clamped to the then-current safe head, so it never
   caches reorg-able blocks). **Loop until `cursor >= H`** — *not*
   `min(H, currentSafeHead)`: at steady state `cursor == safeHead == S` and a
   just-mined `H > S` would make `min(H,S)` immediately true, so the loop would
   exit without ever waiting for `H` to finalize — exactly the case it exists
   for. Targeting `H` keeps it pending until `H` is actually ingested.

The loop is **bounded by three budgets**: an iteration cap, the `waitUntil`
wall-budget (~25 s), and a **subrequest budget** (a single backfill scan can
spend ~38 of the Worker's ~50 subrequests/invocation). The wait-poll is 1
subrequest, so waiting is cheap; but only **one** full scan runs per webhook
invocation when subrequests are near the cap — remaining backlog is left to the
next webhook / the cron, never risking a mid-scan abort that drops events.

**Latency claim (honest, narrowed).** In **steady state** (cursor near head),
on **fast-finality L2s** (Base / OP / Arbitrum — safe head trails the tip by
seconds), the loop ingests a just-mined repay/match **within seconds of it
becoming safe**, which on L2s is within seconds of mining. **Ethereum
mainnet**'s safe head trails ~2 epochs (~13 min) — `H` can't be ingested before
it finalizes (inherent to not caching reorg-able state), so the loop exits at
the budget and the cron covers it; a **deep backlog** likewise finishes
cron-paced. The acceptance test (§8) is scoped to a fast-finality testnet.

### 3.3 Per-row `(block, log_index)` high-water-mark — the correctness mechanism

The existing domain handlers assume single-threaded, in-order, never-replayed
processing. The webhook breaks all three assumptions: it can run **concurrently**
with the cron, a partial-failure scan re-runs a range **sequentially** (rows are
written before the cursor advances), and Alchemy can **replay** a delivery. The
high-water-mark makes every mutated row **convergent under all of these**.

**Schema** — a new migration adds two columns to each mutated domain table
(`offers`, `loans`, `prepay_listings`, `swap_to_repay_intents`):

```sql
ALTER TABLE <table> ADD COLUMN last_event_block INTEGER NOT NULL DEFAULT 0;
ALTER TABLE <table> ADD COLUMN last_event_log_index INTEGER NOT NULL DEFAULT 0;
```

**The guard** — every **mutating** write carries the event's `(block,
log_index)` and applies **only if it is strictly newer** than what the row
records, stamping the new pair in the same statement:

```sql
UPDATE <table> SET <fields> = ...,
       last_event_block = :block, last_event_log_index = :logIndex
 WHERE <pk> = ...
   AND ( :block > last_event_block
      OR (:block = last_event_block AND :logIndex > last_event_log_index) );
```

(For the `INSERT`-creating handlers, the create stamps the creating event's
pair; subsequent mutations use the guard above.)

This single rule makes the indexer convergent:

- **Replay / same-event re-process** — the re-applied event's `(block,
  logIndex)` is *not greater* than the stored pair → the `UPDATE` matches 0
  rows → no-op. Even a raw `-=`/`+=` delta becomes idempotent (it can't apply
  twice), and a re-run of a creation+mutation range can't double-apply.
- **Concurrent out-of-order writes** — if a slow scan tries to write an *older*
  log after a faster scan already stamped a *newer* one, the older write's guard
  fails → rejected. No stale row survives a cursor that advanced past it. "**The
  highest `(block, logIndex)` event wins**", deterministically, regardless of
  processing order or concurrency.
- **Same-block ordering** — `log_index` disambiguates two events touching the
  same entity in one block (e.g. `InternalMatchExecuted` then `LoanRepaid`); the
  later-logIndex event's state is the one that survives.

Because the watermark — not a lock — guarantees convergence, **no per-chain
advisory lock is needed**; the cron and webhook may run the same chain
concurrently and still converge. (A lock could be added later purely as a
de-dup *optimization* to avoid duplicate-scan RPC cost; it would never be
load-bearing. Dropping it removes the lease/owner-token/migration-ordering
complexity entirely.)

### 3.4 Absolute-snapshot writes for value handlers (the watermark's companion rule)

The watermark gives "**last event wins per row**". That is automatically correct
for a field set to an **absolute** value (status, `principal`, an
absolute `amount_filled`). It has one trap: a handler that updates only **one**
field computed from the **current row** can have its update dropped when a
*later* event to a **different** field stamps a higher watermark first. So the
handlers that today read-modify-write the current row are converted to write a
**complete, absolute, block-pinned snapshot** of the mutable fields, so whichever
event wins carries the *whole* correct row, never a partial patch:

- **`OfferMatched` / `OfferModified`** (chainIndexer.ts:601-610, 928-956) — today
  compute `amount_filled` from the **current D1 `amount_max`**. Rewrite: re-read
  the offer's absolute fill/`amount_max` via `getOfferDetails(offerId,
  {blockNumber: log.blockNumber})` and write absolute values.
- **`InternalMatchExecuted`** (chainIndexer.ts:1965-2001) — today reads
  `principal`/`collateral_amount` from D1 and **subtracts** deltas. Rewrite:
  `getLoanDetails(loanId, {blockNumber: log.blockNumber})` per affected loan and
  write the absolute post-image. **Preserve its terminal side-effects**: when a
  leg reaches `principal == 0`, still set the terminal status **and delete any
  live prepay listing** for that loan (else it serves a stale listing). Both the
  status write and the listing delete are watermark-guarded.
- **Audit the remaining mutators for current-row dependence** during
  implementation (e.g. `PartialRepaid`, `CollateralAdded`, periodic-interest
  updates): any that compute from the current row become absolute block-pinned
  writes; pure absolute-field setters (`LoanRepaid` → `status`+`principal=0`,
  `LoanDefaulted`, `Transfer` → owner) just gain the watermark guard.

**Block-pin every absolute read** — `{blockNumber: log.blockNumber}`. A
block-pinned read is "end-of-block", not literally "as of this log", but
combined with the watermark ("highest log wins") the *final* applied write is
the highest-logIndex event's end-of-block snapshot = the true end-of-block state,
which is correct. (The prepay-listing handler's `grace_period_end` helper, which
calls `getLoanDetails`, must be block-pinned too, so a replayed older listing
event can't mix in later/unsafe loan state.)

**External side-effects need their own replay guard.** `PrepayListingPosted`/
`Updated` call the **OpenSea publish** before writing the row. D1 converges via
the watermark, but the external call doesn't — a replay/concurrent re-process
would re-submit the same order. Guard it with an **atomic reservation**: an
`INSERT OR IGNORE` on a persistent `(order_hash)` published-marker *before* the
external call; only the row that wins the insert publishes. (A plain
read-before-call isn't enough — two concurrent scans could both read "unpublished"
then both publish.)

### 3.5 HMAC verification + pre-auth body cap (fail-closed) + dispatch order

Alchemy signs the **raw request body** with HMAC-SHA256 and sends it hex-encoded
in `X-Alchemy-Signature`.

- **Dispatch `/hooks/chain-event` BEFORE the global `resolveEnv`.** `index.ts`
  currently calls `resolveEnv(env)` at the top of `fetch`, fetching **every**
  RPC/OpenSea Secrets-Store secret for *any* request. The webhook route is
  matched first and runs the body cap + HMAC reading **only**
  `ALCHEMY_WEBHOOK_SIGNING_KEY` from the raw `WorkerEnv` (one `.get()`); it
  resolves the rest of the env only **after** auth passes (for the scan, inside
  `waitUntil`). Every other route keeps the existing top-of-`fetch` resolve.
- **Body-size cap before any hashing** — `413` if `Content-Length` exceeds a
  small cap (`MAX_WEBHOOK_BODY ≈ 64 KiB`; Alchemy payloads are a few KB); if
  `Content-Length` is absent, read through a length-bounded reader and abort
  past the cap. Bounds the pre-auth CPU/alloc cost of this public route.
- New secret **`ALCHEMY_WEBHOOK_SIGNING_KEY`** — Secrets Store binding, added to
  `WorkerEnv` + `wrangler.jsonc`, read directly from the raw env in the route.
- Verify with **Web Crypto** (constant-time; same primitive as
  `apps/agent/src/diagHash.ts`): `crypto.subtle.importKey('raw', keyBytes,
  {name:'HMAC',hash:'SHA-256'}, false, ['verify'])` then
  `crypto.subtle.verify('HMAC', key, sigBytes, rawBodyBytes)`. Decode the hex
  header to bytes; malformed/odd-length → reject.
- **Fail-closed**: secret unset, header missing/malformed, or verify fails →
  **401, no read/write**. Read the (capped) body **once** as text for the HMAC;
  parse the payload from that same text.

### 3.6 Payload → (chainId, target block H) — hint only

- Map the Alchemy **network** field (`BASE_MAINNET`, `ETH_MAINNET`, …) →
  `chainId` via a small explicit table. Unknown/unmapped → 200 ack + no-op.
- **Extract the maximum delivered block `H`** as the catch-up loop's finish line
  (§3.2). Parsing `H` is not "trusting the payload": `H` only bounds *how long
  the loop waits*; the scan range stays cursor-derived, each scan is clamped to
  the safe head, and every row comes from a fresh dRPC re-read. A forged `H` that
  never finalizes just makes the loop wait to its budget and exit — no bad data,
  and the per-delivery throttle (§3.7) bounds how often that can be triggered.
- Resolve `ChainConfig` via `getChainConfigs(env)`; no RPC/deployment → 200 ack
  + no-op. Reads use `chain.rpc` (**dRPC**); Alchemy is never read through.

### 3.7 Route wiring, ack timing, replay throttle

- Add the route in `index.ts` `fetch`, before the generic 404, **no CORS** (the
  caller is Alchemy's edge). **Add `ctx: ExecutionContext`** to the `fetch`
  signature so the handler can `ctx.waitUntil(<catch-up loop>)` and return a
  fast **200** ack — Alchemy expects a prompt 2xx (retries on non-2xx/timeout);
  the loop can exceed that window, so it runs in `waitUntil` and a transient
  failure is covered by the cron backstop. Auth + parse happen **synchronously**
  before the ack (bad signature → real 401, oversized body → real 413).
- Wrap the `waitUntil` loop in `.catch(console.error)` like the existing
  `scheduled()` passes — a scan failure logs and is left to the cron.
- **Per-delivery throttle (after HMAC, before the loop).** A *valid* signed body
  is harmless for data convergence (the watermark) but not for cost: an
  aggressively replayed delivery would schedule a fresh catch-up loop each time.
  An **exact seen-delivery dedupe** — `INSERT OR IGNORE` into a small
  `webhook_deliveries(delivery_id PRIMARY KEY, seen_at)` table keyed by the
  Alchemy delivery id (or `(network, H)` when none), dropping a duplicate that's
  already present — runs **before** `resolveEnv`/`getChainConfigs`/the loop, so a
  replay 200-acks without burning RPC/D1/`waitUntil`. (A 60/min rate-limiter
  binding is too coarse here — many replays pass before it trips — so an exact
  dedupe is used; an old `seen_at` row is pruned by the same retention sweep the
  cron already runs.)

## 4. How this design closes the review concerns

The high-water-mark + absolute-snapshot rules replace the earlier lock-centric
mechanism and close every concern raised across PR #759's review rounds:

| Concern (review round) | Closed by |
|---|---|
| Webhook caches **reorg-able** blocks | Scan reads `blockTag:'safe'` — same reorg-proof head as the cron (§3.2) |
| **Replayed** delivery resurrects deleted / re-applies a delta | Watermark rejects any write `≤` the row's recorded `(block,logIndex)` (§3.3) |
| `InternalMatchExecuted` **delta** double-subtract (concurrent OR sequential) | Watermark makes it apply-once; rewritten to absolute block-pinned snapshot so it can't drop a field either (§3.3/§3.4) |
| Cron/webhook **interleave** / **out-of-order** writes leave a stale row | Watermark: highest `(block,logIndex)` wins, order-independent (§3.3) |
| Block-pin is **end-of-block**, not "as-of-log" → wrong terminal status | Highest-logIndex event wins (watermark) + absolute snapshot = correct end-of-block state (§3.3/§3.4) |
| `OfferMatched`/`OfferModified` recompute from the **current row** | Rewritten to absolute `getOfferDetails` block-pinned snapshot (§3.4) |
| `OpenSea publish` re-submits on replay/concurrency | Atomic `INSERT OR IGNORE` published-marker reservation before the call (§3.4) |
| Prepay `grace_period_end` read at current head on replay | Block-pinned `{blockNumber: log.blockNumber}` (§3.4) |
| Bounded-window blind spot / lost activity enrichment | No window — full cursor-gap scan in order; activity is append-only `INSERT OR IGNORE` (§2/§3.2) |
| Just-mined block **above safe head** / per-scan block cap / contended | Catch-up loop waits for `H` to become safe then scans to `cursor ≥ H`, within iteration/wall/**subrequest** budgets (§3.2) |
| Unbounded **pre-auth** body hashing / `resolveEnv`-runs-first | Dispatch before `resolveEnv`; body cap + signing-key-from-raw-env first (§3.5) |
| Valid body **replayed** burns RPC/D1/`waitUntil` | Exact seen-delivery dedupe before the loop (§3.7) |
| Lock lease TTL-overrun / migration-ordering / NULL-init | **Lock removed** — the watermark, not a lock, owns correctness (§3.3) |

Always-present guards: activity stays `INSERT OR IGNORE`; all reads go to dRPC;
ingest failure logs and falls to the cron.

## 5. Operator configuration (post-merge, not a deploy gate)

1. Provision `ALCHEMY_WEBHOOK_SIGNING_KEY` in the Cloudflare Secrets Store and
   bind it in `wrangler.jsonc`.
2. Apply the new migration (`wrangler d1 migrations apply vaipakam-archive
   --remote` from `apps/indexer/`) — adds the `last_event_block` /
   `last_event_log_index` columns (`DEFAULT 0`, so existing rows are treated as
   "no event applied yet" and the first real event always wins) and the
   `webhook_deliveries` dedupe table. The columns default-0 + the
   `INSERT OR IGNORE` activity path mean the **cron keeps working unchanged**
   whether or not the webhook is configured.
3. Create the Alchemy webhook (prefer **Custom Webhook** for full log coverage
   incl. `OfferCreated`/`OfferCanceled`; if Custom is paid-only, fall back to
   **Address Activity** + let the cron backstop cover pure-state events — the
   webhook is a latency optimization, partial coverage is fine), filtered to the
   Diamond address, target `…/hooks/chain-event`, payload carrying the network
   id mapped in §3.6.
4. No contract change, no ABI re-export, **no new contract events** → the
   `check-event-coverage` guardrail is unaffected. Degrades to cron-only when
   unconfigured.

## 6. Verification

- `pnpm --filter @vaipakam/indexer typecheck` (`tsc` + the `check-event-coverage`
  guardrail). apps/indexer has **no unit-test runner** (tsc-only Worker), so the
  HMAC-verify, body-cap, dedupe, and payload→(chainId,H) parse are validated by
  typed side-effect-free shapes + a manual signed-`curl` smoke against `wrangler
  dev` (valid sig → loop runs; bad sig → 401; oversized → 413; unmapped network
  → 200 no-op; replayed delivery id → 200 no-op). Adding `vitest` for the pure
  helpers is a small follow-up, flagged not done here.
- **Watermark/idempotency assertion** (the core): re-running a scan over a block
  range that includes a mutated row (simulating sequential partial-failure
  replay) leaves the row identical to the single-pass result; processing the same
  block's events out of order converges to the highest-logIndex state.
- **Backstop assertion**: with the webhook disabled, the cron still ingests an
  on-chain repay/match within its normal window — Phase A adds no dependency.
- **Latency assertion**: on a fast-finality testnet (cursor near head), with the
  webhook enabled, D1 reflects an on-chain repay/match **within seconds of the
  block becoming safe** (slow-finality / backlog degrade cron-paced — §3.2).

## 7. Phase B + UX (later slices — context only, not built here)

- **Phase B**: after the D1 write, the indexer notifies an in-account
  **Cloudflare Durable Object (inbound WebSocket + Hibernation)** which
  broadcasts a typed **invalidation key** (`offer.created` · `offer.cancelled`
  · `offer.accepted` · `loan.updated` · `activity.appended` ·
  `indexer.watermark.updated`); the client refetches the affected slice via the
  existing REST. DO Hibernation is inbound-WS-only, which is exactly why Phase
  A is an HTTP webhook (no persistent outbound connection on our side).
- **UX**: extend the existing `DataFreshnessContext` / `IndexerStatusBadge` /
  `ChainDiagnosticsPanel` with an orthogonal **transport** dimension (Live /
  Polling / Reconnecting) composed with the existing **freshness** dimension;
  numbers live in the drawer, not the badge; a transient "updated" pulse on the
  affected card; adaptive poll cadence (slow while push healthy, restored on
  disconnect).

## 8. Acceptance criteria (Phase A slice of the issue)

- [ ] `POST /hooks/chain-event` dispatched **before** the global `resolveEnv`;
      body-capped (413) then HMAC-verified (`X-Alchemy-Signature`, signing key
      from raw `WorkerEnv`), fail-closed (401); per-delivery dedupe drops
      replays; then the bounded catch-up loop runs in `waitUntil`.
- [ ] The loop waits for `H` to become safe, then scans (cursor-derived,
      safe-head-clamped, same decode/dispatch as the cron) until **`cursor ≥ H`**
      or the iteration/wall/**subrequest** budget; reads via **dRPC** only.
- [ ] Every mutating domain write is guarded by the per-row `(last_event_block,
      last_event_log_index)` high-water-mark — **highest `(block,logIndex)` wins,
      apply-once** — so concurrent / sequential-replay / out-of-order processing
      all converge. (No lock required.)
- [ ] `OfferMatched`/`OfferModified` and `InternalMatchExecuted` write **absolute
      block-pinned snapshots** (not current-row deltas); `InternalMatchExecuted`
      preserves its terminal status + prepay-listing-delete side-effects.
- [ ] The OpenSea publish is gated by an **atomic published-marker** so replay /
      concurrency can't re-submit the same order.
- [ ] Cron pass unchanged and still catches events when the webhook is
      disabled/failing (backstop); the new columns default-0 so the cron is
      unaffected.
- [ ] On a fast-finality testnet, D1 reflects an on-chain repay/match **within
      seconds of the block becoming safe**; slow-finality / backlog degrade
      cron-paced.
- [ ] Push outage / unconfigured chain / unmapped network → clean degrade to
      cron-only, no user-facing error.
