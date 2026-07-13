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
| Positions/Claims | 12s blanket × (own-positions batch + claimables fan-out + vault + pending cards); Claims re-verifies each candidate with 3 reads (`getLoanDetails`+`ownerOf`+`getClaimable`) | 2,000–6,000 |
| Desk | 12s blanket + `OpenOrdersPanel`'s 5s `deskChainNow` block-timestamp read (the cancel-cooldown clock, NOT an order-state poll) + ranked-book read | 2,000–4,000 |
| Offer book | 12s blanket + the `bookCatchUp` ghost-strip `eth_getLogs` that runs INSIDE `useActiveOffers` on every `activeOffers` invalidation | 500–1,500 |
| Idle/hidden tab | `idleAware` backoff + no block subscription when hidden | small (already solved) |

Meanwhile the **signals that make most of this spend redundant already
exist** — with one important exception (counterparty-finality latency, called
out below):

- The indexer ingests via an **event-driven path** (provider webhook → per-
  chain Durable Object → immediate scan) with a 60s cron backstop, and its
  WebSocket rail pushes coarse invalidation keys to the browser within
  seconds of ingest (#757).
- The push `KEY_MAP` **already nudges the hybrid chain-read caches** —
  `myLoans`, `myOffers`, `claimables`, `loan`, `offer` are mapped under
  `loan.created/updated` and `offer.created/changed`. **Gap (Codex #1224):**
  an ownership *Transfer* (a position NFT moving in or out of the wallet with
  no accompanying status change) updates `*_current_owner` server-side but is
  NOT emitted by `invalidationKeysFromResult` under any own-position key —
  `activity.appended` does not dirty `myLoans`/`myOffers`. Today the 12s
  blanket masks this; removing it needs a new ownership-change push key
  (§4.0).
- Every write flow already invalidates its affected queries after its own
  transaction receipt confirms — but a single immediate invalidation can
  refetch pre-tx state from a public RPC that hasn't advanced past the mined
  block yet (§4.1.4).

**The one honest cost of removing the per-block blanket — counterparty
finality.** The blanket invalidates on the *latest* tip (~12s on Base
Sepolia). The push rail, by contrast, only fires *after* the ingest scan
writes D1, and that scan reads at the **`safe` block tag** (reorg safety; up
to a `latest − 32` fallback). So for **someone else's** action that changes
the wallet's own chain-read state (a counterparty accepting/cancelling, a
partial fill flipping a crossable band, a keeper liquidation), push-only
freshness is `safe`-finality + ingest + push — seconds to a few tens of
seconds on an L2, i.e. **slower than the ~12s tip blanket for that specific
class of event.** This design does not hand-wave that: §4.1.2 keeps a
narrow tip-driven nudge for exactly the roots whose truth turns on
counterparty/foreign-block events, so the blanket's *coverage* is preserved
while its *cost* (blanket-refetch-everything-every-block) is removed. Own-tx
freshness is unaffected — it rides the receipt, not either rail.

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

And the owner constraints: near-zero *recurring* chain reads; **no
update-speed regression** — own-tx and shared market/history get strictly
faster, and counterparty-driven own-position freshness is held at parity with
today by retaining a narrow tip nudge (§4.1.2), NOT allowed to slip to
`safe`-finality; Claims may keep chain reads; improve chain→D1 and
D1→browser delivery.

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

### Phase 0 — the two ingest-side keys the app-side plan depends on

Two `KEY_MAP`/push-frame additions are prerequisites, not optional (Codex
#1224): without them, removing the block blanket would silently drop refresh
coverage the blanket is masking today.

- **0.1 Ownership-transfer key.** `invalidationKeysFromResult` must emit an
  own-position key (dirties `myLoans`/`myOffers`/`claimables`) when the scan
  records a position-NFT `Transfer` — the in/out of a wallet's holdings with
  no status change. Add `ownership.changed` (or fold into `loan.updated` /
  `offer.changed`) and map it in `KEY_MAP`.
- **0.2 Cooldown is a client clock, not a chain read** (see 1.3): removes the
  `OpenOrdersPanel` 5s `deskChainNow` read entirely; needs the offer's
  `createdAt` + `CANCEL_COOLDOWN_SECONDS`, both already in the row the panel
  renders.

### Phase 1 — app-only: retire the timers (no new infra, biggest win)

**1.1 Rail-health–adaptive refresh, gated on cursor freshness (not socket
config).** Introduce one shared helper (extending `idleAware`) that resolves
each hook's `refetchInterval` from whether the rail is *actually delivering*.
The signal must be **`indexer_cursor` freshness**, not `hello.ingestActive`:
the DO sets `ingestActive` from static rollout/config membership, so a
webhook/cron/scan stall with a still-reachable socket would otherwise be
misread as healthy (Codex #1224). Concretely: the DO reports the cursor's
`updatedAt`/`lastBlock` age in `hello` and periodic frames (or the client
reads it from the `/offers/stats` freshness field it already polls via
`MarketFreshnessNote`), and "rail healthy" means **cursor advanced within the
last ~90s** AND the socket is open.

- **Rail healthy:** chain-read hooks drop their 30s interval to a **180s
  safety net**.
- **Rail down, cursor stale, OR HTTP-only deploy:** intervals restore to
  today's 30s — byte-for-byte current behaviour, honouring L65–66 ("polling
  remains the fallback"). A stale cursor with a live socket is treated as
  *down*, not healthy.
- **Explicit focus refetch (required).** The app sets
  `refetchOnWindowFocus: false` globally, so `idleAware` alone does NOT
  refetch a returning hidden tab (Codex #1224). Phase 1 adds an explicit
  `visibilitychange`/on-resume invalidation for every root whose interval is
  stretched to 180s, so a user returning after missed frames re-reads
  immediately rather than waiting out the net.

**1.2 Demote the per-block blanket — but keep a narrow tip nudge.**
`LiveChainSync` keeps its WS `newHeads` subscription. When the rail is
healthy it stops blanket-invalidating the full ~19-root set every 12s;
instead it invalidates only a **small tip-sensitive subset** whose truth
turns on *foreign* (counterparty/keeper) blocks that the push rail can only
report after `safe`-finality: `myLoans`, `myOffers`, `claimables`,
`offer`/`loan` detail, `loanSalePending`, `refinancePending`,
`deskPreviewMatch`, and the book ghost-strip (1.2a). This preserves the
blanket's *counterparty-freshness coverage* (~12s, no regression vs today)
while dropping its *cost* — vault, approvals, keeper-config, token/rewards
roots no longer refetch every block; they ride push + receipt + the 180s net.
When the rail is **down**, `LiveChainSync` reverts to invalidating the full
set (today's behaviour) as the fallback rail.

  **1.2a Split the book ghost-strip into its own query.** The L357–361
  ghost-strip currently runs *inside* `useActiveOffers` after the indexed
  fetch, so there is no root to keep block-driven independently — leaving it
  in place either forces `activeOffers` to keep invalidating every 12s
  (preserving the cost) or stops re-running the strip (violating shared-book
  honesty) (Codex #1224). Refactor the strip into a separate lightweight
  `bookGhostStrip` query keyed off the freshest-safe-block, block-driven and
  ≥12s-throttled, whose result the render intersects with the
  indexer-served/push-refreshed `activeOffers` list. Then `activeOffers`
  itself is push-driven and the honesty check stays live, independently.

**1.3 Replace the 5s desk cooldown poll with a local clock.** The
`OpenOrdersPanel` 5s read is `deskChainNow` — a `block.timestamp` fetch that
gates the Cancel button until `createdAt + CANCEL_COOLDOWN_SECONDS`. No
`offer.changed` push fires merely because wall-clock crosses that threshold
(Codex #1224), so push+interval alone would leave Cancel disabled until the
180s net. Fix: compute the cooldown client-side from the offer's `createdAt`
(already in the row) with a local `setTimeout`/countdown — **zero RPC**, and
more responsive than a 5s poll. Actual fill/cancel state changes still arrive
via the `offer.changed` push nudge.

**1.4 Centralize own-receipt invalidation with a next-block retry.** Move the
standard post-receipt invalidation set (own positions, claimables, vault,
activity, book) into the shared `diamond.ts` write hook so no future flow can
forget it. Critically, a *single* invalidation right after
`waitForTransactionReceipt` can refetch pre-tx state from a public RPC that
still serves the parent block (the existing code already dodges some block
invalidations for exactly this reason) (Codex #1224). So the centralized
handler must **re-invalidate on the next observed block after the receipt**
(or apply the known read-after-write patch, as the VPFI/keeper toggles
already do) — not one immediate refetch that can settle stale state until push
safe-finalizes. This is the rail that carries the L55–56 "within a block"
contract once timers are gone.

**1.5 Claims cadence (chain reads stay).** Per the owner directive and
L176–183, the #988 verification contract is untouched: candidates from the
indexed+chain union, per-candidate `ownerOf` + `getClaimable` on chain,
revert = not claimable, transport failure = unavailable (never a confident
short list). What changes is only *when* it runs: own-receipt (1.4),
`loan.updated`/`ownership.changed` push nudge, the tip nudge (1.2), explicit
focus (1.1), 180s net — instead of every 12–30s.

**1.6 Push-storm throttle — leading AND trailing.** Coarse keys mean a busy
chain could nudge `myLoans` on every ingest scan. Add a per-root minimum
re-fetch gap (~15s, same shape as `LiveChainSync`'s `MIN_INVALIDATE_MS`)
inside the push dispatcher. It must be **leading + trailing**: a
leading-only gap would fetch the first frame's D1 state and silently drop a
second frame landing inside the window, leaving `myLoans`/`claimables` stale
until focus/180s (Codex #1224). Queue a trailing invalidation at the end of
the gap whenever ≥1 frame arrived during it, so the last event is always read.

**Expected effect.** Recurring per-tab load drops sharply, but the honest
floor is set by the biggest *remaining* chain-read surface, **Claims**: ~10
candidates × 3 reads = ~30 `eth_call`s per verification, so even at the 180s
net that page alone is ~600 calls/hour before other hooks (Codex #1224 — the
earlier "20–80/hour" figure ignored this and is corrected here). Net picture:

- **Positions/Claims open:** ~2,000–6,000/hr → **~600–900/hr** (Claims
  verification floor + own-positions batch + short event/focus bursts), with
  candidate-narrowing (2.3) able to cut the Claims floor further.
- **Desk open:** ~2,000–4,000/hr → **low hundreds/hr** (5s cooldown poll
  gone; ranked-book on push + net).
- **Offer book open:** ~500–1,500/hr → **low hundreds/hr** (ghost-strip
  block-driven but decoupled; `activeOffers` push-driven).

So a **~4–10× cut** overall (not the earlier 10–30×), dominated by the Claims
verification floor which is deliberately preserved for correctness. Update
speed is held at parity for counterparty events (1.2 tip nudge) and improves
for own-tx and market/history.

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
own rows — **with an `unknown/new id ⇒ always refetch` rule** so create/accept
cases are never dropped (Codex #1224): a counterparty accepting one of my
offers emits a `loan.created` frame carrying a `loanId` NOT yet in `myLoans`,
so a pure intersection-against-existing-rows filter would skip the very
refetch that discovers the new position. The filter must therefore refetch on
(a) any id already owned, (b) any id NOT yet seen (potential new own row), and
only skip when the affected ids are all known-and-foreign.

**2.3 Claimable-candidate hint (optional) — new route, do NOT repurpose
`/claimables`.** The existing `GET /claimables/:address` is still consumed by
`apps/defi` (`indexerClient.ts`, typed `{asLender, asBorrower}`); changing its
shape to return alpha02 candidate ids would silently break that consumer
(Codex #1224). Add a separate `GET /claim-candidates/:address` (or a versioned
response) that returns candidate ids to *narrow* the Claims fan-out — fewer
`ownerOf`/`getClaimable` probes per run; candidates only, actionability stays
chain-decided (L177–178). Given the corrected Claims RPC floor (~600/hr), this
moves from "optional" to the **highest-value phase-2 item** for the quota goal.

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
  (DevTools network filter on the RPC host; expectation: a large drop, floored
  by the Claims verification surface if the Claims page is open), (b) from a
  second wallet accept/cancel against the first, and confirm the first tab's
  own-position roots refresh at **tip parity (~12s, via the 1.2 tip nudge)** —
  NOT delayed to `safe`-finality — while a hidden→focused tab refreshes
  immediately (1.1 explicit focus), (c) transfer a position NFT between the two
  wallets and confirm My positions updates without the block blanket (0.1
  ownership key), (d) kill the WS (block the endpoint) and confirm the 30s
  cadence and the degraded-source note return, (e) stall the cursor with a live
  socket (pause ingest) and confirm rail-health demotes to 30s (1.1
  cursor-freshness gate), not a false-healthy 180s.
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

1. **PR 0 (phase 0 — prerequisite, ships first):** the ownership-transfer
   invalidation key (0.1) in the indexer + `KEY_MAP`, landed and observed on
   the live WS rail *before* PR A removes the blanket that masks its absence.
   (The cooldown-clock change 0.2 ships with PR A since it's app-side.)
2. **PR A (phase 1):** rail-health helper (cursor-freshness gated) +
   `LiveChainSync` demotion-with-tip-nudge + book-ghost-strip split +
   OpenOrders local cooldown clock + centralized receipt invalidation with
   next-block retry + leading/trailing throttle + explicit focus refetch.
   One release behind a `VITE_FRESHNESS_TIMERS=legacy` escape hatch, removed
   after the live review passes.
3. **PR B (2.1):** config table + endpoint + display-hook switch.
4. **PR C (2.3):** `claim-candidates` route + Claims fan-out narrowing —
   promoted ahead of 2.2 because the corrected Claims floor is the dominant
   residual.
5. **PR D (2.2, after volume data):** scoped hints (with the new-id refetch
   rule).
6. Re-measure; decide 2.4/phase 3 with the owner.

Each PR updates `apps/alpha02/e2e/COVERAGE.md`, carries a release-note
fragment, and lands the matching intent edits in `Alpha02ConnectedApp.md`
(the freshness section gains one sentence: signal-driven refresh with polling
as the degraded fallback — which is already its spirit at L65–66).
