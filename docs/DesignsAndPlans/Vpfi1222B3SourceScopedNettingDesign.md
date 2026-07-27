# #1222 M3 B3 — Source-scoped netted remittance: closing the per-chain
# commitment loop

> **Scope.** Programme #1349, plan
> [`VpfiRecyclingCompletionPlan.md`](VpfiRecyclingCompletionPlan.md) §M3,
> slice **B3** — "source-scoped netted remittance completion (shortfall-only
> sends on the per-chain books d3 creates)". Predecessor record:
> [`Vpfi1222B2dDeliveredBackingDesign.md`](Vpfi1222B2dDeliveredBackingDesign.md).
>
> The plan is FROZEN. Everything below is either quoted from it or a
> delegated implementation decision recorded here, per the plan's "the
> implementing PR picks one and tests it" convention.

## 1. What d3 already shipped, and the exact gap that remains

The phrase "source-scoped netted remittance" covers two halves. **d3 shipped
the send half**: `RewardRemittanceFacet._planDay` nets a destination's
locally-funded backing (`ChainDayFunding.recycleConsume`) out of the recycled
legs, so Base ships only the shortfall. That is live and tested.

**The book half was left open, deliberately and explicitly.** `LibMeshFunding`
says so at the write site:

> `chainOutstandingRecycledCommit[c] += commitLocal;`
> — "Monotonic in d3: Base has no authenticated view of mirror claims, so
> **B3's source-scoped netting is what retires it.**"

and the d2/d3 design record §3 says the same from the other side:

> "the reservation ledger is what B3's netting retires once a
> mirror-consumption signal exists (Base cannot observe mirror claims in d3)
> … **Direction of any drift is conservative**: un-claimed mirror commitments
> leave Base counting more instructed than the mirror eventually spends, so
> Base UNDER-states that chain's availability and under-funds it — never the
> reverse."

So B3 is one thing: **give Base an authenticated mirror-retirement signal, and
close both books with it.**

Concretely, two defects follow from the missing signal.

**(a) The per-chain reservation ledger never retires.**
`chainOutstandingRecycledCommit[c]` has exactly one writer (`+=` at armed-day
finalization) and no decrementer. It grows without bound and diverges further
from the mirror's real `outstandingCommitRecycled` on every claim and every
forfeit. Nothing funds off it today — it is a transparency surface and the
subject of B4's §7 per-chain commitment invariants — so this is a
correctness gap in an assertion surface, not a live payout bug. It is,
however, the exact figure B4 is due to assert on, so it cannot stay wrong.

**(b) Released commitments are permanently lost from Base's availability
model.** Base models a mirror's committable bucket as

```
avail_c = chainReportedRecycled[c] − chainConsumedRecycled[c]
        = (mirror's monotonic credit inflow) − (Base's instruction cumulative)
```

A mirror retires a reservation two ways: a claim **consumes** it (tokens
leave, `paidOutRecycled` grows) or a forfeit/RL-3 expiry **releases** it
(tokens stay in the bucket, nothing is paid). Working the algebra through the
mirror's own ledger:

```
mirror truth   = creditedCum − paidOut − outstanding
               = creditedCum − Σinstructed + Σreleased
Base's model   = creditedCum − Σinstructed
```

The models differ by exactly **Σreleased**. Every forfeit and every expiry on
a mirror permanently shrinks Base's picture of that chain's availability, even
though the tokens never moved. The drift is monotone and unbounded over a
deploy's lifetime: a chain with ordinary forfeit rates eventually reads as
having zero availability while its bucket is full, at which point Base funds
that chain's entire slice from Base's own balance and the mesh has quietly
degenerated back to "Base funds everything".

The direction is safe. The magnitude is not bounded. B3 fixes it.

## 2. The signal — decided here (plan-delegated)

### 2.1 What the mirror reports

Two new **monotonic cumulative counters**, maintained locally on every chain
inside the two existing commitment-retirement primitives:

| Counter | Incremented in | By |
| --- | --- | --- |
| `recycleCommitRetiredCumulative` | `LibVpfiRecycle.consume` **and** `releaseCommitment` | the **actual** decrement applied to `outstandingCommitRecycled` |
| `recycleCommitReleasedCumulative` | `LibVpfiRecycle.releaseCommitment` only | the same actual decrement |

`released ≤ retired` by construction. Both count the *actual* decrement, never
the requested amount: both primitives floor the outstanding sum at zero
(bounded cap-trim dust — see their natspec), so counting the request would
over-report retirement on a chain whose outstanding is already exhausted.

They ride the existing mirror→Base day-close report, which already carries
this chain's recycled cumulative and its day-bucketed credit. Report payload
goes **6 → 8 words**.

### 2.2 What Base derives

Base ratchets both counters per chain (`chainRetiredRecycledCommit[c]`,
`chainReleasedRecycledCommit[c]`) exactly as it ratchets
`chainReportedRecycled[c]` — monotonic, so a stale or reordered delivery can
never walk them back — and then:

```
outstanding_c  ←  outstanding_c − Δretired            (floor 0)
avail_c        =  reported_c − (consumed_c − released_c)  (both floored — see §2.3)
```

The identity that makes one counter enough for the ledger is worth stating,
because it is why B3 does not need to know *which* day a retirement belonged
to:

```
Base's per-chain outstanding
  = (instructions not yet applied on the mirror)  +  (mirror's live outstanding)
  = (instructed − applied)                        +  (applied − retired)
  =  instructed − retired
```

The "applied" term cancels. Base never has to track how far the broadcast
pipeline has drained; instruction-minus-retirement is exact at every instant,
including with messages in flight.

### 2.3 Why the release credit cannot be gamed — the hard ceiling

Both figures are **clamped on ingest to Base's own instruction cumulative**,
`chainConsumedRecycled[c]`, and `released` is additionally clamped to the
ratcheted `retired`. Base therefore trusts the mirror for *timing only*, never
for magnitude: the clamps are evaluated against Base-local state.

That yields the load-bearing bound, by construction and independent of what
any mirror sends:

```
released_c ≤ consumed_c   ⟹   avail_c = reported_c − (consumed_c − released_c) ≤ reported_c
```

**The availability read is arranged as a subtraction, never an addition**
(Codex #1435 r1 P1). `reported_c + released_c − consumed_c` is mathematically
identical under the clamp, but it can OVERFLOW: `chainReportedRecycled[c]` is
ratcheted to whatever cumulative a chain reports and is deliberately unbounded
(B1 — it is that chain's own lifetime absorption), so a faulty or compromised
mirror sending a near-maximal cumulative alongside any nonzero release would
make the read revert. That failure is not contained: this read sits on the
`finalizeDay` path through the mesh funding pass, and the ratchets cannot be
walked back — one such report would wedge day finalization for the entire mesh,
permanently. The subtraction form cannot overflow, both of its subtractions are
floored regardless of the clamp, and it makes the ceiling **structural** rather
than derived.

**A chain's availability can never exceed what it reported as locally
credited.** This is the invariant that keeps d5's exclusion intact. d5
deliberately kept remitted (Base-funded) custody out of `creditedCumulative`
precisely so Base could not re-commit against its own remitted tokens —
"phantom availability". The release credit rides *on top of* that same
`reported_c` and is capped by Base's instructions, so it cannot reintroduce
what d5 excluded. Relocated custody remains invisible to Base's availability
model.

### 2.4 The one imprecision, stated honestly

`outstandingCommitRecycled` is a single fungible sum on the mirror, not a
per-day ledger. A claim or forfeit whose recycled portion includes a
**Base-funded top-up** (which was never reserved locally) retires up to that
full amount, so it can eat a *different* day's reservation. `retired` and
`released` faithfully report that; Base's books then match the mirror's books
exactly, over-retirement and all.

This is pre-existing single-bucket behaviour accepted by d3 §5 ("one bucket,
one ledger"), and B3 deliberately reports reality rather than inventing a
per-day reservation ledger to paper over it. Its worst case is that
availability is restored a little early, bounded by the §2.3 ceiling; and the
consequence of over-committing a mirror is a **claim-walk deferral**, not a
wrong payout — the ShareOfPool walk budgets the recycled portion against the
chain's live balance and stops the day when it cannot cover it. A safe failure
mode with a self-clearing wait, which is exactly the property the d4
withdrawal note fixed as the standing rule.

### 2.5 Alternatives rejected

1. **Advance `recycleCreditedCumulative` on release.** Arithmetically
   equivalent for availability (`reported + released − consumed` collapses into
   one term) and needs no new report field. **Rejected**: that cumulative is
   also the baseline for B1's day-credit clamp ("Base clamps any report whose
   for-day credit exceeds the increase in the chain's cumulative since the last
   accepted report"). Inflating it with releases manufactures clamp headroom,
   and a mirror sender bug or replay could then feed excess into `Ā` — the
   precise hazard the clamp exists to prevent. Availability and `Ā` attribution
   must not share a counter.
2. **Report the mirror's live `outstandingCommitRecycled` instead of
   cumulatives.** One field, but it cannot express the in-flight term
   (instructions issued and not yet applied), so Base could not reconstruct its
   own ledger; and a live balance is not monotonic, so a delayed delivery
   would corrupt it. Cumulative-plus-ratchet is the shape every other field in
   this ledger already uses.
3. **A per-day mirror retirement report.** Exact per-day attribution, but it
   is a per-(chain, day) message with its own completeness gate — the cost the
   commitment report already pays for a quantity that genuinely needs day
   resolution. Retirement does not: §2.2's identity is day-free.

## 3. Wire evolution — report 6 → 8 words

Follows the plan's receiver-first rule verbatim, and the shape already in the
code (the report path dual-decodes 4-word legacy and 6-word B1 today; B3 adds
8).

- **Length is a sound discriminator here** — the report payload is a flat
  tuple of `uint256`s with no dynamic member, so there is no head-offset
  ladder to mis-read. This is why B3 does **not** need d5's leading-sentinel
  tag (`RemitWire.REMIT_WIRE_TAG_D5`), which existed because the remit payload
  carries a dynamic `uint256[]` whose head offset was doing double duty as a
  version marker. The 8-word length collides with `BROADCAST_PAYLOAD_SIZE` and
  `TIER_UPDATED_PAYLOAD_SIZE`, resolved by the `uint8 kind` tag exactly as the
  standing rule in the messenger already documents for the 4-word collision
  set.
- **Rollout order: Base first.** Base's messenger must accept 4/6/8 before any
  mirror sends 8. The existing missing-selector shims are extended one level:
  a mirror diamond in front of an older messenger falls back 8 → 6 → 4; Base's
  messenger in front of an un-cut diamond falls back to the 6-word ingress,
  dropping only the two new counters (which advance nothing when zero).
- **In-place upgrade over live state.** Mirror counters start at zero, so the
  first reports understate retirement and Base's self-heal starts from zero and
  ratchets forward as new retirements happen. Conservative, self-correcting,
  and identical in character to B1's cumulative seeding.

## 4. Invariants B3 establishes (B4 asserts them)

1. `chainReleasedRecycledCommit[c] ≤ chainRetiredRecycledCommit[c] ≤ chainConsumedRecycled[c]` — enforced by the ingest clamps, not by trust.
2. `availRecycled(c) ≤ chainReportedRecycled[c]` — the §2.3 ceiling, structural in the subtraction form; d5's exclusion survives. The read can never revert, whatever any chain reports.
3. `chainOutstandingRecycledCommit[c] == chainConsumedRecycled[c] − chainRetiredRecycledCommit[c]` — exact at every instant, in-flight messages included.
4. Base's own chain id is inert in all of the above: Base never instructs
   itself, so `chainConsumedRecycled[Base] == 0`, both clamps pin its copies to
   zero, and Base's funding uses `_recycleFundable`, never the per-chain model.

## 5. Single source of truth for availability

`_mirrorAvailable` in `LibMeshFunding` and `getChainRecycledLedger` in
`ConfigFacet` computed the same formula independently before B3. Both now call
one library helper (`LibVpfiRecycle.mirrorAvailRecycled`) so the funding path
and the operator-facing view cannot drift — the class of bug the plan's
"split rules chosen per-component would drift between claim caps and
remittance" warning names for the funding split.
