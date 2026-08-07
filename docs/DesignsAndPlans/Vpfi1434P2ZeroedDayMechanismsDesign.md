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
- `lapseScheduleVersion` (`uint32`) — the version of the lapse-window /
  cutoff-gap parameter set under which this day's clocks are evaluated,
  **frozen per day at finalization** (`dayLapseScheduleVersion[dayId]`).
- `zeroedForDest` (`bool`, per-destination) — the R1 zeroed marker: true iff
  `chainDayCommitments[dayId][dest].remitIneligible` was set at finalization
  (`RewardAggregatorFacet.sol:561-570`). Per-destination like the existing
  `_perDestFields` halves; a mirror stores it as
  `dayDeliberatelyZeroed[dayId]`.

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
**clock backfill** — it runs the full V2-field divergence check, then writes
only the three V3 fields. So:

- A day applied via kind-5 before the upgrade has no clock. It is **not
  lapse-eligible and not priceable as a zeroed day** (both machines gate on
  `dayFinalizedAt[d] != 0` — see §3 and §2.4). Anyone can heal it by calling
  the permissionless `broadcastGlobal(dayId)` again, which now emits V3 and
  backfills the clock. This is the inventory/backfill 12b requires, and it
  needs no operator: the gate is per-day and self-healing.
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
  parameters* are mirror-known from authenticated Base data).

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
  computes perSide = the §2c per-entry capped supremum for this chain-day
  sends (dayId, quotedLender, quotedBorrower) via the reward channel
```

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
**locally** — `compensatedDailyRpn = quotedSideHalf * 1e18 /
totalSideInterestNumeraire18[d]` (its own folded per-side total,
`LibInteractionRewards.sol:799/828`), bounded by the received compensation
value with **deferral** semantics (the delivered budget grows with the
funding, §2g's rule — never trim). The walk recognises a compensated day by
a mirror-local stamp written at compensation ingress
(`dayCompensated[dayId] = receiptKey`), and `processUserSideDay` prices it
from the compensated pool instead of the broadcast halves. The local
denominator is the SAME quantity the quote's supremum was computed against,
so the quote bounds the payout by construction; entry-level caps (§2c) apply
unchanged.

---

## 2. R1 — the zeroed day: suppression, classification, ingress, top-up

### 2.1 Suppression (R1, main body — restated only to anchor the gate)

A mirror must not price a deliberately-zeroed day through the ordinary walk.
Gate: `dayDeliberatelyZeroed[dayId] && !dayCompensated[dayId]` makes
`_dayPoolHalves` return the **defer** shape for that day (halt=true today is
the blanket mirror halt; after P1-b the per-day form replaces it for zeroed
days only). Deferral — not terminal — because `advanceCumLenderThrough`'s
`if (halt) break;` (`LibInteractionRewards.sol:1042-1044`) leaves the cursor
before the day, which is exactly the "waits, re-attempted next call"
behaviour the standing rule requires. The `rawPay == 0` terminal-progress
path (`:4353-4358` + `_persistDay` `:1456`) is therefore never reached for a
zeroed-uncompensated day; the entries-retired-for-zero mechanism P2 exists
to prevent is closed at the pricing gate, not patched at persistence.

### 2.2 R1a — ingress classifiability + token-safe rejection

A compensation arrives on the remit path carrying the P2 tag (§1.3): the
bound day, its expiry inputs, and a **compensation marker** (the tag itself
plus the single-day payload shape). Ingress (`onRewardBudgetReceived`,
`RewardRemittanceFacet.sol:829+`) classifies:

- day not zeroed on this mirror → **quarantine** (R6d's token-safe form:
  accept the tokens into the stranded-recovery reservation, §4.1, and record
  the malformed-instruction receipt; never revert — a revert is
  re-executable into the same revert forever, `§2h R6d`).
- day zeroed, not lapsed → credit the compensated pool, stamp
  `dayCompensated[dayId]`, clear nothing on Base yet (the ACK does that).
- day zeroed, **lapsed** (mirror clock past expiry per §3) → quarantine into
  the stranded-recovery reservation; R4's return path takes it from there.

The unstamped-mirror case is covered because the expiry inputs ride the
remit itself (R4b) — classification never waits on the broadcast.

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
  requires cumulative funded (original received + prior supplements + amount)
        <= the standing quote                           (the receipt-bound obligation)
  creates a NEW reservation (own remitId, dayIds=[day]) — same lifecycle,
        same wire tag, same ingress; the mirror ADDS to the compensated pool
        for the day (deferral semantics absorb the top-up naturally)
```

It deliberately does **not** touch the day markers — the day stays closed;
what accumulates is funding against the same obligation, which is what §2h
r10 asked for ("admitted despite the day marker, accumulating against the
same receipt-bound obligation"). The received-vs-declared evidence for
sizing comes from the ACK, which reads the mirror's recorded receipt
(`sendRemitAck`, `:1017` — content from the receipt, never caller-supplied).
R6c already permits this: a receipt-bound top-up cannot create a second
stranded delivery.

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
- Base side: `rewardBudgetRecovered += actual inflow` — **recovery-position
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

`lapseZeroedDay` records `lapsedDayLoss[dayId] = (quotedLender,
quotedBorrower, quoteStale?)` from the standing quote if one exists, else
the mirror computes the same §2c supremum inline (it is mirror-local data);
either way the figure is **non-blocking** — recorded state + event, gating
nothing (ratified R6a). If no fold has run the lapse is impossible anyway
(R1d gate), so the observable always has its inputs. Suppressed-by-R6 days
(never dispatched) are exactly the ones this records — the counters that
only see sent/received value stay silent, which is why the terminal itself
writes the number.

### 5.3 R6d — cancellation, the ceremony, and the ONE recovery pattern (⚖ flagged)

Cancellation: an ADMIN evidenced operation in the `finalizeRemitReservation
(forced)` mould — records the CCIP-level evidence that a message can never
execute; tokens remain in pool custody; gate holds.

Recovery settlement (pool → Diamond): the governance ceremony. Its evidence
is balance-verifiable (tokens arrive at the Diamond) plus the ceremony
record binding the recovered amount to the cancelled reservation; it clears
the gate (the stranding ends).

**The reconciliation this document must settle** (assigned here by #1586):
TokenomicsTechSpec §9 ratifies the ceremony as *restoring* emission headroom
and bucket (restore-then-recharge), which makes `remaining` rise inside a
governance-gated window — the one non-monotone case left. Two shapes:

- **(a) RECOMMENDED — unify on the recovery-position pattern.** The
  ceremony's fresh half lands in the SAME recovery position R4 credits:
  no headroom restoration, no non-monotonicity anywhere, and the
  re-remittance that §9's gate holds the day open for is funded **from the
  position, uncharged** — economically identical to restore-then-recharge
  (net one charge per funded day), with strictly stronger invariants and
  one recovery pattern instead of two. Requires a FunctionalSpec amendment
  (an intent change — flagged for the owner with this document; the
  recycled half's ceremony path, `creditCustodyRelocated`, is untouched).
- **(b) Keep §9's restore.** Add the ceremony-recovered cumulative as a
  fourth `remaining` term and accept the bounded non-monotone window, with
  the truncate-and-consume caveat stated at every `remaining` site (six
  sites exist today — `RewardClaimFacet.sol:269`,
  `LibInteractionRewards.sol:2570`, `RewardRemittanceFacet.sol:944`,
  `InteractionRewardsFacet.sol:87,176`, `RewardAggregatorFacet.sol:980`).

(a) is the architecturally clean route under #1571's standing instruction
and is what this document specifies; (b) is recorded so its cost is visible
if the owner prefers spec stability over invariant strength.

### 5.4 R6e — deployment rotation

Receipts and reservations are already deployment-bound: the payload carries
`address(this)` and receipts key on `(remitter, remitId)`
(`RewardRemittanceFacet.sol:604-611, 997`), so old-era evidence lands only
on the old deployment. The rotation inventory is therefore a **readback +
carry-over**, not new wire: a view enumerating non-zero
`compensationOutstanding[*]`, a rotation-runbook step requiring it be
inventoried before cutover, and an ADMIN
`importOutstandingCompensation(chain, oldRemitter, oldRemitId)` on the new
deployment that seeds the gate CLOSED for those chains until old-era
evidence (verified against the old deployment's public state) clears them.
No unresolved compensation may be silently forgotten by a redeploy — that
is the whole requirement.

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
4. **P2-w4 — lapse terminal + R6 gate + R6a instrumentation + supplemental
   transition** (§3, §5.1, §5.2, §2.5). Proves: lapse requires all four
   preconditions; gate one-in-flight; supplemental accumulates under the
   quote bound; R6a figure recorded for a suppressed day.
5. **P2-w5 — R4 return over #1568's channel + recovery position +
   uncharged re-dispatch** (§4.2) — downstream of #1568's shared slice,
   before M7 arming (plan §4 `SHAREDWIRE --> MODEBWIRE -.-> ARMGATE`).
6. **P2-w6 — R6d/R6e terminals + ceremony reconciliation per §5.3(a)** —
   carries the FunctionalSpec amendment if (a) is ratified.

Then **P1-b** consumes the delivered-fresh bound and lifts the halt,
retiring `test_D4_MirrorArmedDayPricingStaysHalted` with the per-day gates
of §2.1/§2.4 in its place.

---

## 9. Decisions this document asks of the owner

1. **§5.3 — unify the ceremony on the recovery-position pattern (a), or
   keep §9's restore (b)?** (a) is specified and recommended; it amends the
   FunctionalSpec's released-reservation passage. Everything else in this
   document is delegated design under #1571's standing instruction and
   ships unless vetoed.
