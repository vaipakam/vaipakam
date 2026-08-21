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
| **P5 Mirror armed-day pricing ON** — **DELIVERED by #1434 P1-b (`83483149e`); first attempt withdrawn, see §2g** | remove the `_dayPoolHalves` mirror halt so mirrors price their own delivered-backed stamp | Historically: P2+P4 backed the RECYCLED halves (done), but the halt ALSO guarded the then-unbounded FRESH side and deliberately-zeroed days — both since addressed, which is what allowed its removal — see §2g for why, and **§2h for the zeroed-day scope** (the fresh side's receipt half shipped as #1556) |
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
- **B2-d4 — Mirror armed-day pricing ON. ✅ DELIVERED by #1434 P1-b
  (`83483149e`); #1434 is closed.** P5. The rest of this entry is HISTORY: it
  records why the FIRST attempt was withdrawn. The intent was to remove the
  `_dayPoolHalves` mirror halt and keep only the genuine `!stamped` wait.
  Review (#1433 r2) found that was not yet safe: the halt also guarded the
  FRESH side, which had no delivered-funding bound on a mirror, and stopped
  deliberately-zeroed (`remitIneligible`) days from advancing the cursor and
  retiring their entries for zero. **Both prerequisites were tracked on #1434
  and both landed before the slice was retried and delivered.**
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
  availability. Until d5 landed, mirror armed-day claims stayed HALTED, which
  is what kept that hazard unreachable at the time. d5 shipped (#1432) and the
  halt itself was lifted by #1434 P1-b, so the backing this entry describes is
  now what holds the hazard closed.
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

> **⚠ SUPERSEDED BY §2c — do not implement this per-USER form.** §2c replaces
> it with the per-ENTRY finest-split supremum
> `Σ_covering-entries min(perDay_e × Δ_D / 1e18, C_side)`, **with no `paid`
> term**: the per-user quantity is transfer-VARIANT (an ownership regrouping
> changes it) and `userSideDayPaidVpfi` is structurally zero at report time
> anyway. The paragraph above is kept because it is the reasoning that led
> there — the mirror's cap really is the D1 `(user,side,day)` one — but the
> *formula* moved. A quote or conversion built against this line underfunds
> users after a transfer (Codex #1573 r10 P1 found this exact form still being
> quoted as present-tense guidance elsewhere in the document).

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
   signal exists (Base cannot observe mirror claims in d3). The §7 #6
   commitment bound binds non-trivially from this slice on, enforced by
   the pass-1 availability cap. (At d3 it read `consumed ≤ reported`; B3's
   release later widened it to the subtraction-first form — see governor
   §7 #6, which is the one place it is stated.)
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

## 2g. d4 pins — why the FIRST attempt was withdrawn (halt since lifted, #1434 P1-b)

§1 scopes d4 as "remove the `_dayPoolHalves` halt; keep the genuine `!stamped`
wait". **That scope turned out to be incomplete, and d4 was WITHDRAWN** (owner
decision after Codex #1433 r2: defer, keep the halt fail-closed, file a
follow-up). **#1434 later discharged both prerequisites and removed the halt** — P2-w3 met
the zeroed-day one, P1-b (`83483149e`) met the delivered-fresh one and then
lifted the halt. `_dayPoolHalves` itself now halts only on an unstamped
day; a stamped day can still WAIT, via the separate `_p2DayDeltas`
zeroed-and-open state that defers a compensable day rather than retiring it for
zero. Both are per-day waits, but they end on different things. The unstamped one
ends on the stamp arriving. That is NOT the same as ending on funding, and the
difference decides who can clear it: where the canonical chain already finalized
the day and only the message failed to land, the stamp can be rebuilt from
canonical state by ANY caller paying the transport fee — no reward budget
changes hands. It waits indefinitely only where there is nothing to resend,
because the day was never finalized upstream. The zeroed-and-open one has four exits. Its quote may complete at
genuinely zero on both sides, in which case the day is resolved-zero and crosses
immediately — no compensation, no deadline, nothing owed. Otherwise: its
compensation becoming both funded AND settled (a fully funded compensation still defers while
its quote is undispatched or its credit provisional), or, past the frozen
expiry, either permissionless lapse terminal — and the two do NOT settle
alike. `lapseZeroedDay` crosses an uncompensated day at zero: nothing was
backed, nothing pays. `lapseShortCompensatedDay` takes a confirmed-but-
underfunded day and pays the BACKED portion before the cursor advances, so the
entries retire against what actually arrived rather than against nothing. The
scale is not simply `pool / quoted`: the covering-entry count is shaved off the
pool first, so the factor is `(pool − entryCount) / quoted` and a pool at or
below that count yields zero. A short lapse therefore pays the backed portion
where there is one and can still cross at zero when the shortfall is deep enough
— which is why "the short lapse pays" is a description of its intent, not a
guarantee about any particular day.

Two things follow that matter operationally. Neither wait is the exclusive
property of whoever holds the funding — the zeroed-and-open one through its two
lapse terminals, the unstamped one through the permissionless resend above —
so an operator is not the only party who can clear either. And ending it is not
uniformly a write-off: on the short-funded path the lapse is how the backed
value gets paid at all. This
section is retained as the record of why, and of the two
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
**BOTH WERE LATER DISCHARGED, and not by the same slice** — prerequisite 2 by
P2-w3's zeroed-day pricing ladder, prerequisite 1 by P1-b's delivered-fresh
bound, after which P1-b removed the halt. The analysis below is the state at the
time of the withdrawal and its reasoning is retained because it constrains any
future change here. Each prerequisite carries a note saying what met it.

1. **The FRESH side had no delivered-funding bound on a mirror.** *(Met by
   `PoolBudget.deliveredFresh`, carried as its own term so its shortfall DEFERS
   — see the fix-shape note below, which anticipated exactly this.)* Fresh is
   entirely Base-funded and arrives with the remit, but the walk bounded it only
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
   **P1-b implementation pin (2026-08-13, scouted post-w6 on
   `feat/1434-p1b-halt-lift`).** The two parts land at two different sites, and
   the whole slice turns on ONE distinction that neither the §2g text above nor
   the §8 summary makes explicit:

   - **Part 1 — the bound.** `delivered fresh − armed fresh PAID`. The receipt
     half shipped as #1556 (`rewardBudgetArmedFreshReceived`); **the paid half
     did not exist anywhere in the tree and was created by P1-b** as
     `rewardBudgetArmedFreshPaid` (tail-appended storage, written at every
     armed-fresh payout site — the claim walk, the forfeiture sweep, the expiry
     batch — each scoped to mirrors, plus the one-shot migration seed
     `seedArmedFreshPaid` for chains carrying pre-P1-b history).
     `interactionPoolPaidOut` is explicitly FORBIDDEN as a proxy — it counts
     lifetime payouts including ordinary-schedule ones no delivery funded, so
     charging them would defer every later day on any chain with prior
     activity. The receipt figure is **not monotone**: it carries a saturating
     UNWIND (the reclassification unwind in `RewardRemittanceFacet`'s ack
     ingress) for a released or reclassified delivery, so the bound is computed
     saturating in both terms — a paid side charged against a receipt figure
     that has since shrunk would otherwise underflow or wedge. Read it through
     `LibInteractionRewards.deliveredFreshBound`, never by differencing the two
     counters by hand.

   - **Part 2 — defer, not truncate — and where.** The two behaviours sit a few
     lines apart near the end of `LibInteractionRewards.processUserSideDay`,
     just after the per-leg pool-boundary comment block. The RECYCLED leg does
     `if (pool.recycled < user_.recycled) return (charge, slices);` — returning
     with `charge.advanced` still false, so nothing persists, the cursor does
     not move, and the day stays retryable. The FRESH leg immediately after
     does the opposite: it folds `freshTrimmed` into `cappedOff.armedFresh` and
     falls through to `advanced = true`, retiring the commitment terminally.
     The caller's `if (!charge.advanced) break;` contract in
     `_walkShareOfPoolDays` used to state this in as many words ("A FRESH
     shortfall never lands here — the day primitive settles it terminally
     (truncate-and-consume) and still advances"); that sentence was ON THE
     SWEEP LIST and P1-b has since rewritten it, because a mirror's delivered
     shortfall now does land there.

     > **Reference by NAME, not by line.** These pins previously carried line
     > numbers (`:4692`, `:1652-1657`) and rotted twice as the code moved —
     > eventually pointing at a parameter declaration and at an unrelated
     > helper, which sends anyone auditing this record to the wrong code. Line
     > numbers fail silently; a function name fails visibly under rename, and
     > `grep` finds it either way.

   - **THE DISTINCTION, which is the crux.** A mirror must NOT simply defer on
     any fresh trim. Fresh can be trimmed for reasons that are genuinely
     terminal (the loan-side cap; the global 69M pool exhausting) and reasons
     that are merely not-yet-funded (the delivered bound). Deferring on a
     terminal cause would wedge the cursor forever — the precise failure the
     withdrawn B2-d4 drew four P1s for. So the delivered bound must be
     evaluated as its OWN term, and the day defers only when the **delivered**
     bound is the binding one; a cap-bound trim still truncates and advances,
     exactly as on Base. The design's own distinguishing test is the reason:
     *"can the condition that stopped it always be satisfied"* — a delivered
     shortfall can be (another remit lands), an exhausted cap cannot.

   - **The mutant this must kill**, stated so the test suite can target it:
     wiring the delivered budget into `ctx.pool.fresh` and reusing the existing
     shortfall path. That satisfies Part 1's value bound and reads as done,
     but it inherits truncate-and-consume — so a day whose funding is merely in
     flight is permanently underpaid. A phase-A-only test (zero delivered
     funding ⇒ pays zero) passes under it, which is why the post-lift test must
     be the three-phase fixture asserting STORED state (cursor +
     `outstandingCommitFresh`): B (delivered but short ⇒ still zero, cursor
     STILL unmoved) and C (topped up ⇒ pays the canonical control's amount,
     cursor advances exactly one day) are the phases that kill it.

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

   Until BOTH existed, a zeroed day had to stay unpriced rather than be
   walked. *(Both now exist: the zeroed-day pricing ladder supplies the
   mirror-observable signal and the per-side figures, so a compensated day is
   priceable without rewriting the ordinary funding stamp.)*

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
backing VALUE. When the halt lifted (#1434 P1-b), the fresh-side prerequisite
was met with a delivered-funding BUDGET as this pin required — carried as
`PoolBudget.deliveredFresh` rather than by overloading `PoolBudget.fresh`,
because the fresh path truncates terminally and a growing budget must DEFER.
Not a per-day flag, which is what this pin exists to rule out.

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

**On the wire — AT LEAST THREE paths, not one and not two:**

> **Three is a FLOOR, not a budget** (Codex #1573 r10 P2). R1a's re-opened
> conversion input has a mirror-authenticated quote as its leading shape, which
> likely adds a **fourth** path. An implementer planning from a fixed count
> would provision the broadcast, the remit and the return, and omit the
> quote's transport. The count settles when the inverse-input mechanism does.

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
    it must carry enough authenticated identity to SETTLE the original remit
    accounting (under the 2026-08-07 decision that settlement is the
    receipt-bound recovery-position credit and returned-cumulative writes,
    never a deduction from cap usage — this line said "reverse" until Codex
    #1586 r3 P1, which an implementer could build as the rejected cap
    reversal), and R4 explicitly forbids reusing C2's. It therefore needs its
    own payload kind, decoder and rollout compatibility. An earlier revision
    kept saying "two evolutions" *after* making the change that created the
    third, which would let a P2 implementation and rollout plan omit **the very
    receiver that makes late arrivals recoverable**. **At least** three
    versioned changes, each with its own rollout test — and the same reasoning
    that made this a third path applies again to the conversion's authenticated
    input if it lands as its own message (r10 P2).

> **✅ RATIFIED 2026-08-07 (owner) — how 12a coexists with §3.6a's "one
> transport with a mode discriminator".** The two texts briefly read as a
> fork (surfaced on #1578 r7, recorded on #1434) and the owner ratified
> the layered reading as the architecturally clean route: the mirror→Base
> return CHANNEL is shared and cut once (§3.6a constraint 3's
> transport-layer decision), and **the payload-kind tag IS the mode
> discriminator** — each mode keeps its own payload kind, decoder and
> rollout compatibility exactly as 12a requires. Nothing in
> this constraint changes; the canonical statement of the layering lives
> in §3.6a, beside the discriminator requirement it qualifies.

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

12c. **The clean split above is not quite clean — R4b puts the applicable
    expiry on the REMIT as well** (Codex #1573 r7 P1). Constraint 12 routes
    `finalizedAt` exclusively through the broadcast, and constraint 4 requires
    compensation to be able to land while the mirror is still unstamped. Those
    two together leave an arriving compensation **unclassifiable at ingress**:
    no expiry is present to compare against, so a late delivery is credited as
    ordinary and can be consumed before the broadcast proves it should have
    been returned. R4b closes it by carrying the bound day's authenticated
    expiry on the remit itself. That duplicates a value across two paths, so
    the R5 versioned schedule is what keeps them consistent — both sides derive
    the expiry from the same authenticated schedule version rather than
    carrying independently-set timestamps. **Still three paths**; one of them
    gains a field.

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

**Ratified: a MIRROR-LOCAL PERMISSIONLESS LAPSE, in six parts — R1 through
R6.** Those six are the owner-ratified decision and are stable.

**Each part also carries lettered sub-rules (R1a, R4b, R6c, …), and they are
NOT enumerated here on purpose.** Review has added sub-rules in five separate
rounds; every revision that listed them went stale in the next one, and a
reader trusting a stale list skips exactly the requirement that was just found
to be load-bearing. Read each part through to its last lettered sub-rule — they
are inseparable from the part they hang off, not optional refinements of it.
(The top-level count has drifted too: the first draft said "four" before R5 was
added, and "five" before R6. Six is the ratified number.)

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

> ⚠️ **The specific mechanism below — "Base sends an amount, the mirror divides
> by its own day interest" — is WITHDRAWN** (Codex #1573 r9 P1; r8 established
> why, and this paragraph was left standing as a directive an implementer would
> follow). It is kept, struck, because the *reasoning* that produced it is what
> the replacement must preserve. **The stable, still-ratified part of R1 is
> below it.**

~~So the ratified shape is: the wire carries an authenticated AMOUNT, and the
MIRROR derives Δ locally from its own day interest.~~ That amount is the
**declared pricing obligation**, not a statement about what physically lands —
R1b preserves it unscaled on a short receipt while backing is only
`actualReceived`, so equating the two would either reject a valid short receipt
or overstate backing (Codex #1573 r4). ~~The conversion happens where its input
actually lives, and neither party solves for anything.~~
Any alternative must pin an authenticated local denominator explicitly — an
unpinned conversion is the footgun, not the delta.

**What survives, and binds any replacement:**

1. The wire carries **two authenticated per-side amounts** — not halves, not
   one scalar (R1, R1b). Ratified, unchanged.
2. Each amount is a **declared pricing obligation**, preserved unscaled on a
   short receipt while backing is only `actualReceived` (R1b, constraint 18).
3. The conversion is performed **where its inputs actually live**, and **neither
   party solves for anything**. This is the principle; "mirror divides by local
   interest" was one *implementation* of it, and r7/r8 showed that
   implementation prices against an obligation the mirror will not pay.
4. Whatever supplies the conversion's denominator must be **authenticated**, not
   inferred from local state that may be absent or superseded.

The mechanism satisfying all four is **open** — see the conversion discussion
below, where a mirror-authenticated `(Δ, per-side amount)` quote is the leading
shape. An implementer must not fall back to `amount / localInterest` because it
appears earlier in this section.

**The conversion must be defined at its edges** (Codex #1573 r4). These rules
were derived against the now-withdrawn `amount / localInterest` mechanism, and
**they survive it** — every one of them is a property any conversion must have,
not a property of that division. Read them as requirements on the replacement.

Concretely: a conversion is **undefined** for a non-zero side amount against a
**zero** denominator, and for non-dividing values **no integer Δ reproduces the
amount exactly** — flooring silently underpays the preserved obligation,
rounding up exceeds its backing and parks the day behind the budget gate. So,
pinned rather than deferred (Codex #1573 r5 — an earlier revision said these
"must be pinned" without pinning either, which leaves implementations free to
floor and underpay or round up and overdraw):

- a **zero-interest side must carry a zero amount**; a non-zero amount against
  a *finalized* zero local interest is a malformed instruction and must be
  rejected, not coerced. **"Finalized" is load-bearing — see R1d**: an
  unstamped mirror cannot tell an authenticated zero from a not-yet-folded one,
  and rejecting on the latter destroys a valid compensation;
- **Δ FLOORS** — whatever the denominator turns out to be. Flooring underpays
  the declared obligation by sub-unit dust; rounding up would pay beyond the
  delivered backing, which is the one direction this design never takes — the
  same reason the recycled side floors everywhere else. (Stated as
  `floor(amount × 1e18 / localInterest)` before the denominator was withdrawn;
  the *direction* is the rule, not that expression);
- the **residual is un-drawn backing**, not a debt. Nothing accrues it to a
  user and no supplemental transition is owed for it — but it needs a named
  ledger and a terminal, which the next paragraph is about. An earlier revision
  said it "leaves by the ordinary return path"; **there is no such path**
  (Codex #1573 r7 P2). R4 is the only fresh-return mechanism in this design and
  it is scoped to post-lapse late arrivals, so as written the residual could
  neither leave nor be accounted as live backing.

**The denominator is NOT the uncapped local interest, and that is what makes
the residual material rather than dust** (Codex #1573 r7 P1). `Δ = amount ×
1e18 / localInterest` prices against the mirror's **uncapped** aggregate
interest, while what the mirror actually pays is a **capped** sum. Whenever a
cap binds, the payout is strictly less than `localInterest × Δ / 1e18`: the
operator delivers an amount sized to an obligation the mirror will not pay, and
the shortfall is a **material portion of the delivery**, not sub-unit dust. An
earlier framing treated the whole residual as a rounding artifact and is wrong
by that margin.

**The r7 remedy for it was wrong, and its own citation was stale** (Codex
#1573 r8 P1). That revision named the capped sum as
`Σ_users min(rawPay_user, C_side − userSideDayPaidVpfi)` and said the operator
could simply size against §2's report. Both halves fail against this document's
own later sections:

- **§2c superseded that formula.** The liability is the per-ENTRY finest-split
  supremum `Σ_covering-entries min(perDay_e × Δ_D / 1e18, C_side)`, and §2c
  **removes the `paid` term deliberately** — `userSideDayPaidVpfi` is
  structurally zero at report time, and re-introducing it would restore
  user-keyed, transfer-variant state. I cited §2 and did not read §2c, which
  supersedes it a page later.
- **§2b forbids using the report for exactly this case.** A zeroed chain's late
  report *"prices at that chain's deliberately-zero funding stamp … so the
  operator sizes the manual remit from the mirror's locally-readable state,
  never from this figure."* The compensation case is the zeroed-chain case, so
  the one input I pointed at is the one already ruled out for it.

**So the requirement stands and the mechanism is open.** What P2 owes is an
**authenticated inverse input that originates where the capped liability
actually lives** — the mirror — rather than a figure Base derives or an
operator guesses. The leading shape, and the one to beat: a
**mirror-authenticated `(Δ, per-side amount)` quote that Base only funds.** It
inverts the direction of the unsolvable step instead of trying to solve it, and
it keeps R1's ratified properties intact — still two authenticated per-side
amounts, still converted where its inputs live, still nobody solving for
anything. Note that it likely adds a wire path, so constraint 12's "three
paths" count should be read as provisional until this is settled.

**Separately, give the residual a ledger and a permissionless terminal.**
Whatever the conversion, floor dust plus any cap-bound excess remains
delivered-but-unpayable. It must be either retained as identified backing for a
named purpose or returnable through an authenticated path — and, per R6d, the
choice may not be "it sits there with no transition", because that is a
stranded balance with no terminal wearing a different name.

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

**R6 does not block that top-up — see R6c** (Codex #1573 r7 P1). Read naively,
R6's one-compensation-per-chain gate makes this terminal circularly
unreachable: the top-up *is* a compensation. R6c resolves it by separating the
two axes — the earlier compensation is *resolved* once its tokens are credited
(nothing is stranded, which is all R6 bounds), while the *day* stays
unresolved. Which terminal this state takes, and on what clock, is still open.

**But R6 was not the only blocker, and clearing it is not sufficient** (Codex
#1573 r10 P1). §4's reservation model makes a day fund **at most once**:
`rewardBudgetRemitted[c][d]` is marked at send and **only a release re-opens
it**. The short delivery was consumed, so its ACK sets that marker and
deliberately does *not* release — the day is now permanently un-fundable
through the ordinary path regardless of what R6 permits. R6c removed a gate and
revealed a second one behind it, so the promised top-up is still undispatchable
and the day can still block later claims indefinitely.

So R1c's terminal requires an explicit **supplemental transition**: admitted
*despite* the original day marker, and accumulating against the **same
receipt-bound obligation** rather than opening a second independent funding of
the day. It cannot be built from `releaseRemitReservation` — constraint 11
already rules that out for a delivery that executed — and it must not be a
second ordinary remit, which is what the marker exists to prevent. This is now
the concrete shape of the R1c open item, not a restatement of it.

**R1d — `localInterest == 0` is AMBIGUOUS on an unstamped mirror, so the
zero-interest rejection must be gated on finalization** (Codex #1573 r8 P1).
§2b's stamp gate exists because *"before the mirror's own interest close folds
day-`D` totals, the day LOOKS quiet"* — a stamp arrival transitively proves the
local close ran. But constraint 4 requires compensation to be able to land while
the mirror is still **unstamped**, and §2b's transitive proof carries an
explicit carve-out for exactly our case: *"or the chain was zeroed, which is
already remit-ineligible."* So on a zeroed chain the stamp does **not** prove the
local close ran, and in that reachable state `localInterest == 0` means
*not-yet-folded or unknown*, not *authenticated zero*.

Reading it as an authenticated zero makes R1a reject — and under R6d cancel — a
**valid** compensation that would have become convertible minutes later once the
local close folded. That is avoidable lapse and avoidable user loss, caused by a
rule written to prevent a malformed instruction.

So: **prove local interest is finalized before classifying an instruction as
malformed.** Absent that proof, the delivery is neither valid nor malformed but
*undecidable*, and undecidable means **quarantine with a bounded permissionless
terminal** — never rejection.

This is the same shape as **R4b** one axis over. R4b established that an
arriving compensation must be classifiable at ingress and that the *expiry* it
is judged against must travel with it. R1d is the *interest* axis of the same
problem: the mirror is being asked to judge a delivery against local state that
may not exist yet. Both resolve the same way — **do not decide on absent state**
— and a P2 implementation should treat "what must be true locally before this
delivery can be judged?" as one question with one answer, not two rules that
happen to rhyme.

**R2. The lapse is PERMISSIONLESS**, on the authenticated `finalizedAt` clock
required by constraint 7. Anyone may resolve an expired zeroed day to
genuinely-zero. This is what discharges §2g's pin: the halt required by
constraint 1 now has a terminal reachable without any privileged actor.

**R2a — an unpermissioned CALLER is not a reachable TERMINAL if the EVIDENCE
can fail to arrive** (Codex #1573 r9 P1). This is the sharpest correction in the
section, because it lands on the rule the whole design rests on. R2's clock is
the authenticated `finalizedAt`, and `finalizedAt` reaches the mirror **only**
through the Base→mirror V2 broadcast (constraint 12). If that broadcast never
executes — lane outage, or a permanently failed packet — the mirror holds
neither the zeroed marker nor the clock, so **there is nobody who can call the
lapse**, `_dayPoolHalves` stays halted, and every later day's claims on that
chain stall indefinitely. That is precisely the unbounded stall constraint 2
requires a terminal for and R2 claims to discharge.

**R6 sharpens it rather than helping.** One might hope a compensation packet
carries duplicate timing evidence — but R6 suppresses dispatch for every zeroed
day after the first, so the later days receive no packet at all. The design's
own stranding bound removes the redundant evidence path.

So R2 needs one of: a **permissionlessly re-presentable proof of the finalized
broadcast** — anyone can supply the authenticated evidence, decoupling the
terminal from that one delivery — or an **independent, bounded, mirror-known
terminal** that does not depend on cross-domain evidence at all. Which, and its
safety argument, is open.

> **The general rule, and it now has three instances — state it once.**
> **A permissionless terminal requires permissionlessly OBTAINABLE evidence,
> not merely an unpermissioned caller.** R2 here (the lapse needs
> `finalizedAt`), R6b (the gate needs proof of consumption), and R6a (the loss
> record needs a liability figure) are the same defect three times: each made
> the *caller* open and left the *input* on a single delivery whose loss is
> terminal. When adding any permissionless path to this design, name its inputs
> and ask who can supply them if the lane carrying them is down. If the answer
> is "nobody", the path is not permissionless — it is merely unpermissioned.

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
perform the corresponding **Base-side recovery-position credit — bounded by the
amount Base ACTUALLY RECOVERS, on authenticated Base receipt** (Codex #1573 r4
P1: the original declared total, the mirror's receipt and the amount finally
returned can all differ when either leg lands short; crediting the declared
total, or crediting before receipt, over-states the re-dispatchable position
for tokens that are still missing or were burned — an uncharged emission path,
with any residual tracked separately) — and
reduce the mirror's **spendable** delivered-fresh backing.

**Spendable, by SUBTRACTING A SECOND CUMULATIVE — never by decrementing the
receipt cumulatives** (Codex #1573 r7 P2, correcting the r5 wording, which said
"decrement … bound to the receipt's own attribution"). The receipt counters are
**gross lifetime sums of deliveries** and the tree already depends on it:
`RewardRemittanceFacet` writes both with `+=` only, and
`RewardRemitLedgerTest.test_DeliveredFresh_CountedPlusUncountedIsExhaustive`
asserts `counted + uncounted` reconciles **exhaustively** over every
non-recycled delivery. A decrement makes those lifetime figures non-monotonic,
breaks that reconciliation, and erases the returned receipt from operator
reconstruction — the receipt *did* happen, and the ledger should still say so.

So:

- `rewardBudgetArmedFreshReceived` and `rewardBudgetFreshUncounted` stay
  **append-only**, exactly as `rewardBudgetRemittedGlobal` already is, and for
  the same reason: monotonicity is what makes them usable as evidence;
- R4 adds a **separate receipt-bound RETURNED cumulative**, attributed to the
  same counter the original receipt was credited to;
- spendable backing is the **difference**, derived at read time.

**And the append-only discipline applies to the BASE side too — that is where
it came from** (Codex #1573 r9 P1). The rule above was written for the mirror's
receipt counters and left Base's side with no instrument for the authenticated
inflow at all: `rewardBudgetRemittedGlobal` is append-only, so an
implementation was left choosing between decrementing it, which destroys the
gross-evidence semantics the whole rule exists to protect, and recording the
inflow nowhere. The fix is the same counter shape — with the recovered
counter's ROLE fixed by the 2026-08-07 decision (Codex #1586 r2 P1: an earlier
revision of this list said "net 69M usage is `gross remitted − recovered`,
derived at read time", which an implementer would wire straight into
`remaining` — exactly the reopening the decision rejects):

- `rewardBudgetRemittedGlobal` stays **append-only** (gross remitted), and it
  is what `remaining` reads — **`remaining` never reads the recovered
  cumulative**;
- R4 adds a **receipt-bound BASE RECOVERED cumulative** whose role is
  **recovery-position evidence**: it credits and bounds the re-dispatchable
  position of the decision block above, and is never a deduction from cap
  usage;
- the operator reporting view of net physical outflow is
  `(gross remitted + re-dispatched) − recovered`, **additions first** (Codex
  #1586 r3 P2 + r4 P2: the two-term form reports zero while value has left
  Base again, and the subtraction-first ordering underflows once a
  re-dispatched parcel is recovered a second time — 100 gross / 200 recovered
  / 100 re-dispatched is reachable and its true net outflow is zero). Every
  authenticated recovery follows a dispatch of one of the two kinds, so
  `recovered ≤ gross + re-dispatched` holds by construction; implementations
  still evaluate additions-first and saturate defensively. A reporting view
  only, feeding no funding-planning surface and never `remaining`, which
  reads gross alone. **Scoped to the R4/Mode-B flow** (Codex #1586 r5 P2): a
  governance-ceremony recovery of a released reservation returns value whose
  dispatch is in `gross` but whose recovery rides the ceremony's own
  instrument — unspecified until R6d — so ceremony recoveries enter operator
  reporting only once R6d defines that instrument, and this view does not
  claim to cover them.

**⚠ This exposed a real tension — since DECIDED (2026-08-07, below).** The
claim path's truncate-and-consume rule is justified by
`remaining = CAP − paidOut − remittedGlobal` being **monotone non-increasing** —
a trimmed remainder is unfundable forever, so consuming the entry alongside it
costs the claimant nothing. If `recovered` feeds `remaining`, that monotonicity
breaks: headroom can rise, and entries truncated before a recovery were retired
against a bound that later loosened. If `recovered` does *not* feed `remaining`,
the cap permanently under-counts a pool that genuinely still holds the tokens,
and R4's reversal accomplishes nothing.

The accounting shape above is right either way — a gross counter and a separate
recovered counter — so it can be specified now. **What feeds `remaining` was the
decision**, and it had a stated cost on both sides; the ratification below takes
the non-reopening side, with a disposition that discharges most of that side's
stated cost (the re-dispatch never charges twice — below).

**✅ DECIDED 2026-08-07 (owner) — the recovered cumulative does NOT feed
`remaining`, ratified jointly with #1568 §3.6a** (decided across both modes
at once, as the coordination note below required; the retained charge itself
is a Mode-B property — see the narrowing recorded there). What was this
document's conservative default is now the permanent rule: recovered value
sits in an explicitly separate, **non-reopening** recovery position, visible
to operators and excluded from 69M headroom. No Mode-B recovery ever moves
`remaining` upward, so with respect to THIS path the claim path's
truncate-and-consume justification is untouched and no past truncation is
retroactively falsified. Stated path-scoped on purpose: the one upward
movement that exists anywhere is the pre-existing, governance-gated
released-reservation ceremony in the boundary note below — claims truncated
while released funds sat stranded can have been consumed before that ceremony
restores headroom, and reconciling THAT with truncate-and-consume is R6d's
open item. This decision neither creates nor cures that window.

**The owner also settled the recovered tokens' DISPOSITION, which the default
had left open: recovered VPFI is re-used for platform interaction rewards —
not burned, and not quarantined.** The recovery position is a *source* for
future interaction-reward funding, and — the owner's model, stated precisely —
**a recovery-sourced re-dispatch does NOT charge `rewardBudgetRemittedGlobal`
a second time**: the parcel's cap charge happened at its original dispatch and
is never repeated. Stated with each counter's direction explicit (Codex #1586
r4 P2: "the 69M counter only ever decreases" conflated the two and read as an
instruction to decrement the gross-evidence counter): the append-only
`rewardBudgetRemittedGlobal` only ever INCREASES, and only at first dispatch;
`remaining` headroom only ever DECREASES, and only at first dispatch; recovery
and re-use move neither. `remaining` therefore never rises (recovery is not a
credit) and is not debited again on re-use (a re-dispatch is not a new mint). Two constraints make this safe
rather than a cap bypass, and both are implementation requirements: a
recovery-sourced dispatch must be **sourced from and bounded by the recovery
position's receipt-bound balance** — anything else is an uncharged emission
path; and it must advance its **own re-dispatch cumulative**, so the
reconciliation over gross remitted / recovered / re-dispatched stays
exhaustive — reusing `rewardBudgetRemittedGlobal` for it would re-introduce
the second charge, and reusing nothing would leave physical outflow
unaccounted. Which targets a recovery-sourced dispatch may fund (ordinary day
funding, an R1c supplemental top-up, a later manual compensation) is R4
mechanism design, specified with it in the P2 design document. The one honest
residual of the old "accepted cost": a recovered parcel with no admissible
target left at end-of-program simply remains treasury-held VPFI — nothing
about this decision strands value mid-program.

**Boundary — the released-reservation TRANSPORT-CUSTODY recovery is a
NEIGHBOURING CASE this decision does not cover.** TokenomicsTechSpec §9's
"Delivered-backing ledger" passage (the B2-d2 operator-valve bullets) already
ratifies that when an operator-RELEASED reservation's tokens — sent but never
executed, sitting in the CCIP token pool, never delivered to any mirror — are
physically recovered pool → Diamond, that governance ceremony restores BOTH
the lifetime emission headroom and the recycled bucket. That is not overruled
here, and the asymmetry is deliberate — with the ORDERING as the spec states
it (Codex #1586 r2 P1: an earlier wording here said a re-remittance had
"already" consumed new headroom by ceremony time, which reverses the spec'd
sequence and, followed literally, would bypass the post-close backing gate):
a released day stays UNFUNDABLE while its tokens sit in transport custody —
every remittance-planning surface gates each day on post-close backing — so
the recovery ceremony runs FIRST, restoring the original charge and the
backing, and only then can the replacement re-remittance proceed under its
own single fresh charge. Net one charge per funded day, achieved by
restore-then-recharge through an evidenced governance act. R4's case needs no
restoration at all: its day lapsed, no replacement send will ever exist, and
the parcel is re-usable against its standing original charge (the uncharged
re-dispatch above) — restoring automatically on a permissionless path would
be the exact reopening this decision rejects. *(Since decided one step
further: the owner unified the ceremony itself on the recovery-position
pattern — `Vpfi1434P2ZeroedDayMechanismsDesign.md` §5.3 — so after P2-w6's
FunctionalSpec amendment the restore, and with it the one non-monotone
window, is gone entirely.)* The residual tension — the
ceremony makes `remaining` rise too, inside its narrow governance-gated
window — belongs to R6d's open recovery-settlement item, which must specify
the ceremony's evidence and clearing path and reconcile it with the
truncate-and-consume justification rather than leave the two rules adjacent
and unexplained.

**This coordinates with #1568's repatriation case — which at the time was NOT
on this branch** (Codex #1573 r10 P2). An earlier revision cited
`VpfiCrossChainRecyclingDesign.md` §3.6a as having already settled the
repatriation direction — the exact unverifiable cross-branch dependency **R4a
records this section making once before**, repeated. The local rule above was
therefore kept self-contained rather than waiting on that section landing.
What was checkable then — "the two paths share `rewardBudgetRemittedGlobal`"
— was later NARROWED (Codex #1586 r5 P2): only fresh remittances advance that
counter, so Mode A's recycled surplus was never in it and the retained-charge
rule is a Mode-B property; the operative point survives in weakened form —
both modes needed the same no-restore decision, and the claim path's
monotonicity reliance is on the counter Mode B retains its charge in. **Both
documents have since merged (`268e7db10`, `37256d430`), and the 2026-08-07
decision above was taken jointly across them, as this note required.**

**Two deltas, not one — the mirror's OUTFLOW and Base's INFLOW are different
numbers** (Codex #1573 r8 P1). The paragraph above already establishes that the
declared total, the mirror's receipt and the amount finally returned can all
differ when a leg lands short, and correctly bounds the Base-side
recovery-position credit by what Base **actually recovers**. Applying that same
figure to the mirror's returned cumulative is the error: on a fee-on-transfer
or partially-burned return, the mirror no longer holds the taxed portion, but
an inflow-sized decrement leaves it counted as spendable backing — so later
claims can consume backing for tokens that are gone. Track both, each bound to
the receipt: the **mirror's actual outflow** drives its returned cumulative,
and **Base's actual inflow** drives the recovery-position credit. They
coincide only when the return lands whole,
and assuming they always do re-creates on the mirror the exact over-backing
this rule exists to prevent on Base.

The r5 attribution point is preserved and still load-bearing — it just applies
to which returned-cumulative the return lands in. A compensation that overtook
the arming broadcast was booked to `rewardBudgetFreshUncounted`, **not**
`rewardBudgetArmedFreshReceived`; netting its return against the armed side
would consume armed credit belonging to *unrelated* deliveries and defer their
properly-funded claims. Bind the return to its own receipt's attribution.
Otherwise P1-b later treats returned, no-longer-held VPFI as funding.

**"Its own receipt's attribution" must mean the EFFECTIVE one, because
constraint 16 lets attribution move** (Codex #1573 r10 P1). Constraint 16
requires a compensation that overtook the arming broadcast to become
attributable once `D*` installs — i.e. re-attributed from
`rewardBudgetFreshUncounted` to `rewardBudgetArmedFreshReceived`. If that
re-attribution runs *before* a late return settles, a rule that nets against
the counter which **originally** received the delivery subtracts from the
uncounted side while the **armed** credit for those same tokens stays live —
so later claims can draw backing for VPFI that has already left the mirror.
Two rules, each correct alone, composing into an over-credit.

So the receipt carries **one effective classification**, and re-attribution and
return must update it **atomically** — or a receipt that is quarantined or
return-pending must be **ineligible for re-attribution** until its return
settles. The second is simpler and loses nothing: a delivery on its way back is
not funding anything, so promoting it to armed credit has no purpose.

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
repatriation design "already states", which was **not verifiable from this
document's branch at the time** — the C2 design carried a matching constraint
but the two changes were unmerged and cross-referencing each other (Codex
#1573 r4). Both have since merged; the rule stays stated in full because it
is P2's own, not because the other statement is unavailable.

**R4b — the arriving compensation must be CLASSIFIABLE at ingress, and today's
wire split makes it not** (Codex #1573 r7 P1). R4a says late receipts are
quarantined; that presumes the mirror can tell a late receipt from an on-time
one when it arrives. It often cannot. Constraint 4 requires compensation to be
able to land while the mirror is still **unstamped**, and constraint 12 puts
`finalizedAt` and the lapse schedule in the **broadcast** — a separately
delivered message, over a transport that orders nothing. A compensation that
arrives after its true expiry but **before** that broadcast presents as
perfectly ordinary: the mirror has no expiry to compare against, credits it
normally, and claims can consume the funds before the broadcast later proves
the delivery must be returned. That is R4a's own failure mode reintroduced
through the classification gap rather than through timing.

Two ways to close it, and this design takes the first:

- **Authenticate the applicable expiry on the remit itself**, so the message is
  self-classifying at ingress regardless of broadcast arrival. Constraint 15
  already binds a compensation to **exactly one** day, so carrying that day's
  expiry adds no ambiguity, and R5 already requires the schedule to be
  authenticated in both domains — this is where the mirror's copy arrives for
  the manual path. Preferred.
- Quarantine **every** unstamped compensation until the broadcast installs the
  schedule. Correct but strictly worse: it makes an on-time delivery's
  availability depend on a second message, and quarantine-until-broadcast has
  no terminal of its own if that broadcast never arrives — which is the same
  unbounded-wait shape R2 exists to eliminate.

This is the same ordering gap as constraint 16 (compensation overtaking the
arming broadcast), one layer down: **any property the mirror must evaluate at
ingress has to travel with the delivery, not alongside it.**

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
strands at most one delivery rather than one per zeroed day.

**"Unresolved" means THE DELIVERY'S VALUE IS NEITHER CONSUMED NOR RECOVERED —
never "the outcome is unknown"** (Codex #1573 r6 P1, r7 P1 ×4, and r10 P1
correcting this opening line itself). The clearing rule has now been wrong in
three directions, so it is stated as an exhaustive state machine rather than as
a sentence — and the *definition* is stated in terms of stranded value, because
r8 established that a **cancelled** delivery has a perfectly known outcome and
is still stranded. An implementation keyed on outcome-certainty clears the gate
on cancellation and permits repeated dispatches while prior funds sit in the
CCIP pool.

r6 established that a *post-lapse* ACK is not resolution: R4 has the mirror
finalize/ACK the original reservation *before* starting the fresh-return, so
releasing the gate there would free Base to dispatch again while the tokens and
the return settlement are still outstanding. That much stands.

**The r6 wording then over-generalised it to "only a recovered receipt plus
completed reversal clears the gate", and that breaks the ordinary path.**
Several reachable states never produce a return at all — including the *most
common* one, an ordinary on-time delivery — so under that rule the gate never
clears and the chain is locked out of compensation permanently:

| State | What actually happened | Terminal |
| --- | --- | --- |
| **Consumed on time** | mirror credited the delivery, users were paid, no return settlement exists or ever will (r7 P1) | **consumption ACK** clears |
| **Consumed on time but short** | all delivered tokens landed and were credited; the *day* awaits a top-up (R1c) | **consumption ACK** clears — see R6c |
| **Delivered after lapse** | quarantined (R4a), fresh-returned, Base credits the recovery position (the 2026-08-07 settlement — never a cap deduction) | **return settlement** clears |
| **Permanently undeliverable** | ingress rejects a malformed instruction; CCIP leaves it failed-but-re-executable and re-execution repeats the failure, so there is no ACK and no return (r7 P1) | **HOLDS the gate.** Cancellation records the message's terminal state but does **not** clear it — §2d leaves the tokens locked in the CCIP pool (r8 P1). See R6d |
| **Cancelled, recovery pending** | the dispatch is provably dead and cancelled, and the pool → Diamond recovery has not settled yet (r9 P1) | **HOLDS the gate** — the tokens are still stranded, which is the only thing R6 measures |
| **Recovered** | the governance recovery settled and Base authenticated the inflow | **recovery settlement** clears |
| **In flight, no evidence yet** | genuinely unknown | **HOLDS the gate** |

**The gate's question is "are these tokens still stranded?" — never "is the
outcome known?"** (r8, sharpened by r9 P1: an earlier revision of this table
still called in-flight "the only state that holds the gate", which the
cancellation row had already falsified in the same edit). The gate clears
exactly when the delivery's VALUE is accounted for — consumed, or come back.
Three distinct states hold it, and only one of them is an unknown: a cancelled
delivery has a *perfectly* known outcome and is still stranded. The r6 point
survives as its narrow form — an ACK that closes a reservation *in order to
start a return* is not a terminal; a consumption ACK on a delivery the mirror
actually credited is.

**R6b — the EVIDENCE must be permissionlessly re-presentable, or an ACK-lane
outage becomes a user-loss mechanism** (Codex #1573 r7 P1). Base learns of
consumption through the ACK. If the forward lane is healthy but the independent
mirror→Base ACK lane is not, Base cannot distinguish "consumed" from "in
flight", so the gate holds and R6 suppresses later compensations **that the
working forward lane would have delivered**. That is new user loss created by
the gate itself, not the pre-existing lapse exposure — and it is the one place
R6 stops being user-neutral. Clearing must therefore be a **re-presentable
proof of receipt**, submittable by anyone, not a one-shot message whose loss is
terminal. This is R2's principle applied to the gate: a permissionless terminal
on authenticated evidence.

**R6c — compensation-resolution and DAY-resolution are different axes**
(Codex #1573 r7 P1). R1c leaves a short-but-on-time receipt with the day
partially backed and awaiting supplemental funding, while R6 forbids a new
compensation for the chain. Read as one axis those are circular: the top-up is
itself a compensation, so the terminal R1c requires is unreachable, and the only
exits left are lapsing an on-time receipt or reopening — both of which R1c
exists to avoid. They are not one axis. The *compensation* is resolved the
moment its tokens are credited: nothing is stranded, which is the only thing R6
bounds. The *day* remains unresolved. **A receipt-bound top-up to a day whose
earlier compensation was consumed is therefore permitted by R6**, because it
cannot create a second stranded delivery — the first one's tokens are already
accounted for. What R6 forbids is a second *independent* dispatch while an
earlier one's outcome is unknown.

**R6d — ingress may not leave a token-bearing message with no terminal**
(Codex #1573 r7 P1). R1a requires rejecting a non-zero amount against zero local
interest, and Base structurally cannot pre-validate it: the mirror-local
interest that would prove the instruction malformed is exactly what Base does
not hold (that is why R1a exists). So the malformed case *reaches the receiver*.
If the receiver reverts, CCIP records a failed-but-re-executable message —
re-execution replays the same payload and fails identically, producing neither
ACK nor return, and R6 then locks the chain forever while the tokens sit
undelivered. **Rejection must be token-safe**: accept-and-quarantine the
delivery, or provide a permissionless authenticated cancellation terminal for a
provably-undeliverable dispatch. "Revert and rely on re-execution" is only valid
where re-execution can *succeed*.

**But cancellation is a terminal for the MESSAGE, not for the STRANDING — and
it therefore does NOT clear the R6 gate** (Codex #1573 r8 P1, correcting the r7
wording, which listed authenticated cancellation as a clearing terminal). §2d is
explicit about where the tokens are: on a send that never executes they *"sit
locked in the CCIP token pool, genuinely outside Diamond custody"*, which is why
`releaseRemitReservation` restores no value counter and a re-remit consumes new
headroom and new backing. **Physical recovery (pool → Diamond) is a separate
governance operation.** So a cancelled-but-unrecovered delivery is still
stranded, and clearing the gate on cancellation would let a second compensation
go out beside it — with repeated malformed instructions accumulating *unbounded*
stranded deliveries under a rule whose entire purpose is to bound them at one.

The gate therefore clears on **receipt-bound recovery settlement**, or
cancellation must atomically recover and settle. Since §2d makes recovery a
governance op rather than an atomic step, the practical reading is the first.

**That this clearing is operator-gated is acceptable, and the reason is worth
stating** — constraint 3 warns that operator-gated exits do not bound a wait,
and this looks like one. The distinction is *what* is gated. R6 gates **Base's
dispatch of further compensation**, not any user outcome: the R2 lapse stays
permissionless, days still retire, claims still settle. A stuck R6 gate costs
future compensation opportunities, which is exactly the exposure R6b already
names and prices; it cannot stall a user's claim the way an operator-gated
*lapse* would. The one-stranded-delivery bound is worth that cost; a
permissionless clearing that leaves tokens stranded is not.

**R6e — the gate is per CHAIN, across deployment epochs** (Codex #1573 r7 P2).
Constraint 20 already treats delayed packets from retired deployments as
reachable and keys receipts by deployment identity. If the gate is keyed the
same way, rotating Base resets it: the new deployment sees no outstanding
compensation and dispatches a second one while the old deployment's is still
unresolved — two stranded deliveries, which is precisely what R6 forbids.
Activation/rotation must **inventory unresolved compensations and carry the
gate forward**, or the gate must be evaluated against a deployment-independent
per-chain view.

> **R6a is stated further down, not here** — it belongs to the loss discussion
> that follows rather than to the gate mechanics above, so the sub-rules of R6
> run R6b … R6e, then R6a. Do not stop reading at R6e.

**R6 does NOT cap the USER loss, and it must not be read as doing so.** In the
case R6 was designed for — a dead lane — the loss is a day lapsing at zero, and
that happens whether or not a compensation was dispatched, because a
compensation sent into a dead lane does not arrive either way. There R6 changes
*those tokens were sent and came back* into *those tokens were never sent*:
strictly better operationally, neutral for the user. An earlier framing of this
bound as "capping the exposure" was wrong in exactly the way this section keeps
having to correct, so it is stated in its narrow form here.

**But neutrality is NOT universal — R6b is a standing exception** (Codex #1573
r11 P2). When the **forward lane is healthy and only the ACK lane is down**,
the first compensation is delivered and consumed while Base cannot see it, so
the gate suppresses later compensations that the working forward lane **would
have delivered**. Those days lapse because of the gate, not because of the
outage. That is R6-*induced* loss, and it is why R6b requires the clearing
evidence to be permissionlessly re-presentable. Operators and implementers must
not treat every R6 suppression as pre-existing outage loss: in the split-lane
case it is new, and it is attributable to this design.

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
down**. It is bounded by outage duration and capped by nothing.

**R6a — and R6 makes it LESS observable, so the lapse must instrument itself**
(Codex #1573 r6 P2). An earlier revision said the honest posture was
detect-and-report, "the uncounted/stranding counters make it visible". **That
was wrong, and R6 is what makes it wrong**: by suppressing dispatch for every
zeroed day after the first, R6 ensures those days produce **no delivery at
all** — and both `rewardBudgetFreshUncounted` and the stranding counters only
ever observe tokens that were actually sent or received. The days R6 suppresses
are precisely the bulk of the correlated loss, and they would move no counter.

So the **permissionless lapse terminal must itself record the loss**, rather
than relying on delivery-side counters that R6 guarantees will stay silent.
Without that, the one part of this design that was honest about the accepted
cost stops being able to see it.

**But it must record a NON-BLOCKING observable, not the exact unpaid amount**
(Codex #1573 r7 P1, correcting the r6 wording, which asked for "the day, the
chain, and the unpaid amount"). The exact figure is the per-user capped
liability of §2 — a keeper-fed, chunked accumulation — and a day is zeroed
**precisely when that accumulation did not complete or did not reach Base**.
So the one input the exact figure needs is the one the failure removed. Making
its recording a *precondition* of retirement would either leave the terminal
unsatisfiable, or make it depend on privileged data — reintroducing the
unbounded, privileged stall that R2 exists to eliminate, inside the very
mechanism that discharges it. This is the same fact as R1a's capped-liability
correction, met from the other direction.

So the shape is:

- the lapse terminal emits an observable **status and identity** — the day, the
  chain, that entries were retired at zero, and a count — plus any magnitude
  that is derivable from **mirror-local state without privileged input**,
  explicitly labelled as a **bound** rather than as the loss;
- **nothing about that record may block retirement.** If a figure is
  unavailable, the terminal still completes and the record says so;
- if an exact loss figure is wanted, it is a **separate completion path** that
  can attach it later and **cannot prevent retirement** — reconciliation, not a
  gate.

Observability was the point of R6a, and observability does not require
exactness. A day that retired at zero, flagged as such and countable, is what
makes the accepted cost visible; the precise number is reconciliation work.

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

**Further items are genuinely OPEN, and none of them is a parameter.** No count
is given — this list grew in four of the last five review rounds, and a stated
count is a claim that goes stale faster than the list does.

- **R1c's partially-backed state** — its pinned representation and its
  permissionless terminal are required but not yet specified. R6c cleared one
  blocker (R6 permits a receipt-bound top-up), and **r10 found a second behind
  it**: §4's `rewardBudgetRemitted[c][d]` marks a day funded at send and only a
  release re-opens it, so a consumed short delivery leaves the day
  un-fundable through the ordinary path. The open item is now concrete — a
  **supplemental transition admitted despite the day marker, accumulating
  against the same receipt-bound obligation** — not merely "a terminal is
  needed".
- **R6b's propagation into §3/§5/§6** (r10) — §5 still promises that the
  bounded operator reconcile means a lost ACK never permanently suppresses
  funding. That is the privileged path constraint 10 rejects, and R6 makes its
  silence cost other days too. The ack-binding text and the test plan must
  carry the permissionless re-presentation requirement, or a suite written from
  §5 will assert the privileged path is sufficient.
- **The conversion's authenticated input** (r7, re-opened r8) — pricing must
  not use uncapped local interest, and r7's proposed replacement (size from §2's
  report) is **falsified**: §2c superseded that formula and §2b forbids the
  report for the zeroed-chain case, which is the compensation case. What is
  needed is an authenticated input originating **on the mirror**, where the
  capped liability lives; the leading shape is a mirror-authenticated
  `(Δ, per-side amount)` quote that Base only funds. Likely adds a wire path.
- **R1d's finalization proof** (r8) — what authenticates that a mirror's local
  interest close has run, so a zero can be classified as genuine rather than
  not-yet-folded, and what the bounded terminal is for the undecidable case.
- **R6d's recovery settlement** (r8) — cancellation does not clear the gate;
  the pool → Diamond recovery that does is a governance op, and its evidence
  and clearing path are unspecified. It also inherits a reconciliation duty
  from the 2026-08-07 `remaining` decision: the TokenomicsTechSpec's
  released-reservation ceremony restores emission headroom, which makes
  `remaining` rise inside its governance-gated window, and the recovery
  settlement must square that with the truncate-and-consume justification
  (boundary note above) rather than leave the two rules adjacent and
  unexplained. **The reconciliation is DECIDED** (owner, 2026-08-07 —
  `Vpfi1434P2ZeroedDayMechanismsDesign.md` §5.3): the ceremony unifies on
  the recovery-position pattern — no restore, `remaining` monotone
  everywhere — with the FunctionalSpec amendment carried by P2-w6; the
  evidence and clearing mechanics are specified there (§5.1/§5.3).
- **R2a's evidence path** (r9) — the lapse cannot be invoked at all if the
  broadcast carrying `finalizedAt` never executes. Needs either a
  permissionlessly re-presentable proof of the finalized broadcast, or an
  independent bounded mirror-known terminal. **This is the largest open item
  in the section**: without it R2 does not actually discharge §2g's pin in the
  case the pin was written for.
- ~~**What feeds `remaining` after a recovery**~~ — **DECIDED 2026-08-07
  (owner), jointly with #1568 §3.6a** as required: `recovered` does NOT reopen
  69M headroom. The gross/recovered counter split stands, and a Mode-B
  recovery never moves `remaining` in either direction — no credit on
  recovery, no second debit on re-use, because a recovery-sourced re-dispatch
  is uncharged, bounded by the position's receipt-bound balance, and tracked
  on its own cumulative. The recovered position's exit is re-use for platform
  interaction rewards. Full statement — including the two implementation
  constraints that keep the uncharged path from becoming a cap bypass —
  beside the R4 accounting rules above; §3.6a's "returned tokens do NOT
  restore interaction-pool headroom" is thereby ratified rather than default.
  The released-reservation ceremony's governance-gated rise stays R6d's item.
- **The residual's ledger and terminal** (r7) — floor dust plus cap-bound
  excess is delivered-but-unpayable VPFI. R1a says what it is *not* (a debt);
  what holds it and how it leaves is open.
- **R6b's re-presentable proof of receipt** (r7) — the mechanism that lets
  anyone clear the gate from authenticated evidence when the ACK lane is down.
  Without it the gate itself creates user loss.
- **R6d's cancellation terminal** (r7) — for a dispatch that is provably
  undeliverable, so ingress rejection is never unrecoverable.
- **R6e's cross-epoch gate** (r7) — how unresolved compensations are inventoried
  and carried across a Base deployment rotation.
- **R6a's exact-loss completion path** (r7) — the lapse terminal records a
  non-blocking observable; whether an exact unpaid figure is attached later, and
  by what path, is open. Whatever it is, it may not gate retirement.
- ~~The correlated-loss bound~~ — **DECIDED 2026-08-06 (#1571)** and landed as
  **R6**: no new manual compensation for a chain while an earlier one is
  unresolved. Note what R6 does and does not do — it bounds the **stranding**,
  not the **user loss**, and the correlated user loss remains *inherent* to
  lapsing on a clock while a lane is down. It is bounded by outage duration,
  capped by nothing short of reopening lapsed days, and is therefore a
  **detect-and-report** exposure. Do not cite R6 as a cap on user harm — and
  note R6b: badly implemented, the gate can *add* to that loss rather than
  leaving it unchanged.

### General rule earned here, applicable beyond P2

**A field named for an OBLIGATION is not the amount that MOVED, and the two
diverge exactly where a cap or clamp bites.** `EntrySplit.armedFresh` is kept
whole for commitment retirement while `total` sheds the capped-off part;
`interactionPoolPaidOut` mixes legacy-schedule and armed payouts;
`armedFreshFull` is pre-clamp. Before transmitting, bounding, or subtracting
any such field, establish which side of that line it is on. Findings across
#1556 and this section keep reducing to this one mistake — it has recurred in
most review rounds, which is why it is stated as a rule rather than fixed as a
list of sites.

**R1a's conversion denominator (r7) is the same mistake again, and the most
expensive instance so far.** `localInterest` is the mirror's *uncapped*
aggregate — an obligation figure. What moves is the **capped** sum, whose
current definition is §2c's per-ENTRY finest-split supremum
`Σ_covering-entries min(perDay_e × Δ_D / 1e18, C_side)` — **with no `paid`
term** (Codex #1573 r10 P1: this rule quoted the superseded per-user form
`Σ_users min(rawPay_user, C_side − paid_user)`, which §2c replaced precisely
because a user-keyed, transfer-variant quantity can be regrouped by an
ownership change; a quote built against it underfunds users after a transfer).
Dividing a delivered amount by the
former prices against money that will never be paid, and the gap is material
rather than dust. The tell was present and missed: §2 of this very document
already defines the mirror's liability as the capped sum, and names the
`− userSideDayPaidVpfi` term that stops it factoring out.


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
  exactly one slice — **which #1434 P1-b (`83483149e`) delivered.** d4's first
  attempt was withdrawn with the halt left fail-closed; P2-w3 discharged the
  zeroed-day prerequisite and P1-b the delivered-fresh one (§2g), after which
  P1-b removed the halt. `_dayPoolHalves` itself now halts only
  on an unstamped day; a stamped `remitIneligible` day still defers through
  `_p2DayDeltas`'s zeroed-and-open state. None of this may be reordered.
- **Per-chain commitment bound** (becomes real in d3): stated in governor
  §7 #6 and **not reproduced here** — a copy is what let this line carry the
  bare `chainConsumedRecycled[c] ≤ chainReportedRecycled[c]` long after B3's
  release falsified it. What matters at this level: it is a subtraction-first
  bound, not that bare form, because a released commitment is legitimately
  re-committable.
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
  availability (the §3.6a formula — this line carried a `reported − consumed`
  form that predates B3's release term and #1568's repatriation terms both)
  and widen the Ā
  attribution headroom in `recordChainRecycled`. Because
  `creditedCumulative()` derives a floor of `recycleBucket + paidOutRecycled`,
  leaving `recycleCreditedCumulative` unwritten is NOT sufficient — the
  custody counter is subtracted from that floor.
  *(This bullet originally said the credit advances `recycleCreditedCumulative`;
  that was written while B2-b forced mirror `avail = 0` and is unsafe now.)*
- **pending never double-allocates and a lost ack never permanently suppresses**
  (d2): reservation bound to the ack key, idempotent+retryable finalize,
  bounded operator reconcile against observed CCIP status.

  > **⚠ The second half of that guarantee is NOT met once R6 exists, and the
  > operator reconcile is not a sufficient answer** (Codex #1573 r10 P1). This
  > bullet promises that a lost ACK never permanently suppresses funding, and
  > backs it with the **bounded operator reconcile** — which is exactly the
  > privileged path **constraint 10** rejects: it is a transaction from the
  > same discretionary party whose silence is the failure mode. With R6 in
  > place, a lost ACK additionally holds the per-chain gate and suppresses
  > **later** compensations, so operator silence now costs other days too
  > (R6b). An implementation built from this §5 bullet alone would omit R6b's
  > permissionless surface and recreate the ACK-only user-loss mode.
  >
  > **R6b's requirement propagates here**: the clearing evidence must be a
  > permissionlessly **re-presentable proof of receipt**, not only an operator
  > reconcile. Carry it into §3's ack-binding text and the §6 test plan too —
  > the two recovery contracts must not be left in conflict, and a test suite
  > written from the older one would assert the privileged path is enough.
- **quote == send:** the clamp is mirrored at all 3 remit sites.

## 6. Test plan (per slice; full 3-chain e2e is B4)

d1: mirror batches accumulate + conservation completes + send ships the
per-side aggregate; Base ingress stores liabilities + `.complete`
(post-finalize acceptance); armed finalize fires on interest coverage alone
(no commitment input — §2b); zeroed-interest chain marked `remitIneligible`,
reported chains not; unarmed/incomplete days unreportable; cursor + entry
validation rejections; keeper send pass. d2: pending→ack→remitted lifecycle,
lost-ack reconcile, clamp at 3 sites, quote==send. d3: the §7 #6 commitment
bound (subtraction-first — a test written from the bare `consumed ≤ reported`
rejects healthy post-B3 states),
one-bucket-one-ledger, netting sum identity, idempotent
commitment-on-arrival (a RESERVATION, not a bucket debit — §2e.1).
**d4 (first attempt withdrawn; DELIVERED by #1434 P1-b)** — while the halt was
pinned, a mirror armed day priced nothing, with a canonical control proving the
mirror flags were what stopped it. P1-b then delivered the slice: a mirror
prices its own stamp, `!stamped` still waits, and the coverage this line
anticipated landed across two slices: the delivered-FRESH bound with P1-b, the
zeroed-day repricing case with P2-w3. d5: Ā-excluded credit
advances cumulative but not the day-bucket; 3-way forfeit/expiry classify;
no-recycle→budget→expiry→bucket Ā inflation (the geometric-inflation guard).
