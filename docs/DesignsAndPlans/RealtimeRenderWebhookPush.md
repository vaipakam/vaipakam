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
                                                       │ 1. verify X-Alchemy-Signature (fail-closed)
                                                       │ 2. parse payload → {chainId, blockRange}  (HINT only)
                                                       │ 3. ctx.waitUntil( ingestChainEventRange(...) )
                                                       │ 4. return 200 ack immediately
                                                       ▼
                                 ingestChainEventRange(env, chain, fromBlock, toBlock)
                                   = the scan-core of runChainIndexerForChain,
                                     re-read via dRPC, dispatch to the SAME handlers,
                                     **WITHOUT advancing the cron cursor**
```

### 3.2 The reusable ingest function (refactor)

Extract the scan-core of `runChainIndexerForChain` (build client → chunked
`getLogs(range)` → decode → fetch block timestamps → `processOfferLogs` /
`processLoanLogs` / `recordActivityEvents`) into a new internal helper that
takes an **explicit range**:

```
async function ingestChainEventRange(
  env, chain: ChainConfig, fromBlock: bigint, toBlock: bigint,
  opts?: { advanceCursor?: boolean },
): Promise<ChainIndexerResult>
```

- `runChainIndexerForChain` becomes a thin caller: derive `[scanFrom, scanTo]`
  from the cursor + safe head, then `ingestChainEventRange(..., {advanceCursor:
  true})` and run the stub-heal side-lanes.
- The **webhook** calls `ingestChainEventRange(env, chain, from, to)` with
  `advanceCursor` **false** — see §3.5. Stub-heal side-lanes are left to the
  cron (async healing; not latency-critical).
- Export `ingestChainEventRange` (+ a small `ingestChainEventForChainId`
  wrapper that resolves the `ChainConfig` from a chainId) so `index.ts` can
  call it from the route handler. Keep `processOfferLogs` etc. internal.

This keeps **one** scan/decode/dispatch implementation; the cron and webhook
differ only in *where the range comes from* and *whether the cursor moves*.

### 3.3 HMAC verification (fail-closed)

Alchemy signs the **raw request body** with HMAC-SHA256 using the webhook's
signing key and sends it hex-encoded in `X-Alchemy-Signature`.

- New secret **`ALCHEMY_WEBHOOK_SIGNING_KEY`** (Cloudflare Secrets Store
  binding, same pattern as `RPC_*`): `WorkerEnv` (SecretBinding) → `Env`
  (string) → `resolveEnv` → `wrangler.jsonc:secrets_store_secrets`.
- Verify with **Web Crypto** (constant-time, Worker-native; same primitive as
  `apps/agent/src/diagHash.ts`):
  `crypto.subtle.importKey('raw', keyBytes, {name:'HMAC',hash:'SHA-256'},
  false, ['verify'])` then `crypto.subtle.verify('HMAC', key, sigBytes,
  rawBodyBytes)`. `crypto.subtle.verify` is constant-time — no hand-rolled
  compare.
- **Fail-closed**: if the secret is unset, or the header is missing, or verify
  fails → **401, no D1 write, no RPC read**. (Unlike the optional RPC secrets
  that degrade to "skip a chain", an unsigned write path must never ingest —
  the route's whole defense is the signature.)
- Read the body **once** as text for the HMAC, then `JSON.parse` that same
  text (never re-read the stream).

### 3.4 Payload → (chainId, block range) — payload is a HINT

- Map the Alchemy **network** field (e.g. `BASE_MAINNET`, `ETH_MAINNET`,
  `BASE_SEPOLIA`, …) → our `chainId` via a small explicit table. Unknown /
  unmapped network → 200 ack + no-op (a webhook for a chain we don't index is
  not an error; the cron owns coverage).
- Extract the **block number(s)** the payload references. We do **not** trust
  the payload's log contents — we only use it to decide *which range to
  re-read*. Compute `[fromBlock, toBlock]` (see §3.5) and let
  `ingestChainEventRange` re-`getLogs` that range from **dRPC** and decode
  against `EVENT_ABI`, exactly as the cron does. (So a spoofed-but-somehow-
  signed or reorged payload can only cause us to re-read a range and write
  what the *chain* actually says.)
- Resolve `ChainConfig` from the mapped chainId via `getChainConfigs(env)`; if
  that chain has no RPC/deployment configured → 200 ack + no-op (degrade like
  the cron skipping an unconfigured chain).

### 3.5 Block range + cursor — the two correctness subtleties

**(a) Do NOT advance the cron cursor from the webhook.** If the cron is at
block `C` and the webhook ingests block `H ≫ C`, advancing the cursor to `H`
would make the next cron tick scan from `H+1`, **silently skipping `[C+1, H-1]`**
— blocks the cron hadn't reached yet. So the webhook ingests its range
idempotently and leaves the cursor alone; the cron keeps advancing
independently and will re-scan the webhook's blocks later (idempotent no-op).
The cursor stays the single authoritative watermark, owned by the cron.

**(b) Re-read a small lookback window, not a single isolated block.** A few
handlers replay `amount_filled` in log order (`OfferMatched` / `OfferModified`)
"to preserve interleaved semantics". To avoid a fast-path that depends on a
single block in isolation, the webhook re-reads `[H - SAFETY_LOOKBACK, H]` for
a **small** `SAFETY_LOOKBACK` (handful of blocks), clamped at the chain's
deploy block. The overlap is harmless (idempotent writes), bounded (small range
on dRPC — the 10-block cap was Alchemy-read-only, never bites here), and absorbs
intra-tx / adjacent-block ordering. The cron remains the full-coverage
authority for anything beyond the window.

### 3.6 Route wiring + ack timing

- Add the route in `index.ts` `fetch`, before the generic 404, **no CORS**
  (the caller is Alchemy's edge, not a browser): `if (url.pathname ===
  '/hooks/chain-event' && req.method === 'POST') …`.
- **Add `ctx: ExecutionContext`** to the `fetch` signature (currently `(req,
  env)`), so the handler can `ctx.waitUntil(ingest…)` and return a fast **200**
  ack. Alchemy expects a prompt 2xx (it retries on non-2xx/timeout); an RPC
  re-read + D1 writes can exceed that window under load, so ingest runs in
  `waitUntil` and a transient ingest failure is covered by the cron backstop
  (consistent with "webhook = best-effort latency optimization"). HMAC verify
  + payload parse happen **synchronously** before the ack (so a bad signature
  is a real 401, not a swallowed 200).
- Wrap the `waitUntil` ingest in `.catch(console.error)` like the existing
  `scheduled()` passes — a webhook ingest failure logs and is left to the cron,
  never wedging the Worker.

### 3.7 Abuse / replay

- The HMAC gate is the primary defense: without the signing key an attacker
  can't forge a signed body, and a bad signature → 401 before any read/write.
- **Replay** of a valid past delivery → re-reads the range from chain and
  writes idempotently → harmless. (Alchemy signatures carry no timestamp; we
  don't need anti-replay because the ingest is idempotent and chain-sourced.)
- Optional belt-and-suspenders: a per-IP `ratelimit` binding like the
  `OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT` endpoint. Deferred — HMAC + idempotent
  chain-re-read already bound the blast radius; note as a follow-up if needed.

## 4. Security & idempotency summary

| Concern | Mitigation |
|---|---|
| Forged POST | HMAC-SHA256 over raw body, fail-closed 401; secret in Secrets Store |
| Spoofed/reorged payload contents | Payload is a *hint*; we re-`getLogs` from dRPC and write what the chain says |
| Double-write vs cron | All writes `INSERT OR IGNORE`/`OR REPLACE` keyed by chain+id / chain+block+logIndex+tx; deterministic UPDATEs |
| Cursor skipping un-scanned blocks | Webhook never advances the cursor (§3.5a) |
| Intra-batch amount replay | Small `SAFETY_LOOKBACK` window (§3.5b) |
| Ingest failure | `waitUntil` + `.catch`; cron backstop re-scans the range |
| Reading through Alchemy | All `getLogs`/detail re-reads go to `chain.rpc` (dRPC); Alchemy only POSTs |

## 5. Operator configuration (post-merge, not a deploy gate)

1. Provision `ALCHEMY_WEBHOOK_SIGNING_KEY` in the Cloudflare Secrets Store and
   bind it in `wrangler.jsonc`.
2. Create the Alchemy webhook (prefer **Custom Webhook** for full log coverage
   incl. `OfferCreated`/`OfferCanceled`; if Custom is paid-only on the account,
   fall back to **Address Activity** + let the cron backstop cover pure-state
   events — the webhook is a latency optimization, partial coverage is fine),
   filtered to the Diamond address, target URL `…/hooks/chain-event`. Configure
   the payload to carry the network identifier we map in §3.4.
3. No contract change, no ABI re-export, **no new contract events** → the
   `check-event-coverage` guardrail is unaffected. No deploy gate; degrades to
   cron-only when unconfigured.

## 6. Verification

- `pnpm --filter @vaipakam/indexer typecheck` (runs `tsc` + the
  `check-event-coverage` guardrail). apps/indexer has **no unit-test runner**
  (tsc-only Worker, like apps/keeper), so the HMAC-verify and
  payload→range parse are validated by a typed, side-effect-free shape plus a
  manual signed-`curl` smoke against `wrangler dev`. (If we want assertions,
  adding `vitest` for the two pure helpers — `verifyAlchemySignature`,
  `parseChainEventPayload` — is a small follow-up; flagged, not done here.)
- **Backstop assertion** (acceptance): with the webhook disabled, the cron
  still ingests an on-chain repay/match within its normal window — i.e. Phase A
  adds no dependency; deleting the route returns the system to today's
  behaviour.
- **Latency assertion** (acceptance): with the webhook enabled, D1 reflects an
  on-chain repay/match within seconds (vs up-to-N-minutes), measured by row
  `updated_at` vs block timestamp.

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

- [ ] `POST /hooks/chain-event` — HMAC-verified (`X-Alchemy-Signature`),
      fail-closed; routes through the shared `ingestChainEventRange` (same
      decode/dispatch as the cron); re-reads chain via **dRPC**; idempotent vs
      the cron; does **not** advance the cron cursor.
- [ ] Cron pass unchanged and still catches events when the webhook is
      disabled/failing (backstop).
- [ ] D1 reflects an on-chain repay/match within seconds of the event.
- [ ] Webhook handler reads **dRPC only**, never Alchemy; cron `eth_getLogs`
      stays on dRPC (no 10-block cap).
- [ ] Push outage / unconfigured chain → clean degrade to cron-only, no
      user-facing error.
