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
  remit sites. Closes #1351's remitted-clamp tail. **Effect:** Base never remits
  more than a mirror's reported+backed liability.
- **B2-d3 — Mirror consume-on-arrival + two-sided netting + per-chain books.**
  P2. `_stampOne` split (mirror avail = delivered-backed availability), Base
  books `chainConsumedRecycled`/`chainOutstandingRecycledCommit`, mirror
  `LibVpfiRecycle.consume(recycleConsume)` under the `broadcastV2Applied`
  idempotency, remittance netting. **Makes the per-chain §7 invariants bind.**
- **B2-d4 — Mirror armed-day pricing ON.** P5. Remove the `_dayPoolHalves`
  line-879 halt; keep the genuine `!stamped` wait. Gated behind d2+d3 landing.
- **B2-d5 — Third credit class (#1331).** P6. The Ā-excluded custody-credit
  primitive, the `VpfiRecycled` discriminator, the 3-site forfeit/expiry
  reclassification, the remit-arrival provenance tag. (Previously tracked as
  "B2-e"; §M3 says #1331 is absorbed by B2 — keeping it as the last B2-d slice
  is consistent.)
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
  permissionless mirror function;
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
   late report is also accepted — it stores exactly the liability figure the
   operator needs to size the manual remit.
5. **Mirror send/readiness are armed-gated** (`sendCommitmentReport` /
   `isDayCommitmentReady`): an unarmed quiet day is trivially "complete"
   (0 == 0 conservation), and without the gate the keeper trigger would burn
   CCIP fees reporting days Base never consults.

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
  (§2) — per-loan on Base, per-D1-user on a mirror.
- The reservation is **bound to the CCIP `messageId`** (§3): `pendingRemitted[messageId]
  → {dstChain, dayIds, per-side amounts}`. The clamp subtracts a **per-(chain,day)**
  running `pending` sum derived from open reservations; `remitted` is the
  ack-finalized per-(chain,day) counter (the mesh-grain sibling of the formula
  doc's per-loan `loanSideRewardRemitted`). Mirror-side, `processUserSideDay`
  clamps `cEff` by the delivered `remittedRemaining` (rev-15) so the mirror
  never pays past what actually arrived.

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
