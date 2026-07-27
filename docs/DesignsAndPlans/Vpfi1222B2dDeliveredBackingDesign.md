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
| **P2 Mirror consume-on-arrival + two-sided netting** | mirror debits its own bucket for the locally-funded slice; Base books `chainConsumedRecycled` / `chainOutstandingRecycledCommit`; `_stampOne` splits local vs Base top-up | must be gated by delivered backing (P4) or it cannibalises the mirror bucket |
| **P3 Σcommitments remittance clamp** | `chainRewardBudgetForDay = min(uncappedSlice, Σcommitments − remitted − pending)`, 3 sites | needs P1's reported total + P4's ledgers |
| **P4 Delivered-backing ledger** | `pendingRemitted` reservation at dispatch → authenticated ack → `loanSideRewardRemitted`; bounded reconciliation | **greenfield** — no ack channel exists in any direction today |
| **P5 Mirror armed-day pricing ON** | remove the `_dayPoolHalves` mirror halt so mirrors price their own delivered-backed stamp | unsafe until P2+P4 guarantee the priced recycled halves are backed |
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
- **B2-d3 — Mirror consume-on-arrival + two-sided netting + per-chain books.**
  P2. `_stampOne` split (mirror avail = delivered-backed availability), Base
  books `chainConsumedRecycled`/`chainOutstandingRecycledCommit`, mirror
  `LibVpfiRecycle.consume(recycleConsume)` under the `broadcastV2Applied`
  idempotency, remittance netting. **Makes the per-chain §7 invariants bind.**
- **B2-d4 — Mirror armed-day pricing ON.** P5. Remove the `_dayPoolHalves`
  line-879 halt; keep the genuine `!stamped` wait.
  **⚠️ HARD ORDERING GATE (Codex #1430 r3): d4 MUST NOT land before d5.**
  Lifting the halt is what makes mirror armed-day claims reachable, and a
  mirror's claim path debits its bucket for the WHOLE recycled payout while
  only the locally-funded share was ever credited there — the Base-funded
  top-up arrives as VPFI but `onRewardBudgetReceived` only increments
  `rewardBudgetReceivedTotal`, never the bucket. A 40-local/23-top-up day
  would then consume 63 against a 40 bucket: the bucket floors at zero,
  `paidOutRecycled` over-counts by 23, and the DERIVED
  `creditedCumulative` (`bucket + paidOut`) reports those 23 Base-funded
  tokens as this chain's own new absorption — phantom availability Base
  re-commits on later days. d5 is exactly the fix the plan already
  specifies for this (§M3's `Ā`-feed exclusion: remitted-recycled credits
  the mirror bucket for availability/custody labelling while staying OUT of
  the `credited[d]`/`Ā` feed), so the two must land in that order.
  Gated behind d2+d3+**d5**.
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
   under the existing whole-day `broadcastV2Applied` idempotency). The bucket
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
  is the sole `.complete` writer; d4 is the sole thing that removes the mirror
  pricing halt — none may be reordered.
- **`consumed ≤ reported` per chain** (becomes real in d3): `chainConsumedRecycled[c] ≤ chainReportedRecycled[c]`.
- **One bucket, one ledger:** a mirror-local slice reserves into
  `chainOutstandingRecycledCommit[c]`; a Base-funded slice into the global
  `outstandingCommitRecycled` — never both.
- **No double-pay across surrender+remit:** mirror-surrendered + Base-remitted =
  exactly the funded recycled slice (two-sided netting, d3).
- **No manufactured Ā (d5):** the remitted-recycled custody credit advances
  `recycleBucket` + `recycleCreditedCumulative` (availability/netting) but
  **skips** `recycledCreditedByDay` (the Ā day-bucket) — those tokens were
  Ā-counted once on Base at first absorption.
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
one-bucket-one-ledger, netting sum identity, idempotent consume-on-arrival. d4:
mirror prices its own stamp; `!stamped` still waits. d5: Ā-excluded credit
advances cumulative but not the day-bucket; 3-way forfeit/expiry classify;
no-recycle→budget→expiry→bucket Ā inflation (the geometric-inflation guard).
