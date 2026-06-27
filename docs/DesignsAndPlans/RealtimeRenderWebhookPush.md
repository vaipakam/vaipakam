# Near-real-time render — inbound chain webhook + browser push (#757)

**Status:** design — Phase A detailed for build; Phase B + UX summarized for
context. Architecture is **owner-locked** (issue #757, sign-off 2026-06-27);
this doc is the *implementation* design that slots that architecture into the
existing `apps/indexer` ingest, not a re-litigation of the architecture.

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
- Push carries an **invalidation key only**, never authoritative data (Phase
  B). Time-based states (offer expiry) are **not** event-driven and stay owned
  by the client clock + the cron sweep.

## 2. Today's ingest (what Phase A reuses)

`apps/indexer/src/index.ts` → `scheduled()` → `runChainIndexer(env)`
([chainIndexer.ts:134](../../apps/indexer/src/chainIndexer.ts)):

1. **Round-robin chain pick** via the `indexer_cursor` sentinel row
   `(chain_id=0, kind='roundrobin')`, whose `last_block` column is repurposed
   as the pointer.
2. `runChainIndexerForChain(env, chain)` (chainIndexer.ts:350) for the picked
   chain:
   - read cursor `SELECT last_block FROM indexer_cursor WHERE chain_id=? AND
     kind='diamond'`; `scanFrom = last_block + 1`;
   - `scanTo = min(scanFrom + SCAN_LOOKBACK_BLOCKS*4, safeHead)` (≤ ~2000
     blocks/tick); head read at `blockTag:'safe'` (reorg-proof);
   - chunked `client.getLogs({ address: diamond, fromBlock, toBlock })` at
     `MAX_RANGE_PER_CALL = 5000`; **address-only filter**, client-side decode
     against `EVENT_ABI` (derived from `DIAMOND_ABI_VIEM`, deduped by event
     signature — never hand-typed);
   - dispatch the decoded logs to `processOfferLogs` / `processLoanLogs` /
     `recordActivityEvents` (all internal to chainIndexer.ts);
   - side-lane heals (`refreshStubOffers` / `refreshStubLoans`);
   - **advance cursor** to `scanTo` (`INSERT … ON CONFLICT … DO UPDATE`).

**Idempotency already present** — every domain write is
`INSERT OR IGNORE` (offers PK `(chain_id, offer_id)`, loans PK
`(chain_id, loan_id)`, activity PK `(chain_id, block_number, log_index,
tx_hash)`) or `INSERT OR REPLACE` (swap-to-repay / prepay, PK
`(chain_id, loan_id)`); status changes are deterministic `UPDATE`s of
chain-derived values. So re-processing the same block converges — this is what
makes a webhook fast-path safe alongside the cron.

**RPC client**: `createPublicClient({ transport: http(chain.rpc) })`, where
`chain.rpc` is the dRPC URL from `getChainConfigs(env)`.

## 3. Phase A — `POST /hooks/chain-event`

### 3.1 Flow

```
Alchemy Custom Webhook ──POST (HMAC-signed body)──▶ /hooks/chain-event
                                                       │ 1. cap body size (pre-auth) + verify X-Alchemy-Signature (fail-closed)
                                                       │ 2. parse payload → chainId ONLY  (HINT — which chain, not which blocks)
                                                       │ 3. ctx.waitUntil( runChainIndexerForChain(env, chain) )  ← the cron's own scan
                                                       │ 4. return 200 ack immediately
                                                       ▼
                                 runChainIndexerForChain(env, chain)   (UNCHANGED scan)
                                   = read cursor → scan [cursor+1, SAFE head] via dRPC
                                     → decode → dispatch (same handlers, log order)
                                     → advance cursor.  Run NOW, out of round-robin order,
                                     under a per-chain lock so it can't race the cron tick.
```

**Design correction (Codex review #759).** An earlier draft had the webhook
ingest an arbitrary window `[H - k, H]` around the delivered block and *not*
advance the cursor. Review surfaced four P1 / three P2 holes in that shape:
unsafe (reorg-able) blocks getting cached, replayed old deliveries resurrecting
deleted rows, the non-idempotent `InternalMatchExecuted` delta handler
double-subtracting, bounded-lookback blind spots in the `amount_filled` replay,
activity rows missing prior-state enrichment, and cron/webhook interleaving the
log-order replay. The revised design below avoids all of them by **not inventing
a second ingest shape**: the webhook simply runs the cron's existing
cursor-derived, safe-head-bounded, in-order, cursor-advancing scan for the
hinted chain — immediately instead of waiting up to N minutes for its
round-robin slot — serialized by a per-chain lock.

### 3.2 The webhook runs the cron's scan — it does NOT invent a second ingest

The webhook handler, for the hinted chain, calls the **existing**
`runChainIndexerForChain(env, chain)` — the same function the cron tick uses —
immediately, out of round-robin order. That function already:

- reads the cursor and scans **`[cursor+1, safeHead]`** (the FULL gap — no
  bounded-window blind spot), with `head` read at `blockTag:'safe'`
  (reorg-proof — never caches a block that can still reorg);
- decodes against `EVENT_ABI` and dispatches to the handlers **in log order**,
  single-threaded within the scan (so the `amount_filled` replay is correct);
- **advances the cursor** to `safeHead`.

The webhook therefore inherits safe-head reorg-safety, full-gap coverage,
in-order replay, and cursor advancement **for free** — none of the order- or
delta-sensitive handlers (`InternalMatchExecuted`, `OfferMatched`/`OfferModified`,
`PrepayListing*`, `SwapToRepay*`) is re-processed out of order or with a partial
range, because the webhook never re-reads an arbitrary old range — it only ever
scans *forward from the cursor to the current safe head*, exactly as the cron
does. The block `H` in the payload is used **only to pick the chain**; the range
comes from the cursor, never from `H`.

**Bounded catch-up / wait-for-safe loop (Codex r2 P1 — just-mined block above
safe head; P2 — per-scan block cap; P2 — contended scan).** A single immediate
scan is not enough on its own for two reasons: (i) the delivered block `H` may
be **above the current safe head** (Alchemy fires on the just-mined tip), so the
first safe-bounded scan won't include it and Alchemy won't retry; (ii)
`runChainIndexerForChain` caps each scan at `scanTo = min(scanFrom +
SCAN_LOOKBACK_BLOCKS*4, head)` (~2000 blocks, [chainIndexer.ts:405-408]), so a
deep backlog (post-outage / cold start) isn't drained in one pass. So the
webhook runs a **bounded loop inside `ctx.waitUntil`**: repeatedly
`(acquire lock → runChainIndexerForChain → release)` until the cursor reaches
`min(H, currentSafeHead)`, sleeping a short delay (~2-3 s) between iterations
(re-reading the safe head each time so a block that finalizes mid-loop is
picked up). The loop is **bounded** by an iteration cap **and** the `waitUntil`
wall-budget (~25 s) so it never runs unbounded; on a contended iteration it
retries the lock acquire (rather than dropping the hint) until the budget
elapses.

**Latency claim (honest, narrowed).** In **steady state** (cursor near head),
on **fast-finality L2s** (Base / OP / Arbitrum — safe head trails the tip by
seconds), the loop ingests a just-mined repay/match **within seconds**. Two
cases fall back to the cron, by design, not silently: **Ethereum mainnet**'s
safe head trails ~2 epochs (~13 min) — `H` can't be ingested before it
finalizes (inherent to not caching reorg-able state), so the loop exits at the
budget and the cron covers it; a **deep backlog** beyond what the loop drains in
its budget likewise finishes cron-paced. The webhook's guarantee is therefore
"*ingest within seconds of the event becoming **safe**, in steady state*", which
on L2s is within seconds of mining — not "within seconds of mining on every
chain". The acceptance test (§8) is scoped to a fast-finality testnet.

The refactor into `runChainIndexerForChain`: thread a per-chain **lease lock**
(§3.3) so the cron tick and webhook loops can't process the same chain
concurrently, and make `InternalMatchExecuted` replay-idempotent (§3.3b) so a
partial-failure re-scan can't double-apply. No change to the scan, decode, or
dispatch order otherwise.

### 3.3 Per-chain advisory lock — serialize webhook vs cron (Codex P1: idempotency / interleave)

The cron is implicitly single-writer-per-chain (one chain per tick, ticks
rarely overlap), which is why its order-dependent / read-modify-write handlers
are safe today. The webhook introduces **real concurrency** (a webhook
invocation racing the cron tick, or two webhooks), under which those handlers
break: `InternalMatchExecuted` reads `principal`/`collateral_amount` from D1 and
subtracts event deltas (chainIndexer.ts:1965-2001) → a second concurrent pass
double-subtracts; `OfferMatched`/`OfferModified` compute `amount_filled` against
the mutable D1 row (chainIndexer.ts:928-956) → two passes can interleave to a
wrong value.

Rather than rewrite every such handler to be absolute / monotonic, **preserve
the single-writer-per-chain invariant the cron always relied on** with a D1
advisory lock that BOTH the cron and the webhook acquire before
`runChainIndexerForChain`:

The lock carries a **per-acquisition owner token** so a holder that overran the
TTL can't clear a *new* holder's lock (Codex r2 P1):

```sql
-- migration: indexer_lock(chain_id PK, locked_until INTEGER, owner TEXT)
-- acquire (atomic CAS — D1 serializes writes); `token` = a fresh random id:
UPDATE indexer_lock SET locked_until = ?, owner = ?   -- now + LOCK_TTL_SECONDS, token
  WHERE chain_id = ? AND locked_until < ?;            -- now  (lock free / expired)
--   meta.changes === 1  ⇒ acquired;  0 ⇒ held elsewhere
-- (INSERT OR IGNORE a row per chain first so the UPDATE has a target)
-- release (ONLY if we still own it — guards the TTL-overrun race):
UPDATE indexer_lock SET locked_until = 0
  WHERE chain_id = ? AND owner = ?;                    -- token
```

- The release is **owner-guarded**: if our lease expired and another scan took
  the lock, our `owner` no longer matches, so our `finally` release is a no-op
  and can't free the new holder's lock (which would let a third scan in and
  reintroduce the concurrent corruption). `LOCK_TTL_SECONDS` should comfortably
  exceed a normal scan; an overrun only loses *mutual exclusion for that one
  long scan*, and the §3.3b idempotency makes even that safe.
- `LOCK_TTL_SECONDS` self-heals a crashed holder — the lock can't deadlock the
  chain.
- Lock not acquired ⇒ the caller does **not** silently drop the trigger: the
  webhook loop (§3.2) **retries the acquire** within its budget, so the hint is
  serviced by either the in-progress scan or this loop once the holder releases.
  The cron, contended, just skips the chain that tick (next tick re-tries).
- This keeps every block processed by **exactly one scan at a time**, so the
  existing single-threaded handler assumptions hold unchanged.

### 3.3b Make `InternalMatchExecuted` replay-idempotent (Codex r2 P1 — sequential retry)

The lock prevents *concurrent* double-processing, but **not sequential** retry:
`runChainIndexerForChain` writes domain rows **before** the final cursor update
([chainIndexer.ts:499-545]), so if a step fails after `InternalMatchExecuted`'s
read-modify-write delta applied but before the cursor advanced, the **next**
scan re-applies the same delta and double-subtracts principal/collateral. This
is a **latent bug in the cron today** (any partial-tick failure hits it); the
webhook just raises the re-scan frequency. Fix the handler to be idempotent
regardless of replay:

- Replace the `principal -= delta` / `collateral_amount -= delta` reads-then-
  subtract with an **absolute, chain-derived write**: on `InternalMatchExecuted`,
  `getLoanDetails(loanId)` for each affected loan at the event and write the
  absolute post-image (the same "re-read chain, don't trust the log/D1-delta"
  principle the creation handlers already use). Re-applying then sets the same
  value — idempotent under both concurrent and sequential replay. (Internal
  match is a rare event, so the extra `getLoanDetails` calls are negligible.)
- This is a self-contained handler change to an already-covered event (no
  `check-event-coverage` impact) and **hardens the existing cron**, not just the
  webhook path.

### 3.4 HMAC verification + pre-auth body cap (fail-closed)

Alchemy signs the **raw request body** with HMAC-SHA256 using the webhook's
signing key and sends it hex-encoded in `X-Alchemy-Signature`.

- **Dispatch this route BEFORE the global `resolveEnv` (Codex r2 P2).**
  `index.ts` currently calls `resolveEnv(env)` at the top of `fetch`, which
  fetches **every** RPC/OpenSea Secrets-Store secret for *any* request. If the
  webhook route ran after that, an oversized unauthenticated POST would still
  force all that Secrets-Store work before the 413/401. So `fetch` checks the
  `/hooks/chain-event` path **first**, runs the body cap + HMAC verify reading
  **only `ALCHEMY_WEBHOOK_SIGNING_KEY`** from the raw `WorkerEnv` (one
  `.get()`), and only **after** auth passes resolves the rest of the env (for
  the ingest, inside `waitUntil`). Every other route keeps the existing
  top-of-`fetch` `resolveEnv`.
- **Body-size cap BEFORE any hashing (Codex P2):** reject with `413` if
  `Content-Length` exceeds a small cap (e.g. `MAX_WEBHOOK_BODY = 64 KiB`;
  Alchemy payloads are a few KB). If `Content-Length` is absent, read the body
  through a length-bounded reader and abort past the cap. This bounds the
  pre-auth CPU/alloc cost of this public write route — an unauthenticated
  caller can't force unbounded `req.text()` + HMAC work just to be 401'd.
- New secret **`ALCHEMY_WEBHOOK_SIGNING_KEY`** (Cloudflare Secrets Store
  binding, same pattern as `RPC_*`): added to `WorkerEnv` (SecretBinding) and
  `wrangler.jsonc:secrets_store_secrets`; read **directly from the raw
  `WorkerEnv`** in the route (not via `resolveEnv`, per the dispatch-order point
  above).
- Verify with **Web Crypto** (constant-time, Worker-native; same primitive as
  `apps/agent/src/diagHash.ts`): `crypto.subtle.importKey('raw', keyBytes,
  {name:'HMAC',hash:'SHA-256'}, false, ['verify'])` then
  `crypto.subtle.verify('HMAC', key, sigBytes, rawBodyBytes)` —
  `crypto.subtle.verify` is constant-time, no hand-rolled compare. Decode the
  hex `X-Alchemy-Signature` to bytes; a malformed/odd-length header → reject.
- **Fail-closed**: secret unset, header missing/malformed, or verify fails →
  **401, no D1 write, no RPC read**. (Unlike the optional RPC secrets that
  degrade to "skip a chain", an unsigned write path must never ingest — the
  signature is the route's whole defense.)
- Read the (capped) body **once** as text for the HMAC; the payload is then
  parsed from that same text — never re-read the stream.

### 3.5 Payload → chainId (HINT — which chain, not which blocks)

- Map the Alchemy **network** field (`BASE_MAINNET`, `ETH_MAINNET`,
  `BASE_SEPOLIA`, …) → our `chainId` via a small explicit table. Unknown /
  unmapped network → 200 ack + no-op (a webhook for a chain we don't index is
  not an error; the cron owns coverage).
- We use the payload **only** to choose the chain to scan; the block range is
  the cursor gap (§3.2), so the payload's block numbers and log contents are
  advisory and never trusted into D1.
- Resolve `ChainConfig` from the mapped chainId via `getChainConfigs(env)`; no
  RPC/deployment configured → 200 ack + no-op (degrade like the cron skipping
  an unconfigured chain). Reads use `chain.rpc` (**dRPC**); Alchemy is never
  read through.

### 3.6 Route wiring + ack timing

- Add the route in `index.ts` `fetch`, before the generic 404, **no CORS** (the
  caller is Alchemy's edge, not a browser): `if (url.pathname ===
  '/hooks/chain-event' && req.method === 'POST') …`.
- **Add `ctx: ExecutionContext`** to the `fetch` signature (currently `(req,
  env)`) so the handler can `ctx.waitUntil(<catch-up loop §3.2>)` and return a
  fast **200** ack. Alchemy expects a prompt 2xx (it retries on non-2xx/timeout);
  the bounded loop can exceed that window, so it runs in `waitUntil` and a
  transient failure is covered by the cron backstop. Body-cap + HMAC verify +
  chain resolution happen **synchronously** before the ack (so a bad signature
  is a real 401, an oversized body a real 413 — not a swallowed 200). The
  ack body is informational only (Alchemy ignores it); it never carries chain
  data.
- Wrap the `waitUntil` scan in `.catch(console.error)` like the existing
  `scheduled()` passes — a webhook scan failure logs and is left to the cron,
  never wedging the Worker.

### 3.7 Replay safety

- HMAC is the primary gate: no key ⇒ no forged body; bad signature ⇒ 401 before
  any read/write.
- **Replayed/duplicate/out-of-order delivery is harmless** because the webhook
  never re-reads an arbitrary old range — it scans `[cursor+1, safeHead]`. A
  replay of an old delivery just triggers another forward scan, which (the
  cursor having advanced past those blocks) scans a now-empty or already-current
  range. No old delivery re-processes a stale block to resurrect a deleted
  prepay listing / swap intent (the windowed draft's failure), because old
  blocks are below the cursor and never re-read.
- **The one re-process path** — a partial-failure scan that wrote some rows but
  didn't advance the cursor, so the *next* scan re-runs `[cursor+1, …]` over the
  same blocks — is made safe by §3.3b: every re-processable handler is either a
  deterministic recompute (`OfferMatched`/`OfferModified` set `amount_filled`
  from the event + current row) or an absolute chain-derived write
  (`InternalMatchExecuted`, creation handlers), and all writes are
  `INSERT OR IGNORE`/`OR REPLACE`. No handler does a non-idempotent `+=`/`-=`
  after the §3.3b fix.

## 4. How the revised design closes each Codex #759 finding

| # | Finding (windowed draft) | Closed by |
|---|---|---|
| P1 | Webhook cached **reorg-able** blocks | Scan reads `blockTag:'safe'` (§3.2) — same reorg-proof head as the cron; never ingests unsafe blocks |
| P1 | **Replayed** delivery resurrects deleted prepay/swap rows | Scan is forward-from-cursor only; old blocks are below the cursor and never re-read (§3.7) |
| P1 | `InternalMatchExecuted` **delta** double-subtract under *concurrency* | Per-chain lease lock keeps one scan/chain at a time (§3.3) |
| P1 | Cron/webhook **interleave** the log-order `amount_filled` replay | Per-chain lease lock serializes them (§3.3) |
| P2 | Bounded lookback **blind spot** for `OfferModified` before the window | No window — scan covers the full cursor gap (§3.2) |
| P2 | Activity rows miss **prior-state enrichment** outside the window | Full-gap scan gives the same prior-state coverage the cron has (§3.2) |
| P2 | Unbounded **pre-auth** body hashing | `Content-Length` / bounded-read cap before HMAC (§3.4) |

**Round 2 (revised-design findings):**

| # | Finding | Closed by |
|---|---|---|
| P1 | Just-mined block **above safe head** → one scan misses it, no Alchemy retry | Bounded catch-up/wait-for-safe loop in `waitUntil` re-scans (re-reading safe head) until cursor ≥ min(H, safe) or budget (§3.2); latency claim narrowed to "within seconds of becoming **safe**" |
| P1 | Lock **release race** — TTL-overrun holder clears a new holder's lock | Per-acquisition **owner token**; release is `WHERE owner = token` (no-op if superseded) (§3.3) |
| P1 | `InternalMatchExecuted` **delta** double-subtract under *sequential* retry (rows written before cursor advance) | Handler rewritten to an **absolute chain-derived write** (`getLoanDetails` post-image) — idempotent under sequential AND concurrent replay; also fixes a latent cron bug (§3.3b) |
| P2 | Per-scan **~2000-block cap** → deep backlog not drained in one shot | Loop iterates the scan within budget (§3.2); deep backlog finishes cron-paced (claim narrowed) |
| P2 | Body cap ineffective because **`resolveEnv` runs first** for all routes | Dispatch `/hooks/chain-event` **before** `resolveEnv`; read only the signing key from raw `WorkerEnv` (§3.4) |
| P2 | Contended `{skipped:'locked'}` **drops the only trigger** | Loop retries the lock acquire within budget instead of dropping (§3.2/§3.3) |

Plus the always-present guards: writes stay `INSERT OR IGNORE`/`OR REPLACE`
keyed by chain+id / chain+block+logIndex+tx; all reads go to dRPC; ingest
failure logs and falls to the cron.

## 5. Operator configuration (post-merge, not a deploy gate)

1. Provision `ALCHEMY_WEBHOOK_SIGNING_KEY` in the Cloudflare Secrets Store and
   bind it in `wrangler.jsonc`.
2. Create the Alchemy webhook (prefer **Custom Webhook** for full log coverage
   incl. `OfferCreated`/`OfferCanceled`; if Custom is paid-only on the account,
   fall back to **Address Activity** + let the cron backstop cover pure-state
   events — the webhook is a latency optimization, partial coverage is fine),
   filtered to the Diamond address, target URL `…/hooks/chain-event`. Configure
   the payload to carry the network identifier we map in §3.5.
3. Apply the new `indexer_lock` migration (`wrangler d1 migrations apply
   vaipakam-archive --remote` from `apps/indexer/`).
4. No contract change, no ABI re-export, **no new contract events** → the
   `check-event-coverage` guardrail is unaffected. No deploy gate; degrades to
   cron-only when unconfigured.

## 6. Verification

- `pnpm --filter @vaipakam/indexer typecheck` (runs `tsc` + the
  `check-event-coverage` guardrail). apps/indexer has **no unit-test runner**
  (tsc-only Worker, like apps/keeper), so the HMAC-verify, body-cap, and
  payload→chainId parse are validated by a typed, side-effect-free shape plus a
  manual signed-`curl` smoke against `wrangler dev` (assert: valid signature →
  scan runs; bad signature → 401; oversized body → 413; unmapped network →
  200 no-op). (If we want assertions, adding `vitest` for the pure helpers —
  `verifyAlchemySignature`, `parseChainEventPayloadNetwork` — is a small
  follow-up; flagged, not done here.)
- **Lock assertion**: while the chain lock is held, the webhook loop retries
  the acquire within its budget (doesn't drop the hint); the owner-token release
  is a no-op when our lease was superseded; the lock self-releases after
  `LOCK_TTL_SECONDS` if a holder dies.
- **Idempotency assertion**: re-running a scan over a block containing
  `InternalMatchExecuted` (simulating a partial-failure sequential replay)
  leaves `principal`/`collateral_amount` unchanged from the single-pass value
  (absolute-write idempotency).
- **Backstop assertion** (acceptance): with the webhook disabled, the cron
  still ingests an on-chain repay/match within its normal window — i.e. Phase A
  adds no dependency; deleting the route returns the system to today's
  behaviour.
- **Latency assertion** (acceptance): on a **fast-finality testnet**, with the
  webhook enabled and the cursor near head, D1 reflects an on-chain repay/match
  **within seconds of the block becoming safe** (vs up-to-N-minutes round-robin
  delay), measured by row `updated_at` vs block timestamp. (Slow-finality L1 and
  deep-backlog cases finish cron-paced — see the narrowed claim in §3.2.)

## 7. Phase B + UX (later slices — context only, not built here)

- **Phase B**: after the D1 write, the indexer notifies an in-account
  **Cloudflare Durable Object (inbound WebSocket + Hibernation)** which
  broadcasts a typed **invalidation key** (`offer.created` · `offer.cancelled`
  · `offer.accepted` · `loan.updated` · `activity.appended` ·
  `indexer.watermark.updated`); the client refetches the affected slice via the
  existing REST. DO Hibernation is inbound-WS-only, which is exactly why Phase
  A is an HTTP webhook (no persistent outbound connection on our side).
- **UX**: extend the existing `DataFreshnessContext` /
  `IndexerStatusBadge` / `ChainDiagnosticsPanel` with an orthogonal
  **transport** dimension (Live / Polling / Reconnecting) composed with the
  existing **freshness** dimension; numbers live in the drawer, not the badge;
  a transient "updated" pulse on the affected card; adaptive poll cadence
  (slow while push healthy, restored on disconnect).

## 8. Acceptance criteria (Phase A slice of the issue)

- [ ] `POST /hooks/chain-event` dispatched **before** the global `resolveEnv`;
      body-capped (413) then HMAC-verified (`X-Alchemy-Signature`, signing key
      read from raw `WorkerEnv`), fail-closed (401). Auth passes → resolve env
      and run the bounded catch-up loop in `waitUntil`.
- [ ] The loop re-scans (cursor-derived, safe-head-bounded, same
      decode/dispatch as the cron) until cursor ≥ min(H, safeHead) or the
      iteration/wall budget; re-reads safe head each iteration; reads via
      **dRPC** only, never Alchemy.
- [ ] Cron and webhook are serialized per chain by the `indexer_lock`
      **lease** lock (owner-token release); no concurrent same-chain scan; a
      contended webhook retries the acquire within budget rather than dropping
      the hint.
- [ ] `InternalMatchExecuted` writes an **absolute chain-derived** post-image
      (idempotent under sequential AND concurrent replay) — re-scanning its
      block doesn't double-subtract.
- [ ] Cron pass unchanged and still catches events when the webhook is
      disabled/failing (backstop).
- [ ] On a fast-finality testnet (cursor near head), D1 reflects an on-chain
      repay/match **within seconds of the block becoming safe**; slow-finality /
      backlog degrade cron-paced (narrowed claim §3.2).
- [ ] Push outage / unconfigured chain / unmapped network → clean degrade to
      cron-only, no user-facing error.
