# alpha02 RPC Read Diet — Signal-Driven Freshness, Timer-Free Chain Reads

**Status:** Design — pending owner sign-off on phase ordering
**Module:** apps/alpha02 (phase 1), apps/indexer (phase 2)
**Priority:** P2 — RPC quota pressure grows linearly with active tabs
**Origin:** Owner request 2026-07-13: reduce direct blockchain reads to near
zero by serving reads from the indexer without compromising update speed —
improving both chain→D1 ingest and D1→browser delivery — with the Claims
surface explicitly allowed to keep proper chain reads.
**Governing spec:** [`docs/FunctionalSpecs/Alpha02ConnectedApp.md`](../FunctionalSpecs/Alpha02ConnectedApp.md)
(the alpha02 spec; `WebsiteReadme.md` governs apps/defi and is deliberately
NOT a constraint source for this design).

---

## 1. Problem

Every active alpha02 tab spends RPC quota on a recurring schedule, whether or
not anything on chain changed. The cost has three drivers, in descending
order:

1. **The per-block blanket invalidation.** On deploys with a WebSocket RPC,
   `LiveChainSync` watches new heads and invalidates the entire chain-read
   cache set (~19 query roots: own positions, claimables, vault, approvals,
   keeper config, loan-sale/refinance pending, previewMatch, …) at a
   ≥12-second throttle. Base Sepolia mines ~every 2s, so this fires
   essentially every 12s — each firing refetches every mounted chain-read
   hook even when no Vaipakam event occurred in those blocks.
2. **Standing intervals.** Chain-read hooks also poll on `idleAware`
   intervals (mostly 30s; rewards/approvals/keepers 60s; grace 10min) as the
   HTTP-only floor. One outlier polls hard: the desk's `OpenOrdersPanel`
   refetches order state every **5s** while mounted.
3. **Fan-out shape.** The heaviest single refresh is Claims:
   `useMyClaimables` re-verifies each candidate loan with three reads
   (`getLoanDetails` + `ownerOf` + `getClaimable`), so one 30s tick with ~10
   candidates is ~30 `eth_call`s. Own-positions hydration was already
   collapsed to ~one call per 250 positions by the #1025 batch views;
   claimable verification was not.

Rough per-tab budget today (active tab, WS-RPC deploy, viem request batching
on; counting `eth_call`/`eth_getLogs` units, which is what provider quotas
meter):

| Surface open | Dominant drivers | Est. calls/hour |
| --- | --- | --- |
| Positions/Claims | 12s blanket × (own-positions batch + claimables fan-out + vault + pending cards) | 2,000–6,000 |
| Desk | 12s blanket + 5s open-orders poll + ranked-book read | 2,000–4,000 |
| Offer book | 12s blanket + `bookCatchUp` `eth_getLogs` per invalidation | 500–1,500 |
| Idle/hidden tab | `idleAware` backoff + no block subscription when hidden | small (already solved) |

Meanwhile the **signals that make most of this spend redundant already
exist**:

- The indexer ingests via an **event-driven path** (provider webhook → per-
  chain Durable Object → immediate scan) with a 60s cron backstop, and its
  WebSocket rail pushes coarse invalidation keys to the browser within
  seconds of ingest (#757).
- The push `KEY_MAP` **already nudges the hybrid chain-read caches** —
  `myLoans`, `myOffers`, `claimables`, `loan`, `offer` are mapped under
  `loan.created/updated` and `offer.created/changed`.
- Every write flow already invalidates its affected queries after its own
  transaction receipt confirms (read-after-write freshness is not carried by
  the timers).

So the timers and the per-block blanket are, on a healthy push rail, a
**redundant third and fourth delivery channel** for changes the app already
hears about twice.

## 2. Constraints (what must not change)

From `Alpha02ConnectedApp.md` — quoted because they are load-bearing:

- **Data authority (L49–54):** "Chain reads are authoritative for the
  connected wallet's current positions, claimability, offer and loan detail
  pages, ownership, and submit-time safety. Indexed reads are the fast market
  and history layer…"
- **Own-tx freshness (L55–56):** "A just-confirmed offer or loan owned by the
  connected wallet should appear in My positions within a block when the
  chain can enumerate it."
- **Redundancy (L342–350):** own current positions are discovered from the
  chain; the indexed lists are the redundancy source; either source down →
  degraded note; unavailable only when both fail.
- **Outranking (L351–356):** "Live chain state always outranks the indexed
  snapshot for the wallet's own positions… even while background ingestion
  lags."
- **Claims (L176–183):** "Claims are chain-authoritative. Indexed data may
  provide candidates, but live ownership and claimability decide whether a
  claim is actionable… A stale indexed row must not remain actionable after
  the chain says it is no longer claimable." (This matches the owner
  directive: the Claims surface keeps proper chain reads.)
- **Push is a hint (L65–66):** "Realtime push refreshes matching indexed
  views when available. Polling remains the fallback."
- **Shared-book honesty (L357–361):** the one-sided chain check that strips
  already-ended offers the cache hasn't ingested yet stays.

**The spec mandates outcomes, not timers.** Nothing in it requires a 30s
interval or a per-block blanket refetch. "Within a block" for the wallet's
own transaction is carried by the receipt-gated invalidation (the app watched
that tx confirm), not by polling. That is the opening this design uses.

And the owner constraints: near-zero *recurring* chain reads; no update-speed
regression (target: strictly faster); Claims may keep chain reads; improve
chain→D1 and D1→browser delivery.

## 3. Rejected alternatives

**(a) Indexer-primary for everything, chain only for Claims** (the literal
reading of the request). Rejected on three grounds:

1. *It cannot meet L55–56.* Ingest reads at the **`safe` block tag** (with a
   32-block fallback buffer) precisely so a reorg can never poison D1. That
   is a structural 10–32-block (~20–60s on an L2) freshness floor for
   everything indexer-served. A just-confirmed own transaction would again
   take tens of seconds to appear — re-opening the exact staleness bug the
   #1016 chain-authoritative own-positions work closed, and violating
   L55–56/L351–356.
2. *It halves availability.* Today an indexer outage leaves own positions
   rendering from chain (L342–350's two-source contract). Indexer-primary
   makes the Worker+D1 a single point of failure for the user's own money
   state.
3. *Claims aren't separable from the cluster.* Ownership ("a loan whose
   position token the wallet no longer holds must not keep rendering"),
   detail-page resolution for fresh deep links (L59–60), and submit-time
   safety live on the same authority line as claimability (L51–52). Keeping
   chain reads for Claims but not for these would satisfy the letter of one
   clause while breaking its siblings.

**(b) Ingest at the chain tip with reorg rollback in D1.** Would remove the
safe-head floor, but requires reversible writes across every table, a reorg
detector, and re-broadcast semantics on the push rail — a large correctness
project with new failure modes (the May-2026 "every loan stuck active"
incident shows what silent ingest gaps cost). Not worth it when the hybrid
already covers the tip-side gap with cheap targeted reads.

**(c) Server-side shared read proxy** (Worker performs the authoritative
chain reads once, all browsers share the result). Cuts quota by the fan-out
factor but makes the Worker an oracle for money-state — the trust posture
the authority split exists to avoid — and its cache TTL becomes a new
staleness knob. Deferred to phase 3 as an explicit owner decision **only if**
quota is still binding after phases 1–2; not recommended now.

## 4. Design — three phases

The unifying rule: **a chain read runs when a signal says something may have
changed, never because a timer expired** — except as the degraded fallback
the spec itself requires when the push rail is down.

### Phase 1 — app-only: retire the timers (no new infra, biggest win)

**1.1 Rail-health–adaptive refresh.** Introduce one shared helper (extending
`idleAware`) that resolves each hook's `refetchInterval` from the push rail's
health, which `IndexerPushSync` already knows (`hello.ingestActive`, socket
state):

- **Rail healthy:** chain-read hooks drop their 30s interval to a **180s
  safety net** (catches a missed webhook/frame; the 60s ingest cron plus push
  means a real event still arrives in seconds).
- **Rail down / HTTP-only deploy:** intervals restore to today's 30s —
  byte-for-byte the current behaviour, honouring L65–66 ("polling remains the
  fallback").
- `idleAware`'s hidden-tab pause and focus catch-up stay; a `visibilitychange`
  → immediate refetch already covers the returning user.

**1.2 Demote the per-block blanket.** `LiveChainSync` keeps its WS `newHeads`
subscription but only invalidates the chain-read set when the **push rail is
down** (it becomes the fallback rail, mirroring 1.1). When the rail is
healthy the per-block blanket is off: chain-read caches refetch on
(a) own-receipt invalidation, (b) push nudges via the existing `KEY_MAP`
entries, (c) focus, (d) the 180s net. Two deliberate exceptions stay
block-driven because their truth changes with *any* block, not only Vaipakam
events: `deskPreviewMatch` (crossability math) and the `bookCatchUp` ghost-
strip (L357–361) — both already throttled to ≥12s and mounted only on their
surfaces.

**1.3 Kill the 5s desk poll.** `OpenOrdersPanel` fills/cancels are on-chain
events the ingest scan folds into `offer.changed` within seconds; the panel
moves to push-nudge + the adaptive interval from 1.1. (Its cancel pre-flight
reads are one-shot and unaffected.)

**1.4 Centralize own-receipt invalidation.** Flows individually invalidate
after `waitForTransactionReceipt`; move a standard post-receipt invalidation
set (own positions, claimables, vault, activity, book) into the shared
`diamond.ts` write hook so no future flow can forget it. This is the rail
that carries the L55–56 "within a block" contract once timers are gone.

**1.5 Claims cadence (chain reads stay).** Per the owner directive and
L176–183, the #988 verification contract is untouched: candidates from the
indexed+chain union, per-candidate `ownerOf` + `getClaimable` on chain,
revert = not claimable, transport failure = unavailable (never a confident
short list). What changes is only *when* it runs: own-receipt, `loan.updated`
push nudge (already mapped), focus, 180s net — instead of every 12–30s.

**1.6 Push-storm throttle.** Coarse keys mean a busy chain could nudge
`myLoans` on every ingest scan. Add a per-root minimum re-fetch gap (~15s,
same shape as `LiveChainSync`'s `MIN_INVALIDATE_MS`) inside the push
dispatcher so a burst of frames collapses to one refetch — bounding worst-
case signal-driven load at roughly what one block-tick costs today.

**Expected effect:** the recurring per-tab budget in §1 drops from
~2,000–6,000 calls/hour to the safety-net baseline (~20–80/hour across
mounted hooks) plus short bursts around real events and focus — an
order-of-magnitude 10–30× cut — while a counterparty's action now surfaces in
**push latency (seconds)** instead of "next 12–30s tick", i.e. update speed
improves.

### Phase 2 — indexer additions: move the movable reads off RPC entirely

**2.1 Config snapshot endpoint.** Protocol config is chain-only today (fees
bundle, master flags, VPFI params, rental buffer, sanctions-oracle address),
each browser re-reading it on 5–10min caches. Add `GET /config/:chainId`
served from a small D1 table the indexer refreshes server-side (on the
config-change events it already scans, plus a slow re-read as backstop).
Display surfaces read it with zero per-user RPC. **Boundary:** pre-sign
paths keep reading the Diamond (L51–52 submit-time safety) — the receipt a
user signs against always quotes live chain values. Bonus: `/help`'s fee
answer can become live for disconnected visitors without shipping the ABI
(compare the UX2-008 deferral).

**2.2 Scoped push hints.** Frames today carry only coarse keys, so every tab
refetches own-position roots on any loan event. The Durable Object already
holds the decoded events server-side; extend frames with the affected
`offerIds`/`loanIds` (bounded list, no new authority — still just a hint per
L65–66). The browser skips the refetch when none of the ids intersect its
own rows. This keeps signal-driven load flat as protocol volume grows.

**2.3 Claimable-candidate hint (optional).** The unused `/claimables`
endpoint can return candidate ids to *narrow* the Claims fan-out (fewer
`ownerOf`/`getClaimable` probes per run) — candidates only; actionability
stays chain-decided (L177–178). Only worth it if Claims-page telemetry shows
the fan-out still dominating after 1.5.

**2.4 Desk ranked book (decide separately).** `getActiveOffersByAssetPairRanked`
could be replicated in SQL over the `offers` table, moving the desk's last
recurring display read to the indexer behind the same ghost-strip pattern.
Medium effort, needs rank-parity tests against the facet; flagged as a
candidate, not committed here.

### Phase 3 — only if still needed

Re-measure after phases 1–2. If quota remains binding at scale, bring the
shared read-proxy tier (§3c) to the owner as its own decision with the trust
trade-off stated. This design does not recommend it today.

## 5. Chain→D1 and D1→browser delivery (the speed half)

The requested pipeline improvements are mostly **hardening what shipped with
#757**, not new machinery:

- **chain→D1:** the webhook→DO path is live (`CHAIN_INGEST_VIA_DO: "true"`);
  the DO re-arms 3s catch-up alarms until it reaches the target and the 60s
  cron backstops missed deliveries. Actions: verify a provider webhook is
  registered for **every** supported chain (Arb Sepolia parity with Base
  Sepolia), and alert (ops bot) when `indexer_cursor.updated_at` ages beyond
  ~5min — a silent webhook+cron stall must page someone, because after phase
  1 the app leans harder on this rail. The `safe`-tag read stays: it is the
  reorg-safety floor, and the tip-side gap is exactly what the retained
  targeted chain reads and `bookCatchUp` cover.
- **D1→browser:** the WS rail already delivers invalidations in seconds,
  degrades to polling honestly (503/`ingestActive:false` → dormant retry),
  and defers hidden-tab frames to one flush on focus. Phase 1.1 makes the
  app's polling cadence *react* to this rail's health; phase 2.2 makes its
  frames more precise. No protocol change: frames stay signal-only
  (L65–66), so a compromised or buggy indexer still cannot inject state —
  the refetch goes through the same trusted read surfaces as before.

## 6. What deliberately stays on chain

| Read | Why it stays | Cadence after this design |
| --- | --- | --- |
| Write-path: preflights, allowances, simulation, `previewMatch`, deadline `getBlock` | Submit-time safety (L52); must reflect exact pre-sign state | One-shot per user action (unchanged) |
| Claims actionability (`ownerOf` + `getClaimable`) | L176–183 + owner directive | Signal-gated (1.5) |
| Own-positions enumeration + hydration (batch views) | L51, L55–56, L342–356 | Signal-gated (1.1/1.2) |
| Offer/loan detail fresh-deep-link fallback | L59–60 | On indexed-row miss (unchanged) |
| `bookCatchUp` ghost-strip `eth_getLogs` | L357–361 | Block-driven, book surface only (unchanged) |
| Token metadata / ENS | Immutable, cached forever | Once per session (unchanged) |

## 7. Verification plan

- **Fork tier (CI):** the fork harness has no WS rail by design, so specs
  assert the **fallback posture**: intervals at 30s, flows still refetch on
  own-receipt, Claims still verify on chain. A unit test pins the rail-health
  helper's two states and the push-dispatcher throttle.
- **Live review (post-deploy DoD):** with a dev wallet on the deployed site,
  (a) count RPC requests over a 10-minute idle-but-focused window before/after
  (DevTools network filter on the RPC host; expectation: dozens → single
  digits outside the 180s net), (b) act from a second wallet and confirm the
  first tab reflects the counterparty change within seconds via the push
  nudge, (c) kill the WS (block the endpoint) and confirm the 30s cadence
  and the degraded-source note return.
- **Regression tripwires:** the existing `pushKeyMap` unit test extends to
  the new root throttles; the ops alert from §5 covers the ingest rail.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Missed push frame (webhook drop + frame loss) | 60s ingest cron + 180s client net + focus refetch; ops alert on cursor age |
| WS flapping re-enables timers repeatedly | Rail-health is debounced by the existing dormant-retry (300s) posture; flapping degrades to plain 30s polling, never worse than today |
| Push storm on busy chain | Per-root ≥15s throttle (1.6); scoped hints (2.2) |
| A future flow forgets receipt invalidation | Centralized in the shared write hook (1.4) |
| Indexer serves wrong data | Unchanged trust posture: push is signal-only; chain reads still decide own-position/claim/pre-sign truth |
| Config snapshot staleness at sign time | Pre-sign paths keep reading the Diamond; snapshot is display-only (2.1) |

## 9. Rollout

1. **PR A (phase 1):** rail-health helper + `LiveChainSync` demotion +
   OpenOrders poll removal + centralized receipt invalidation + throttle.
   One release behind a `VITE_FRESHNESS_TIMERS=legacy` escape hatch, removed
   after the live review passes.
2. **PR B (2.1):** config table + endpoint + display-hook switch.
3. **PR C (2.2, after volume data):** scoped hints.
4. Re-measure; decide 2.3/2.4/phase 3 with the owner.

Each PR updates `apps/alpha02/e2e/COVERAGE.md`, carries a release-note
fragment, and lands the matching intent edits in `Alpha02ConnectedApp.md`
(the freshness section gains one sentence: signal-driven refresh with polling
as the degraded fallback — which is already its spirit at L65–66).
