# LiveTailProvider Design — AppLayout-Level Event Scanner

**Status:** Draft 2026-05-07. Sub-design under
`DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar 4.2.
Phase 3 of the platform-optimisation roadmap implements this.

**Last updated:** 2026-05-07.

**Goal:** consolidate the per-hook live-tail scanners
(`useIndexedActiveOffers`, `useMyOffers`, `useIndexedLoans`,
`useIndexedActivity`, `useIndexedClaimables`, plus the legacy
`useLogIndex`) into a single AppLayout-mounted provider with
topic-routed dispatch and route-aware cadence. Replaces ~20 RPC
`eth_getLogs` calls per minute on busy pages with ~3.

---

## 1. Why one provider

Per-hook scanners run independently today. On the OfferBook page
with a logged-in user, five scanners hit the chain RPC for
overlapping block ranges with disjoint topic filters:

- `useIndexedActiveOffers` polls every 5 s (hot tier) for
  OfferCreated / Accepted / Cancelled.
- `useMyOffers`, `useIndexedActivity`, `useIndexedLoans` poll
  every 30 s (warm tier) for their own topic subsets.
- `useLogIndex` polls every 30 s (warm tier) for ALL 23 topics
  at once.

Aggregate RPC cost per minute on a busy page: ~20 `eth_getLogs`
calls. Reduces to ~3 calls/min after consolidation: one per
unique cadence (5 s × 1 + 30 s × 1 + 60 s × 1 = ~16 + 2 + 1 = 19
per minute total but each covers all subscribed topics, so the
incremental cost per added subscriber is zero).

Beyond RPC savings, consolidation gives:

- A **single watermark** for the diagnostics panel — no more
  aggregating `max(per-hook watermarks)`.
- A **single page-cadence policy** that varies by route via
  `useLocation()` instead of per-hook `watermarkPolicy('warm')`
  calls scattered across the codebase.
- A **uniform tab-visibility / idle / focus** behaviour without
  every hook re-implementing it.
- A clean **subscriber API** for future list-hook authors —
  subscribe to topics, receive events, render. No scanner
  authoring.

---

## 2. API contract

### 2.1 Provider mount

```ts
// In AppLayout.tsx, wrapping every authenticated route:
<LiveTailProvider chainId={chainId}>
  <Outlet />
</LiveTailProvider>
```

The provider is keyed on `chainId` and re-mounts on chain
switch. Internal state is per-chain to avoid stale subscribers
from a prior chain leaking into the new chain's scan.

### 2.2 Subscriber hook

```ts
useLiveTailSubscribe({
  topics: Hex[];            // topic0 hashes the subscriber cares about
  onEvent: (decoded: DecodedEvent) => void;
  // Optional: indexed-arg filter to reduce dispatch load
  // (the provider still scans the full topic union; this just
  // gates per-subscriber dispatch).
  filter?: { topic1?: Hex | Hex[]; topic2?: Hex | Hex[]; topic3?: Hex | Hex[] };
});
```

Returned: `void`. Subscriber registers on mount, unregisters on
unmount via the standard `useEffect` cleanup. The provider
invokes `onEvent` for every matching event the next scan
emits; the subscriber's component re-renders if it calls a
`setState` inside the handler.

### 2.3 Watermark accessor

```ts
const { lastScannedBlock, lastScannedAt } = useLiveTailWatermark();
```

Returns the highest block successfully scanned across the union
of all current subscribers. The diagnostics panel uses this
directly. Updates on every successful scan completion.

### 2.4 Catchup-state accessor

```ts
const { state, blocksRemaining } = useLiveTailCatchupState();
// state: 'in-sync' | 'catching-up' | 'deep-backlog'
```

Reads `chainSafeHead - lastScannedBlock` against
`CAUGHT_UP_GAP_BLOCKS` (100) and `LIVE_TAIL_BACKLOG_BLOCKS`
(50_000). The chain panel's `Live-tail status` row reads this.

### 2.5 Cadence override (escape hatch)

```ts
useLiveTailCadenceOverride({
  intervalMs: number | null;   // null = default for current route
});
```

For surfaces that need a different cadence than the route map
provides (e.g. a modal that wants 1 s during open). Override
unwinds on unmount.

---

## 3. Internal architecture

### 3.1 Single `eth_getLogs` per tick

Each tick the provider:

1. Computes the topic union — sum of every active subscriber's
   `topics`. De-duplicated.
2. Computes the block range — `[lastScannedBlock + 1,
   chainSafeHead]` from the watermark probe.
3. Issues ONE `eth_getLogs(diamondAddress, topics, fromBlock,
   toBlock)`. Chunks per `lib/rpcCatchUp.ts` semantics
   (1 000-block chunks default; auto-down-shift on RPC reject).
4. For each returned log, looks up subscribers by `topic[0]`
   and invokes their `onEvent` handlers.
5. Updates `lastScannedBlock` to `toBlock`.

If the topic union exceeds **22 entries** (publicnode silent
cap; documented in `lib/logIndex.ts`), the provider splits into
two parallel `eth_getLogs` calls. Cap is per-call, not per-tick.

### 3.2 Cadence by route

```ts
const ROUTE_CADENCE_MS: Record<string, number> = {
  '/app': 30_000,
  '/app/dashboard': 15_000,
  '/app/offers': 5_000,         // OfferBook is the busiest surface
  '/app/loans': 15_000,
  '/app/loans/:id': 5_000,      // Loan detail watches one loan
  '/app/activity': 15_000,
  '/app/claim-center': 10_000,
  '/app/escrow': 30_000,
  '/app/analytics': 60_000,     // Analytics tolerates more lag
  '/app/admin': 30_000,
  // Default for unmatched routes
  '*': 30_000,
};
```

Route resolution via `useLocation()` from react-router. On
route change, the provider's interval re-arms with the new
cadence.

**Tab visibility**: pause when document.hidden; resume on
visibilitychange + run one immediate catch-up scan.
**Idle**: drop to 60 s if no mouse / keyboard / scroll / touch
in the last 5 minutes. Drop to "paused" at 15 minutes inactive.
Same mechanics as `useLiveWatermark` today, lifted up.

### 3.3 Watermark probe

The provider runs `getBlock({ blockTag: 'safe' })` on the same
tick to set `chainSafeHead`. Single probe, single source of
truth. Removes the duplicate watermark probes today running in
the badge + drawer panel + every hook.

### 3.4 Subscriber dispatch

Internal map: `Map<Hex /* topic0 */, Set<Subscriber>>`.

On each event:
- Look up `topic[0]` → set of subscribers.
- For each subscriber, run optional `filter` (topic1/2/3 match);
  if pass, call `onEvent(decoded)`.
- Subscribers are NOT de-duplicated: if a hook subscribes to two
  topics that both fire in the same scan, it receives two
  callbacks. This is the right shape — handlers should be
  idempotent against repeated events for the same id.

### 3.5 Decoded event shape

The provider hands subscribers a normalised shape:

```ts
interface DecodedEvent {
  topic0: Hex;
  topics: Hex[];               // raw, including topic[0]
  data: Hex;                   // raw, ABI-encoded
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  removed: boolean;
}
```

Decoding the event-specific fields (offerId, loanId, struct
parameters) is the subscriber's responsibility. The provider
deliberately does NOT decode — different subscribers want
different field sets, and centralising the decode would force
the provider to know every event ABI.

---

## 4. Migration plan (per-hook)

Each list hook migrates independently behind a feature flag:

```ts
const USE_PROVIDER = import.meta.env.VITE_LIVE_TAIL_PROVIDER_ENABLED === 'true';

function useMyOffers(address: string | null) {
  if (USE_PROVIDER) {
    return useMyOffersViaProvider(address);
  }
  return useMyOffersLegacy(address);     // existing per-hook scanner
}
```

Migration order (lowest risk first):

1. **`useIndexedActivity`** — smallest hook, append-only event
   stream. Ideal pilot.
2. **`useIndexedClaimables`** — small, narrow topic set.
3. **`useMyOffers`** — moderate complexity; multiple topics +
   filter.
4. **`useIndexedLoans`** — multi-role (lender + borrower)
   subscription.
5. **`useIndexedActiveOffers`** — hottest path; last to migrate
   so we can validate at lower-traffic surfaces first.
6. **`useLogIndex`** — biggest scope. Subscribe to all 23
   topics + retain the localStorage cache layer; drop the
   internal scan loop.

After all six migrate:

- Remove `useLiveWatermark` from every hook (provider's
  watermark replaces it).
- Remove the per-hook `watermarkPolicy('warm')` calls.
- Drop the feature flag; provider becomes default.

---

## 5. Diagnostics integration

The provider exposes:

- `lastScannedBlock` → "Last safe block (available)" row in the
  Chain & Indexer panel reads this directly.
- `catchupState` → "Live-tail status" row reads this.
- `currentCadenceMs` → "Cadence" row (new) reads this.
- `currentRoute` → "Active route" row (new, advanced-mode only)
  shows which route's cadence is active.
- `subscriberCount` → "Active subscribers" row (new,
  advanced-mode only) shows how many list hooks are subscribing
  on this surface.

These replace the placeholder "probe" approach we discussed
earlier — the provider IS the source of truth, no separate
probe needed.

---

## 6. Open questions

1. **Should the provider run even when the diamond address is
   null** (e.g. user not connected, chain not deployed)?
   Recommendation: no. Provider state is empty; hooks skip
   subscription; no scan occurs.
2. **Should the watermark probe stay separate from the topic
   scan**, or share the same RPC tick?
   Recommendation: share. Same `eth_call` round-trip can carry
   `eth_blockNumber` (or `getBlock safe`) + the
   `eth_getLogs`. Saves one round-trip per tick.
3. **Subscriber-side filter — pre-dispatch or post-dispatch?**
   Recommendation: post-dispatch. Provider stays simple; the
   filter runs in JS after the topic-set match. Cost is
   negligible (filter is just an indexed-topic comparison).
4. **Should the provider fall back to per-hook scanners if the
   provider's scan repeatedly fails?**
   Recommendation: no — that would defeat consolidation. Surface
   the failure in the diagnostics panel; let the operator
   investigate. Polling resumes on the next tick after backoff.
5. **Cadence override stack — multiple overrides simultaneous?**
   Recommendation: most-recent-wins (LIFO). Modal A overrides
   to 1 s; modal B overrides to 10 s; closing B reverts to 1 s;
   closing A reverts to route default.

---

## 7. Cross-references

- `DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar
  4.2 (parent).
- `DesignsAndPlans/EventSourcingAudit.md` — extended event payloads
  the provider's subscribers consume.
- `DesignsAndPlans/CacheStoreDesign.md` — IndexedDB store updated by
  subscriber `onEvent` handlers.
- `frontend/src/lib/logIndex.ts` — existing 23-topic-OR scanner
  whose pattern the provider generalises.
- `frontend/src/lib/rpcCatchUp.ts` — chunked `eth_getLogs`
  primitive the provider reuses.
- `frontend/src/hooks/useLiveWatermark.ts` — current watermark
  probe, replaced by the provider's internal probe.
- `frontend/src/components/app/ChainDiagnosticsPanel.tsx` —
  diagnostic surface that reads the provider's accessors.
