# #1222 M3 B2-d — Delivered-backing ledger + mirror→Base commitment report — design

> **Status:** design, pre-implementation. Binds to
> [`VpfiRecyclingCompletionPlan.md`](VpfiRecyclingCompletionPlan.md) §M3 (the
> authoritative wire/accounting rules) and
> `VpfiAbsorptionDistributionFormulaRedesign.md` rev-15. This doc is the
> implementing-PR record §M3 defers the open mechanism choices to — it does not
> supersede §M3; where they differ, §M3 wins.
>
> **Card:** #1222 (M3, umbrella #1349). Follows B2-a (#1414), B2-b (#1417),
> **B2-c (#1422 — the Base-side commitment GATE)**. B2-d is the coupled other
> half the B2-c re-slice ("fold report into B2-d", owner 2026-07-25) deferred.

## 0. Why this is one design, then several PRs

B2-c shipped the Base-side finalization GATE (`ChainDayCommitments.complete` /
`.remitIneligible`, `_armedMirrorCommitmentsReady`, `reconcile…`) **dormant**:
`.complete` has **zero writers** in the tree today, so on an armed multi-chain
day the fast close never fires and every grace/force close marks mirrors
`remitIneligible`. That is the deliberate fail-closed posture until B2-d.

B2-d is everything that makes that gate live **safely**, and per §M3 it must be
"designed once across its coupled inputs" — but it is far too large for one
reviewable PR. The pieces, and why they couple:

| Piece | What it does | Couples to |
| --- | --- | --- |
| **P1 Commitment report** | mirror→Base per-side day-D **claimable-liability** total; sets `.complete` | needs the enumeration decision (§2); feeds the clamp (P3) |
| **P2 Mirror commitment-on-arrival + two-sided netting** *(this row said "consume-on-arrival / mirror debits its own bucket" while the slice was being planned; §2e.1 superseded that before implementation — recorded here because a planning table that outlives its own correction reads as shipped behaviour)* | mirror RESERVES the locally-funded slice into its own `outstandingCommitRecycled`; the bucket drains later, pro-rata, at claim/remit. Base books `chainConsumedRecycled` / `chainOutstandingRecycledCommit`; `_stampOne` splits local vs Base top-up | must be gated by delivered backing (P4) or it cannibalises the mirror bucket |
| **P3 Σcommitments remittance clamp** | `chainRewardBudgetForDay = min(uncappedSlice, Σcommitments − remitted − pending)`, 3 sites | needs P1's reported total + P4's ledgers |
| **P4 Delivered-backing ledger** | `pendingRemitted` reservation at dispatch → authenticated ack → `loanSideRewardRemitted`; bounded reconciliation | **greenfield** — no ack channel exists in any direction today |
| **P5 Mirror armed-day pricing ON** — **ATTEMPTED, WITHDRAWN (#1434); the halt STAYS** | remove the `_dayPoolHalves` mirror halt so mirrors price their own delivered-backed stamp | P2+P4 back the RECYCLED halves (done), but the halt ALSO guards the unbounded FRESH side and deliberately-zeroed days — see §2g for why, and **§2h for the zeroed-day scope** (the fresh side's receipt half shipped as #1556) |
| **P6 Third credit class (#1331)** | Ā-**excluded** custody-credit for remitted-recycled forfeit/expiry; provenance tag at remit arrival; `VpfiRecycled` discriminator | needs P4's provenance signal |
| **P7 Keeper + indexer** | keeper drives the mirror→Base report send; out-of-window reconciled-day rediscovery via the `CommitmentRemitEligibilityReconciled` hook; indexer handlers + D1 | needs P1/P4 to exist first |

**Ground-truth confirmations from the scout** (all grep-verified against
`main` @ `6134f565`): `.complete` has no writer; `chainConsumedRecycled` and
`chainOutstandingRecycledCommit` are declared + view-exposed but **never
written** (so every per-chain "consumed ≤ reported" invariant is vacuously
true today); `ChainDayFunding.recycleConsume`/`keeperAllocate` ride the wire as
0; there is **no ack/return channel** for any remittance (strictly one-way
Base→mirror); no `pendingRemitted`/`loanSideRewardRemitted` field exists; the
third credit class has no primitive, event flag, or provenance signal.

## 1. Proposed sub-slice cut (ordered)

Each is an independently-reviewable PR with its own targeted tests, and each
leaves the tree in a **safe** state (the gate stays fail-closed until the slice
that legitimately lights it up):

- **B2-d1 — Commitment report + `.complete` writer.** P1 only. Adds the
  mirror→Base commitment-report wire kind (canonical-only ingress), the mirror
  computation of the day-D per-side claimable-liability total, the Base-side
  ingress that stores the reported per-side totals on an extended
  `ChainDayCommitments` and sets `.complete`, and the keeper send pass (part of
  P7). **Effect (as retimed in §2b):** armed full-coverage finalize fires on
  interest coverage alone (the B2-c commitment readiness input is removed — it
  was causally unsatisfiable, see §2b); `.complete` becomes the d2 REMIT gate's
  input; `remitIneligible` is set only for chains zeroed out of the
  denominator. **Still safe without P2–P6:** remittance is still the pre-mesh
  whole-budget send (no clamp yet), and mirror consumption is still off —
  nothing new can over-pay.
- **B2-d2 — Delivered-backing ledger + Σcommitments clamp.** P3 + P4. The
  `pendingRemitted` reservation, the authenticated ack path, reconciliation, and
  the `min(uncappedSlice, Σcommitments − remitted − pending)` clamp at the 3
  remit sites. Closes #1351's remitted-clamp tail. **Also owns the evidenced
  MANUAL-BUDGET path for zeroed chains (Codex #1425 r2):** clearing
  `remitIneligible` alone cannot fund a zeroed chain (its finalized slice is
  zero, so `remitRewardBudget` reverts `NothingToRemit`) — the manual vehicle
  must reserve into `pendingRemitted` and finalize on ack like any remit, so
  it is designed WITH the ledger, not before it; until d2, zeroed-chain
  compensation stays the pre-mesh out-of-band governance posture. **Effect:**
  Base never remits more than a mirror's reported+backed liability.
- **B2-d3 — Mirror commitment-on-arrival + two-sided netting + per-chain
  books.** P2. `_stampOne` split (mirror avail = delivered-backed
  availability), Base books
  `chainConsumedRecycled`/`chainOutstandingRecycledCommit`, mirror
  `LibVpfiRecycle.reserveMirrorCommit(dayId, recycleConsume)` under its own
  once-only flag `mirrorRecycleCommitReserved`, remittance netting. **Makes the per-chain §7 invariants
  bind.** *(An earlier draft of this line said
  `LibVpfiRecycle.consume(recycleConsume)`. §2e.1 superseded it before
  implementation: consuming at arrival would debit the same tokens twice,
  because claims already debit as they pay.)*
- **B2-d4 — Mirror armed-day pricing ON. ⚠️ ATTEMPTED AND WITHDRAWN — the halt
  STAYS; see §2g and #1434.** P5. The intent was to remove the
  `_dayPoolHalves` mirror halt and keep only the genuine `!stamped` wait.
  Review (#1433 r2) showed that is not yet safe: the halt also guards the
  FRESH side, which has no delivered-funding bound on a mirror, and stops
  deliberately-zeroed (`remitIneligible`) days from advancing the cursor and
  retiring their entries for zero. **Both prerequisites are tracked on #1434
  and both must land before this slice can be retried.**
  - The ordering gate below is now HISTORICAL — d5 shipped first (#1432) and
    discharged the precondition it names. It is kept because it records why
    the two were sequenced that way. **Original gate (Codex #1430 r3): d4 MUST
    NOT land before d5.** Lifting the halt is what makes mirror armed-day
    claims reachable, and a mirror's claim path debits its bucket for the
    WHOLE recycled payout while only the locally-funded share was ever
    credited there — the Base-funded top-up arrived as VPFI but
    `onRewardBudgetReceived` only incremented `rewardBudgetReceivedTotal`,
    never the bucket. A 40-local/23-top-up day would then consume 63 against a
    40 bucket: the bucket floors at zero, `paidOutRecycled` over-counts by 23,
    and the DERIVED `creditedCumulative` (`bucket + paidOut`) reports those 23
    Base-funded tokens as this chain's own new absorption — phantom
    availability Base re-commits on later days. d5 was exactly the fix §M3
    already specified (the `Ā`-feed exclusion), so the two had to land in that
    order. Gated behind d2+d3+**d5** — all three now shipped.
- **B2-d5 — Third credit class (#1331).** P6. The Ā-excluded custody-credit
  primitive, the `VpfiRecycled` discriminator, the 3-site forfeit/expiry
  reclassification, the remit-arrival provenance tag. (Previously tracked as
  "B2-e"; §M3 says #1331 is absorbed by B2 — keeping it inside B2-d is
  consistent.) **Now sequenced BEFORE d4** (see the d4 gate above): its
  remit-arrival credit is what gives a mirror's bucket real backing for the
  Base-funded recycled share, so that mirror claims cannot inflate
  `paidOutRecycled` → the derived `creditedCumulative` → phantom
  availability. Until d5 lands, mirror armed-day claims stay HALTED, which
  is what keeps that hazard unreachable today.
- **Keeper/indexer (P7)** rides d1 (send pass) + a small follow-up for the
  out-of-window reconcile rediscovery (indexer event handler + D1 table + keeper
  read), landing alongside d2.

Then **B3** (source-scoped netted remittance) and **B4** (3-chain
e2e/invariants/watcher/specs) as the plan already sequences.

## 2. The commitment quantity + report scheme — RESOLVED by plan §M3 + rev-15

> **Correction (owner redirect 2026-07-25):** an earlier draft of this doc
> posed "aggregate vs per-loan" and "ack binding" as open forks. They are
> **not** open — the plan resolves both. This section records the frozen
> decisions and the one genuine code-vs-doc reconciliation.

The quantity the report must carry, per side, is the **residual capped
liability** for the closing day `d`:

```
liability_side(d) = Σ_units min( rawPay_unit , cap_unit(d) − paid_unit )
   where  rawPay = uncappedDelta(side,d)/1e18 × Σ(unit's active-entry perDayNumeraire18)
```

**The binding cap differs by chain — this is the code-vs-doc reconciliation:**
the formula doc (rev-15) freezes the commitment as **per-loan headroom**
`capEff_L − max(paid_L, remitted_L)`. That holds on **Base**, where reward-
eligible loans are stamped (`FeeEntitlementFacet.chargeFullTariff` →
`openDays ≥ 1`, finite `loanSideRewardCapOpen`). But on a **mirror** loans are
**unstamped** — `LibInteractionRewards.sol:2811` is explicit: *"An UNSTAMPED
loan (`openDays == 0` — a mirror-chain … loan) is NOT reward-ineligible here:
the cap does not apply so it earns normally"*, and `cfgFeeEntitlementEnabled`
ANDs `isCanonicalVpfiChain`, so a mirror **structurally cannot** stamp `cStar`.
On a mirror the loan-side cap is inert (`_loanSideRemaining` → `type(uint256).max`)
and the **only** binding constraint is the D1 `(user,side,day)` share cap
`C_side(d) = dayUserSideCapVpfi18[d]`. So the commitment "unit" is **per-loan on
Base, per-(user,side) on a mirror** — the mirror's `liability_side` is the
**D1 residual** `Σ_users min(rawPay_user, C_side − userSideDayPaidVpfi)`. This is
**not** the "aggregate-only headroom" the formula doc forbids: it is a bounded
scheme whose per-unit detail is verifiable (§ below), exactly what §M3 sanctions.

**Report scheme — §M3 (lines 325-331) already fixes it as a BOUNDED CHUNKED
scheme and delegates only the sub-form to this PR:** *"the report carries a
bounded scheme (aggregate per-side headroom + a commitment root with chunked
detail, **or** paginated commitment chunks), and ShareOfPool remittance for a
day is gated on all chunks present and verified — never computed from a partial
set."* A busy chain's day-close report must never become undeliverable, and a
missing chunk **delays, never zeroes** (a force-finalize without all chunks
marks the chain `remitIneligible` — B2-c already built that half).

**This PR's pick (the one genuinely-delegated choice):** the mirror computes
`liability_side(d)` on-chain via **keeper-fed, mirror-verified, bounded
accumulation chunks**, then reports **one compact per-side aggregate** to Base:
- the keeper (which holds every entry in the indexer D1) submits bounded batches
  of the units (loans on Base / users on a mirror) active on `d` to a
  **KEEPER_ROLE-gated** mirror function (amended from the earlier
  "permissionless" pick: per-entry verification cannot prove a submission is a
  user's *full* entry set, and the ascending cursor consumes each user's slot
  once — so a permissionless partial/empty submission would wedge demand
  conservation permanently, a cheap per-day DoS. The role is anti-grief, not
  trust — the figures stay mirror-computed; an ADMIN
  `resetCommitmentAccumulation(day, side)` valve recovers a keeper
  mis-submission by wiping the (day, side) accumulation for full resubmission,
  blocked once the report is sent);
- the mirror **recomputes each batch's** `Σ min(rawPay, cap)` **from its own
  storage** and accumulates — so the keeper can never inflate the figure, and
  each on-chain step is bounded (never undeliverable);
- completeness is proven by **demand conservation** — an exact integer identity
  with no maintained count or new lifecycle hooks: the submitted entries'
  `Σ perDayNumeraire18` must equal `totalSideInterestNumeraire18[D]`, because
  the difference-array interest fold writes exactly `±perDayNumeraire18` per
  entry and reward-ineligible loans appear in *neither* sum. A missing user
  keeps the sums unequal and the day incomplete (a missing unit would
  *understate* the liability → under-remit, so completeness is load-bearing;
  it **delays, never zeroes**). Double-counting is barred by a
  strictly-ascending per-(day,side) user-address cursor plus a within-batch
  duplicate-entry guard. (This refines the earlier "active-unit count" sketch —
  a count would need new write hooks on every entry lifecycle path; the
  conservation identity is already maintained by the existing fold.)
- the wire report to Base is a fixed 2-number (per-side) payload — **no Merkle
  commitment-root is needed** because the *mirror diamond itself* computes and
  attests via the authenticated messenger peer (the trust anchor is the peer
  auth, not a root over untrusted detail). This is §M3's "aggregate per-side
  headroom … chunked detail" with the chunking on the *computation*, not the
  wire.

Rejected (per rev-15 §F8): the closed-form upper proxy `min(Σ raw, N×C)` /
pool-bound — it over-pays on partial-bind days and rev-15 documents it as a
non-spec upper bound only. A paged permissionless **active-loan-list** report
(the withdrawn B2-c approach, Codex #1422) stays rejected — the accumulation
batches are keeper-fed and **mirror-verified against own storage**, not a
positional snapshot of a mutable list.

## 2b. Report timing — the finalize-gate contradiction and its resolution (d1)

**Discovered at build time (2026-07-26), decided per the delegated-decision
rule and flagged for owner ratification:** the plan's §M3 sentence *"this gate
must be wired into day-finalization readiness itself"* is **causally
unsatisfiable** for the mirror-liability commitment this design computes:

- The mirror's day-`D` liability prices from `Δ_D` (the day's per-chain funding
  stamp) and `C_side(D)` (the day's per-side D1 caps).
- Both are **outputs of Base's `finalizeDay(D)`**, delivered to mirrors only by
  `broadcastGlobal(D)`, which itself requires `dailyGlobalFinalized[D]`.
- B2-c's armed full-coverage readiness waited for `chainDayCommitments[D].complete`,
  and the d1 ingress draft rejected reports post-finalize (`ReportAfterFinalization`).

Net: finalize(D) waits for a report whose inputs are produced *by* finalize(D).
Once d1 reports honestly, every armed multi-chain day deadlocks into the 4-hour
grace backstop with **every** mirror marked remit-ineligible, forever — total
mechanism failure. The plan sentence predates the owner's B2-c re-slice and the
mirror-unstamped reconciliation (§2): it was written for per-loan **lifetime**
headroom riding the day-close report, which *is* pre-finalize computable for
stamped Base loans — not for a day-`D` **priced liability**, which is not.

**Resolution (the only causally-possible ordering; the plan's GOALS are all
preserved):**

1. **Finalization readiness has no commitment input** (B2-c's readiness gate
   and its `isDayReadyToFinalize` mirror are removed). Armed fast-close =
   full interest coverage, as pre-B2-c.
2. **The gate moves to remittance, where §M3's rule actually binds:**
   ShareOfPool remittance for a `(day, chain)` waits for that chain's COMPLETE
   report (`ChainDayCommitments.complete`, consumed by the d2 gate + clamp).
   A late report **delays, never zeroes** — §M3's rule verbatim.
3. **`remitIneligible` is retargeted** from "commitment-incomplete at finalize"
   (which would now flag every mirror on every armed day) to the case that
   genuinely poisons automatic remittance: an armed-day finalize that **zeroed
   the chain's interest contribution** out of the denominator (grace/force over
   a missing report — the chain's slice was sized without its real demand).
   Operator reconciles + remits manually (B2-c's reconcile surface, unchanged).
4. **The Base ingress accepts reports post-finalize** (that is the normal
   sequence now; no `ReportAfterFinalization` on this path). A zeroed chain's
   late report is also accepted for bookkeeping — but it prices at that
   chain's deliberately-zero funding stamp (Codex #1425 r1), so the operator
   sizes the manual remit from the mirror's locally-readable state (day
   totals + entry set), never from this figure. Membership is checked
   against the DAY's finalized topology evidence (`chainDailyIncluded` /
   `remitIneligible`), not only the mutable expected-chain list.
5. **Mirror send/readiness are armed-gated AND stamp-gated**
   (`sendCommitmentReport` / `isDayCommitmentReady`): an unarmed quiet day is
   trivially "complete" (0 == 0 conservation), and without the armed gate the
   keeper trigger would burn CCIP fees reporting days Base never consults.
   The stamp gate closes the pre-close race: before the mirror's own interest
   close folds day-`D` totals, the day LOOKS quiet (totals 0 ⇒ trivially
   complete) and an irreversible `(0, 0)` report could ship. Stamp arrival
   transitively proves the local close ran (Base can only finalize+broadcast
   once this chain's interest report was included — or the chain was zeroed,
   which is already remit-ineligible).

Timeline on an armed day `D`: mirrors `closeDay(D)` → Base full interest
coverage → `finalizeDay(D)` (caps + stamps + arming) → `broadcastGlobal(D)` →
mirror keeper submits batches → conservation completes → `sendCommitmentReport(D)`
→ Base stores liabilities + `.complete` → d2 remit gate opens for that chain-day.

Plan-conformance: *"never computed from a partial set"* ✓ (remit gate);
*"a missing chunk delays, never zeroes"* ✓ (remit waits; nothing zeroes);
*"permanently underfunds that mirror"* hazard ✓ eliminated (late reports
accepted; remittance waits instead of proceeding partial). Only the gate's
*placement* is amended — finalize-readiness → remittance — because the re-sliced
commitment content made the frozen placement self-contradictory.

## 2c. r1 restructure — the unit is the ENTRY, not the user (Codex #1425 r1)

Three round-1 findings shared one root — the per-user grouping of §2's pick:

1. **Ownership is not frozen** (P1): `repointRewardEntry` rewrites
   `RewardEntry.user` on position transfers/sales, so a per-user capped sum
   fixed at report time can be REGROUPED before the entries become claimable —
   splitting a cap-bound user's entries across owners raises the true
   liability above the once-only report, and the d2 clamp would underfund.
2. **Unbounded per-user set** (P1): the cap-on-whole-rawPay rule forced a
   user's FULL entry set into one cursor slot (one tx), with an O(n²)
   duplicate scan — a sufficiently active user becomes undeliverable and
   wedges conservation.
3. **User discovery is fragile** (P1/P2): D1 `loans.lender/borrower` are
   init-time participants; transferred/intermediate holders own entries too,
   so the keeper's candidate set was NOT a superset, and the empty-scan
   truncation could livelock.

**Resolution — per-ENTRY finest-split liability:**
`liability_side(D) = Σ_covering-entries min(perDay_e × Δ_D / 1e18, C_side)`.
Because `min(a+b, C) ≤ min(a, C) + min(b, C)`, this is the exact supremum of
the per-user capped sum over EVERY possible ownership regrouping: it is
transfer-invariant, can never under-state (the fatal direction), and any
over-reservation (one owner holding several cap-binding entries) is bounded
and swept back by d3's netting. No `paid` term: mirror payouts for an armed
day are `remittedRemaining`-clamped (rev-15), remittance waits for this
report, so `userSideDayPaidVpfi` is structurally zero at report time — and
including it would re-introduce user-keyed (transfer-variant) state. All
three findings dissolve structurally: no grouping to freeze, entries chunk
freely across batches (the ascending entry-id cursor IS the dedup — O(1) per
entry, no quadratic scan, no whole-set rule), and the keeper enumerates the
chain's own sequential entry ids (creation-ordered ⇒ `startDay` monotone ⇒ a
day's scan stops at the first `startDay > D`) — no D1 dependency at all.
Still §M3-conformant: per-unit mirror-verified detail (more granular than
per-user), bounded chunks, delays-never-zeroes. Two send-path guards ride
along from the same round: the send/readiness additionally require the
mirror's OWN interest close (`chainReportSentAt[D] != 0` — a Base grace/force
finalize stamps a mirror whose close never ran, and pre-close the day looks
quiet), and the readiness view now includes the mirror + messenger wiring
preconditions so it is never true where the send would revert. The zeroed
chain's report prices at its deliberately-zero stamp, so operator
reconciliation sizes from mirror-local state, never from the report (§2b
item 4 corrected accordingly).

## 2d. d2 pins — remit gate, clamp mechanics, release semantics, manual path

Recorded at d2 build time (2026-07-26); these are the §1/§3/§4 choices the
record delegated to the implementing PR:

1. **One shared eligibility helper, three call sites.** The remit facet already
   duplicates its day filter across `remitRewardBudget` / `quoteRewardBudget` /
   `quoteRemittanceFee`; the d2 gate + clamp land as ONE internal helper all
   three consume, so `quote == send` holds structurally rather than by
   triplicated logic. Per finalized day the helper yields zeros when: already
   remitted OR terminally closed (below), `remitIneligible`, or — armed days
   only — the destination's commitment report is not `.complete` (§M3's
   "delays, never zeroes": the day simply contributes 0 now and remits once the
   report lands).
2. **Clamp = `min(slice, liabilityLender18 + liabilityBorrower18)`, pro-rata
   apportionment.** Armed, gate-passing days clamp the (CEIL-rounded) slice by
   the reported per-entry liability supremum — safe because §2c's figure can
   never under-state the mirror's eventual payout, so clamping to it can never
   brick a claim (under-funding stays impossible; the removed surplus is
   exactly #1351's "never remit more than reported+backed liability"). The
   clamped total is apportioned across the fresh/recycled funding sources
   pro-rata (floor on fresh, remainder recycled) — the same convention the
   PR-3c combined-cap apportionment already pins.
3. **Terminal day close releases residual commitments.** A clamped day still
   retires/releases its FULL finalize-time commitments: fresh retires whole
   (`consumeArmedFresh(sliceFresh)` — remitted + residual are both dead once
   the day is terminally funded), recycled splits into
   `consume(clampedRecycled)` + `releaseCommitment(residualRecycled)` — else
   `outstandingCommitFresh/Recycled` leak the residuals forever and `fundable`
   under-states availability. A gate-passing armed day whose clamp yields ZERO
   (complete report, zero liability, non-zero slice) is terminally CLOSED
   without funding via the reservation day-marker (`rewardBudgetRemitted` keeps
   amount semantics and cannot mark a zero) so its commitments release and the
   day never lingers half-open. `RecycleSource` gains an appended
   `RemitClampResidual` member for the release event's class vocabulary
   (append-only enum, the #1204 `SpendGatedPerk` precedent). **Codex r1:**
   discovery of close-only days is keeper-visible through a batch planner
   view returning `(amounts, closeable)` per day — an amount-only quote
   cannot distinguish "actionable at zero" from "gated/closed", and a
   keeper reading only amounts would leave zero-clamp days open forever;
   the remit pass plans through it and extends its window over the armed
   range (bounded backscan) so a report completing after the plain
   lookback still funds its day.
4. **Release restores obligations, never value ledgers.** (As amended by
   Codex r4/r5 — this is the FINAL rule; an earlier draft of this pin said
   the emission counters were restored, which r4 retracted.)
   `releaseRemitReservation` (ADMIN, evidenced, for a remit the operator has
   verified can never execute, and gated on-chain by the §M3 reconciliation
   TIMEOUT — a minimum reservation age — so a merely-delayed message cannot
   have its days re-opened while it can still execute) re-opens the
   reservation's days, restores the outstanding fresh + recycled commitments
   (so a re-remit's retirement pairs off exactly), and reverses
   `paidOutRecycled` (seeding the derived cumulative first on an unseeded
   in-place upgrade, so the monotonic credit total never shrinks) — but
   restores NO value counter: `rewardBudgetRemittedGlobal`,
   `rewardBudgetRemittedTotal`, and `recycleBucket` all stay as-sent, because
   the tokens sit locked in the CCIP token pool, genuinely outside Diamond
   custody. A re-remit therefore consumes NEW headroom and NEW backing (two
   real outflows happened).
   Physical recovery (pool → Diamond) is a governance op whose re-credit rides
   d5's Ā-excluded custody-credit class — never a d2 blind re-credit that would
   un-back the bucket. A late ack arriving for a Released reservation is
   surfaced by a dedicated anomaly event (the operator released in error and
   the mirror was double-funded) rather than silently swallowed. **Codex r2,
   sharpened r6 to the NET invariant:** a released recycled-bearing day must
   not RE-REMIT while its backing is stranded — `consume` floors an
   insufficient bucket at zero, so the re-remit would draw its "recycled"
   share from fresh/user custody — and a GROSS bucket check would only
   relocate the stranded hole onto innocent later days (release keeps the
   bucket custody-true while restoring the full outstanding commitment, so
   outstanding deliberately exceeds backing by the stranded amount). All
   four planning sites therefore gate each day on the POST-close invariant
   `bucket' ≥ outstanding'` (running pair: `bucketLeft + recycledFull_day ≥
   outstandingLeft + clamped_day`): while a stranded hole exists, recycled
   remits WAIT for the d5 recovery ceremony; on the healthy path the gate
   never binds (finalize reserves commitments ⊆ fundable). The 69M fresh
   guard is the symmetric NET form — `CAP − remitted − paid −
   (outstandingFresh − retiredByThisClose)` — at the send, the fee quote,
   and the manual path.
5. **Manual-budget path (zeroed chains) is flag-anchored and fresh-funded.**
   `remitManualBudget` (ADMIN-only, payable) requires the `(day, chain)` still
   marked `remitIneligible` — the un-cleared flag IS the on-chain evidence the
   day was zeroed; run the manual remit BEFORE any
   `reconcileCommitmentRemitEligibility` clear (clearing removes the anchor
   and, for a zeroed day, restores nothing fundable anyway — the automatic
   slice is 0 forever). The amount is operator-sized from mirror-local state
   (§2b item 4), funded FRESH under the 69M `RewardPoolCapExceeded` guard (a
   zeroed day stamped no recycled funding for the chain, so a recycled draw
   has no backing figure), reserves into the ledger, rides the same token
   channel with a `remitId`, and finalizes on ack like any remit. It does not
   retire armed-fresh commitments (a zeroed chain's share was never committed
   at finalize — its numerator was excluded from the globals).

## 2e. d3 pins — arrival COMMITS (not debits), per-chain books, netting

Recorded at d3 build time (2026-07-26). §1 sketched the arrival step as a
mirror-side `LibVpfiRecycle.consume(recycleConsume)` — a bucket DEBIT. The
scout showed that reading is wrong, and plan §M3 (authoritative; this record
defers to it) states the correct rule verbatim: **"commitment semantics
(broadcast *commits*; bucket debited pro-rata at claim/remit)"**.

1. **Why a debit-at-arrival would have been a bug (the scout's evidence for
   the plan's rule).** `LibVpfiRecycle.consume` is ALREADY called on every
   chain at claim time (`RewardClaimFacet` — `consume(paidRecycled)`), because
   a mirror's recycled-funded payouts debit its bucket as users claim. Had the
   mirror ALSO consumed `recycleConsume` at broadcast arrival, the same tokens
   would be debited twice: the bucket ledger drains at 2× (flooring at zero,
   silently under-backing) and `paidOutRecycled` double-counts — which inflates
   the DERIVED `creditedCumulative` floor (`bucket + paidOut`) and therefore
   OVER-states that chain's availability to Base. Over-statement is the unsafe
   direction, and it is the same class the d2 r5 review caught on the release
   path. §1's wording is superseded by this section.
2. **Arrival = commitment.** The mirror's V2 ingress reserves the instructed
   figure into its OWN `outstandingCommitRecycled` (the existing primitive,
   under its OWN once-only flag `mirrorRecycleCommitReserved`, NOT the
   whole-day `broadcastV2Applied` stamp this line first claimed — Codex
   #1430 r4: a day whose broadcast was applied by a PRE-d3 implementation
   set `broadcastV2Applied` without reserving, so gating on that stamp
   would skip its reservation permanently; a separate flag lets a later
   replay complete it exactly once). The bucket
   is untouched at arrival; it drains through the unchanged claim/remit
   `consume` sites, and a forfeit/expiry releases the un-drawn remainder
   through the unchanged `releaseCommitment` path. So the mirror runs exactly
   the reserve → consume → release lifecycle Base already runs, with zero new
   ledger primitives, zero change to `consume`, and zero change to the
   `creditedCumulative` derivation (the r5 landmine stays untouched).
3. **Base's per-chain books.** At finalization Base books the mirror-funded
   share into BOTH per-chain ledgers: `chainConsumedRecycled[c] += commitLocal`
   (the INSTRUCTION cumulative — exactly what the B1 storage comment defines
   the field as, and the hard availability backstop) and
   `chainOutstandingRecycledCommit[c] += commitLocal` (§5's local-slice
   reservation ledger, the per-chain sibling of the global
   `outstandingCommitRecycled`). Availability nets by the INSTRUCTION only —
   `availRecycled[c] = chainReportedRecycled[c] − chainConsumedRecycled[c]`,
   per the B1 comment — so the two books are not double-subtracted; the
   reservation ledger is what B3's netting retires once a mirror-consumption
   signal exists (Base cannot observe mirror claims in d3). The §7 invariant
   `consumed ≤ reported` binds non-trivially from this slice on, enforced by
   the pass-1 availability cap.
   **Direction of any drift is conservative:** un-claimed mirror commitments
   leave Base counting more instructed than the mirror eventually spends, so
   Base UNDER-states that chain's availability and under-funds it — never the
   reverse.
4. **Two-pass funding turns on for mirrors.** Pass 1's `c.avail` becomes
   `reported − consumed` for a mirror (Base's model of its committable
   bucket); Base's own `_recycleFundable` is unchanged. `_stampOne` splits the
   #1008-capped commit pro-rata by funding source — `commitLocal =
   commit × localTotal / fundedTotal` (floor), `reservedBase = commit −
   commitLocal` — so §5's "one bucket, one ledger" holds by construction: the
   local share books into the per-chain ledgers, the Base-funded share into the
   global `outstandingCommitRecycled`, never both.
6. **The remitted top-up has no bucket backing on the mirror — d5's job, and
   it re-orders the slices (Codex r3).** A mirror's claim path debits its
   bucket for the whole recycled payout, but only the locally-funded share was
   ever credited there; the Base-funded top-up arrives as VPFI without a
   bucket credit. Once mirror armed claims are reachable that over-counts
   `paidOutRecycled` and the derived `creditedCumulative` reports Base-funded
   tokens as local absorption — phantom availability Base re-commits. It is
   NOT reachable in d3 (the `_dayPoolHalves` halt keeps mirror armed-day
   claims off), and the fix is the one §M3 already specifies — d5's
   `Ā`-excluded remit-arrival custody credit. Recorded consequence: **d5 now
   sequences BEFORE d4**, and d4 carries a hard gate saying so (§1).

5c. **Per-SIDE clamping (Codex r3).** The clamp runs per reward side, not on
   the summed liability: the mirror reports `liabilityLender18` /
   `liabilityBorrower18` separately and the two sides carry genuinely
   different fresh:recycled compositions, so collapsing them first misprices
   whichever leg the liability concentrates on (a fresh-heavy lender side
   paired with a recycled-heavy borrower side gets too little fresh, and the
   local recycled backing then nets a remainder it cannot actually fund). The
   single stamped local commitment is apportioned across the sides pro-rata to
   their GROSS recycled budgets — the basis it was computed on at
   finalization.

5b. **The remit CLAMP nets local backing PER FUNDING SOURCE (Codex r1→r2).**
   d2's clamp bounds the remittance by the mirror's reported liability. Under
   d3 part of that liability is already backed by the chain's own locally
   committed RECYCLED share, so the clamp must net it — but only against the
   matching source. The mirror's claim path splits every payout pro-rata over
   the day's fresh:recycled composition (`_splitDayAmount`), so local recycled
   backing can cover the recycled leg and never the fresh leg (Base funds all
   fresh). `_planDay` therefore splits the liability by the GROSS composition
   (the pool claims actually price against, local share included) and
   subtracts the local backing from the recycled leg alone. Netting against
   the aggregate instead — r1's first cut — treats local recycled VPFI as
   backing fresh claims: on a 90-fresh/10-recycled pool with a local commit of
   10 and a liability of 5 it remits ZERO while ~4.5 of fresh claims still
   need backing, on a day that then closes terminally.

5. **Two-sided netting = subtract the instruction.** `chainRewardBudgetSplitForDay`
   nets the stamped `recycleConsume` out of the chain's recycled budget
   (floored at zero), so Base remits only the TOP-UP it actually funded. Sum
   identity: `mirror-committed (recycleConsume) + Base-remitted
   (budgetRecycled − recycleConsume) = the funded recycled slice`. Netting
   lands INSIDE the split helper — below d2's `_planDay` — so all four planning
   sites inherit it, and d2's net backing gate keeps comparing the Base-funded
   share against Base's own bucket, which is exactly what funds it. The fresh
   side is untouched (Base funds all fresh).

## 2f. d5 pins — where the custody credit lands, and how wide its exclusion must be

Scouted against the merged d3 code (`bf2b97cc`) before writing any d5 code.
Two of these pins **correct earlier wording in this document and in plan
§M3** — both were written before d3 made mirror availability live, and
following either literally now would reintroduce an over-statement.

1. **The credit lands at REMIT ARRIVAL, not at mirror forfeit/expiry.**
   Plan §M3 (~line 446) words it as *"the remitted-recycled share of a mirror
   forfeit/expiry credits the mirror bucket"*. The code says arrival:
   `RewardClaimFacet` debits the bucket for the WHOLE recycled payout
   (`consume(paidRecycled)`, no funding-source split), while
   `RewardRemittanceFacet.onRewardBudgetReceived` only advances
   `rewardBudgetReceivedTotal` and never touches `recycleBucket`. So the
   bucket must already hold the Base-funded share by claim time, and only an
   arrival credit puts it there. This is also exactly what closes the
   Codex #1430 r3 F2 hazard that produced the d5-before-d4 ordering gate.

   Consequence: **the 3-site forfeit/expiry reclassification largely
   dissolves.** Once the remitted share is credited at arrival, a
   remitted-recycled forfeit/expiry is a *pure commitment release* — the
   tokens are already in the bucket — which is precisely what
   `InteractionRewardsFacet` / `RewardClaimFacet` already do for the
   recycled share. d5 keeps those call sites and adds the provenance the
   §1/P6 row asked for, rather than a three-way split at each site.

2. **⚠ The exclusion must cover the REPORTED CUMULATIVE, not just the `Ā`
   day-bucket. This supersedes §5's "No manufactured `Ā`" bullet**, which
   says the custody credit advances `recycleBucket` **and**
   `recycleCreditedCumulative` while skipping `recycledCreditedByDay`. That
   was safe when B2-b forced mirror `avail = 0`. After d3 it is not, by two
   independent paths:

   - **Availability.** The day-close report sends
     `LibVpfiRecycle.creditedCumulative(s)`; `recordChainRecycled` ratchets
     `chainReportedRecycled[c]` to it; d3's `_mirrorAvailable` computes
     `reported − consumed` and offers the difference to Base as that
     mirror's committable local funding. Worked example — mirror bucket 40
     local, day-D recycled liability 63 (40 local + 23 Base top-up): arrival
     credit → bucket 63, reported 63, while `chainConsumedRecycled` is 40, so
     day D+1 shows `avail = 23`. Base commits its OWN already-spent top-up a
     second time as mirror-local funding and remits nothing against it,
     while M's bucket is actually empty after D's claims.
   - **`Ā` headroom.** `recordChainRecycled`'s aggregate consistency clamp
     accepts `min(forDayReported, reported − attributed)`. An inflated
     `reported` widens that headroom, so custody tokens leak into `Ā`
     *through the clamp* even with `recycledCreditedByDay` correctly
     skipped. Skipping the day-bucket alone is therefore not sufficient.

   Both are the over-statement direction — the same class as the d2 r5
   finding and §2e.1's arrival-COMMITS correction.

3. **Mechanism: a `recycleCustodyRelocatedCumulative` counter subtracted from
   the derived floor.** `creditedCumulative()` is
   `max(stored, recycleBucket + paidOutRecycled)`, so a custody credit that
   raises the bucket leaks into the reported cumulative **through the
   pre-upgrade floor even if `recycleCreditedCumulative` is never written** —
   the counter must be subtracted, not merely left unwritten. The custody
   credit therefore advances `recycleBucket` + `recycleCustodyRelocatedCumulative`
   ONLY, and the floor becomes
   `recycleBucket + paidOutRecycled − recycleCustodyRelocatedCumulative`.

   Same worked example: stored 40, bucket 63, paidOut 0, custody 23 →
   floor `63 + 0 − 23 = 40` → reports 40, so `avail = 40 − 40 = 0`. After D's
   claims consume 63: bucket 0, paidOut 63, custody 23 → floor
   `0 + 63 − 23 = 40` → still 40, the mirror's genuine lifetime absorption.

   **Underflow is structurally impossible**, so the subtraction needs no
   special-casing beyond a saturating guard for defence in depth: every
   custody credit adds its amount to `recycleBucket`, and `consume` only
   moves value bucket → `paidOutRecycled` (`releaseCommitment` moves
   neither), so `recycleBucket + paidOutRecycled` is monotonically
   non-decreasing and always dominates the custody counter.

   This keeps §5's *one bucket, one ledger* property — there is still exactly
   one bucket, with one extra scalar recording how much of it is relocated
   custody rather than first-time absorption.

4. **The recycled share must ride the wire — it cannot be re-derived.**
   `remitRewardBudget` accumulates `st.fresh` / `st.recycled` separately but
   sends only their sum, and a mirror cannot reconstruct the split because
   `p.recycled` is computed AFTER Base's Σcommitments clamp — Base-global
   state the mirror cannot observe — so any reconstruction would diverge
   exactly when the clamp binds. d5 therefore adds one word to the remit
   payload, per the owner-confirmed plan §7 wire rule (derive the layout
   from the union at implementation time; the implementing PR pins the
   words).

   **The d5 shape LEADS with an explicit tag — it does NOT extend the
   head-offset ladder.** (Corrected in review, Codex #1432 r2; the first cut
   of this section proposed **0xA0** as a third rung and that is unsafe.)

   The two older shapes are discriminated by the leading ABI head word — the
   `dayIds` array offset, `32 × head-slots`: **0x40** legacy · **0x80** d2
   `(+ remitId, remitter)`. Adding **0xA0** for d5 looks like the same
   pattern but breaks across the **rollout window**: the canonical chain is
   refreshed before the mirrors, and in between, a not-yet-upgraded receiver
   reads `0xA0`, fails its `== 0x80` test, falls into the legacy branch —
   and because `0xA0` is a perfectly valid in-bounds array offset, the decode
   **succeeds**. It drops `remitId` / `remitter` / `recycledShare`, forwards
   through the retired ingress selector, strands the canonical reservation
   Pending and applies no custody credit. Silently, and on every rollout.

   So d5's payload is
   `abi.encode(REMIT_WIRE_TAG_D5, dayIds, total, remitId, remitter,
   recycledShare)` (`RemitWire.sol`). The tag is keccak-derived, hence
   astronomically larger than any real payload length, so an old receiver
   reads it as the array offset, the decoder's bounds check fails, and the
   delivery **reverts** — deterministically, not probabilistically (a small
   sentinel could land on a valid offset; this cannot). CCIP records a failed
   message, re-executable once that mirror is upgraded, so nothing is lost.

   The wire is therefore version-gated **by construction**: no operator flag,
   no "refresh mirrors first" rule to remember, and no way for a partial
   rollout to under-credit silently — the same fail-closed posture the
   cross-chain pause lever relies on. Both older layouts still decode (with
   `recycledShare = 0`, i.e. the pre-d5 behaviour) and both get an explicit
   test, as does the fail-closed property itself.

   **Future wire evolutions take a NEW tag, never another rung on the
   offset ladder.**

## 2g. d4 pins — the halt STAYS; two prerequisites remain (#1434)

§1 scopes d4 as "remove the `_dayPoolHalves` halt; keep the genuine `!stamped`
wait". **That scope turned out to be incomplete, and d4 was WITHDRAWN** (owner
decision after Codex #1433 r2: defer, keep the halt fail-closed, file a
follow-up). The halt remains in the tree. This section records why, and the two
approaches tried and dropped along the way, so neither is repeated.

**What d5 DID discharge.** The halt's originally-documented cause was that a
mirror's remitted recycled funding never credited its local bucket. B2-d5 fixed
exactly that. The recycled leg is safe for a second reason too: the ShareOfPool
walk budgets it against the LIVE bucket (`ctx.pool.recycled = s.recycleBucket`,
mirrored by the preview) and defers a day it cannot cover, so a recycled
shortfall never reaches `LibVpfiRecycle.consume` (which FLOORS at zero rather
than reverting). That check sits one layer ABOVE the consume site — which is why
reading only the consume site makes it look absent, and why my first cut
invented a hazard that did not exist.

**What d5 did NOT discharge — the two prerequisites (Codex #1433 r2, both P1).**

1. **The FRESH side has no delivered-funding bound on a mirror.** Fresh is
   entirely Base-funded and arrives with the remit, but the walk bounds it only
   by `poolRemaining()` — on a mirror that is the GLOBAL 69M cap less LOCAL
   payouts, not what has been received. Lifting the halt would let a mirror pay
   fresh before its remit lands, out of VPFI the Diamond holds for other
   obligations (LIF custody, earlier days' unclaimed budget). My r1 claim that
   "the walk already budgets it" was true only of the RECYCLED leg; I
   generalised across legs without checking.

   **Fix shape — and a delivered-fresh budget alone is NOT enough** (Codex
   #1433 r6). Giving `PoolBudget.fresh` a delivered-fresh budget on mirrors
   (received − locally paid out) supplies the missing VALUE bound, but the
   fresh path's SEMANTICS are wrong for it: a fresh shortage is handled as
   TRUNCATION, and the truncated remainder is consumed terminally. That is
   correct on Base — `remaining` there is `CAP − paidOut − remittedGlobal`,
   both subtrahends append-only, so the pool is monotone non-increasing and a
   trimmed remainder is unfundable forever ("there is no future state that
   could pay it"). On a MIRROR the delivered budget **grows with every remit**,
   so the same trim would permanently underpay a day whose funding was merely
   still in flight. So prerequisite 1 is two parts: the delivered-fresh
   **bound**, and **deferral rather than truncation** when a mirror's fresh
   budget is short — matching the recycled side, whose shortfall already
   defers.
2. **Deliberately-zeroed days would retire entries for zero.** A grace/force
   finalization that excludes a mirror's interest report broadcasts an all-zero
   stamp and marks the day `remitIneligible` for later operator-sized funding.
   With the halt gone the mirror advances its cursor at zero delta,
   `processUserSideDay` treats `rawPay == 0` as terminal progress and persists
   the cursor — so entries are retired BEFORE `remitManualBudget` can
   compensate them.

   **Not-priced is necessary but NOT sufficient** (Codex #1433 r4). Suppressing
   the day only stops it being *burned*; it does not make it *payable* once the
   compensation lands. `remitManualBudget` sends a total plus a `dayId`, and
   `onRewardBudgetReceived` merely increments `rewardBudgetReceivedTotal` — it
   never writes the mirror's `chainDayRecycledFunding` stamp. So after
   compensation the stamp is still all-zero and the day still prices at zero;
   the tokens arrive with no path into the claim math. The manual path
   therefore needs a **repricing** step, not just an exclusion:

   - the mirror must be able to tell a deliberately-zeroed day from a
     genuinely-zero one — a mirror-observable signal, likely a broadcast field,
     and per §2f.4 a wire evolution takes a **NEW TAG**, never another rung on
     the offset ladder; **and**
   - the compensation must carry (or authorise) the per-side funding figures
     that replace that day's zero stamp, so the day becomes priceable at the
     operator-sized amount. Whatever writes that stamp is a fund-moving,
     operator-driven path into pricing and needs the same evidence discipline
     as the rest of d2's manual vehicle.

   Until BOTH exist, a zeroed day must stay unpriced rather than be walked.

**The withdrawn approach, and why it was worse than the problem** (Codex #1433
r1 — 4×P1 + 1×P2 on one mechanism). I gated pricing on a per-day
`mirrorDayBudgetReceived` marker set from the remit's `dayIds`:

- **it wedges the cursor permanently.** `advanceCumLenderThrough` does
  `if (halt) break;`. Base does NOT remit every armed day — `_planDay` closes a
  fully mirror-local recycled day, and a liability-clamped-to-zero day, with
  `p.fresh + p.recycled == 0` and never adds them to `fundedDays`. Such a day
  could never be marked, so it would halt forever and block every LATER day's
  claims on that mirror. My "the gate cannot strand a payable day" claim was
  simply false.
- **it breaks the destination gas budget.** One cold `SSTORE` per day against
  the fixed `REWARD_BUDGET_DEST_GAS_LIMIT` of 300,000; the keeper batches by
  VPFI value over a 45-day window, so the marker writes alone can exceed the
  callback allowance — the delivery then fails AFTER Base closed the days and
  put the tokens in flight.
- **it is not bound to the remitter deployment.** d2 keys receipts by
  `(remitter, remitId)` precisely because a delayed pre-rotation packet cannot
  be identified from delivery-time config; a day-only flag lets such a packet
  unlock the current era's stamp.
- **it unlocks the zeroed-chain manual path.** A `remitIneligible` day is
  stamped all-zero by design, and `remitManualBudget` later sends an
  operator-sized FRESH amount carrying that day — the marker would make a zero
  stamp priceable, advancing the cursor and retiring entries for nothing.
- **it over-marks a short delivery.** The receiver's fee-on-transfer path
  forwards `actualReceived` and scales `recycledShare`, but the loop marked
  every declared day fully backed.

**Pin: no arrival-marker gate.** An arrival EVENT is the wrong proxy for a
backing VALUE. When the halt does eventually lift (#1434), the fresh-side
prerequisite must be met with a delivered-funding BUDGET in `PoolBudget.fresh`,
matching the recycled side's existing shape — not with a per-day flag.

**Pin: a backing refusal must be a pool-budget DEFERRAL, never a
`_dayPoolHalves` halt.** Both stop at the offending day — `processUserSideDay`
returns `advanced == false`, `_walkSideDays` breaks, and `_lowestPendingDay`
re-selects that same oldest day next attempt, so later days genuinely do wait.
The difference is RECOVERABILITY, and it is what makes one shape acceptable and
the other not:

- a pool-budget deferral clears as soon as the backing arrives, and for a funded
  day it always does;
- a `_dayPoolHalves` halt keyed on a signal that may NEVER arrive is permanent.
  That is what killed the arrival marker: Base does not remit every armed day
  (`_planDay` closes a fully mirror-local recycled day, and a
  liability-clamped-to-zero day, with `p.fresh + p.recycled == 0` and never adds
  them to `fundedDays`), so those days would have blocked their mirror forever.

So the test is not "does it stop the cursor" — both do — but "can the condition
that stopped it always be satisfied".

## 2h. P2 scope — the zeroed-day signal and its repricing vehicle (#1434)

§2g states the two prerequisites. Prerequisite 1's **receipt** half shipped as
P1-a (#1556, `41d4538a4`); its paid half and the deferral semantics are P1-b.
This section scopes **prerequisite 2**, which is what actually gates lifting
the halt. **The lapse decision it opened with is now RATIFIED** (#1571,
2026-08-04) and appears below as R1-R6; treat those as settled premises. What
remains deferred is the detailed design, which belongs in its own document —
so this section is a ratified premise plus a constraint set, not a design.

### The mechanism, traced (verified against the tree at `41d4538a4`)

1. A mirror's per-(day, chain) funding stamp is written **at broadcast
   arrival**, in `RewardReporterFacet`, as a whole-struct assignment with
   `stamped: true` — including its per-side fresh and recycled halves.
2. For a chain excluded from the day's interest report at grace/force
   finalization, those halves are **all zero**. The stamp is still `stamped`.
3. `_dayPoolHalves` gates only on `f.stamped`. A stamped all-zero day is
   therefore **priceable at zero**, not halted — the halt that currently saves
   it is the blanket `isMirrorRewardChain` one, which is what P2 removes.
4. Zero halves ⇒ zero RPN delta ⇒ `rawPay == 0`, which `processUserSideDay`
   treats as terminal progress: it persists the cursor and retires the day's
   entries. For zero.
5. `remitManualBudget` later sends the operator-sized compensation. It is
   **fresh-only by construction** (`r.fresh = amount`, `recycledShare: 0`),
   carries exactly the one `dayId`, and goes through the ordinary
   `_sendRemitPayload`/d5 path. `onRewardBudgetReceived` **never writes
   `chainDayRecycledFunding`** — so after compensation the stamp is still
   all-zero, the day still prices at zero, and the tokens have no path into
   the claim math.

So the tokens arrive and the entries are already gone. Both halves of §2g's
prerequisite 2 are needed: a signal, *and* a vehicle that rewrites the stamp.

### Why this section stops here — and what replaces it

**Three adversarial rounds on this section produced SIXTEEN P1s, every one
confirmed against the tree.** (Counted from the API, not from notifications —
an earlier pass called round three "six" and missed one, which is the same
class of error as several of the findings themselves.) Two of them retracted claims this section itself
had made a round earlier. The rate never fell.

That is not a drafting problem, and one more round would not fix it. It is the
section discovering that prerequisite 2 is **a subsystem, not a slice** — and
that authoring it inline, one review round at a time, is the wrong instrument.
Each round I proposed a mechanism; each round review found the mechanism
contradicted something already in the tree, or something written two paragraphs
above it. A design that needs sixteen corrections to reach a first draft needs
a different starting point, not a seventeenth correction.

**So this section deliberately does NOT contain a design.** It contains the
verified problem statement above, the constraint set below, and — since
2026-08-04 — the **ratified answer** (R1-R6) to the decision that gated all of
it. **The design is deferred to its own document, and that document starts from
R1-R6** rather than from another revision here.

What the withdrawn revisions got wrong is recorded, because each is a
constraint the eventual design must satisfy and re-deriving them costs another
review cycle.

### Constraints the P2 design must satisfy — all verified against the tree

**On suppression:**

1. The suppression must be a `_dayPoolHalves` **HALT**, not a pool-budget
   deferral. `advanceCumLenderThrough` folds each day's halves into a **stored**
   cumulative (`s.cumLenderRpn18[d] = next`) and advances its frontier; only
   `if (halt) break;` prevents the fold, and nothing walks backwards. A later
   rewrite cannot unwind a cumulative that has already absorbed the zero.
2. §2g's pin against halts is therefore **satisfied, not overridden** — but
   only if the halt has a guaranteed terminal reachable without a privileged
   actor. The pin's own test ("can the condition that stopped it always be
   satisfied?") is what any proposal must pass.
3. **Two operator-gated exits are one operator-gated exit.** A "compensate or
   the operator confirms zero" pair does not bound the wait; both branches need
   a transaction from the same discretionary party whose silence caused the
   problem.

**On the state model:**

4. Broadcast progress and funding progress are **orthogonal**. A linear chain
   is self-contradictory: compensation must be able to land while the mirror is
   still `unstamped`, which a chain rooted at the pending marker forbids.
5. The model must include the **ordinary, non-zeroed day** — where the funding
   halves arrive in the canonical broadcast itself. A two-axis draft that halts
   until "both axes settle" halts every ordinary day unless a
   broadcast-funded terminal exists.
6. Transitions must be monotonic, replay-safe, and delivery-order-independent
   in both directions. The stamp is written today as a **whole-struct
   assignment**, which is exactly where this breaks.

**On the clock:**

7. There is **no authenticated finalization time** anywhere today —
   `RewardBroadcastV2` carries no timestamp and neither does `ChainDayFunding`.
   Local receipt makes any deadline a function of CCIP delay; the nominal day
   boundary lets a late grace/force finalization arrive already expired.
8. Base must **refuse to dispatch** a manual compensation at or after the
   authenticated expiry. Today `remitManualBudget` gates only on
   `remitIneligible` and the close markers, so an admin can create a
   compensation that is guaranteed never to be able to reprice anything.

**On the in-flight race — and why NEITHER option is currently viable:**

9. Compensation dispatched before expiry can be **delivered after** a lapse,
   and no window length bounds cross-chain latency.
10. The **Base-authoritative** branch, as sketched, loses bounded liveness:
    both `finalizeRemitReservation` and `releaseRemitReservation` are
    `onlyRole(ADMIN_ROLE)`, so if the admin becomes unavailable while a message
    sits failed-but-re-executable, the reservation stays Pending and the day
    never lapses. It needs a permissionless terminal backed by authenticated
    non-delivery evidence, or it must be stated as sacrificing the invariant.
11. The **mirror-local** branch's recovery, as sketched, was wrong:
    `releaseRemitReservation` is for a send that can NEVER execute. A late
    compensation *has* executed and its receipt ACKs the reservation, so the
    release either reverts or violates its own precondition and re-opens the
    day for a second manual remit after the first has landed. Recovery must
    **finalize/ACK** the original reservation, keep the day closed, and
    repatriate the stranded tokens through an explicit delivered-after-lapse
    path.

**On the wire — it is THREE paths, not one and not two:**

12. The zeroed marker, the authenticated `finalizedAt` and the R5 schedule
    version are known at day finalization and travel through
    `VaipakamRewardMessenger._encodeBroadcastV2`. The armed-fresh-dispatched
    figure and the per-side compensation amounts are known at token dispatch
    and travel through `RewardRemittanceFacet._sendRemitPayload` →
    `RewardRemittanceReceiver`. **Independent messages, independent decoders,
    independent rollout compatibility.** An earlier revision recommended
    putting them all on "the same tag"; that would leave one path unversioned.

12a. **R4's fresh-return is a THIRD wire path** (Codex #1573 r3 P1). Once R4
    stopped routing through C2, the mirror→Base return became its own message —
    it must carry enough authenticated identity to reverse the original remit
    accounting, and R4 explicitly forbids reusing C2's. It therefore needs its
    own payload kind, decoder and rollout compatibility. An earlier revision
    kept saying "two evolutions" *after* making the change that created the
    third, which would let a P2 implementation and rollout plan omit **the very
    receiver that makes late arrivals recoverable**. Three versioned changes,
    each with its own rollout test.

12b. **Legacy zeroed-day broadcasts need an inventory/backfill or an activation
    gate, not just a decoder test** (Codex #1573 r3 P1). At activation, a
    zeroed day whose V2 broadcast has already landed — or is still in flight —
    carries neither `finalizedAt` nor the R5 schedule version.
    `broadcastV2Applied[dayId]` makes an applied day whole-day idempotent while
    backward decoding still admits an old in-flight packet, so no rollout test
    can populate the missing per-day clock afterwards. Treating the default as
    valid **lapses the day immediately**; rejecting it **halts the cursor
    indefinitely**. Constraint 19 migrates legacy *compensations* only — this is
    the broadcast half, and it needs its own answer.

**On binding a component to its target:**

15. The compensation figures — **the authenticated amount under R1**, not
    halves — must be bound to **exactly one** day. The new
    remittance generation is shared with the ordinary batched path, whose
    payload carries many `dayIds`, and a per-delivery sum bound does **not**
    stop an implementation writing the same bounded pair into every listed
    stamp — multiplying claimable funding by the batch length from one
    transfer. Carry an explicit compensation-day discriminator, require it to
    name a single manual-eligible day, and require the figures to be zero on
    an ordinary multi-day batch, all before any stamp is rewritten.

**On every new component of a delivery:**

13. It inherits **short-delivery scaling** (`actualReceived / declaredTotal`)
    and a **joint bound** against its siblings, by default — the burden is on
    stating an exception. Several of the sixteen were this one omission
    recurring on each newly-proposed field.
14. The armed-fresh-dispatched figure is **not** `st.armedFresh` /
    `r.armedFreshFull`: those are the PRE-clamp commitment retired at close,
    and `RewardRemitLedgerTest` asserts `r.armedFreshFull > r.fresh` directly.
    It needs a new accumulator over the post-clamp `p.fresh` on armed days —
    **and `remitManualBudget` must populate it too**, since it builds its
    dispatch directly and has no `p`. A default zero there would make the
    compensation's own authenticated amount priceable while never raising the
    mirror's delivered-fresh budget, so P1-b would defer the very payout the
    compensation funded.

**On repricing actually making the day PAYABLE:**

17. **Rewriting the stamp may not be sufficient.** The day's payout is
    `perDayNumeraire18 × Δ_d`, and `Δ_d` divides the funding half by the
    **global interest denominator frozen at finalization**. If the excluded
    mirror supplied the only interest on a side, that denominator is **zero**
    and the delta stays zero however the halves are rewritten. If it is
    non-zero it contains only *other* chains' interest, so the compensated
    day is scaled by an unrelated `localInterest / globalInterest` ratio
    rather than by the operator-sized amount. The repricing vehicle needs a
    mirror-specific denominator, a directly authenticated delta, or another
    normalization — **not just replacement halves.** This is the constraint
    most likely to change the vehicle's shape, so settle it early.

18. **Do NOT scale the authenticated compensation amount itself** (halves in
    the pre-R1 wording) — scale only the backing credit. This is the one place constraint 13's default is wrong,
    and the exception is exactly why 13 requires exceptions to be stated.
    The halves become the day's **pricing obligation**: once the cumulative
    folds reduced halves, `processUserSideDay` retires the entries at the
    reduced payout, and the delivered-fresh budget exactly covers that
    scaled claim — so §2g's deferral never fires, while the manual remit has
    already closed the day against another ordinary compensation. A
    fee-on-transfer shortfall would become **permanent user underpayment**
    instead of recoverable back-pressure. Preserve the intended halves behind
    the budget gate, or define a supplemental-funding transition before
    pricing goes terminal.

**On rollout:**

19. **Legacy manual compensations must be drained or backfilled.** A d5
    manual compensation that is pending, in flight, or already received when
    P2 activates carries no compensation discriminator and no replacement
    halves. The upgraded receiver still accepts that shape and its ACK closes
    the Base day, but the mirror has no authenticated values to rewrite the
    zero stamp with, and cannot request the ordinary manual path again — so
    the day's only terminal is lapse-and-underpay. A rollout *test* does not
    cover this. Activation must inventory and drain legacy manual
    reservations/receipts, or specify an authenticated backfill.

20. **Bind the broadcast to its originating Base deployment.** A delayed
    packet from a retired deployment can install its zeroed marker and expiry
    under the new era, then combine with compensation sent by the *new*
    remitter for the same day. `CcipMessenger._ccipReceive` authenticates the
    remote adapter but derives `sourceSender` from the current
    `channelPeerOf`, and `VaipakamRewardMessenger.onCrossChainMessage`
    ignores it. d2 already solved this for remit ACKs by carrying immutable
    deployment identity **in the payload** and keying receipts on
    `(remitter, remitId)`; the broadcast evolution must do the same, and both
    state axes must bind to the same deployment/era.

> **READING THE CONSTRAINTS AFTER R1.** Constraints 13-19 were written while
> the vehicle was still *replacement halves*. R1 retired that vehicle, and the
> constraints have been reworded to match — but the RULES are unchanged and
> each still binds: single-day binding (15), no scaling of the pricing
> obligation (18), receipt-time scaling and joint bounds for every delivery
> component (13), the manual path populating the armed-fresh accumulator (14),
> and the legacy-drain requirement (19). A constraint that still reads in
> halves terms is a **drafting miss, not an exemption** — apply it to the
> authenticated amount (Codex #1573 r1 P1).

### ✅ RATIFIED 2026-08-04 — the lapse decision, and what it settles

The question this section opened with — *who lapses a zeroed day, and how does
the in-flight compensation race resolve* — was **decided by the owner on
2026-08-04** (#1571), together with a standing instruction to take the
**architecturally clean** route where clean and expedient diverge.

**Ratified: a MIRROR-LOCAL PERMISSIONLESS LAPSE, in six parts (R1-R6), with
the sub-rules R1a-R1c and R4a that review established as inseparable from
them.** The count is stated because it has drifted twice: the first draft said
"four" before R5 was added, and said "five" before R6. A reader trusting a
stale header would have skipped the cross-chain schedule requirement, then the
stranding bound.

**R1. Repricing carries TWO AUTHENTICATED PER-SIDE AMOUNTS, not replacement
halves.** This is what makes constraint 17 tractable rather than fatal, and it
is the clean route rather than the expedient one. Splitting 17 into its two
cases shows why halves cannot be the vehicle:

- *denominator > 0* — an operator could still reach an intended total by
  solving for the half rather than setting it to the amount they mean to send.
  Arithmetically possible; operationally a trap, because the number an operator
  types stops being the number they intend.
- *denominator = 0* — the excluded mirror supplied the only interest on that
  side. **No half produces any payout, ever.** Entirely reachable on a young
  mesh with few chains.

A delta sidesteps the frozen denominator completely. **Do not build the vehicle
on halves.**

**R1a — a delta alone does NOT remove the operator solve; the conversion
contract is part of R1** (Codex #1573 r1 P1). The payout is still
`localInterest × Δ / 1e18`, so an operator targeting a VPFI *amount* would have
to derive Δ from the mirror's own day interest — which **Base does not hold**.
Left there, R1 merely renames solve-for-the-half to solve-for-the-delta, and
lets the authenticated pricing obligation drift from the delivered backing.

So the ratified shape is: **the wire carries an authenticated AMOUNT, and the
MIRROR derives Δ locally from its own day interest.** That amount is the
**declared pricing obligation**, not a statement about what physically lands —
R1b preserves it unscaled on a short receipt while backing is only
`actualReceived`, so equating the two would either reject a valid short receipt
or overstate backing (Codex #1573 r4). The conversion happens where its input
actually lives, and neither party solves for anything.
Any alternative must pin an authenticated local denominator explicitly — an
unpinned conversion is the footgun, not the delta.

**The conversion must be defined at its edges** (Codex #1573 r4).
`Δ = amount × 1e18 / localInterest` is **undefined** for a non-zero side amount
against **zero** local interest, and for non-dividing values **no integer Δ
reproduces the amount exactly** — flooring silently underpays the preserved
obligation, rounding up exceeds its backing and parks the day behind the budget
gate. So: a **zero-interest side must carry a zero amount** (or another stated
terminal), and the rounding direction plus the residual's disposition must be
pinned rather than left to the implementer.

**R1b — it must be TWO amounts, one per side, jointly bounded by the delivery**
(Codex #1573 r2 P1). A first draft of R1a authenticated a *single* amount while
R1 still spoke of a *per-side* delta, and `remitManualBudget` carries one
scalar total. Whenever lender and borrower local interest are both non-zero,
one scalar does **not** determine `Δ_lender` and `Δ_borrower`: different splits
pay different users off identical backing, and nothing on the wire says which
split was intended.

Two authenticated side amounts remove the ambiguity at the source rather than
introducing an allocation rule that both domains must implement identically and
neither can verify. It is also the shape everything adjacent already uses —
`fundedLender`/`fundedBorrower`, `freshLenderHalf`/`freshBorrowerHalf`,
`liabilityLender18`/`liabilityBorrower18` — so it adds no new concept.

**Their sum is bounded against the DECLARED total, not against
`actualReceived`** — and that distinction is load-bearing, because the naive
reading contradicts constraint 18 (Codex #1573 r3 P1). Constraint 18 preserves
both authenticated side amounts *unscaled* on a short delivery, scaling only
the backing credit; if their sum were bounded against what actually landed,
a fee-on-transfer receipt would leave an implementation with two ratified rules
and no legal move — strand the delivery, or scale the pricing obligation and
permanently underpay users.

So the two rules divide cleanly: **the sum is validated against the declared
total** (constraint 13's joint-bound rule — individually-valid components
summing past the delivery is the failure mode), while **payment of those
preserved obligations is separately gated on actual backing**, deferring to a
supplemental-funding transition rather than being written down. A short receipt
delays; it never silently reprices.

**R1c — "delays" needs a terminal, or it is a stall** (Codex #1573 r4 P1). A
compensation arriving **before** expiry but **short** of the preserved
obligations moves the day into supplemental-funding deferral — and the receipt's
ACK closes the original manual remit, while R2 grants a lapse terminal only to
an **expired zeroed** day. If installing the pricing amounts makes the day
no-longer-zeroed, a supplement that never arrives leaves that oldest day
blocking every later claim **indefinitely**, violating constraints 1-2 — the
exact failure the whole lapse design exists to prevent. If instead lapse stays
available, an on-time receipt can be discarded, contradicting "a short receipt
merely delays".

So the **partially-backed state must be pinned explicitly**, with a
permissionless terminal of its own: top-up to full backing, or reopen, or lapse
— reachable by anyone, on a bounded clock, exactly as R2 requires for the
zeroed case. A state that only a supplement can leave is not a state this
design may contain.

**R2. The lapse is PERMISSIONLESS**, on the authenticated `finalizedAt` clock
required by constraint 7. Anyone may resolve an expired zeroed day to
genuinely-zero. This is what discharges §2g's pin: the halt required by
constraint 1 now has a terminal reachable without any privileged actor.

**R3. Base REFUSES TO DISPATCH compensation after a cutoff STRICTLY EARLIER
than the lapse deadline.** Constraint 8 already requires *a* cutoff; making it
strictly earlier turns the gap into an explicit **CCIP delivery budget**.

**What R3 does NOT do** (Codex #1573 r1 P1): it does not restrict late arrivals
to last-moment dispatches, and an earlier draft of this section claimed it did.
Constraint 9 is unconditional — *no* window bounds cross-chain latency — so a
compensation dispatched **well before** the cutoff can sit failed-but-
re-executable and still arrive after the lapse. R3 buys delivery budget for the
common case; it does not bound the failure class. **Any in-flight dispatch can
lapse**, and the recovery path must be sized and monitored on that basis rather
than on a last-moment-only assumption.

**R4. A late arrival recovers through a DEDICATED FRESH-RETURN path — NOT
M4 C2.** It `finalize`/ACKs the original reservation, because the tokens
genuinely arrived (`releaseRemitReservation` is the wrong instrument;
constraint 11 says why), and returns the VPFI to Base.

**A first draft routed this through C2, and that does not connect** (Codex
#1573 r2 P1). C2 repatriates `availRecycled` out of the mirror's **recycle
bucket** and debits `consumedCumulative`. A manual compensation is
**fresh-only** by construction — `remitManualBudget` sets `r.fresh = amount`
with `recycledShare = 0`, and the ingress books it in the fresh received /
uncounted ledgers, never the bucket. No transition makes those tokens
C2-eligible, so "finalize, then invoke C2" describes a path that does not
exist.

Returning a stranded compensation is logically **undoing a remit**, not
disposing of surplus: different source ledger, different authorization,
different bounds. It therefore gets its own authenticated path, which must also
perform the corresponding **Base-side accounting reversal — bounded by the
amount Base ACTUALLY RECOVERS, on authenticated Base receipt** (Codex #1573 r4
P1: the original declared total, the mirror's receipt and the amount finally
returned can all differ when either leg lands short; reversing the declared
total, or reversing before receipt, reopens 69M headroom for tokens that are
still missing or were burned — with any residual tracked separately) — and net
the mirror's received-fresh counter (otherwise P1-b later treats returned,
no-longer-held VPFI as funding — see the C2 constraint set in
`VpfiCrossChainRecyclingDesign.md` §3.6a).

**Consequence, correcting an earlier claim: C2 is NOT a prerequisite of P2.**
The two are independent again.

**R4a — a late receipt must be QUARANTINED on arrival, not merely returned
later** (Codex #1573 r3 P1). The ingress credits an arriving compensation into
the chain-global delivered-fresh accounting immediately, so between arrival and
the fresh-return running, **P1-b can let claims for other armed days consume
that headroom**. The supposedly stranded VPFI is then already gone: decrementing
the receipt counter under-backs claims that have already paid, and the return
either reverts or draws from unrelated Diamond custody. Late receipts must be
held in a **dedicated stranded-recovery reservation, excluded from claim
backing, retired exactly once on the return** — or the accounting and the
return must be **atomic at ingress**.

Stated in full here on purpose: an earlier revision cited it as a rule the
repatriation design "already states", which is **not verifiable from this
document's branch** — the C2 design carries a matching constraint but the two
changes are unmerged and cross-referencing each other (Codex #1573 r4). This
rule is P2's own and does not depend on that one landing.

**R5. The per-day lapse SCHEDULE is authenticated in BOTH domains** (Codex
#1573 r2 P1). Base enforces the R3 dispatch cutoff while the mirror enforces
the R2 lapse, and the constraints authenticate only `finalizedAt` — so an
independently rolled-out upgrade, or any later parameter change, lets a mirror
on a shorter window lapse a day Base still considers dispatchable. That feeds
compensation straight into the accepted underpayment path **that R3 exists to
avoid**, silently and by configuration rather than by latency.

So the expiry and the cutoff must be **authenticated and snapshotted per day**,
not read from live config on either side — cleanest as a **versioned immutable
schedule** both domains derive from, carried with the day. A parameter change
then mints a new version and in-flight days keep the schedule they were
finalized under.

#### Why not Base-authoritative — recorded so it is not re-proposed

It reads as the safer option and is not. It trades away **bounded liveness**,
the one invariant here that must not be traded, and it *still* needs a
permissionless terminal for the admin-unavailable case (constraint 10) — so it
costs **more** new mechanism, not less. It also puts a canonical round-trip
inside the liveness path, adding moving parts to precisely the flow that must
never stall.

#### The accepted cost — stated plainly, because it is a real one

Under R1–R6, a compensation that arrives after the lapse means **those users
are not paid for that day**: their entries retired at zero and the tokens
return to Base. It is visible, and R3 improves the common case — but it is a
user-facing loss, and calling it anything else would be dishonest.

**It is NOT limited to near-deadline dispatches.** An earlier draft said so
here even after R3 had been corrected two paragraphs above, which is exactly
the kind of surviving claim that misleads: per constraint 9 *any* in-flight
dispatch can sit failed-but-re-executable and arrive after the lapse, however
early it was sent. **Size recovery capacity and monitoring against the full
in-flight population**, not against a cutoff-adjacent slice.

**This was weighed and accepted — but the asymmetry as first stated was
OVERSTATED, and the correction matters** (Codex #1573 r4). The accepted harm is
**not** "one day's rewards for the users of one excluded day": constraint 9 and
R3 let *any* in-flight compensation outlive its deadline, so a prolonged lane
or receiver outage can lapse **every zeroed day finalized and dispatched during
that outage** — many consecutive days, largely for the **same** users on the
same chain. The failure is **correlated**, not isolated.

The direction of the trade survives — a stalled mirror is unbounded, blocking
every later day's claims for every user on that chain indefinitely, while the
correlated loss is bounded by the outage — but the magnitude on the accepted
side is materially larger than the original sentence implied.

**R6. Bound the STRANDING: Base issues no new manual compensation for a chain
while an earlier one for that chain is unresolved.** Owner-directed
2026-08-06 (#1571). One compensation per chain may be in flight, so an outage
strands at most one delivery rather than one per zeroed day — which removes the
operational pile-up, the repeated fresh-return traffic, and the repeated
reversal accounting.

**R6 does NOT cap the USER loss, and it must not be read as doing so.** The
loss is a day lapsing at zero; that happens whether or not a compensation was
dispatched, because a compensation dispatched into a dead lane does not arrive
either way. R6 changes *those tokens were sent and came back* into *those
tokens were never sent* — strictly better operationally, neutral for the user.
An earlier framing of this bound as "capping the exposure" was wrong in exactly
the way this section keeps having to correct, so it is stated in its narrow
form here.

**What WOULD cap the user loss, and why none is taken:**

- *Reopening a lapsed day* — the only mechanism that actually pays those users.
  It is the alternative already rejected below: it reopens terminal-state
  monotonicity (constraint 6) and is a substantially larger design.
- *Extending the window while a lane is unhealthy* — reintroduces a wait on a
  signal that may never arrive, which is what R2 exists to prevent.
- *Not zeroing a chain whose lane is down* — grace/force finalization exists
  precisely so a silent chain cannot block the day, so this trades the
  correlated loss straight back for the stall.

So the correlated user loss is **inherent to lapsing on a clock while a lane is
down**. It is bounded by outage duration, capped by nothing, and the honest
posture is to **detect and report it** — the uncounted/stranding counters make
it visible — rather than to claim a bound that does not exist.

The rejected alternative, recorded so the trade is not silently revisited: a
lapse that does **not** retire entries would avoid the underpayment, but it
reopens terminal-state monotonicity (constraint 6) and is a substantially
larger design.

#### What remains open

Two **parameters** — the lapse window length and the R3 dispatch-cutoff gap —
both wanting sizing against observed operator and lane behaviour rather than a
guess.

**The gap must also cover cross-domain CLOCK SKEW** (Codex #1573 r3 P2). Even
with an identical authenticated schedule, Base evaluates the R3 cutoff against
Base's `block.timestamp` while each mirror evaluates the R2 lapse against its
own chain clock. A mirror whose clock leads Base by more than the gap can lapse
permissionlessly while Base still considers dispatch valid — recreating exactly
the race R5 exists to prevent, from clock drift rather than configuration. Size
the gap against the supported chains' worst-case skew as well as lane latency,
or derive both decisions from authenticated evidence in a single clock domain.

**An earlier draft called that the whole remainder. It was not** (Codex #1573
r2): R5's cross-chain schedule authentication is **architecture**, not a
parameter, and R4's fresh-return path is a mechanism that does not exist yet.
Both are stated above as ratified requirements, and both belong in the P2
design document — which they do not block, but do shape.

**Two further items are genuinely OPEN as of r4, and neither is a parameter:**

- **R1c's partially-backed state** — its pinned representation and its
  permissionless terminal (top-up / reopen / lapse) are required but not yet
  specified. Until they are, an on-time short receipt has no defined exit.
- ~~The correlated-loss bound~~ — **DECIDED 2026-08-06 (#1571)** and landed as
  **R6**: no new manual compensation for a chain while an earlier one is
  unresolved. Note what R6 does and does not do — it bounds the **stranding**,
  not the **user loss**, and the correlated user loss remains *inherent* to
  lapsing on a clock while a lane is down. It is bounded by outage duration,
  capped by nothing short of reopening lapsed days, and is therefore a
  **detect-and-report** exposure. Do not cite R6 as a cap on user harm.

### General rule earned here, applicable beyond P2

**A field named for an OBLIGATION is not the amount that MOVED, and the two
diverge exactly where a cap or clamp bites.** `EntrySplit.armedFresh` is kept
whole for commitment retirement while `total` sheds the capped-off part;
`interactionPoolPaidOut` mixes legacy-schedule and armed payouts;
`armedFreshFull` is pre-clamp. Before transmitting, bounding, or subtracting
any such field, establish which side of that line it is on. Three separate
findings across #1556 and this section were the same mistake.


### The manual-budget path is USUALLY counted — and the exception is a constraint

An earlier revision recorded this as "one thing that already behaves
correctly": the manual-budget path lands **counted** in P1-a's delivered-fresh
figure, being fresh-only by construction and targeting only `remitIneligible`
days, which are armed. **That is over-stated** (Codex #1565 r4 P1), and the
exception is exactly the case P2 exists for.

`_armedAttributableDelivery` requires `governorCommitArmedFromDay != 0` **on
the mirror**. For the FIRST armed zeroed day, the compensation can overtake the
broadcast that installs `D*` — CCIP orders neither — and then the ingress books
the whole amount to `rewardBudgetFreshUncounted`, not to
`rewardBudgetArmedFreshReceived`. The tokens are present and the day is
compensated, but the mirror's delivered-fresh budget never rose, so P1-b would
defer a payout that is fully funded.

So, as constraint 16:

16. Compensation that **overtakes the arming broadcast** must still be
    attributable. Either the ingress can re-attribute an uncounted delivery
    once `D*` installs, or armed attribution travels authenticated on the
    delivery itself rather than being inferred from local arming state. This is
    the same ordering gap P1-a documented on `_armedAttributableDelivery` —
    P2 is where it stops being acceptable, because the compensation path is
    precisely where a funded-but-uncounted day is most likely.

What remains true, and worth keeping so it is not "fixed" the wrong way: when
the mirror IS armed at ingress, the manual path is **inside** the delivered-
fresh accounting. A reader concluding "manual top-ups bypass it entirely" would
be wrong, and adding a second accounting path would double-count.

## 3. Delivery-ack binding — RESOLVED by plan §M3 (lines 348-351)

Not an open fork: §M3 pins it — *"reservations are bound to the **CCIP message
ID**; the ack is idempotent and retryable (a re-delivered ack finalizes the same
reservation exactly once); and an ambiguous outcome … resolves through a bounded
reconciliation path — after a timeout, the operator finalizes or releases the
reservation against the observed CCIP delivery status."*

There is **no ack/return channel today** (reward-budget flow is strictly
one-way), so P4 is greenfield. Binding to the CCIP `messageId` has a real
consequence the implementing PR (d2) must carry: `sendMessage` returns the
`messageId` to the SENDER (Base captures it at `RewardRemittanceFacet.sol:334`),
but `onCrossChainMessage` does **not** receive it — `CcipMessenger` drops it
after `_ccipReceive` and only logs it. So d2 must **surface the messageId to the
ack path**: either widen `ICrossChainMessageRecipient.onCrossChainMessage` to
carry `bytes32 messageId` (blast radius: the seam + `CcipMessenger` + all 4
recipients) or carry Base's `messageId` **in the remittance payload** so the
mirror echoes it back in the ack (no seam change — the reservation key travels
with the value). d2 pins which; the payload-echo path is the lighter one and
keeps the messageId binding §M3 requires without touching the recipient seam.

> **d2 pin (2026-07-26) — payload-echo, in its only causally-possible form.**
> The raw "messageId in the payload" sketch is circular: CCIP computes the
> `messageId` over the fully-built message (the router returns it from
> `ccipSend`), so a message cannot carry its own id. The implementable echo:
> Base reserves under a self-generated `remitId` (monotonic nonce) BEFORE the
> send — CEI-clean — and the widened remit payload carries that `remitId`;
> immediately after `sendMessage` returns, the reservation is annotated with
> the CCIP `messageId` plus a `remitIdByCcipMessageId` reverse index. §M3's
> "reservations are bound to the CCIP message ID" holds through that stored
> binding — the operator reconciles from observed CCIP delivery evidence by
> messageId — while the wire echo key is the `remitId`. The ack is a new
> data-only wire kind (mirror→Base, canonical-only receive, strict FOUR-word
> shape after the r4 `remitter` echo: kind, remitId, amountReceived,
> remitter), sendable by anyone on the mirror (payable, fee-on-caller,
> mirror-computed content, re-sendable for lost-ack retry); Base finalizes
> exactly once (idempotent status check + source-chain + self-naming
> remitter checks). Receiver compatibility: the widened remit payload
> (`dayIds, total, remitId, remitter` after r4) is discriminated from the
> legacy 2-tuple by the leading ABI head word (the `dayIds` array offset —
> `0x40` legacy vs `0x80` widened; the interim 3-tuple/`0x60` shape existed
> only on this branch and never shipped), so delayed pre-d2 deliveries keep
> crediting on an upgraded receiver (they carry no `remitId` and simply
> produce no ack — their reservations don't exist). **Codex r2:** a mirror
> receipt is bound to the Base DEPLOYMENT that sent it — remit ids are
> per-deployment, so after an owner base-chain rotation the ack path rejects
> a stale receipt (recorded source ≠ configured base) instead of routing it
> to the new base, where an authenticated ack could finalize an unrelated
> same-numbered reservation. **Codex r3 hardened this to sender-binding;
> Codex r4 showed the adapter's `sourceSender` is delivery-time CONFIG**
> (`channelPeerOf` at receive), so a delayed pre-rotation packet delivered
> after the peer update would be misattributed to the new deployment — and
> any symmetric supersession rule inherits an unsolvable ordering problem.
> **Final shape (r4): the deployment identity travels IN the remit
> payload** — Base embeds `address(this)` (immutable message data,
> transitively authenticated by the messenger allowlist + channel-sender
> auth); receipts key by `(remitter, remitId)` so different deployments'
> same-numbered receipts CO-EXIST (no collision, no supersession, no
> ordering); the kind-7 ack echoes the recorded remitter (4 words) and the
> Base ingress accepts only acks that name ITSELF. The keeper passes the
> Base diamond it scans as the receipt key, and its D1 ack-scan state is
> likewise namespaced by (chain, diamond) so a redeploy starts a fresh
> scan namespace. Release semantics tightened in the same round: ALL value
> counters (69M fresh headroom included) stay reserved on release — the
> tokens are outside Diamond custody, and re-opening fresh headroom would
> let a re-remit draw commingled custody as "fresh" — restored only by the
> d5-class physical-recovery ceremony.

The ack is authenticated by the same messenger peer the reports use
(`msg.sender == messenger` + `CcipMessenger` `remoteMessengerOf`/`channelPeerOf`)
— no new auth primitive. The bounded operator reconciliation (finalize/release
against observed CCIP status after a timeout) rides d2 alongside.

## 4. Reservation granularity + where the numeric headroom lives (this PR decides)

§M3's headroom formula is per-loan (`capEff − paid − remitted − pending`), but
the remit path holds only **per-(chain,day) aggregate** numerators and "cannot
reconstruct how the windowed cap lands on each mirror user". Reconciled with
§2/§3:
- `Σcommitments` is the reported **per-(chain,day) per-side aggregate** liability
  (§2) — per-loan on Base, per-ENTRY on a mirror (r1 restructure, §2c).
- The reservation is **bound to the CCIP `messageId`** (§3): `pendingRemitted[messageId]
  → {dstChain, dayIds, per-side amounts}`. The clamp subtracts a **per-(chain,day)**
  running `pending` sum derived from open reservations; `remitted` is the
  ack-finalized per-(chain,day) counter (the mesh-grain sibling of the formula
  doc's per-loan `loanSideRewardRemitted`). Mirror-side, `processUserSideDay`
  clamps `cEff` by the delivered `remittedRemaining` (rev-15) so the mirror
  never pays past what actually arrived.
- **d2 pin:** the reservation keys by the Base-generated `remitId` with the
  CCIP `messageId` annotated post-send (§3 pin — a message cannot carry its
  own id). And at mesh grain the formula's `− remitted − pending` terms
  COLLAPSE to a per-(chain,day) state machine: a day funds at most once
  (`rewardBudgetRemitted[c][d]` marks it at send, a release re-opens it), so
  the live clamp is `min(uncappedSlice, liability)` evaluated the single time
  the day funds, with per-chain `pending`/`acked` aggregates maintained for
  observability + the d3 netting inputs rather than as clamp subtrahends.

**Where the reported totals live:** extend `ChainDayCommitments` with the two
per-side liability totals (`liabilityLender18`, `liabilityBorrower18`) — it is
inside the append-only storage tail, so widening it is layout-safe. This changes
the `getChainDayCommitments` ABI shape (frontend + keeper re-export). A sibling
mapping is the alternative if we want to keep the struct's ABI frozen; the
struct extension is simpler and the ABI churn is a routine re-export.
`pendingRemitted`(keyed by messageId) and the per-(chain,day) `remitted`/`pending`
running sums land as new append-only tail fields.

## 5. Invariants B2-d must preserve / establish

- **Fail-closed until lit:** every slice before d1 keeps `.complete` unset; d1
  is the sole `.complete` writer; and the mirror pricing halt is removed by
  exactly one slice — **which is still outstanding.** d4 attempted it and was
  withdrawn, so the halt REMAINS in the tree and its two prerequisites are
  tracked on #1434 (§2g). None of this may be reordered.
- **`consumed ≤ reported` per chain** (becomes real in d3): `chainConsumedRecycled[c] ≤ chainReportedRecycled[c]`.
- **One bucket, one ledger:** a mirror-local slice reserves into
  `chainOutstandingRecycledCommit[c]`; a Base-funded slice into the global
  `outstandingCommitRecycled` — never both.
- **No double-pay across surrender+remit:** mirror-surrendered + Base-remitted =
  exactly the funded recycled slice (two-sided netting, d3).
- **No manufactured Ā (d5) — AMENDED by §2f.2/§2f.3, read that first.** The
  remitted-recycled custody credit advances `recycleBucket` +
  `recycleCustodyRelocatedCumulative` ONLY. It skips `recycledCreditedByDay`
  (the Ā day-bucket) AND must not reach the **reported cumulative** — those
  tokens were Ā-counted once on Base at first absorption, and after d3 an
  inflated cumulative would also re-offer Base's own top-up as mirror-local
  availability (`_mirrorAvailable = reported − consumed`) and widen the Ā
  attribution headroom in `recordChainRecycled`. Because
  `creditedCumulative()` derives a floor of `recycleBucket + paidOutRecycled`,
  leaving `recycleCreditedCumulative` unwritten is NOT sufficient — the
  custody counter is subtracted from that floor.
  *(This bullet originally said the credit advances `recycleCreditedCumulative`;
  that was written while B2-b forced mirror `avail = 0` and is unsafe now.)*
- **pending never double-allocates and a lost ack never permanently suppresses**
  (d2): reservation bound to the ack key, idempotent+retryable finalize,
  bounded operator reconcile against observed CCIP status.
- **quote == send:** the clamp is mirrored at all 3 remit sites.

## 6. Test plan (per slice; full 3-chain e2e is B4)

d1: mirror batches accumulate + conservation completes + send ships the
per-side aggregate; Base ingress stores liabilities + `.complete`
(post-finalize acceptance); armed finalize fires on interest coverage alone
(no commitment input — §2b); zeroed-interest chain marked `remitIneligible`,
reported chains not; unarmed/incomplete days unreportable; cursor + entry
validation rejections; keeper send pass. d2: pending→ack→remitted lifecycle,
lost-ack reconcile, clamp at 3 sites, quote==send. d3: `consumed ≤ reported`,
one-bucket-one-ledger, netting sum identity, idempotent
commitment-on-arrival (a RESERVATION, not a bucket debit — §2e.1).
**d4 (withdrawn): the halt is PINNED instead** — a mirror armed day prices
nothing, with a canonical control proving the mirror flags are what stop it;
when #1434 revives the slice, add "mirror prices its own stamp; `!stamped` still
waits", plus a delivered-FRESH bound and a zeroed-day repricing case. d5: Ā-excluded credit
advances cumulative but not the day-bucket; 3-way forfeit/expiry classify;
no-recycle→budget→expiry→bucket Ā inflation (the geometric-inflation guard).
