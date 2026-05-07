# IndexedDB Cache Store Design

**Status:** Draft 2026-05-07. Sub-design under
`DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar 4.3.
Phase 4 of the platform-optimisation roadmap implements this.
Builds on Phases 1 (event extensions) and 3 (LiveTailProvider).

**Last updated:** 2026-05-07.

**Goal:** client-side cache for fully-hydrated offer / loan rows
so the page first-paints from local storage and updates rows
in-place from event stream — no network round-trip per render,
no re-fetch on tab return, lazy `getOfferDetails` /
`getLoanDetails` only on cache miss.

---

## 1. Why IndexedDB, not localStorage

`lib/logIndex.ts` already writes to localStorage today, but only
the lightweight event-derived ID index. The fully-hydrated row
shape (~25 fields per offer, ~40 per loan, ~12 per activity
event) is ~800 B per row decoded. localStorage's ~5 MB cap with
synchronous JSON-parse on every read becomes a bottleneck.

IndexedDB:

- ~50 MB+ per-origin (browser-dependent — Chrome 60 MB +
  scaling, Firefox 50 % of free disk).
- Async API, no main-thread blocking on read.
- Structured storage (no manual `JSON.parse` for every read).
- Transaction model — atomic multi-row updates (event arrival
  often updates multiple rows).
- Schema versioning built in (`upgradeneeded` event).

The library `idb` (Jake Archibald's wrapper) is the de-facto
standard; ~2 kB minified; promise-based. Add it as a dep.

---

## 2. Schema — five object stores, all chainId-scoped

### 2.1 `myOffers`

Connected wallet's own offers (in any status).

| Field | Type | Indexed? |
|---|---|---|
| `(chainId, offerId)` | composite key | primary |
| `chainId` | number | yes |
| `offerId` | string (decimal) | yes |
| `creator` | string (lowercase hex) | yes — equals connected address |
| `status` | string enum | yes — for status-filter chip |
| `offerType` | string enum (Lender/Borrower) | yes |
| `lendingAsset` | string | — |
| `amountMin`, `amountMax`, `amountFilled` | string (bigint) | — |
| `interestRateBpsMin`, `interestRateBpsMax` | number | — |
| `durationDays` | number | — |
| `collateralAsset`, `collateralAmount` | strings | — |
| `periodicInterestCadence` | number | — |
| `allowsPartialRepay`, `keeperAccessEnabled` | boolean | — |
| `createdAtBlock`, `createdAtTimestamp` | number | sortable |
| `updatedAtBlock` | number | sortable — for live-tail dedup |
| `_cacheVersion` | number | — schema-version stamp |

### 2.2 `myLoans`

Connected wallet's loans (lender or borrower side).

| Field | Type | Indexed? |
|---|---|---|
| `(chainId, loanId)` | composite key | primary |
| `chainId` | number | yes |
| `loanId` | string | yes |
| `lender`, `borrower` | string (hex) | yes — for role filter |
| `status` | string enum | yes |
| `lenderTokenId`, `borrowerTokenId` | string | yes — for NFT-ownership lookup |
| `lendingAsset`, `principal`, `outstandingPrincipal` | strings/bigint | — |
| `interestRateBps`, `durationDays`, `graceDays` | numbers | — |
| `collateralAsset`, `collateralAmount` | strings | — |
| `startTimestamp`, `dueTimestamp`, `lastRepaidAt` | numbers | sortable |
| `liqThresholdBps`, `maxLtvBpsAtInit` | numbers | — |
| `lenderClaimed`, `borrowerClaimed` | booleans | — |
| `createdAtBlock`, `updatedAtBlock` | numbers | — |
| `_cacheVersion` | number | — |

### 2.3 `topOffers`

Top-N global active offers, paginated. Used by OfferBook for
first-paint without hitting the indexer.

| Field | Type | Indexed? |
|---|---|---|
| `(chainId, offerId)` | composite key | primary |
| `chainId` | number | yes |
| `sortKey` | composite "rate-then-amount" string | yes — for sorted iteration |
| `status` | string enum | yes (must equal Active for inclusion) |
| Same shape as `myOffers` rows for the rest. |  |  |

Bounded at **500 rows per chain**; eviction on insert beyond
the cap, lowest-rate wins (configurable).

### 2.4 `recentActivity`

Bounded ring buffer of recent activity events (claim, sale,
liquidation, etc.) per chain. Hydrates the Activity page first-
paint.

| Field | Type | Indexed? |
|---|---|---|
| `(chainId, eventId)` | composite key | primary |
| `chainId` | number | yes |
| `eventType` | string enum | yes |
| `actor` | string (hex) | yes |
| `loanId` or `offerId` | string | yes |
| `blockNumber`, `timestamp` | numbers | sortable |
| Type-specific payload | JSON blob | — |

Bounded at **1 000 events per chain**; eviction = lowest
blockNumber (oldest).

### 2.5 `metadata`

Per-chain knobs and watermarks.

| Key | Value |
|---|---|
| `myOffers:lastScannedBlock` | bigint serialised |
| `myLoans:lastScannedBlock` | bigint |
| `topOffers:lastScannedBlock` | bigint |
| `recentActivity:lastScannedBlock` | bigint |
| `cacheVersion` | number |
| `connectedAddress` | string (hex) |
| `lastConnectedAt` | timestamp |

---

## 3. Cache invalidation

### 3.1 Schema version bump

A constant `CACHE_VERSION` bumps when the row shape changes
(field added / removed / renamed) or when the event-decoder
contract changes (e.g. the Phase 1 event extensions land).
On bump, `upgradeneeded` event handler:

1. Drop ALL stores for the prior version.
2. Re-create with the new shape.
3. The provider re-fetches everything from indexer / chain on
   next mount.

The bump is a one-line constant change in
`lib/cacheStore.ts`. Operators reading the diff can see when
caches will reset.

### 3.2 Chain switch

Cache stores are keyed on `chainId`. On chain switch:
- Connected-wallet stores (`myOffers`, `myLoans`) are scoped to
  the prior chain — they stay populated for fast return.
- The active page reads from the new chainId; sees empty stores;
  triggers re-fetch from indexer / chain.

### 3.3 Wallet disconnect / address change

`myOffers` and `myLoans` rows where `creator` or
`(lender, borrower)` ≠ new connected address are cleared on
wallet change. `topOffers` and `recentActivity` are wallet-
agnostic and persist.

### 3.4 Explicit purge (advanced-mode only)

The Chain Diagnostics Panel's "Purge browser-side state" button
(shipped 2026-05-06) wipes IndexedDB plus localStorage plus
sessionStorage. Reaches this cache via the global `databases()`
API — no special-case wiring needed.

---

## 4. Merge semantics — events into rows

Subscribers receive events from the LiveTailProvider. Each
event handler:

1. Decode the event payload into row-update fields (per the
   Phase 1 self-sufficient event extensions).
2. Look up the existing row by `(chainId, id)`.
3. If exists AND `event.blockNumber > row.updatedAtBlock`:
   merge fields, write back, set `row.updatedAtBlock =
   event.blockNumber`.
4. If exists AND `event.blockNumber <= row.updatedAtBlock`:
   skip (out-of-order arrival; probably from a re-scan after
   live-tail catch-up).
5. If does NOT exist AND the event is a creation event
   (`OfferCreated` / `LoanInitiated`): construct from payload +
   companion-event (`OfferCreatedDetails` / `LoanInitiatedDetails`)
   and INSERT.
6. If does NOT exist AND the event is a lifecycle event
   (`LoanRepaid`, `OfferAccepted`, etc.): cache miss. Lazy-fetch
   via `getDetails` view-call, then proceed with the merge.

The handler is idempotent — replaying the same event yields the
same row state. This matters because re-scans can deliver events
the cache already merged (transactions in the live-tail catch-up
range that were ALSO in the indexer's snapshot).

---

## 5. Read-side flow (per page)

```
Mount
  └─→ Read row set from IndexedDB (synchronous-ish via idb's promise)
        └─→ First-paint with cached rows, even if stale.
  └─→ Subscribe to LiveTailProvider for relevant topics.
        └─→ Events flow into merge handler; rows update in place.
  └─→ Periodic indexer reconcile (every N seconds via the
      LiveTailProvider's cadence):
        └─→ Fetch the indexer's row list for the relevant
            scope (e.g. /offers/by-creator).
        └─→ Diff against cache; INSERT new rows; UPDATE drifted;
            DELETE rows the indexer no longer reports as
            relevant (status changed to terminal + not in
            scope).
```

The reconcile step catches drift between cache and indexer
(e.g. events the live-tail dropped during a tab-hidden period).

### 5.1 Cache miss → lazy fetch

When the live-tail receives a lifecycle event for an `id` not
in the cache:

```ts
// onEvent for, say, LoanRepaid(loanId, ...)
if (!await store.get('myLoans', [chainId, loanId])) {
  const fresh = await diamond.getLoanDetails(loanId);
  await store.put('myLoans', { ...freshRow });
}
// Then merge the LoanRepaid payload's deltas.
```

The cache miss is the ONLY path that calls `getDetails`. Steady
state is event-driven and zero-RPC for individual rows.

---

## 6. Storage sizing

Per-chain cache size estimates:

| Store | Rows × bytes | Total |
|---|---|---|
| myOffers | ~10 × 800 B | 8 KB |
| myLoans | ~5 × 1 200 B | 6 KB |
| topOffers | 500 × 800 B | 400 KB |
| recentActivity | 1 000 × 400 B | 400 KB |
| metadata | ~10 × 100 B | 1 KB |
| **Per chain** | | **~815 KB** |

Across 6 chains (Base, Arb, OP, plus mainnet equivalents):
~5 MB. Well within IndexedDB's per-origin budget.

The browser may evict on low-disk pressure, but eviction is
graceful — next visit re-builds from indexer + chain.

---

## 7. Multi-source merge (indexer + live-tail + subgraph)

When all three sources are available, the cache reconciles
their views. Conflict-resolution rule: **highest
`updatedAtBlock` wins**. Concretely:

- Indexer reconcile fills cache cold-start.
- Live-tail dispatches updates into cache.
- Subgraph (Pillar 4.5, Phase 6) becomes a third path that
  feeds into the same merge handler.

The merge handler doesn't need to know which source emitted
the update — `updatedAtBlock` is the only ordering signal.

---

## 8. Write-side considerations

Cache is read-mostly. Writes happen during:

- Initial indexer fetch (bulk INSERT).
- Live-tail event arrival (UPDATE / INSERT).
- Subgraph reconcile (UPDATE).
- Cache miss → `getDetails` lazy-fetch (INSERT).
- Eviction (DELETE on `topOffers` / `recentActivity`).

All under IndexedDB transactions to avoid torn reads. `idb`'s
`tx.objectStore(...).put(...)` + `tx.done` pattern is the
default.

---

## 9. Open questions

1. **Should `myOffers` / `myLoans` persist across disconnect**?
   Recommendation: yes, but mark them stale until reconnect.
   Saves a re-fetch on quick reconnect. Cap age at 7 days
   (auto-purge on next mount if older).
2. **Should `topOffers` be sort-key-aware (rate-asc) or
   block-time-aware (newest first)**?
   Recommendation: rate-asc, since OfferBook's default sort is
   rate. Configurable via an indexedKey on the store.
3. **Should the cache support multiple connected addresses
   (e.g. user has two wallets)**?
   Recommendation: no. One connected address at a time. Wallet
   change purges the wallet-scoped stores.
4. **Service Worker integration?** A service worker could
   pre-warm the cache during install; out of scope for Phase 4
   but a natural follow-up if PWA polish lands.
5. **Cross-tab synchronisation?** IndexedDB is shared across
   tabs of the same origin. Two open Vaipakam tabs writing
   simultaneously could race. Mitigate via the
   `BroadcastChannel` API to coordinate cache invalidations
   across tabs.

---

## 10. Cross-references

- `DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar
  4.3 (parent).
- `DesignsAndPlans/EventSourcingAudit.md` — extended event payloads the
  merge handler decodes.
- `DesignsAndPlans/LiveTailProviderDesign.md` — the dispatcher that
  feeds events into the merge handler.
- `DesignsAndPlans/SubgraphSchemaDesign.md` — third source feeding the
  same merge handler post-Phase-6.
- `frontend/src/lib/logIndex.ts` — existing localStorage cache
  pattern; the IndexedDB cache supersedes it.
- `frontend/src/components/app/ChainDiagnosticsPanel.tsx` —
  advanced-mode purge button reaches this cache.
