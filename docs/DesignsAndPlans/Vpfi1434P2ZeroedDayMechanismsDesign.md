# #1434 P2 — Zeroed-day lapse MECHANISMS — design record

| | |
| --- | --- |
| **Status** | Draft for review — the mechanism half of P2. The *constraints* half is `Vpfi1222B2dDeliveredBackingDesign.md` §2h (R1–R6, ratified 2026-08-06 via #1571; both gate decisions ratified 2026-08-07 via #1586 `181191e87`) and is **not restated here** — where this document names a constraint number it defers to §2h's text. |
| **Owns** | The buildable mechanism per §2h open item: the wire evolution (constraints 12/12a/12b/12c + R5), R1a/R1c/R1d, the conversion's authenticated input, R2a's narrowed terminal, R4's concrete accounting, R6's gate state + clearing evidence (R6a/R6b/R6d/R6e), the residual, and the two parameters. |
| **Cards** | #1434 (P2 + R4 + halt lift retry). The shared return channel is **#1568's slice** (§3.6a ownership note); this document only *consumes* it. |
| **Verified against** | `main` @ `181191e87` — every file:line below was read at that commit (scout pass 2026-08-07). |

Reading order for an implementer: §2h for what must hold, this document for
how, `VpfiCrossChainRecyclingDesign.md` §3.6a for the transport layering and
Mode-A/Mode-B split.

---

## 1. The wire: one new broadcast KIND, one remit field, one mirror→Base quote

Constraint 12 fixes the routing: day-finalization facts ride the broadcast,
dispatch facts ride the remit, and R4's return is its own path. What P2 adds
to each:

### 1.1 `MSG_TYPE_BROADCAST_V3` — a NEW kind, not a widened kind-5

`RewardBroadcastV2` is a 14-field all-static struct with **no version field
inside it** (`interfaces/IRewardMessenger.sol:10-25`); the messenger gates
kind-5 on an exact 15-word length (`VaipakamRewardMessenger.sol:255,
1303-1305`). Widening the struct in place is therefore the head-offset-ladder
failure in tag form: an old in-flight packet cannot self-identify against a
widened decoder. Per the B2-d5 rule (`RemitWire.sol:50-51`), P2's fields ride
a **new kind** — `MSG_TYPE_BROADCAST_V3` (next free constant; kind byte in
the leading word exactly as today), whose struct = V2's fields **plus**:

- `finalizedAt` (`uint64`) — Base's `block.timestamp` at
  `_finalizeAndWrite`, **frozen in new per-day storage at finalization**
  (`dayFinalizedAt[dayId]`), never read live at send.
  *(w1 implementation note: the four frozen scalars — `finalizedAt`,
  `scheduleVersion` and the two inline parameters — live packed in one
  per-day slot, `dayLapseClock[dayId]`, on both sides; the doc's
  per-fact names below map onto its fields.)*
- `lapseScheduleVersion` (`uint32`) — the version of the lapse-window /
  cutoff-gap parameter set under which this day's clocks are evaluated,
  **frozen per day at finalization** (`dayLapseScheduleVersion[dayId]`).
- `zeroedForDest` (`bool`, per-destination) — the R1 zeroed marker: true iff
  `chainDayCommitments[dayId][dest].remitIneligible` was set at finalization
  (`RewardAggregatorFacet.sol:561-570`). Per-destination like the existing
  `_perDestFields` halves; a mirror stores it as
  `dayDeliberatelyZeroed[dayId]`.
- `baseDeployment` (`address`) — the sending deployment's own identity,
  `address(this)`, exactly as the d5 remit wire already carries it
  (`RewardRemittanceFacet.sol:604-611`) and as §2h constraint 20 requires of
  the broadcast evolution (Codex #1600 r1 P1: without it, a delayed
  broadcast from a retired Base deployment could install its zeroed marker,
  clock and schedule into the new era, and that stale marker could then
  combine with a new-era compensation to lapse or price the day wrongly).
  The mirror stores it beside the clock (`dayClockEra[dayId]`); the
  compensation ingress (§2.2) accepts a compensation for a day only from
  the remitter matching the day's recorded era, and a V3 packet whose
  `baseDeployment` differs from an already-recorded era for that day is
  rejected. *(w1 strengthening, Codex #1632 r1 P1: the recorded-era check
  alone cannot defend a day's FIRST install — nothing is recorded yet,
  and the CCIP lane authenticates the shared remote messenger, not the
  Diamond generation behind it, so a retired deployment's in-flight
  packet would win the race after a rotation. The mirror therefore holds
  an explicit ADMIN-set ground truth, `baseRewardDeployment`, that every
  V3 packet must name; while unset the V3 ingress is dark (fail-closed,
  packets stay re-executable), and rotation belongs to the same ceremony
  that rotates the Base deployment. Second strengthening, #1632 r2: the
  identity-less LEGACY wires are the remaining cross-era channel — a
  retired era's kind-5 landing around a rotation could create applied
  state a new-era V3 would then backfill its clock onto. So an armed
  mirror stamps era PROVENANCE (`dayClockEra`) on every legacy apply,
  and a true era rotation — a second, different nonzero ground truth —
  permanently retires the legacy wires' fresh applies
  (`LegacyBroadcastRetired`; replays stay idempotent). Arming ships in
  the standard `ConfigureRewardReporter` spell + deploy wrappers (the
  mainnet wrapper enforces it on the transaction-producing configure
  phase itself, #1632 r3); the rotation ceremony is recorded in
  CcipCutoverRunbook §8. Third strengthening, #1632 r3: a rotated
  mirror also refuses V3 clock facts for days with prior state but
  UNKNOWN era (applied before arming — the pre-arming inventory), which
  the ceremony therefore heals BEFORE rotating; and the heal's standing
  predicate includes the frozen `dayZeroedForDest` marker, so
  reconciliation clearing the live flag never strands a zeroed
  destination's heal.)*

**Why frozen-at-finalization is load-bearing (R2a).** A re-broadcast today
is NOT byte-identical by construction — `broadcastGlobal` reads everything
live, and two sends of the same finalized day can differ in `armedFromDay`
(flips 0→D* after arming, `RewardAggregatorFacet.sol:1522`), in a
destination's inclusion (`backfillDayInclusion`, `:1770-1786`), and in the
destination set itself. The three V3 fields are written **once** inside
`_finalizeAndWrite` and only read back at send, so every re-broadcast
carries identical clock/version/zeroed facts by construction. The mirror's
replay-divergence check (`RewardReporterFacet.sol:524-549`) extends to the
three new fields; `armedFromDay` stays outside that comparison, as today
(its install is first-apply-only, `:597-599`).

**Backfill on an already-applied day — the 12b activation gate.** The V2
apply path early-returns on `broadcastV2Applied[dayId]` after the divergence
check. The V3 apply path adds one branch: an already-applied day whose
`dayFinalizedAt` is **unset on the mirror** accepts a V3 packet as a
**clock backfill** — it verifies day identity, `destChainId`, deployment
era, and the **immutable pair only** (the two globals), then writes only
the V3 fields. It deliberately does NOT compare the halves or inclusion-
derived fields (Codex #1600 r1 P2: `backfillDayInclusion` legitimately
mutates a destination's halves after the first send, so a full V2-field
comparison would make the one supported migration sequence unhealable), and
it never re-applies halves — adding the clock is the branch's only write.
So:

- A day applied via kind-5 before the upgrade has no clock. It is **not
  lapse-eligible and not priceable as a zeroed day** (both machines gate on
  `dayFinalizedAt[d] != 0` — see §3 and §2.4). Anyone can heal it by calling
  the permissionless `broadcastGlobal(dayId)` again, which now emits V3 and
  backfills the clock. This is the inventory/backfill 12b requires, and it
  needs no operator: the gate is per-day and self-healing.
- **The heal must stay targetable after a destination-set change** (Codex
  #1600 r1 P1): `broadcastGlobal` enumerates the messenger's *current*
  `broadcastDestinationChainIds`, so a mirror removed from that set after
  its kind-5 apply could never receive its V3 backfill. The design adds the
  single-destination form `broadcastGlobalTo(dayId, destChainId)` —
  permissionless, same payload assembly, admitted when the destination has
  day-scoped historical standing (`chainDailyIncluded[dayId][dest]` or a
  `chainDayCommitments[dayId][dest]` record) even if it is absent from the
  current destination list. Boundary stated plainly: if the LANE itself
  (channel peer / messenger config) has been torn down, nothing can deliver
  to that chain — that is an operator decommissioning decision whose
  consequences include unhealed clocks, the same class as Base-unreachable
  in §3.
- An old in-flight kind-5 after the upgrade still decodes (the kind-5 branch
  is kept, unchanged) and applies without a clock — healed the same way.
  Nothing is rejected, so nothing wedges (12b's "reject → halt forever"
  horn never opens).
- The **halt-lift ordering** makes this safe globally: `_dayPoolHalves`
  halts every armed mirror day today (`LibInteractionRewards.sol:966`), and
  P1-b lifts it only after P2 ships, so no armed day is priced or retired
  anywhere before the clock machinery exists. There is no pre-V3 armed-day
  damage to migrate — the gate only has to hold going forward.

### 1.2 R5 — the versioned lapse schedule (copy the tier-table pattern)

The only authenticated versioned-config channel today is the tier table:
`MSG_TYPE_VERSION_BUMPED` applies a **monotonic max** on the mirror
(`MirrorTierReceiverFacet.sol:149-160`) and the authoritative version also
rides inline on every kind-3 packet so a lost bump self-heals. The lapse
schedule copies both halves:

- Base stores the parameter set `(lapseWindowSeconds, dispatchCutoffGap)`
  under `lapseScheduleVersion`, bumped by an ADMIN setter that **bounds both
  values** (see §7) and never edits a version in place — a change is a new
  version. Old versions stay readable: a finalized day prices its clocks
  under `dayLapseScheduleVersion[d]` forever (a later parameter change
  cannot retroactively move an already-finalized day's expiry — the R5
  race).
- Every V3 broadcast carries the day's frozen version inline (§1.1); a
  standalone bump message is **not needed** on the broadcast path, because a
  mirror never needs a version it has not received a day under. The mirror
  stores the version→parameters table from a small `LAPSE_SCHEDULE` payload
  appended to the same V3 packet the first time each version appears
  (implementation may inline the two bounded values per packet instead of a
  side table — 2 words, simpler, no first-appearance tracking; the
  implementer picks, the requirement is only that the day's *applicable
  parameters* are mirror-known from authenticated Base data). *(w1 took
  the inline option: the two bounded values ride every V3 packet and are
  frozen per day in `dayLapseClock[dayId]`; there is no mirror-side
  version table. `MSG_TYPE_BROADCAST_V3` landed as kind 10 — kinds 8/9
  were taken by the #1568 repatriation wire.)*

> *(w2 implementation notes: `REMIT_WIRE_TAG_P2` landed as specified —
> single-day, per-side amounts, frozen `finalizedAt` + schedule version
> inline; fresh-only (no `recycledShare` field). The §2.2 classification
> is ERA-FIRST: with `broadcastV2Applied && dayClockEra != 0` the known-
> state ladder runs (era match → zeroed → not lapsed → credit; any
> failure quarantines with a reason code); otherwise the provisional
> branch. The provisional confirm/demote hook rides every ACCEPTED V3
> broadcast. §4.1's reservation landed as `strandedRecoveryReserved` +
> receipt-keyed `strandedRecoveries` records; the `backingPosition`
> natspec rule was narrowed to "no balance-OWNER subtractions" since the
> reservation is a protocol LEDGER like the bucket. The R3 dispatch
> cutoff shipped IN w2 after review (#1634 r3): the ingress evaluates
> expiry from the frozen words already, so a late dispatch could arrive
> quarantined after Base closed the day — the cutoff and the evaluation
> must travel together. Clockless days refuse dispatch outright (r2);
> all four clock words ride the wire (r1).)*

### 1.3 R4b — the applicable expiry rides the remit too

Constraint 12c is already ratified: a compensation must be classifiable at
ingress while the mirror is still unstamped, so the remit payload for a
manual compensation carries the bound day's `finalizedAt` and
`lapseScheduleVersion`. Both sides derive the same expiry from the same
frozen values, so the duplication cannot diverge. Wire shape: this is a new
**remit** tag (the d5 keccak-sentinel pattern, `RemitWire.sol:58-59`), NOT a
second broadcast change — `REMIT_WIRE_TAG_P2`, adding the two fields (and
the compensation marker, §2.2) after d5's. Constraint 15 already binds a
compensation to exactly one day, so one expiry per payload is unambiguous.

### 1.4 The conversion quote — the fourth wire path, mirror→Base

§2h's conversion item: compensation sizing must not use uncapped local
interest, §2b forbids the report for the zeroed-chain case, and §2c's
supremum lives per-entry **on the mirror**. So the authenticated input
originates on the mirror: a new mirror→Base message kind,
`MSG_TYPE_COMP_QUOTE`, sent by a permissionless mirror function:

```
quoteZeroedDayCompensation(dayId)
  requires dayDeliberatelyZeroed[dayId]        (V3 marker, §1.1)
  requires chainReportSentAt[dayId] != 0        (R1d, §2.3)
  requires day not lapsed and not already quoted-and-funded
  computes perSide = Σ over local entries of min(perDay_e × Δq_side, C_side)
  sends (dayId, quotedLender, quotedBorrower) via the reward channel
```

**The quote's delta is defined constructively — it is the counterfactual
fair-share delta, not the day's frozen Δ_d** (Codex #1600 r1 P1: the frozen
Δ_d uses the zeroed chain's excluded denominator and is zero on the
constraint-17 side, and an earlier §1.5 wording derived the delta from the
quote — circular). For side *s*:

```
Δq_s = halfPool_s(d) × 1e18 / (G_s + L_s)
```

where `halfPool_s(d)` is the day's **finalize-snapshotted funded half** —
the `dayPoolStamp[dayId].scheduleFloor / 2` value the broadcast already
carries as its floor-half field (`RewardAggregatorFacet.sol:1547`), i.e.
`min(schedule, fresh available)` as frozen at finalization — NOT the raw
schedule `halfPoolForDay` (Codex #1600 r2 P1: near 69M exhaustion the
schedule half overstates what finalization actually funded, producing a
standing quote the cap guard makes unfillable and forcing an avoidable
short-compensated lapse). `G_s` is the frozen global denominator the V3
broadcast already carries (`globalLenderNumeraire18` / `...Borrower...` —
the finalized total that EXCLUDES this chain), and `L_s` is the mirror's
own folded per-side total for the day
(`total{Lender,Borrower}InterestNumeraire18[d]`, valid because R1d's gate
ran). This is exactly the share the chain would have priced at had its
report been included, computed entirely from authenticated broadcast data
plus mirror-local state — no circularity, and `L_s == 0` yields a zero
quote for that side, which is the genuinely-zero case (§2.3).

**The per-entry sum is a BATCHED, checkpointed accumulator — never one
unbounded scan** (Codex #1600 r2 P1: the ledger has no per-day entry index,
and a busy day's linear scan can exceed the block gas limit, making the
quote — and with it compensation — unreachable; `LibCommitmentReport.
accumulateBatch` is the in-tree precedent, keeper-fed bounded batches with
a conservation check). `quoteZeroedDayCompensation` is therefore the
FINALIZE step of a permissionless batched accumulation: anyone advances the
day's quote cursor in bounded batches; the quote dispatches when the cursor
completes. §5.2's lapse-time fallback NEVER scans inline — see the
re-statement there.

**A resolved-zero day is terminal on the MIRROR at quote time** (Codex
#1600 r2 P1: clearing `remitIneligible` on Base changes no mirror-local
flag, so §2.1's gate would suppress the day forever). Both sides zero after
fold is mirror-local knowledge, so the zero-quote path sets
`dayResolvedZero[dayId]` locally before dispatching the zero quote; §2.1's
gate excludes resolved-zero days, and such a day prices zero through the
ordinary walk — correctly, since `L_s == 0` means no entry accrued on that
side that day. The Base-side `remitIneligible` clearing rides the quote
exactly as stated below.

On Base it lands as evidence, not as funding: `onCompQuoteReceived` stores
`compQuote[dayId][chain] = (lender, borrower, receivedAt)` after checking
`dailyGlobalFinalized[dayId]` and `remitIneligible[dayId][chain]`. The
**funding step stays the operator's** (`remitManualBudget`, ADMIN — it
spends real value under the 69M cap), but becomes **evidence-bounded**:
`amount <= quotedLender + quotedBorrower` for a quoted day, and the payload
carries the per-side split from the quote. The quote is re-sendable (same
idempotent shape as day reports); a changed re-quote before funding
overwrites, and after funding is rejected — the funded amount was bounded by
the quote that stood at dispatch, which is the receipt-bound obligation R1c
tops up against (§2.5).

Constraint 12's floor note said the count settles when this input does: it
lands as a message, so P2 has **four** wire paths (broadcast V3, remit tag
P2, R4 fresh-return, comp quote), each its own versioned shape.

### 1.5 The repricing vehicle — a compensated day prices by its OWN denominator

Constraint 17's case is concrete in the tree: when the excluded mirror
supplied a side's only interest, `knownGlobal*InterestNumeraire18[d] == 0`
on that side and Δ_d's division guard returns zero
(`LibInteractionRewards.sol:1048, 3659`) — rewriting the funding stamp
cannot make the day payable through the ordinary walk. The vehicle: a
compensated day does not go through Δ_d at all. The mirror prices it
**locally, with Δq itself as the pricing delta** (Codex #1600 r2 P1: an
earlier wording priced at `fundedSideHalf / L_s`, which UNDERPAYS whenever
any per-entry cap binds — cap binding makes `Q < L_s × Δq`, so the uniform
smaller RPN cuts every entry below its counterfactual and strands a
residual even on a fully funded day). The walk prices a compensated day at
`compensatedDailyRpn = Δq_s` — recomputed from the same frozen inputs §1.4
defines, so both sides derive it identically — with the per-entry §2c caps
applied unchanged, and the **funded amount serves only as the backing /
deferral ceiling**: when the funded pool cannot cover the next entry's
priced amount, the day defers (§2g's rule — never trim), and a fully
funded day pays out exactly `Q = Σ min(perDay_e × Δq_s, C_side)` by
construction. The walk recognises a compensated day by a mirror-local
stamp written at compensation ingress (`dayCompensated[dayId] =
receiptKey`) and prices it from the compensated pool instead of the
broadcast halves.

> *(w3 implementation notes — three recorded deviations, each toward the
> stricter shape. (1) **No second marker**: the walk recognises a
> compensated day by w2's own record (`dayCompensation[d].compensated &&
> !provisional`), not a separate `dayCompensated` stamp — one fact, one
> flag. (2) **The deferral ceiling moved from per-entry to the day
> CROSSING**: scouting found the cumulative cursor exposes a crossed day
> to TWO payment paths — the per-day walk AND the entry path's bulk
> window pricing of spanning entries (`_entryWindowSplitFrom`), which a
> walk-level per-entry bound cannot protect. So the §2.1 ladder's
> compensated arm crosses only when the side's delivered pool covers the
> side's own quoted sum (`compQuoteAccum18`, complete by the dispatch
> conservation proof) — keyed on the AMOUNT present per the standing
> B2-d4 constraint — and an underfunded day defers WHOLE (§2g's
> never-trim holds; per-entry ceilings are vacuous on a crossed day by
> construction). Under-quote partial funding therefore waits for w4's
> supplemental remit or short-lapse terminal (the w2 manual remit is
> once-per-day). (3) **Resolved-zero is a ladder arm, not "ordinary
> walk"**: pre-P1-b the ordinary walk IS the blanket mirror halt, so the
> ladder returns the zero-delta crossing itself. The ladder landed as ONE
> shared per-day derivation (`_dayDeltas`) consumed by both cumulative
> folds, the commitment twin (a governed-open day is NOT priceable — a
> zero report for a later-compensated day would under-commit), and the
> walk's own decomposition; Δq itself is the one shared
> `LibInteractionRewards.compQuoteDelta` the quote accumulator also
> reads, so quoted figure and priced figure cannot diverge. A compensated
> day's Δq stays in `cumMinArmed*` so the window split classifies it
> armed-fresh — matching w2's counting of the credit into
> `rewardBudgetArmedFreshReceived` — and carries zero recycled component.
> `MSG_TYPE_COMP_QUOTE` landed as kind 11; Base ingress admits a
> re-delivery refresh only while the day is unfunded, and a `(0,0)` quote
> clears `remitIneligible` (nothing to compensate) while bounding funding
> to zero. `remitManualBudget` enforces the §2.5 PER-SIDE bound, stricter
> than the aggregate wording here.
>
> Review round 1 (#1636) added four more deviations, all accepted: (4)
> **Δq's numerator is `dayPoolStamp[d].scheduleFloor / 2`** exactly as
> §1.4 above prescribes — the first implementation wrongly read the
> chain's own `chainDayRecycledFunding` slice, which `_perDestFields`
> stamps ZERO for a zeroed destination, so it would have quoted (0,0)
> and resolved a demand-carrying day; the quote surface now also REFUSES
> an unstamped day. (5) **The quote is UNCAPPED** (`Σ perDay × Δq`, no
> `C_side` min): forfeit settlement prices without the per-user ceiling
> by design (#1353), and bulk window pricing skips the per-(user,day)
> ceiling, so a capped quote would open the funding gate below the real
> settlement liability; caps still apply at payment time per path. (6)
> An ADMIN **reset valve** (`resetCompQuoteAccumulation`) mirrors the
> commitment accumulator's — the permissionless accumulator's cursor can
> be parked past the covering set by a single high-id submission. (7)
> The wire carries the **sending diamond as an era word** (stamped by
> the messenger) and Base BINDS the standing quote to it: same-era
> re-delivery refreshes, divergence reverts, ADMIN `clearCompQuote`
> releases a stale binding after a mirror redeploy (funded days refuse
> both). The `_contribFor` global-zero short-circuit was removed — the
> stored cumulative row is the one pricing truth for walk and bulk
> alike.
>
> Round 2 added two more: (8) **the V3 broadcast carries the day-level
> funded pool halves** (2 new wire words, 21 → 23): the V2 wire never
> transported the day-level figure (only per-chain slices, zero for a
> zeroed dest) and the legacy kind-2 ingress that installed
> `dayPoolStamp` retires at rotation — without the transport, mirror-side
> quoting was unreachable on the V3 production path. The V3 apply
> installs the stamp (divergence-checked against any standing one, the
> broadcast consensus family), including on replays, so pre-r2 V3 days
> heal by the same permissionless re-send that backfills clocks. (9)
> **Base holds a FAIL-CLOSED mirror-era registry**
> (`setMirrorRewardDeployment`, the reciprocal of the mirror-side
> `setBaseRewardDeployment`): the quote ingress authenticates EVERY
> arrival — including the first — against it, closing the
> first-arrival window the r1 standing-quote binding alone could not
> defend (a delayed retired-era wire arriving first would have bound
> unchallenged, and a stale (0,0) would have cleared the
> manual-funding anchor permanently). Rotation ceremony: update the
> registry, then `clearCompQuote` any quote standing under the retired
> era.)*

---

## 2. R1 — the zeroed day: suppression, classification, ingress, top-up

### 2.1 Suppression (R1, main body — restated only to anchor the gate)

A mirror must not price a deliberately-zeroed day through the ordinary walk
**while a compensation is still possible**. Gate: `dayDeliberatelyZeroed[d]
&& !dayCompensated[d] && !dayLapsed[d] && !dayResolvedZero[d]` makes
`_dayPoolHalves` return the **defer** shape for that day (halt=true today
is the blanket mirror halt; after P1-b the per-day form replaces it for
zeroed days only). The lapsed conjunct is load-bearing (Codex #1600 r1 P1:
without it the halt outlives the lapse — `lapseZeroedDay` sets neither of
the first two flags, so the "terminal" would leave the day deferring
forever and block every later day's claims behind the stuck cursor), and
so is the resolved-zero one (r2 P1 — §1.4's mirror-local terminal for a
genuinely-zero day). **Pricing precedence across the day states** (r2 P1:
the two lapse outcomes must not share one flag): `dayShortLapsed` →
truncate-at-remaining (pay from the remaining compensated pool, then
zero); `dayLapsed` → `(0, 0, halt=false)` (retire at zero); resolved-zero
→ ordinary walk (prices zero naturally); compensated-and-open → §1.5's
Δq pricing with deferral; zeroed-and-open → defer.
**After the lapse, the day prices as zero through the ordinary machinery**:
`_dayPoolHalves` returns `(0, 0, halt=false)` for a lapsed day, the
`rawPay == 0` terminal-progress path (`:4353-4358` + `_persistDay` `:1456`)
retires its entries at zero, and the cursor advances — which is exactly what
"lapsed" means, with the loss already recorded by §5.2 at the moment of
lapse. Deferral — not terminal — while the gate holds, because
`advanceCumLenderThrough`'s `if (halt) break;`
(`LibInteractionRewards.sol:1042-1044`) leaves the cursor before the day,
the "waits, re-attempted next call" behaviour the standing rule requires.
The entries-retired-for-zero mechanism P2 exists to prevent is closed at
the pricing gate for exactly as long as payment is still possible, and
deliberately reopened by the lapse terminal — retiring at zero is then the
intended outcome, not the bug.

### 2.2 R1a — ingress classifiability + token-safe rejection

A compensation arrives on the remit path carrying the P2 tag (§1.3): the
bound day, its expiry inputs, and a **compensation marker** (the tag itself
plus the single-day payload shape). Ingress (`onRewardBudgetReceived`,
`RewardRemittanceFacet.sol:829+`) classifies:

- day **stamped and not zeroed** on this mirror → **quarantine** (R6d's
  token-safe form: accept the tokens into the stranded-recovery
  reservation, §4.1, and record the malformed-instruction receipt; never
  revert — a revert is re-executable into the same revert forever,
  `§2h R6d`).
- day **unstamped** (the remit overtook its V3 broadcast — Codex #1600 r2
  P1: with `dayClockEra` and `dayDeliberatelyZeroed` both unset, a
  stamped-only rule would quarantine a valid on-time compensation with no
  later promotion) → the remit's authenticated `remitter` establishes a
  **PROVISIONAL era and provisional compensated credit** for the day. When
  the V3 broadcast later arrives: matching `baseDeployment` → the
  provisional state confirms in place (the compensated pool stands);
  mismatching → the provisional credit moves to the stranded-recovery
  reservation and the confirmed era's state governs. Transport rotation
  bounds the exposure: once the messenger's peers rotate, an old era's
  messages stop being deliverable at all, so provisional-then-confirm only
  spans the in-flight overlap.
- day zeroed, not lapsed, not short-lapsed → credit the compensated pool
  **per side** (the P2 payload carries per-side amounts, §2.5), stamp
  `dayCompensated[dayId]`, clear nothing on Base yet (the ACK does that).
- day zeroed, **lapsed or short-lapsed** (mirror clock past the applicable
  expiry per §3 / §2.5 — a supplemental arriving after `dayShortLapsed` is
  in this branch, r2 P1) → quarantine into the stranded-recovery
  reservation; R4's return path takes it from there.

The unstamped-mirror case never waits on the broadcast: the expiry inputs
ride the remit itself (R4b) and the provisional-era rule above supplies the
missing classification state.

### 2.3 R1d — a genuine zero is `chainReportSentAt != 0`, and the terminal is permissionless

The mirror-local fact "this day's local interest close HAS RUN" already
exists: `closeDay` folds both sides' frontiers through the day
(`RewardReporterFacet.sol:196-197`) and stamps
`chainReportSentAt[dayId] = block.timestamp` **before** dispatching the
report (`:222`). `totalLenderInterestNumeraire18[d] == 0` alone is ambiguous
(unfolded vs zero); `chainReportSentAt[d] != 0` is not. So:

- the lapse terminal (§3) and the quote (§1.4) both **require**
  `chainReportSentAt[dayId] != 0`;
- the undecidable case has a bounded permissionless terminal already:
  `closeDay` is permissionless (`:175`), so anyone can produce the missing
  classification fact and then invoke the dependent terminal. No new
  mechanism; the design only forbids either terminal from *waiting* on
  anything else.
- a day that is genuinely zero on both sides after fold needs no
  compensation: the quote would be zero, and a zero quote marks the day
  **resolved-zero** on Base (no dispatch, `remitIneligible` cleared via the
  existing `reconcileCommitmentRemitEligibility` path,
  `RewardCommitmentFacet.sol:272+`) — the lapse clock stops mattering
  because there is nothing to pay.

### 2.4 Both clocks gate on the day's frozen inputs

Nothing in R1/R2 evaluates against live config: expiry =
`dayFinalizedAt[d] + lapseWindow(dayLapseScheduleVersion[d])`, both frozen
(§1.1/§1.2). A day with no clock (pre-V3 apply, §1.1) is neither
lapse-eligible nor zero-priceable — permissionlessly healable by
re-broadcast.

### 2.5 R1c — the supplemental transition for a consumed short delivery

The gap, concretely: a short-delivered compensation (fee-on-transfer /
partial burn) that was **consumed** leaves the day partially backed, and
every re-entry is closed — `_planDay` gates on
`rewardBudgetRemitted[c][d] != 0` (`RewardRemittanceFacet.sol:668`),
`remitManualBudget` requires both day markers clear (`:1267-1271`), and only
a **release** deletes them (`:1183-1184`) — which is wrong for a consumed
delivery (the reservation is Acked, not dead). The supplemental transition:

```
remitSupplementalBudget(dstChainId, dayId, amount)   ADMIN, canonical
  requires dayClosedByRemitId[dst][day] != 0            (day closed by a remit)
  requires that reservation is Acked                    (value consumed — else release is the tool)
  requires the day was a COMPENSATION day               (quoted; ordinary days heal via release)
  requires PER-SIDE cumulative funded (original + prior supplements + this)
        <= that side's standing quote                   (each side separately)
  creates a NEW reservation (own remitId, dayIds=[day]) — same lifecycle,
        same wire tag, same ingress; the mirror ADDS to the compensated pool
        PER SIDE (deferral semantics absorb the top-up naturally)
```

The bound is **per side, and every supplement's payload carries its own
per-side split** (Codex #1600 r2 P1: an aggregate bound lets a sequence
stay under `quotedLender + quotedBorrower` while overfunding one side past
its quote and shorting the other; and an unallocated scalar would leave the
mirror nothing to add per side). A supplement adds **backing only** — the
pricing delta stays the day's Δq from the original quote; nothing re-prices.

It deliberately does **not** touch the day markers — the day stays closed;
what accumulates is funding against the same obligation, which is what §2h
r10 asked for ("admitted despite the day marker, accumulating against the
same receipt-bound obligation"). The received-vs-declared evidence for
sizing comes from the ACK, which reads the mirror's recorded receipt
(`sendRemitAck`, `:1017` — content from the receipt, never caller-supplied).
R6c already permits this: a receipt-bound top-up cannot create a second
stranded delivery.

**The partially-backed state also gets a bounded PERMISSIONLESS terminal —
the ADMIN top-up alone is not one** (Codex #1600 r1 P1: with
`dayCompensated` set, §3's lapse precondition is false, so if the operator
never supplements, the day defers on its shortfall forever and blocks every
later day behind the cursor — the exact R1c state §2h requires to have a
permissionless exit). New mirror function:

```
lapseShortCompensatedDay(dayId)                       permissionless
  requires dayCompensated[dayId] && !dayShortLapsed[dayId]
  requires compensated pool short of the standing per-side obligations
  requires mirror block.timestamp > effectiveDeadline(dayId)
```

Effect: sets **`dayShortLapsed[dayId]` — its own monotonic state, distinct
from `dayLapsed`** (Codex #1600 r2 P1: reusing `dayLapsed` would retire
every entry unpaid through §2.1's zero branch, while no flag at all would
leave the day reopenable after its terminal). Under §2.1's precedence the
day's pricing switches from defer-on-shortfall to **truncate-at-remaining**
— entries are paid until the funded pool exhausts, the rest retire with the
shortfall recorded in the §5.2 loss ledger, and the cursor advances. A
supplemental arriving after the state is set is quarantined (§2.2's lapsed
branch), never credited.

**The deadline is absolutely bounded** (Codex #1600 r2 P1: "every
supplement restarts the full window" would let an operator park the oldest
day unclaimable forever with dust top-ups — recreating the operator-
controlled wait the terminal exists to eliminate):

```
effectiveDeadline = min( lastQualifyingReceiptAt + lapseWindow(v),
                         firstReceiptAt + 3 × lapseWindow(v) )
```

and a supplement is **qualifying** (clock-extending) only if it reduces the
remaining per-side shortfall by at least one quarter; a smaller top-up is
credited but does not move the clock. The absolute 3× cap holds regardless
— after it, only full funding before the deadline prevents the terminal.
This is R2's principle applied to R1c's state: pay what is backed,
terminate on a bounded clock, record the loss.

> *(w4 implementation notes — deviations recorded: (1) **§2.1's
> "truncate-at-remaining" landed as PRO-RATA SCALING AT THE CROSSING** —
> the short-lapsed day's ladder arm prices `Δq × pool_s / quoted_s` per
> side rather than paying entries in order until the pool exhausts. The
> w3 lesson governs: bulk window pricing settles from the cumulative
> rows with no payment-path budget, so an order-dependent truncation
> cannot bound it — the scaled crossing bounds every path at once, is
> order-independent, and Σ floored payments ≤ pool by construction.
> (2) **`stampLegacyCompensation` is ADMIN-evidenced, not
> permissionless**: `ReceivedRemit` predates any day binding, so the
> receipt↔day association is verifiable only against Base's
> `RemitReservation.dayIds` — operator-side evidence; a permissionless
> surface could bind any legacy receipt to any zeroed day. Pre-live
> there are ZERO legacy receipts on any deployment. (3) The R6 gate
> clears on the operator-evidenced **forced finalize too** (same
> consumption semantics, same mould as the ACK); cancels/releases hold
> it as ratified. (4) The deadline's qualifying stamps live in
> `_creditCompensation` reading the PRE-credit shortfall; with no
> standing quote yet the qualifying test is vacuously false and the
> absolute clock alone runs — the conservative direction. (5) The
> supplemental checks clock PRESENCE only — deliberately NOT the manual
> path's R3 cutoff (#1656 r3): a compensated-and-open day is inside its
> §2.5 remediation window, whose deadline supersedes the original
> expiry, and the mirror ingress correspondingly exempts
> already-compensated days from the raw-expiry quarantine (the terminal
> FLAGS govern supplements). The cutoff's guaranteed-quarantine premise
> holds only for FIRST compensations, where it stays. Two precise
> qualifications (#1656 r5): the remediation deadline is NOT an
> enforced ingress cutoff — the mirror rejects only once a terminal
> FLAG is set, and the flag is set by the permissionless terminal
> TRANSACTION, so a supplemental landing after the effective deadline
> but before that transaction is still credited, and a full top-up in
> that ordering window prevents the terminal (a bounded, benign race:
> the day ends fully funded — the outcome the terminal exists to
> approximate). And the declared→received reconciliation of the
> per-side cumulative (`compFunded*`, stamped by both dispatchers)
> runs on PENDING acks and on the FIRST ack after a forced
> finalization only — a RELEASED reservation's late-executing ack is
> recorded (`RemitAckAfterRelease`) but does not reconcile — instead
> the RELEASE ITSELF subtracts the reservation's declared per-side
> split from the funded cumulative (#1656 r6): the released tokens
> never funded the obligation, and leaving them counted would make the
> recovery ceremony's re-dispatch impossible against the per-side
> bound. Contributions from other reservations on the day remain
> counted. (6) Fitting w4 required
> the EIP-170 triple split: `RewardRemittanceLensFacet` (22 ledger
> views), `RewardCompensationDispatchFacet` (manual + supplemental),
> `LibRewardRemitDispatch` (the shared dispatch tail / net headroom /
> gate pair — one source, inlined per facet). Review round 2 (#1656)
> hardened the upgrade seams: the terminals ship DARK behind a one-shot
> ADMIN `armLapseTerminals` (the §8 activation gate as on-chain state —
> a permissionless lapse cannot race the legacy migration); the funded
> record's existence is a dedicated flag (`compFundedRecorded`), never
> the (0,0) value pair (a severe short delivery's reconciliation can
> round both sides to zero and the day must stay supplementable); the
> migration seed records AT MOST the declared scalar (an already-ACKed
> short delivery seeds at received); and the operator-evidenced forced
> finalize preserves declared funding (its zero received-amount is a
> sentinel — the authentic ACK is permissionlessly re-presentable when
> reconciliation is wanted). Round 10 closed the last two seams of that
> state machine: the forced-finalize one-shot is spent only by a
> CONSUMED ack — a provisional (non-consumed) ack arriving post-force
> leaves the flag standing so the consumed re-presentation can still
> reconcile — and the in-place refresh script generation-gates the
> reward MESSENGER proxy the same way it gates the receiver
> (`WIRE_GENERATION`), since the refreshed facets speak the 5-word
> consumption ACK that a generation-1 messenger rejects. Round 11
> hardened three more edges. First, the short-lapse scaled delta shaves
> the side's covering-entry count off the delivered pool before scaling
> (`Δq × (pool − n) / quoted`): bulk settlement floors once over an
> entry's whole window, so the lapsed day's marginal can round UP by a
> wei per covering entry, and the unshaved scaling could pay a few wei
> more than was delivered out of unrelated custody — the same
> "upper bound must dominate every rounding regime" lesson the quote's
> per-entry ceiling encodes, now applied to the terminal's arm. The
> accumulator counts entries from the feature's genesis (no deployment
> ever ran the w3 accumulator without the count), so the count is never
> stale for a real quoted day. Second, a PROVISIONAL compensation stamps
> no remediation clocks — they start when its V3 broadcast confirms the
> credit, because only from confirmation can Base's supplemental path
> run at all; a delayed broadcast would otherwise burn the bounded
> window while remediation was impossible and let the terminal fire the
> moment `provisional` cleared. Third, an EXACT lapse-loss record
> (conservation proved) freezes its accumulation — the admin reset valve
> refuses, since a wiped accumulator could never refresh figures the
> refinement hook no longer touches; partial records stay resettable,
> which is precisely the parked-cursor recovery the valve exists for.)*

---

## 3. R2 — the lapse terminal, and R2a stated at its true width

The lapse itself (ratified): a permissionless mirror function
`lapseZeroedDay(dayId)` requiring `dayDeliberatelyZeroed[d]`,
`!dayCompensated[d]`, `chainReportSentAt[d] != 0` (R1d),
`dayFinalizedAt[d] != 0` (clock present), and mirror
`block.timestamp > expiry` (§2.4). Effects: marks the day lapsed (terminal —
never reopened, constraint 6), records the R6a loss observable (§5.2), and
arms the ingress post-lapse branch (§2.2, third case).

**R2a — narrowed, as scouted on the card (2026-08-06), now design text:**

- *Execution failure* (committed broadcast that reverted — pause, gas):
  covered by the transport. `CcipMessenger._ccipReceive` failures are
  CCIP-recorded and **manually re-executable, permissionlessly**; the
  whole-day idempotency makes re-execution safe. No mechanism to build.
- *Never committed*: `broadcastGlobal(dayId)` is permissionless
  (`onlyCanonical` is a chain check, not a role gate), repeatable (gates
  only on `dailyGlobalFinalized`), fee-paid-by-caller. Anyone can
  re-present the finalization data. The one real requirement was
  determinism, and §1.1's frozen fields provide it: the facts the lapse
  depends on (`finalizedAt`, version, zeroed marker) cannot differ between
  re-sends. Fields outside the frozen set may differ (armedFromDay,
  late-backfilled inclusion) — the mirror's divergence check governs those,
  and none of them feeds the lapse clock.
- *Base itself unreachable*: out of scope, stated plainly — a halted
  canonical chain halts finalization, remits and claims alike; the lapse
  clock never starts (no `finalizedAt`), so the failure mode is a stall,
  not a wrong lapse. That is the correct direction.
- *Liveness*: "anyone can" is made "someone will" by adding the V3
  re-broadcast of any finalized-but-unapplied day to the keeper's routine
  (apps/keeper), stated as an operational requirement, not a protocol one.

---

## 4. R4 — the concrete accounting (ratified in #1586; storage shape here)

### 4.1 Arrival reservation — one new subtrahend at the ONE subtraction site

New storage: `strandedRecoveryReserved` (mirror; sum of quarantined
arrivals, per §2.2) with per-receipt records keyed exactly like receipts
today (`keccak256(remitter, remitId)`, `RewardRemittanceFacet.sol:997`).
`LibVpfiRecycle.backingPosition` (`LibVpfiRecycle.sol:480-520`) — the single
definition both enforcement sites read (`RewardClaimFacet.sol:314`;
`InteractionRewardsFacet.sol:198-199`) — gains the subtrahend:
`unearmarked = balance − recycleBucket − strandedRecoveryReserved`, floored.
This is the #1574 r11 four-way check: the watcher's `bucket-composition` and
backing views (`getRecycleBackingSnapshot`,
`InteractionRewardsLensFacet.sol:775-788`) publish the reservation so a
fresh claim spending recovery-reserved tokens alarms. **This slice, plus
§2.2's claim-exclusion, is the piece that must land before the halt lifts**
(§3.6a ⛔ SEQUENCING); it rides the remit ingress and needs no return
channel.

### 4.2 The return, settlement, and the recovery position

The return dispatches over #1568's shared channel with Mode B's own payload
kind (§3.6a layering): payload carries the receipt identity
(`remitter, remitId`), the bound day, and the mirror's **actual outflow**
(the two-delta rule). On authenticated Base receipt:

- mirror side: returned cumulative `+= actual outflow`, reservation record
  retired exactly once;
- Base side: the credit is **entitlement-bounded and chain-bound** (Codex
  #1600 r1 P1 ×2): the authenticated message's `sourceChainId` must equal
  the referenced reservation's `dstChainId` — otherwise another registered
  mirror could consume a chain's one-shot recovery, clear its gate, and
  strand the genuine return — and the position credit is
  `min(actual inflow, reservation entitlement − already recovered for this
  receipt)` (constraint 6's amount-bounded entitlement: without the cap, a
  faulty or compromised mirror could attach a small valid receipt to an
  arbitrarily large return and mint uncharged re-dispatch capacity, a 69M
  bypass). Any excess above the entitlement is **quarantined token-safe**
  in an operator-visible overage position — never credited to the recovery
  position, never reverted (R6d's rule);
- `rewardBudgetRecovered += credited amount` — **recovery-position
  evidence, never a cap deduction** (`remaining` reads gross alone); the
  physical tokens sit in the recovery position;
- the R6 gate for that chain clears (return settlement, §5.1).

Re-dispatch from the position is **uncharged** (`rewardBudgetRemittedGlobal`
untouched), bounded by the position balance, tracked on
`rewardBudgetRedispatched` (the third reconciliation term). **Admissible
targets** — the question #1586 deferred here: a recovery-sourced dispatch
may fund (a) a later `remitManualBudget` / supplemental compensation
(§2.5), or (b) an ordinary armed-day batch, in either case as a *funding
source substitution* inside the send path (the reservation records
`fundedFromRecovery` so the release path knows not to restore headroom that
was never charged). It may NOT fund anything outside reward remittance —
the position is reward-funding custody, not treasury.

---

## 5. R6 — the gate's state, evidence, and terminals

### 5.1 The marker and its clearing evidence

New Base storage: `compensationOutstanding[dstChain]` = the manual/
supplemental reservation's remitId (0 = none) — set at dispatch, and the
gate `remitManualBudget` / `remitSupplementalBudget` require it clear for
that chain (one in flight, R6). It clears on exactly the state machine
§2h ratified (the table beside R6): consumption ACK (the manual
reservation's ack — `onRemitAckReceived` is idempotent and its mirror-side
producer `sendRemitAck` reads only the stored receipt, so the ACK is
**re-presentable by anyone** — R6b is satisfied by making `sendRemitAck`
permissionless if it is not already, which must be verified at build time
and is the R6b slice's first task), or return settlement (§4.2), or
recovery settlement (§5.3). Cancellation records terminal message state but
holds the gate (ratified).

### 5.2 R6a — the lapse terminal instruments the loss itself

`lapseZeroedDay` records `lapsedDayLoss[dayId]` from the best figure
available at lapse time, **never by scanning inline** (Codex #1600 r2 P1:
an unbounded per-entry scan inside the lapse could exceed the gas limit
and make the guaranteed terminal itself revert): the completed standing
quote if one exists; else the §1.4 batched accumulator's partial progress,
flagged `partial = true`; else zero-with-flag. The exact figure may
complete afterwards through the same permissionless accumulator and
overwrite the partial record — R6a already ratifies that the exact figure
may not gate retirement, and this is precisely why. Either way the record
is **non-blocking** — state + event, gating nothing. If no fold has run
the lapse is impossible anyway (R1d gate). Suppressed-by-R6 days (never
dispatched) are exactly the ones this records — the counters that only see
sent/received value stay silent, which is why the terminal itself writes
the number.

### 5.3 R6d — cancellation, the ceremony, and the ONE recovery pattern (⚖ flagged)

Cancellation: an ADMIN evidenced operation in the `finalizeRemitReservation
(forced)` mould — records the CCIP-level evidence that a message can never
execute; tokens remain in pool custody; gate holds.

Recovery settlement (pool → Diamond): the governance ceremony. Its evidence
is balance-verifiable (tokens arrive at the Diamond) plus the ceremony
record binding the recovered amount to the cancelled reservation. **The
gate clears only at FULL custody resolution** (Codex #1600 r2 P1: a partial
pool withdrawal, or a full debit that lands short from transfer loss, would
otherwise clear the gate while value is still stranded — and Base inflow
alone cannot tell transport loss from value still in the pool). The
cancellation record fixes the reservation's stranded amount (its dispatched
total); each ceremony records its **reservation-bound pool outflow** and
the corresponding Base inflow separately; any residue neither recovered nor
still in the pool requires an explicit governance **terminal-loss record**
(evidenced, in the same forced-finalize mould). The gate clears when
`stranded − recovered − recorded terminal loss == 0` — partial recoveries
hold it.

**The reconciliation this document had to settle** (assigned here by
#1586) — **✅ DECIDED 2026-08-07 (owner): unify on the recovery-position
pattern.** TokenomicsTechSpec §9 ratified the ceremony as *restoring*
emission headroom (restore-then-recharge), which made `remaining` rise
inside a governance-gated window — the one non-monotone case left. The
owner ratified the unification: the ceremony's fresh half lands in the
SAME recovery position R4 credits — no headroom restoration, no
non-monotonicity anywhere — and the re-remittance that §9's backing gate
holds the day open for is funded **from the position, uncharged**.
Economically identical to restore-then-recharge (net one charge per funded
day), with strictly stronger invariants and one recovery pattern instead
of two. The recycled half's ceremony path (`creditCustodyRelocated`) is
untouched. **P2-w6 carries the FunctionalSpec amendment** to the
released-reservation passage (an explicit intent change, per the
FunctionalSpecs discipline — code-observed behaviour never enters the spec
silently, and neither does a design decision).

The rejected alternative, recorded so its cost stays visible: keeping §9's
restore would have added the ceremony-recovered cumulative as a fourth
`remaining` term and accepted the bounded non-monotone window, with the
truncate-and-consume caveat stated at every `remaining` site (six exist
today — `RewardClaimFacet.sol:269`, `LibInteractionRewards.sol:2570`,
`RewardRemittanceFacet.sol:944`, `InteractionRewardsFacet.sol:87,176`,
`RewardAggregatorFacet.sol:980`).

### 5.4 R6e — deployment rotation

Receipts and reservations are already deployment-bound: the payload carries
`address(this)` and receipts key on `(remitter, remitId)`
(`RewardRemittanceFacet.sol:604-611, 997`), so old-era evidence lands only
on the old deployment. The rotation inventory is therefore a **readback +
carry-over**, not new wire: an **explicitly enumerable outstanding-chain
index** (`compensationOutstandingChains`, pushed on gate-set and removed on
clear — Codex #1600 r2 P1: a mapping alone cannot back the inventory view,
and iterating the MUTABLE destination list would omit a chain removed from
it while its compensation was still stranded, letting the new deployment
reopen that gate), a rotation-runbook step requiring the index be
inventoried before cutover, and an ADMIN
`importOutstandingCompensation(chain, oldRemitter, oldRemitId)` on the new
deployment that seeds the gate CLOSED for those chains until old-era
evidence clears them.

**How an imported gate observes old-era settlement — the clearing
transitions** (Codex #1600 r1 P1: seeding closed with no observer would
suppress that chain's compensations permanently even after the old delivery
resolved):

- *Consumed or returned on the mirror*: the mirror's receipt state for
  `(oldRemitter, oldRemitId)` is mirror-side storage that survives Base's
  rotation. A permissionless mirror function re-presents it to the CURRENT
  Base as a settlement message carrying the old-era tuple; the new
  deployment verifies the tuple against its imported marker — not against
  its own reservations, which never contained it — and clears. This is
  R6b's re-presentable-evidence property pointed at the new era, and it
  reuses the ack/return wire shapes with the imported tuple as the key.
- *Ceremony-recovered*: governance evidence is operator-verified by
  construction, so an ADMIN evidenced clear in the
  `finalizeRemitReservation(forced)` mould covers the case where the old
  era's stranded tokens were recovered pool → Diamond.

No unresolved compensation may be silently forgotten by a redeploy — that
is the whole requirement; the transitions above are what make the imported
marker *resolvable* rather than a permanent lock.

---

## 6. The residual — a ledger that already exists, and a stated terminal

Floor dust and cap-bound excess of a compensated day (delivered value the
capped entries cannot absorb) simply remains in the mirror's delivered
backing: it is inside `rewardBudgetArmedFreshReceived − paid` spendable
funding (P1-a's counters reconcile it exhaustively — `counted + uncounted`
covers every delivery, `RewardRemitLedgerTest`). Its terminal: it funds
**later armed days on the same mirror** through the ordinary delivered-
backing bound (P1-b), exactly like ordinary over-delivery. It is not a debt
(R1a, ratified), not returnable (nothing strands — the day it funded is
resolved), and needs no new ledger — only this statement, so nobody builds
one.

---

## 7. The two parameters — bounded, versioned, and sized against skew

Both live under the R5 versioned schedule (§1.2), ADMIN-set within
hard-coded bounds (the `VpfiPoolRateGovernor` pattern — a setter that
refuses out-of-range values), and take effect only for days finalized after
the bump (frozen per day):

- **`lapseWindowSeconds`** — proposal: default `7 days`, bounds
  `[3 days, 30 days]`. Must exceed `rewardGraceSeconds` (4h default) + lane
  latency + the skew term below by a wide margin; 7 days also covers a
  weekend outage with operator margin.
- **`dispatchCutoffGap`** (R3) — proposal: default `24 hours`, bounds
  `[6 hours, 7 days]`. Base refuses to dispatch a compensation within the
  gap before expiry.
- **Relational bound, enforced at the version setter** (Codex #1600 r1 P1:
  independent ranges admit `window = 3 days, gap = 7 days`, which places
  the cutoff before finalization and forbids every compensation for every
  day frozen under that version — unrepairable, since frozen parameters
  are permanent): `lapseWindowSeconds >= dispatchCutoffGap + 48 hours`.
  The 48-hour floor is the dispatch-opportunity margin (grace + lane
  latency + skew, with slack); a version violating it is refused, never
  stored.
- **The skew rule (ratified requirement):** Base evaluates the R3 cutoff on
  Base's clock; the mirror evaluates the R2 lapse on its own. Both compare
  against the same frozen `finalizedAt` (Base-domain), so the residual
  cross-domain exposure is exactly one clock comparison per side and the
  gap must absorb `maxSkew` between any supported chain pair. EVM chains
  bound block-timestamp drift tightly (minutes at worst); `24 hours >> 2 ×
  skew + lane latency` with two orders of margin. The alternative
  (single-clock-domain evidence for the lapse) would make the lapse wait on
  a Base-signed statement — reintroducing the wait-on-arrival R2 exists to
  prevent — and is rejected for that reason.

Both defaults are proposals sized from testnet observation windows;
the bounds are the design's actual commitment.

---

## 8. Slice cut (build order) and what each slice must prove

1. **P2-w1 — V3 broadcast + frozen fields + backfill** (§1.1, §1.2).
   Proves: re-broadcast determinism of the frozen fields; clock backfill on
   an applied day; old kind-5 in-flight packet still applies; divergence
   check extension.
2. **P2-w2 — remit tag P2 + ingress classification + arrival reservation +
   claim exclusion** (§1.3, §2.2, §4.1). Proves: quarantine on each of the
   three ingress cases; `backingPosition` subtraction visible at both
   enforcement sites and in the watcher figures; unstamped-mirror
   classification. **This is the pre-halt-lift slice** (§3.6a ⛔).
3. **P2-w3 — quote + manual-path evidence bound + repricing + suppression
   gate** (§1.4, §1.5, §2.1, §2.3). Proves: constraint-17 day pays under
   the local denominator; zero-quote resolves a genuinely-zero day; funding
   bounded by quote.
4. **P2-w4 — lapse terminals + R6 gate + R6a instrumentation + supplemental
   transition** (§3, §5.1, §5.2, §2.5 — both lapse functions). Proves:
   each lapse requires its full precondition set; gate one-in-flight;
   supplemental accumulates under the quote bound and restarts the short-
   compensated window; R6a figure recorded for a suppressed day; a lapsed
   day prices zero and the cursor advances past it (§2.1's third conjunct).
   **Activation precondition — the constraint-19 migration for legacy
   MANUAL remits** (Codex #1600 r1 P1: a pre-P2 d5 manual remit carries
   neither the P2 tag nor per-side amounts, so the upgraded machinery could
   ACK it and close the Base day yet never stamp or price the compensated
   pool, leaving lapse-and-underpay as the only exit): before the R6 gate
   and lapse terminals arm, (a) Base inventories pre-P2 manual reservations
   (identifiable: fresh-only, single-day, day was `remitIneligible`) — a
   Pending one is released or allowed to resolve; (b) a delivered one is
   healed on the mirror by the permissionless
   `stampLegacyCompensation(dayId, receiptKey)`: it **requires a COMPLETED
   §1.4 quote for the day first** (Codex #1600 r2 P1: `ReceivedRemit`
   proves only the scalar total and the day — the legacy wire never carried
   a per-side split, so the stamp cannot invent one), verifies the receipt
   covers exactly that zeroed day, then allocates the scalar receipt
   deterministically pro-rata to the quoted sides
   (`sideShare = amount × quotedSide / (quotedL + quotedB)`), stamps
   `dayCompensated`, and moves the allocated amounts from the
   delivered-fresh position into the per-side compensated pools, bounded by
   the receipt amount. A legacy receipt whose day cannot complete a
   non-zero quote is the DRAIN case: the value stays ordinary
   delivered-fresh backing and the day proceeds to its lapse terminal. The
   activation gate is the inventory reading empty.
5. **P2-w5 — R4 return over #1568's channel + recovery position +
   uncharged re-dispatch** (§4.2) — downstream of #1568's shared slice,
   before M7 arming (plan §4 `SHAREDWIRE --> MODEBWIRE -.-> ARMGATE`).

   > **Implementation note (P2-w5, 2026-08-10).** Shipped as designed,
   > with the shapes pinned here. The B1 kind
   > (`vaipakam.return.wire.stranded.b1`) carries `(remitter, remitId,
   > dayId, amount)` plus one TokenAmount — `remitter` (the issuing Base
   > deployment) IS the era binding, checked Base-side against
   > `address(this)` with a stale era failing closed and re-executable
   > (the R6e runbook's case). The mirror dispatch is PERMISSIONLESS
   > payable in the R6b posture: quarantine is terminal mirror-side and
   > the return its only exit, the stored record is the evidence, and
   > the caller can neither redirect nor resize (the recorded amount
   > travels — the two-delta rule's source half). Lane capacity is
   > checked before the one-shot retire, so over-capacity fails
   > retryably. Base-side, the entitlement is the reservation's
   > dispatched `total` with a per-receipt recovered cumulative; the
   > overage position absorbs the excess token-safely. The gate clears
   > only when the returning receipt IS the outstanding one. The
   > reservation's STATUS is deliberately untouched by the return —
   > delivery evidence (the ack path) and value settlement are
   > independent lifecycles. Re-dispatch substitution landed as thin
   > `…FromRecovery` wrappers over the ONE manual/supplemental
   > implementation (a `fromRecovery` funding-source flag): the position
   > check replaces the 69M headroom check, `rewardBudgetRedispatched`
   > replaces the `rewardBudgetRemittedGlobal` charge, and every other
   > bound (quote, era, clock, cutoff, gate, per-side cumulative) is
   > shared by construction. Ordinary armed-day BATCH substitution —
   > which §4.2 also admits — is deliberately deferred: the batch path's
   > mixed fresh/recycled split interacts with commitment retirement and
   > deserves its own slice if ever needed. A release of a
   > recovery-funded reservation restores NEITHER headroom (never
   > charged) NOR the position (the tokens are physically in transport
   > custody until the R6d ceremony — which, per the ratified §5.3
   > unification, credits the SAME position). The Base position joins
   > `backingPosition`'s subtraction as the second protocol-ledger term
   > (single writer set: the authenticated ingress credits, the
   > from-recovery dispatch debits), the transparency snapshot publishes
   > it as an eighth output, and the mesh watcher's
   > recovery-reservation check sums it into the spoken-for figure Review
   > round 1 closed three seams: the entitlement basis requires a
   > COMPENSATION-shaped reservation (single-day, fresh-only, per-side
   > declared) — an ordinary batch remit's recycled component never
   > charged the cap, so crediting its total would mint uncharged
   > re-dispatch capacity; BOTH return-channel satellites publish
   > `WIRE_GENERATION` and the in-place refresh script generation-gates
   > them alongside the receiver and messenger (the w4 lesson applied to
   > every proxy the refreshed facets speak to); and a short actual is
   > recorded per receipt as TRANSPORT LOSS (`strandedReturnShortfall`)
   > — the mirror's one-shot record retired at declared, so the gap can
   > never re-arrive and must read as the R6d loss ceremony's evidence,
   > not as recoverable entitlement.

6. **P2-w6 — R6d/R6e terminals + ceremony reconciliation per §5.3(a)** —
   carries the FunctionalSpec amendment if (a) is ratified.

Then **P1-b** consumes the delivered-fresh bound and lifts the halt,
retiring `test_D4_MirrorArmedDayPricingStaysHalted` with the per-day gates
of §2.1/§2.4 in its place.

---

## 9. Owner decisions

1. **§5.3 — ✅ DECIDED 2026-08-07 (owner): unify the ceremony on the
   recovery-position pattern.** `remaining` is monotone everywhere; one
   recovery pattern; P2-w6 carries the FunctionalSpec amendment. Recorded
   in §5.3 with the rejected alternative's cost.

Everything else in this document is delegated design under #1571's
standing instruction.
