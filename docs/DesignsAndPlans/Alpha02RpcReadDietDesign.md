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
class of event.** This design does not hand-wave that: §4.1.2 splits the
class in two. Roots that **gate money actions or render action-decisive
detail state** keep a tip-driven nudge (full ~12s parity); **list surfaces**
(`myLoans`/`myOffers` grids, Claims) accept push-finality latency for
foreign events as an explicit, documented trade-off — no money action fires
from a list without passing the tip-fresh detail gates and the pre-sign
checks. Own-tx freshness is unaffected — it rides the receipt, not either
rail.

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
that tx confirm), not by polling — broadcast across this origin's tabs, and
scoped per-surface for transactions no tab of this app observed (§4.1.4).
That is the opening this design uses.

And the owner constraints: near-zero *recurring* chain reads; **no
update-speed regression where speed is load-bearing** — own-tx and shared
market/history get strictly faster; money-action gates (detail pages,
pending-card accepts, crossability, the book ghost-strip) hold tip parity
via the narrow tip nudge (§4.1.2); list-row freshness for foreign events
moves to push latency as the one explicit trade-off (§4.1.2's "deliberately
NOT in the tip subset" note); Claims may keep chain reads; improve chain→D1
and D1→browser delivery.

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
`updatedAt`/`lastBlock` age in `hello` and in periodic frames, and the
rail-health state is owned **app-wide by `IndexerPushSync`** (exposed via a
tiny context/store the interval helper reads). It must NOT be derived from
`MarketFreshnessNote`'s per-page poll: Claims and Positions — the pages whose
intervals are being stretched — never mount that component (Codex #1224 r2).
If the socket cannot carry cursor fields (older worker), `IndexerPushSync`
itself owns a low-frequency `/offers/stats` freshness probe as the fallback
source. "Rail healthy" means **the cursor advanced within a
cadence-derived staleness window** AND the socket is open. The window is
NOT a hard-coded wall-clock constant (Codex #1224 r3): it derives from the
ingest mode's actual per-chain service cadence. On the live DO path the
cron pings **every** chain's DO each minute (`apps/indexer/src/index.ts` —
"every chain is serviced each minute (not one per round-robin tick)"), so
~90s (cadence × 1.5) is correct there; on the legacy inline round-robin
fallback a chain is only scanned every `N_chains × 60s`, so the window
scales with the configured chain count. The server tells the client which
cadence applies (the DO includes its expected scan cadence alongside the
cursor age in `hello`/periodic frames, and `/offers/stats` gains the same
two fields for the no-WS fallback probe), so a healthy-but-quiet chain on a
slower cadence is never misread as stale — misreading it would restore 30s
polling during normal quiet periods and quietly undo the diet.
**Sequencing (Codex #1224 r4):** these are server-side fields, so they ship
in **PR 0** (the indexer-side prerequisite PR), not PR A — otherwise the
app-only PR A would have to hard-code a cadence guess and misclassify one
of the two ingest modes. Until the fields are observed live, the
rail-health helper treats missing cadence metadata as "unknown" and stays
in the 30s fallback posture (never guesses healthy).

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

**1.2 Demote the per-block blanket — keep a tip nudge for ACTION-GATING
roots only.** `LiveChainSync` keeps its WS `newHeads` subscription. When the
rail is healthy it stops blanket-invalidating the full ~19-root set every
12s; instead it invalidates only the roots that **gate money-moving actions
or render action-decisive detail state**, where foreign-block staleness could
mislead an imminent decision: the detail-page cluster (`loanLive`,
`loanLiveStatus`, `loanRisk`, `positionOwners`, `offer`/`loan` detail,
`offerLinkedLoan` — Codex #1224 r2: omitting these would leave
`PositionDetails` action gates showing stale roles/status after a foreign
repay/liquidation/claim-burn/transfer), the pending-card accept gates
(`loanSalePending`, `refinancePending`), `deskPreviewMatch` (crossability),
and the book ghost-strip (1.2a). These roots are mounted only on their
specific surfaces, so the tip-driven cost is bounded to the page actually
being viewed.

**Deliberately NOT in the tip subset — and why (Codex #1224 r2, both P1s):**

- **`claimables`.** Tip-nudging Claims re-runs the ~30-call per-candidate
  verification every 12s (~9,000 calls/hr) — worse than today and fatal to
  the quota goal. Claims instead ride events + net (1.5); the L182 guarantee
  ("a stale indexed row must not remain actionable") is enforced at
  *claim-time* by the chain verify and pre-flight regardless of list-refresh
  latency.
- **The list roots `myLoans`/`myOffers`.** *Mostly* navigational — but not
  entirely: `Positions.tsx` and the desk `OpenOrdersPanel` render direct
  `cancelOffer` (and desk amend) actions straight from `useMyOffersFull`
  rows without a detail-page gate in between (Codex #1224 r3). So list
  refresh for *foreign* events rides push (safe-finality,
  seconds-to-~40s) + focus + net — an accepted, documented latency
  trade-off — **with a row-action guard**: any money action fired directly
  from a push-finality list row (cancel/amend) performs a **blocking
  click-time preflight** (one live read / simulation of the exact call,
  fail-closed) *before* the wallet prompt. A row consumed by a counterparty
  during the push window then produces an inline "this offer was just
  filled" outcome at click, never a doomed signature. This is the same
  pre-sign posture the flows already carry, upgraded from advisory to
  blocking for exactly this row-action class; cost is one read per click,
  page- and action-bounded. Own actions stay within-a-block via the receipt
  rail (1.4). The spec's L351–356 outranking rule is about *which source
  wins* when the app reads — and every read still reads chain — not about
  mandating a block-cadence trigger.

Vault, approvals, keeper-config, token/rewards roots: phase 1 carries them
on **receipt + focus + net** honestly stated — the push contract today has
no key class for VPFI deposit/withdraw or reward events (they surface only
as `activity.appended`), so claiming "push" for these roots would be
vacuous (Codex #1224 r3). Where an *existing* key already corresponds to a
vault-balance change (loan settlement events moving escrow → `loan.updated`),
phase 1's KEY_MAP maps it onto `vaultAssets` too. A dedicated scoped
`vault.changed`/`rewards.changed` key (multi-device parity for VPFI and
reward mutations) joins phase 2.2's frame-context work; until then the
cross-device staleness bound for these self-owned roots is focus + 180s.
When the rail is **down**, `LiveChainSync` reverts to invalidating the
full set (today's behaviour) as the fallback rail.

  **1.2a Split the book ghost-strip into its own query.** The L357–361
  ghost-strip currently runs *inside* `useActiveOffers` after the indexed
  fetch, so there is no root to keep block-driven independently — leaving it
  in place either forces `activeOffers` to keep invalidating every 12s
  (preserving the cost) or stops re-running the strip (violating shared-book
  honesty) (Codex #1224). Refactor the strip into a separate lightweight
  `bookGhostStrip` query, block-driven and ≥12s-throttled, whose result is
  intersected with the indexer-served/push-refreshed `activeOffers` list.
  Two composition rules from r3 (Codex #1224 r3, incl. the P1):

  - **The intersection lives INSIDE the shared data hook, not at a render
    surface.** `useActiveOffers` is consumed by more than the Offer Book —
    `OfferFlow`, `Rent`, and `EarlyExitFlow` all select offers from it. The
    hook composes the two queries and returns only the stripped rows, so
    every consumer (present and future) gets the honest view; stripping at
    one render site would leave the other flows steering users into
    reverting accept/sale paths.
  - **The strip scans from the same pre-walk cursor snapshot the indexed
    walk used (P1).** Today `useActiveOffers` snapshots indexer freshness
    *before* paging `/offers/active`, precisely so an ingest landing
    mid-walk cannot advance the cursor past the terminal event of a stale
    row already collected. An independent `bookGhostStrip` query reading
    the cursor on its own re-opens that race — it could start from the
    newer cursor and skip exactly the dead offer it exists to remove. The
    hook therefore passes its pre-walk cursor snapshot into the strip query
    (part of its query key) as the scan start; the strip never re-reads
    cursor freshness independently.

  **Scan bound unchanged:** the strip keeps `filterTerminalOffers`'
  existing window — indexer cursor → `latest − CONFIRMATION_BUFFER`
  (`latest − 2`), NOT the safe head (Codex #1224 r2, P1): the dead-offer
  window that matters is precisely the latest-tip lag *before* safe
  finality, and `safe` can sit behind the indexer cursor (or freeze in CI).
  Keying it off a safe block would let just-ended offers stay selectable
  until finality — the exact violation the strip exists to prevent.

**1.3 Replace the 5s desk cooldown poll with an anchored clock (fail-closed).**
The `OpenOrdersPanel` 5s read is `deskChainNow` — a `block.timestamp` fetch
that gates the Cancel button until `createdAt + CANCEL_COOLDOWN_SECONDS`. No
`offer.changed` push fires merely because wall-clock crosses that threshold
(Codex #1224), so push+interval alone would leave Cancel disabled until the
180s net. Replacement, with two correctness guards from r2:

- **Anchor to chain time, not `Date.now()` alone.** One `getBlock` at panel
  mount captures `offset = chainNow − Date.now()`; the countdown runs on the
  offset-corrected local clock. A device clock running ahead must not enable
  Cancel early and hand the user a doomed `CancelCooldownActive` transaction
  (Codex #1224 r2) — so when the corrected countdown reaches zero, the
  button enables only after a **fail-closed one-shot chain-time confirm**
  (a single read, not a poll). Net cost: 1–2 reads per panel session instead
  of one per 5s.
- **Preserve BOTH contract bypasses.** `OfferCancelFacet.cancelOffer`
  enforces the cooldown only while `amountFilled == 0` AND the offer is
  unexpired — a partial-filled offer is immediately cancellable ("the
  lender already committed value through prior matches"), and an expired
  offer is too (Codex #1224 r2 + r4). The clock therefore mirrors both:
  unlock is immediate when the row shows any fill (`amountFilled > 0`,
  kept current by the `offer.changed` push that every partial match
  emits), else `min(createdAt + CANCEL_COOLDOWN_SECONDS, rowExpiresAt)`.
  Computing only the time bound would keep Cancel disabled on a
  partially-filled young offer the chain would happily cancel.

Actual fill/cancel state changes still arrive via the `offer.changed` push
nudge.

**1.4 Centralize own-receipt invalidation with a next-block retry — as an
ADDITIVE floor.** Add a standard post-receipt invalidation set (own
positions, claimables, vault, activity, book) to the shared `diamond.ts`
write hook so no future flow can forget it. **Additive, not a replacement**
(Codex #1224 r2): existing flows keep their surface-specific invalidations —
e.g. the desk flows' tape/candles/history/markets refreshes after a
match/fill — because collapsing to only the central set would leave those
surfaces stale until safe-finality push or the net. Critically, a *single*
invalidation right after `waitForTransactionReceipt` can refetch pre-tx
state from a public RPC that still serves the parent block (the existing
code already dodges some block invalidations for exactly this reason)
(Codex #1224). The centralized handler therefore schedules a **second
re-invalidation**, with a per-transport block source (Codex #1224 r2):

- **WS deploys:** on the next observed `newHeads` block after the receipt.
- **HTTP-only deploys** (no block subscription): a one-shot delayed re-read
  (~2× block time after the receipt), or a read pinned at the receipt's
  `blockNumber`, or the known read-after-write cache patch (as the
  VPFI/keeper toggles already do). Without this, a lagging public RPC could
  leave a just-confirmed own action stale until the restored 30s interval —
  breaking the very contract this rail carries.

This is the rail that carries the L55–56 "within a block" contract once
timers are gone. Three scope rules keep that contract honest (Codex #1224
r4, incl. the P1):

- **It covers ALL write helpers, not only Diamond calls.** ERC20
  approve/revoke (and Permit2 setup) go through the token helpers, not
  `diamond.ts`; §1.2 removes `standingApprovals` from the block-driven set,
  so those helpers join the same centralized receipt path and invalidate
  the approval/funding-watch roots — otherwise an approval granted in this
  very tab could stay stale until focus/net.
- **Same wallet, another tab of this origin:** the receipt rail is
  broadcast. The centralized handler publishes each confirmed-receipt
  invalidation set on a `BroadcastChannel` (falling back to a
  `localStorage` ping), so every open tab of the app applies the same
  invalidation the acting tab does — no extra RPC, and a submit/cancel
  from a second tab still lands "within a block" in this one.
- **Same wallet, another device (or a wallet path outside the app):** no
  receipt is observable here by construction. The L55–56 contract is
  **per-surface** — the acting device's tab satisfies it locally via its
  own receipt rail; a *watching* device sees the change at push latency
  (seconds-to-~40s) or immediately on tab return (1.1 focus refetch),
  which is the same bound the design documents for foreign events on list
  roots. If the owner judges that window unacceptable for own-position
  lists specifically, the documented fallback knob is re-adding the two
  own-position list roots to the 1.2 tip subset (a measured, bounded cost
  increase) — a decision for the PR A live review, not a silent default.

**1.5 Claims cadence (chain reads stay) — decoupled from `myLoans` refresh
identity.** Per the owner directive and L176–183, the #988 verification
contract is untouched: candidates from the indexed+chain union, and the
**full existing per-candidate probe set** on chain — `ownerOf` +
`getClaimable` **+ `getBorrowerLifRebate` where the borrower side applies**
(Codex #1224 r4: a borrower row whose only payout is the Phase-5 VPFI
rebate is actionable purely through the rebate getter — `claimables.ts`
already probes it, and a re-key/memoization implemented from a shorthand
"ownerOf + getClaimable" description would silently drop rebate-only
claims); revert = not claimable, transport failure = unavailable (never a
confident short list). What changes
is *when* it runs: own-receipt (1.4), `loan.updated`/`ownership.changed`
push nudge, explicit focus (1.1), 180s net — **never the tip nudge** (1.2).
One coupling must be cut for that to hold (Codex #1224 r2, P1):
`useMyClaimables` currently keys its query on `loans.dataUpdatedAt`, so ANY
`myLoans` refetch re-runs the whole verification even when nothing changed.
Re-key it on a **content hash of the candidate set**, where each entry
hashes `(loanId, status, role, entitlement-relevant amounts)` — not
loanId+status alone (Codex #1224 r3, two findings):

- **Role is part of candidate identity.** The probe is role-specific
  (`getClaimable(loanId, isLender)` against the role's position token), so
  a wallet whose side of the same terminal loan flips through position-NFT
  transfers changes the candidate without changing loanId or status; a
  role-blind hash would keep verifying the stale side and miss the new one
  until an unrelated invalidation.
- **Entitlement can change without a status transition.** Not every new
  claimable is born from a terminal repay/default/liquidation: a partial
  internal-match rescue of a `FallbackPending` loan parks `heldForLender`
  while the status stays `fallback_pending`. Including the
  entitlement-relevant amounts the row already carries in the hash makes
  such a change re-verify; and the indexer must emit its push nudge
  (`loan.updated`) for entitlement-mutating events too, not only for
  status transitions — PR 0's push-completeness checklist verifies the
  rescue-path events are in that set.

A `myLoans` refresh that returns identical candidates does not re-verify; a
changed set (id, status, role, or entitlement) does. Claim discovery
latency is push latency, and actionability at click-time is still
chain-decided.

**1.6 Push-storm throttle — leading AND trailing.** Coarse keys mean a busy
chain could nudge `myLoans` on every ingest scan. Add a per-root minimum
re-fetch gap (~15s, same shape as `LiveChainSync`'s `MIN_INVALIDATE_MS`)
inside the push dispatcher. It must be **leading + trailing**: a
leading-only gap would fetch the first frame's D1 state and silently drop a
second frame landing inside the window, leaving `myLoans`/`claimables` stale
until focus/180s (Codex #1224). Queue a trailing invalidation at the end of
the gap whenever ≥1 frame arrived during it, so the last event is always read.

**Expected effect.** Recurring per-tab load drops sharply. The honest floor
is set by the biggest *remaining* chain-read surface, **Claims**: ~10
candidates × 3–4 reads (the borrower rebate getter adds one where it
applies) ≈ 30–40 `eth_call`s per verification. With Claims OFF the
tip nudge and re-keyed on candidate-set identity (1.5), a quiet Claims tab
runs the full verification only on the 180s net (~20/hr → ~600 calls/hr
worst-case ceiling, far less when the set hash is unchanged and probes are
skipped) — versus ~9,000/hr had it stayed tip-nudged (Codex #1224 r2). Net
picture:

- **Positions/Claims open (list surfaces):** ~2,000–6,000/hr →
  **~100–600/hr** (own-positions batch on events+net; Claims net-ceiling as
  above; short event/focus bursts), with candidate memoization (2.3) cutting
  the Claims ceiling further.
- **A detail page (PositionDetails) actively open:** its action-gate cluster
  stays tip-nudged (~12s) — a few calls per tick, bounded to that one loan
  and only while the page is open; comparable to today for that surface,
  by design (money-action gates keep tip parity).
- **Desk open:** ~2,000–4,000/hr → **low hundreds/hr** (5s poll → 1–2
  one-shots per session; ranked-book on push + net; previewMatch tip-nudged
  only while the band renders).
- **Offer book open:** ~500–1,500/hr → **low hundreds/hr** (ghost-strip
  block-driven at its existing `latest−2` bound but decoupled;
  `activeOffers` push-driven).

So a **~5–15× cut** on the list/browse surfaces that dominate real usage,
with the tip-parity cost consciously concentrated on the action-gating
surfaces while they are open. Latency: own-tx stays within-a-block
(receipt rail); action gates and the shared book stay at tip parity (~12s);
market/history improves to push latency; **list-row freshness for foreign
events moves to push latency (seconds-to-~40s) — the one accepted trade-off,
documented in 1.2.**

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

**2.2 Scoped push hints — with CAUSATIVE context, not an unknown-id
wildcard.** Frames today carry only coarse keys, so every tab refetches
own-position roots on any loan event. The Durable Object already holds the
decoded events server-side; extend frames with the affected
`offerIds`/`loanIds` **plus the causative linkage** (bounded list, no new
authority — still just a hint per L65–66): for `loan.created`, the consumed
`offerId` (and, where cheap, the party addresses the event already carries).
Relevance rule on the client: refetch when (a) an affected id is already one
of the wallet's rows, OR (b) the causative `offerId` is one of the wallet's
offers / a party address equals the wallet — that is what distinguishes
"counterparty accepted MY offer" (new `loanId`, unknown, but causatively
mine) from "foreign new loan". A bare `unknown id ⇒ refetch` rule would make
every global create relevant to every tab and defeat the scoping goal
entirely (Codex #1224 r2, both passes flagged this). **Bounded means
truncation-honest (Codex #1224 r3):** the id list is capped, so a busy
scan touching more loans/offers than the cap could omit exactly the id an
affected wallet needed — silently skipping its refetch until focus/180s.
Every frame whose affected-id list is incomplete therefore carries a
`truncated: true` marker, and clients treat a truncated frame as a coarse
key (the throttled 1.6 behaviour): scoping only ever *narrows* work when
the hint is complete, never suppresses a refetch when it is not. Frames
lacking context entirely (older worker version) fall back the same way —
degraded, never wrong.

**2.3 Claimable-candidate hint — new route, ADDITIVE only, never an
intersection.** The existing `GET /claimables/:address` is still consumed by
`apps/defi` (`indexerClient.ts`, typed `{asLender, asBorrower}`); changing
its shape would silently break that consumer (Codex #1224). Add a separate
`GET /claim-candidates/:address` (or a versioned response). **How it may and
may not narrow (Codex #1224 r2):** it must never *suppress* a
chain-enumerated candidate — a fresh position-NFT transfer or a pure
secondary-market holder can be absent from D1 until ingest safe-finalizes,
and the spec requires the current holder's claim to stay discoverable from
chain (L179–180). The route may **prioritize** verification order and
**add** candidates. The actual probe reduction comes from **memoized
verdicts**: cache each candidate's last verdict keyed on
`(loanId, status, role, entitlement-relevant amounts, owner-relevant
block)` — the same identity fields as the 1.5 candidate hash — and skip
re-probing candidates
whose key is unchanged since the last verification; the chain-enumerated set
is always probed on first load and re-probed whenever its key changes.
Chain-decided actionability (L177–178) is untouched. Given the corrected
Claims ceiling, this remains the highest-value phase-2 item.

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
| `bookCatchUp` ghost-strip `eth_getLogs` | L357–361 | Block-driven, composed inside the shared `useActiveOffers` hook so ALL its consumers (book, OfferFlow, Rent, EarlyExit) get the stripped view (§4.1.2a — not book-page-only) |
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
  second wallet accept/cancel against the first, and verify **each root class
  against its own contract** (Codex #1224 r3 — the earlier blanket "~12s"
  wording contradicted 1.2's deliberate list-root exclusion): with the first
  tab ON the affected position's detail page, the action-gate roots
  (`loanLiveStatus`, `positionOwners`, accept gates) refresh at **tip parity
  (~12s, via the 1.2 tip nudge)**; the `myLoans`/`myOffers` **list rows**
  refresh via the **push path (seconds-to-~40s)** — asserting ~12s there
  would pressure PR A to re-add the list roots to the tip nudge; and a
  hidden→focused tab refreshes immediately (1.1 explicit focus). Also
  confirm the 1.2 row-action guard: clicking Cancel on a just-consumed
  offer row surfaces the inline preflight failure, not a wallet prompt,
  (c) transfer a position NFT between the two
  wallets and confirm My positions updates **via the push frame itself** —
  run this check with the tip nudge disabled or on an HTTP-only rail, or
  assert an `ownership.changed` frame arrives and dirties the intended
  roots; otherwise the tip nudge can mask a missing ownership key and the
  prerequisite passes vacuously (Codex #1224 r2), (d) kill the WS (block the endpoint) and confirm the 30s
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

1. **PR 0 (phase 0 — prerequisite, ships first):** the indexer-side
   prerequisites — the ownership-transfer invalidation key (0.1) in the
   indexer + `KEY_MAP`, the audit that `loan.updated` fires for
   entitlement-mutating non-terminal events (the 1.5 rescue-path class),
   the `loan.updated → vaultAssets` mapping (1.2), **and the cadence/
   cursor-age metadata fields in the DO `hello`/periodic frames +
   `/offers/stats`** (1.1 — server-side, so they cannot ship inside the
   app-only PR A; Codex #1224 r4) — landed and observed on the live WS
   rail *before* PR A removes the blanket that masks any absence. (The
   cooldown-clock change 0.2 ships with PR A since it's app-side.)
2. **PR A (phase 1):** rail-health helper (cadence-derived cursor-freshness
   gate) + `LiveChainSync` demotion-with-tip-nudge + book-ghost-strip split
   (shared-hook intersection, pre-walk cursor snapshot) + row-action
   blocking preflight for list-row cancel/amend + OpenOrders local cooldown
   clock + centralized receipt invalidation with next-block retry
   (covering the token-approval helpers, broadcast cross-tab) +
   leading/trailing throttle + explicit focus refetch + Claims content-hash
   re-key (role + entitlement fields, full probe set incl. the borrower
   rebate getter). One release behind a
   `VITE_FRESHNESS_TIMERS=legacy` escape hatch, removed after the live
   review passes.
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
