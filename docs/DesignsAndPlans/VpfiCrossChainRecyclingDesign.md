# VPFI cross-chain recycling — recycle-at-source, net-remit, offset-at-canonical

**Status:** design proposal for a **decision**. Extends the recycle-first rule
(owner decision 2026-07-13, recorded in
[`UserValueEnhancementOpportunities.md`](UserValueEnhancementOpportunities.md) §5)
from a single-chain idea to the full five-chain deployment. Implements the
"how" behind #1217 (R-1) and feeds #1218 (R-2). Legal frame per #694.

> **PARTIALLY SUPERSEDED (2026-07-15, owner-directed redesign for #1222):**
> §3.4's "fresh-mint offset" distributor formula is replaced by the
> **absorption-coupled balance governor** in
> [`VpfiRecyclingBalanceGovernorDesign.md`](VpfiRecyclingBalanceGovernorDesign.md)
> — distribution now *tracks* absorption with a bounded platform-margin knob,
> instead of running the schedule regardless of absorption. The substrate here
> (bucket ledger §3.1, cumulative reporting §3.2, Option-B netting §3.3,
> keeper rider §3.5, Phase-C surplus tooling) is **kept as substrate**, with
> one timing override: §3.3's broadcast-time full-`recycleConsume` bucket
> debit is replaced by the governor's commitment model — the broadcast
> *commits* the amount; the bucket is *debited pro-rata at claim/remit*
> (governor doc §3.1), so unclaimed slices never strand outside the bucket. Read the governor doc first; return here for the
> mesh mechanics.

**Design goal:** every VPFI the protocol receives as fees — on any chain —
re-funds the interaction-reward and keeper-reward programs instead of
stagnating, with **near-zero legal surface** and minimal new cross-chain
machinery.

---

## 1. The problem, precisely

VPFI receipts accrue on **every** chain, not just Base:

- a borrower on Polygon takes the VPFI-LIF path → forfeiture/treasury share
  lands in the **Polygon** Diamond;
- notification fees, forfeited rewards, matcher-share remainders, future
  service-bond slashes — all accrue **locally** on whichever chain the
  activity happened.

But the recycling loop is anchored on **Base**: the 69M interaction-reward
pool lives there, daily finalization happens there, and fresh minting (the
thing recycling displaces) only happens there. Mirror-chain receipts are
burn/mint CCT representations. So the question is: **how do receipts on five
chains feed one canonical emission-offset loop?**

Constraints:

1. **Near-zero legal surface** — no purchases, no redemption, no yield
   promise, no discretionary market operations (the #694 frame).
2. **Minimal new cross-chain machinery** — every new lane/message is ops
   burden (watcher scope, rate limits, stuck-lane failure modes) and audit
   surface.
3. **The reward-accounting mesh already exists** (TokenomicsTechSpec §4a):
   daily mirror→Base interest reports, Base finalization, Base→mirror
   denominator broadcasts, and bounded retriable budget remittances (#776).
   A good design rides that mesh rather than building a second one.
4. **Strict bucket separation** — recycled VPFI must never commingle with
   user LIF custody or unclaimed reward budgets (the #892-family findings,
   esp. the L13 commingling/insolvency class).

---

## 2. Candidate designs considered

### Option A — physical repatriation (rejected as the default path)

Every mirror periodically bridges its receipts back to Base over the CCT
lane; Base credits its reward-emissions budget; Base then remits per-chain
reward budgets back out as today.

- **Why rejected:** VPFI makes a round trip for no reason. Every leg costs
  CCIP fees, consumes lane rate-limit capacity (ET-008 budgets), adds
  monitored surface, and can strand value mid-flight. A busy mirror would
  bridge fees to Base on Monday and receive nearly the same tokens back as
  reward funding on Tuesday. Operationally the worst option; legally fine
  but pointlessly heavy.

### Option B — recycle-at-source with netted remittance (RECOMMENDED)

Tokens mostly **stay where they land**. A mirror's local receipts become the
*first source* of that mirror's own reward-claim funding; Base remits only
the **shortfall**, and counts everything consumed-from-recycling — on every
chain — against fresh emission. Numbers cross chains (one field in existing
messages); tokens cross only when there is a genuine net deficit.

- **Why recommended:** collapses two opposite token flows into bookkeeping.
  Cross-chain token sends shrink as usage grows (a busy chain becomes
  self-funding). For the **daily netting path**, no new lanes and no new
  message types — two new fields in the two §4a messages that already flow
  daily. Detailed in §3.

  **This advantage is scoped to daily netting and does NOT cover Phase C**
  (Codex #1574 r2). Repatriation needs a mode discriminator on the wire and, per
  §3.6a constraint 3, may need a new authenticated channel plus sender/receiver
  contracts — a real operational and audit surface that this bullet would
  otherwise hide. Account for it separately when weighing Phase C.

### Option C — mirror-burn / canonical-remint (rejected)

Mirrors burn receipts locally; Base treats the burn as authorization to move
an equal amount of now-unbacked locked supply into the reward budget.

- **Why rejected:** it performs a token-pool accounting operation *outside*
  the CCIP pool protocol. The canonical-vs-mirror supply invariant
  (`locked on Base == Σ mirror supplies`) is exactly what the ops watcher
  alarms on — this design would manufacture permanent "drift" that the
  monitoring must then special-case, weakening the most important
  cross-chain safety check to save one message field. Bad trade.

### Option D — fully independent per-chain loops (rejected)

Each chain recycles into its own future funding with no global accounting.

- **Why rejected:** Base can't reduce fresh emission for value recycled
  elsewhere (the offset — the entire point — only works with global
  knowledge), and quiet chains strand surplus forever. Option B subsumes D
  and fixes both with one reported number.

---

## 3. Recommended design (Option B) in full

Name: **recycle-at-source, net-remit, offset-at-canonical.**

### 3.1 Per-chain recycle ledger

Every Diamond (Base included) gains a protocol-owned **recycle bucket**:

- Credited by every VPFI receipt class at the moment of receipt: yield-fee
  shares paid in VPFI, forfeited borrower-LIF custody (net of matcher
  share), forfeited interaction rewards, notification fees, matcher-share
  remainders, future service-bond slashes (#1219).
- Event per credit: `VpfiRecycled(source, refId, amount, dayId)` — the
  indexer/transparency surface derives everything from these.
- **Tracked-balance separation** with an on-chain invariant:
  `diamond VPFI balance ≥ userLifCustody + unclaimedRewardBudget +
  recycleBucket`. The recycle bucket is protocol-owned; the other two are
  user-owed. No path may pay users from the bucket except the
  Base-authorized consumption below (this is the structural fix direction
  for the L13 commingling finding, extended cross-chain).

  > **It becomes FOUR-way when §3.6a Mode B lands** (Codex #1574 r11 P1). A
  > **stranded-recovery reservation** — a post-lapse compensation held for
  > return — is a fourth owner of this balance: not `unclaimedRewardBudget`
  > (its day lapsed), not the bucket (never reported as that chain's
  > availability). Left out of this invariant, of
  > `LibVpfiRecycle.backingPosition`, and of the watcher, the check stays
  > green while an ordinary fresh claim spends the very tokens Mode B exists
  > to return. Governor §7 #3 carries the same amendment — this bullet is the
  > *narrative* statement of the same invariant, and an implementer reading
  > §3.1 first would otherwise never reach it.

### 3.2 Reporting — one new field on an existing message

The §4a day-close report (mirror → Base, already idempotent per
`(dayId, chainId)`) gains one field:

- `chainRecycledVpfi18` — **cumulative** recycle-bucket credits on that
  chain through day `D` (cumulative, not per-day delta, so a missed or
  late-zeroed day self-heals on the next report; Base derives the delta).

Base's own receipts are written directly under Base's chain id at its local
day-close, exactly like its interest report — no message, no fee.

### 3.3 Netted funding at finalization — one new field on the broadcast

When Base finalizes day `D` it already computes each chain's reward budget
`B[c][D]` (per-side ratios, per-day-cap trimmed). Two changes:

1. **Netting:** the CCIP token remittance for `(c, D)` becomes
   `max(0, B[c][D] − availRecycled[c])`. **`availRecycled` has ONE definition
   and it lives in §3.6a** — claim-side terms *and* the separate repatriation
   debit/release terms, saturating and subtraction-first. Do not restate it
   here or anywhere else; a partial restatement is what let the repatriation
   terms go missing from three sections at once (Codex #1574 r6).
2. **Consumption instruction:** the existing finalized-denominator broadcast
   (Base → mirror) gains a field `recycleConsume[c][D] = min(B[c][D],
   availRecycled[c])`. On arrival the mirror moves exactly that amount from
   its recycle bucket into its local claim budget — **idempotently per
   `dayId`, with the stamp covering the WHOLE per-day broadcast**: the
   mirror stamps `broadcastApplied[dayId]` on first application, and a
   redelivered or governance-replayed broadcast for the same day is a
   no-op for **every** bucket-touching field it carries —
   `recycleConsume` AND the §3.5 `keeperAllocate` alike (Codex rounds
   4–5: broadcasts are retriable by design, and a double-apply of either
   field would move the bucket twice while Base counted once).

   > **`keeperAllocate` is NOT a bucket DEBIT** (Codex #1578 r7 P2). This
   > paragraph called it "bucket-debiting"; §3.5's amendment makes it an
   > **inside-bucket earmark** — `recycleKeeperBudget` rises and the bucket
   > balance does **not** move, which is what keeps governor §7 #8's
   > composition intact. Debiting on arrival would lower §7 #8's right side
   > with no payout or repatriation term to account for it, tripping a
   > CRITICAL over-credit on the first non-zero allocation. **The
   > idempotency requirement is unchanged and applies identically** — a
   > redelivered broadcast must not advance the earmark twice either.
   > `recycleConsume` remains a genuine debit.

   Consumption is **only** ever
   Base-instructed — a mirror never self-consumes — so the global ledger
   cannot double-count and the accounting identity below holds by
   construction.

Netting applies **after** the per-day-cap trim (the trim defines what the
chain actually needs; recycling changes the *source*, never the amount).

### 3.4 Offset at the canonical mint

> **SUPERSEDED** by the balance governor
> ([`VpfiRecyclingBalanceGovernorDesign.md`](VpfiRecyclingBalanceGovernorDesign.md) §3):
> rewards are paid from the Diamond's existing balance against a fixed
> drawdown allowance, not minted per-day, so this
> offset formula has no mint to offset; and the schedule-blind pool size is
> replaced by `dailyPool[D] = scheduleFloor[D] + (1 − marginBps) × Ā[D]`.
> Retained below for the record.

The distributor (R-1, #1217) funds day `D`'s pool as:

```
totalRecycledConsumed[D] = Base's own consumption + Σ_mirrors recycleConsume[c][D]
freshMint[D]             = dailyPool[D] − min(totalRecycledConsumed[D], dailyPool[D])
```

**Rounding-dust cap (Codex round-10):** the per-chain budgets `B[c][D]`
are deliberately rounded UP per chain/side
(`LibInteractionRewards.chainRewardBudgetForDay`), so on a fully-recycled
multi-chain day `Σ B[c]` can exceed the nominal `dailyPool[D]` by dust.
The fresh-mint offset therefore caps at the pool (saturating at zero
fresh mint) — the dust overfund is funded from recycled balance like the
rest of the consumption and tracked as a separate `recycledDust`
counter, and the invariant below is stated against the capped value.

Invariants (test + transparency surface):

- `Σ freshMint ≤ 69,000,000` — **the category cap bounds fresh mint only.**
  Recycled tokens were already minted once and already counted; re-using
  them extends the program's effective life without touching the 230M
  global cap (which the token enforces regardless). This is the accounting
  decision that makes "recycling extends the runway" literally true, and it
  needs an explicit TokenomicsTechSpec §4/§9 statement.
- per chain: the **commitment invariant** — ONE statement, and it lives in
  §3.6a alongside the availability formula it is the mirror image of. It is a
  subtraction-first bound, *not* `consumedCumulative ≤ reportedCumulative`
  (that form is false once a released commitment can be re-committed).
- per day: `freshMint[D] + min(totalRecycledConsumed[D], dailyPool[D])
  == dailyPool[D]` — with any excess of `totalRecycledConsumed` over the
  pool equal to `recycledDust[D]` (the round-up overfund, bounded by
  chains × sides × 1 wei-scale unit).
- The R-2 (#1218) metric falls out directly:
  `netEmission[D] = freshMint[D]`.

### 3.5 Keeper-reward budget — same principle, Base-authorized

The keeper-reward budget is per-chain already, and deep chains should fund
their own housekeeping from local receipts — but a mirror must **never
debit its recycle bucket unilaterally**, or Base's `availRecycled` view (one
definition, §3.6a) drifts and Base can broadcast a `recycleConsume` the mirror
can no longer fund (Codex round-1 finding). So keeper allocation flows through the same
single authority as claim funding: at finalization Base computes an
optional `keeperAllocate[c][D]` and carries it in the **same broadcast** as
`recycleConsume`. One authority, one message, no local-draw drift.

> **⚠ AMENDED — the two ledger moves this paragraph used to direct were both
> wrong** (Codex #1578 r2/r5, applied here r6). It said Base *"counts it into
> `consumedCumulative[c]`"* and the mirror *"debits its bucket on arrival"*.
> Each breaks a CRITICAL invariant on the **first non-zero allocation**:
>
> - **Charging `consumedCumulative`** breaks `outstanding + retired ==
>   consumed`. Those paired books describe *claim commitments*; a keeper
>   credit reserves nothing into `chainOutstandingRecycledCommit` and retires
>   nothing out of it. Same defect as charging a repatriation there.
> - **Debiting `recycleBucket`** lowers §7 #8's bucket composition without
>   advancing `paidOutRecycled` or `repatriatedOutCumulative`, so the watcher
>   raises a CRITICAL over-credit against a healthy allocation.
>
> **The correct shape is BOTH of the following, and neither alone:**
>
> 1. **Mirror side — an inside-bucket earmark**, which already exists.
>    `recycleKeeperBudget` works exactly this way: `_applyRecycleRegister`
>    *"earmarks part of each day's margin from INSIDE the bucket, so the
>    bucket does not move."* No tokens leave, so §7 #8 is undisturbed.
> 2. **Base side — a separate keeper debit/release ledger** in the
>    availability formula (§3.6a) and in governor **§7 #6**. The earmark
>    reserves nothing in Base's per-chain availability, and `reported` is a
>    *lifetime* cumulative — so with no keeper term advancing, **the next
>    finalization can allocate the same tokens again** as `recycleConsume`,
>    giving `outstandingCommitRecycled + recycleKeeperBudget > recycleBucket`
>    and underbacked commitments.
>
> The general rule, which is what §3.6a reached for repatriation: **a new
> draw on the bucket needs its own Base-side ledger term, and where the
> tokens physically sit is a separate question from whether Base has reserved
> them.** Tracked on **#1569**.

**Claims fund first; keeper takes only the residual** (Codex round-2 P1:
an uncapped bps-of-inflow allocation could instruct a total debit above
the bucket). The combined instruction is computed sequentially against
the same availability:

```
recycleConsume[c][D] = min(B[c][D], availRecycled[c])
keeperAllocate[c][D] = min(reportedInflow[c][D] × keeperBps / 10_000,
                           availRecycled[c] − recycleConsume[c][D])
```

so `recycleConsume + keeperAllocate ≤ availRecycled` by construction and
the **commitment invariant** (§3.6a — one statement, subtraction-first) is
preserved. A day whose claims exhaust the bucket simply funds no keeper
allocation that day.

### 3.6 Surplus handling (the only place tokens still travel)

If a chain's `availRecycled` exceeds a governance knob (e.g. N× its trailing
30-day average daily budget), the surplus is flagged operator-visible.
Disposition, in order of preference:

1. **Carry** (default — future days consume it; zero action).
2. **Batched repatriation to Base** — operator/keeper-triggered CCIP send
   from the mirror's recycle bucket to Base's reward-emissions budget,
   reusing the #776 remittance machinery in reverse (bounded, quoted,
   retriable, lane-limit aware). Like every other bucket debit, the
   repatriation is **Base-authorized and Base-ledgered**: the operator
   triggers it on Base, which takes the **repatriation debit** (§3.6a
   constraints 5/5a — *never* `consumedCumulative`, which would break the
   `outstanding + retired == consumed` identity) *before* instructing the
   mirror send, so `availRecycled` never overstates a bucket drained by a
   reverse remittance (Codex round-2 finding; ledger corrected r5/r6). Expected to be rare: only
   structurally quiet chains or chain sunsets.
3. Local keeper-budget credit (§3.5) where that budget is the binding need.

Never: market operations, LP seeding from this bucket, or any automatic
disposal — surplus movement is always a deliberate, bounded, protocol-
internal transfer.

### 3.6a Repatriation mechanics — TWO modes over one transport (#1568, added 2026-08-04)

§3.6 ratified the *planned* case. Implementation scouting for **#1568**, and the
**#1571** lapse decision, established that repatriation has a **second caller
with different books**, and that conflating them corrupts the per-chain ledger.

| | **Mode A — planned surplus** | **Mode B — stranded-delivery recovery** |
| --- | --- | --- |
| Trigger | Base-initiated (§3.6: operator triggers on Base) | **Mirror**-initiated — the mirror is where the stranded tokens land |
| Source of tokens | the mirror's **recycle bucket**, via a dedicated surplus debit — **not** `LibVpfiRecycle.consume` (constraint 2) | a **stranded-recovery RESERVATION** holding the late arrival — never plain un-earmarked balance (constraint 4) |
| Was it in Base's `reported` availability? | **yes** | **no — never** |
| Availability debit | a **separate repatriation debit term**, taken before the send under a releasable pending authorization — **not** a bare `chainConsumedRecycled += amount`, which breaks the `outstanding + retired == consumed` identity on the first repatriation (constraints 5, 5a) | **none** — these tokens were never in `reported` |
| Base-side ledger | a **pending authorization**, closed on return and released **only on an authenticated cancellation ACK** (constraints 5, 5c — proven non-execution alone is NOT sufficient) | a **one-shot recovery entitlement** that SURVIVES the original ACK and is consumed exactly once (constraint 6) — finalize/ACK alone is not enough |
| Mirror-side precondition | the surplus flag / operator instruction | the day must have reached an **irreversible lapsed** terminal (constraint 9a) |

**Availability must carry the repatriation terms** (Codex #1574 r5). Today it
is `reported − (consumed − released)`, **saturating, subtraction-first** — the
form `LibVpfiRecycle.mirrorAvailRecycled` actually implements. That formula alone is **not
sufficient** once constraints 5/5a select a separate repatriation ledger: a
successful Mode-A return leaves claim-side `consumed` untouched, so an
unextended formula **re-offers the drained amount** to later broadcasts — while
charging `consumedCumulative` instead (which an earlier revision of constraint
5 directed, and no longer does) breaks the `outstanding + retired == consumed`
identity 5a names. The
design must therefore extend availability to
`reported − (consumed − released) − (repatDebited − repatReleased)`, in the
same saturating, subtraction-first shape, and **no direction anywhere may say
"increment `consumedCumulative`" for a repatriation**.

> **Operand ratification (Codex #1608 r2 P2):** the
> `(repatDebited − repatReleased)` net is a **maintained slot**, not a
> derived subtraction — the draw slot is charged on authorization and
> decremented by the authenticated cancellation ACK, with the lifetime
> released cumulative kept separately as monotonic observability. Deriving
> the net from two gross cumulatives fails in both directions: the derived
> figure under-counts the live draw once any release has occurred
> (re-offering genuinely drawn capacity), and a gross debited cumulative
> wedges every later authorization on overflow after a cancelled near-max
> draw. The published pair is `(netDraw, lifetimeReleased)` and every
> consumer uses `netDraw` directly — governor §7 #6 carries the identical
> operand note.

**A THIRD draw term lands with C3** (Codex #1578 r5, applied here r6). The
keeper allocation of §3.5 is a separate draw on the same bucket, so it takes
its own pair on the same footing: `− (keeperDebited − keeperReleased)`. The
mirror-side earmark stays inside the bucket (§3.5's amendment), which is why
this term is about **Base's reservation**, not about tokens moving. Without
it, `reported` being a lifetime cumulative means the next finalization can
re-offer the earmarked tokens as `recycleConsume`.

The generalisation, now that three draws have needed the same treatment:
**every new draw on the bucket gets its own saturating debit/release pair
here — never a share of `consumed`** — and governor §7 #6's bound gains the
matching term. Where the tokens physically sit is a separate question from
whether Base has reserved them.

**Why Mode B must not touch the claim-side ledger at all.** Writing it as
`reported + released − consumed` is not an equivalent rearrangement here: a
mirror's reported lifetime cumulative is unbounded, so on a faulty or hostile
report near `type(uint256).max` the addition overflows and reverts **before**
the subtraction, wedging the mesh finalization path. Record the
subtraction-first form as the invariant. A late compensation's tokens were never reported by the
chain and never entered its availability, so charging them to `consumed` would
subtract availability the chain never had — understating `availRecycled` by the
recovered amount, permanently, on every recovery. The two modes share a
transport and nothing else.

#### The commitment invariant is this same formula read as a bound

The availability formula and the per-chain commitment invariant are **one
proposition**, not two. Availability is the quantity; the invariant is the
statement that the quantity never had to saturate. They drifted apart because
they were maintained as independent sentences (Codex #1574 r6 P1), so:

- the **formula** is stated above, in this section, and nowhere else;
- the **numbered invariant** is
  [`VpfiRecyclingBalanceGovernorDesign.md`](VpfiRecyclingBalanceGovernorDesign.md)
  §7 #6 — the list `MeshLedger.invariant.t.sol` cites *by number*, corrected in
  the same change that added this paragraph;
- everywhere else **must point at one of those two.** A third restatement is
  the defect.

**This is a RULE. No claim is made about how many copies remain.** Four
successive revisions asserted the sweep was complete and all four were wrong —
r7 missed the governor's numbered invariant, r9 the test docstrings and a test
plan, r10 five more sites, and r11 an **eighth** in the governor's §6 that was
wrong in three independent ways at once (double-subtracting `outstanding` on
top of `consumed`, omitting `released`, omitting the repatriation terms).

**A count is itself a claim, and the r10 revision replaced "the sweep is
complete" with "a sweep found seven" — which was stale within one round.** So
no number is recorded here either. What is recorded is the rule above and the
canonical locations; the state of the code-side copies tracked in #1577 is
recorded in the paragraph below. Anyone who finds another restatement has found
a defect, not a counterexample to a claim — and should fix it here rather than
adding to a tally.

**#1577 swept the code side.** What changed — recorded without a count and
without a completeness claim, for the reason the paragraph above gives:

- `contracts/test/invariants/MeshLedger.invariant.t.sol` stated the
  overflow-prone **addition** form in its docstrings and in its function name
  while its own body implemented the subtraction form. The invariant is now
  `invariant_ClaimNetWithinReported`, and the docstrings state
  `sat(consumed − released) ≤ reported`. The body was already correct and did
  not change.
- `contracts/test/GovernorDayPoolTest.t.sol` **asserted** the bare form under an
  `"SS7 invariant"` label. Both assertions now net the release off before
  comparing, and the fixture premise that makes the two forms coincide there
  (`released == 0`) is asserted rather than left implicit. They pass
  identically, which is the point: the bare form was true by fixture, not by
  invariant.
- NatSpec and comments across `contracts/src/` **and `contracts/test/`**,
  carrying both retired shapes: the bare `reported − consumed` and the
  overflow-prone `reported + released − consumed`.

**The rule above earned itself three times inside this one change, so the claim
was replaced by a check.** A first pass corrected four `contracts/src/`
restatements and stated the code side was swept. An adversarial review found
four more, all describing `_mirrorAvailable` by its pre-B3 formula, one of them
in a comment block a fix had already edited. Review then found four more still —
two of them the addition form, and some in `contracts/test/`, which the
verifying grep had never searched. Each pass wrote a narrower claim than the
previous one and each was falsified within a round.

The lesson is not that the sweeps were careless; it is that **this proposition
cannot be held true by prose.** So it is now executable:
**`contracts/script/check-commitment-formula.py`**, step **2c** of
`predeploy-check.sh`. It extracts comment CONTENT from `contracts/src` and
`contracts/test` — comment-only lines, trailing comments and `/* */` blocks
alike — strips the delimiters, joins contiguous runs (a formula split across two
lines is one statement, and that is how the addition form survived a sweep), and
fails on any retired shape, including shapes written with production ledger
names like `chainReportedRecycled[c]`. A block may name a retired form
deliberately — to reject it, or to describe a past revision — by carrying
`formula-check:allow <reason>`, reason on the marker's own line.

**The guard was itself vacuous in four independent ways, and every one was found
by attacking it rather than reading it.** Its scan roots were cwd-relative while
`predeploy-check.sh` cds into `contracts/` first, so it walked nothing and
printed OK. It joined comment lines without stripping `///`, so the multi-line
case it existed for produced `reported + released − /// consumed` and matched
nothing. It ignored trailing comments entirely. And an exemption marker with no
reason passed, because the reason was read from the joined block rather than the
marker's own line. Scanning zero files is now a hard failure, and the checker
reports how much it examined so a silent no-op cannot look like a pass.

`check-commitment-formula.selftest.sh` is that attack, committed: every hole
ever found in the guard is kept there as a case, alongside correct shapes it
must NOT fire on. **The count lives in the script, which prints it when run** —
an earlier revision of this paragraph enumerated the cases here, and that
enumeration was stale within one round, in a document whose own rule two
sections above is that a count is a claim. Third instance of that pattern inside
one change; the count is not coming back. It is deliberately **not** wired into
the deploy gate — it mutates a source file and restores it, which is not
something a pre-deploy path should do — so it is run by hand when the guard
changes.

**No count of REMAINING restatements, and no claim that the sweep is complete,
appears in this document — the check is that claim**, and it states what it
scanned when it runs. (Counts of what HAPPENED — how many rounds found what, and
that this pattern has now recurred three times — are history, not a standing
assertion about the tree, and do not go stale. An earlier revision of this
sentence said no count appeared at all, which the paragraphs around it plainly
falsified.)

**The bare form `consumedCumulative ≤ reportedCumulative` is FALSE and must not
appear as a current claim anywhere.** That is the one thing worth stating here,
because it is why the invariant moved: release exists precisely so a commitment
released un-spent can be committed again, so `consumed` is *deliberately*
unbounded by `reported` in healthy states. Report 100 → consume 100 → release
100 → consume that same 100 again is valid at `consumed = 200, released = 100,
reported = 100`, and a test or transparency check written from the bare form
**rejects a healthy B3 state.**

**The correct forms are in governor §7 #6 and are deliberately not reproduced
here** (Codex #1574 r8 P2 — an earlier revision of this paragraph declared §7 #6
the sole numbered statement and then restated both forms immediately below it,
which is the defect this section had just named). Two properties of them are
worth knowing without following the link, because they are the reasons the
wording is load-bearing rather than stylistic: every term is formed by
**saturating subtraction**, and the multi-ledger bound is **not written as a
sum** — a reported cumulative is unbounded, so any addition on that side reverts
on a hostile near-max report instead of failing the comparison. Equal over ℝ,
different over `uint256`, and only one of those runs.

**They therefore need an explicit MODE DISCRIMINATOR on the wire**, and Base
must reject a payload whose mode does not match the ledger action it is about
to take. This is the #1434 §2h constraint 15 lesson applied one layer up: a
shared wire generation carrying two meanings, with only an aggregate bound
between them, is how one transfer gets booked twice.

> **✅ RATIFIED 2026-08-07 (owner) — the discriminator IS the payload-kind
> tag, and the sharing stops at the transport.** This paragraph and §2h
> constraint 12a briefly read as contradicting each other — "one transport
> with a mode discriminator" versus "R4 needs its own payload kind, decoder
> and rollout compatibility" (surfaced on #1578 r7, recorded on #1434) — and
> the owner ratified the layered reading that satisfies both, per #1571's
> standing architecturally-clean instruction. The mirror→Base return CHANNEL
> is cut once and shared: whatever shape constraint 3 below resolves to (a
> mirror-side sender/escrow contract, or authenticated channel selection in
> the messenger), both modes ride it. Each mode is its own wire PROTOCOL on
> that channel: its own payload kind, its own decoder and Base-side handler,
> its own rollout-compatibility ladder, versioned independently (§2h 12a).
> The discriminator is therefore **not a mode field inside a shared payload
> schema** — one schema with a mode flag is exactly what 12a forbids, since
> one decoder and one rollout ladder for two protocols with different
> authenticated identities lets a rollout plan omit the fresh-return receiver
> entirely. The discriminator is the payload-kind tag itself, and "Base must
> reject a mismatch" means: the kind selects the ledger action, each kind's
> handler performs only its own mode's accounting, and a payload whose kind
> does not match the pending authorization or reservation it references is
> rejected, not coerced. **This is the canonical statement of the
> resolution** — §2h 12a and the completion plan's §M4 point here rather
> than restating it.

#### The returned tokens do NOT restore interaction-pool headroom

`rewardBudgetRemittedGlobal` is **append-only** — verified: written only with
`+=`, and even `releaseRemitReservation` (a send that can *never* execute) does
not restore it. That is load-bearing: the claim path's truncate-and-consume
rule is justified by `remaining = CAP − paidOut − remittedGlobal` being
**monotone non-increasing**, so a trimmed remainder is unfundable forever and
consuming the entry alongside it costs the claimant nothing. Decrementing it on
repatriation would falsify that argument and turn every earlier truncation into
a silent underpayment. **Neither mode decrements it**, so a lapsed compensation
permanently shrinks the interaction pool by its amount — the same conservative
treatment a released reservation already receives.

> **✅ RATIFIED 2026-08-07 (owner), jointly with §2h's `remaining` decision**
> — decided across both modes at once, as §2h required. The retained
> original cap charge is a **Mode-B property**: only FRESH remittances
> advance `rewardBudgetRemittedGlobal` (`RewardRemittanceFacet` advances it
> by the fresh component alone), and Mode A's recycled surplus was never in
> that counter (Codex #1586 r5 P2 — an earlier wording said the two paths
> "share" it, which could couple recycled repatriation to the fresh-cap
> ledger). Mode A's non-effect on 69M headroom holds independently:
> repatriated recycled value moves on the recycle bucket's own books (the
> repatriation debit ledger and its availability terms) and touches no
> fresh-cap instrument. This section's rule is now a ratified decision, not
> a conservative default: recovered or repatriated value never reopens 69M
> headroom, in either mode. §2h additionally records
> the owner's disposition for Mode B's recovered fresh value — re-used for
> platform interaction rewards via an uncharged, position-bounded re-dispatch
> (the parcel's cap charge happened at its original dispatch and is never
> repeated, so `remaining` neither rises on recovery nor falls again on
> re-use) — and the two implementation constraints that keep the uncharged
> path from becoming a cap bypass. The "permanently shrinks" above therefore
> holds for value that is never recovered; a RECOVERED parcel re-enters
> funding through the uncharged re-dispatch, so recovery un-does the shrink
> economically without ever moving the counter. Mode A's destination remains
> governed by
> constraints 1/1a below; nothing here changes it. One neighbouring case sits
> deliberately OUTSIDE both modes and this ratification: the
> released-reservation transport-custody recovery ceremony (tokens sent but
> never delivered, recovered pool → Diamond by governance), which the
> TokenomicsTechSpec ratifies as headroom-restoring — §2h's boundary note
> records why the asymmetry is intended.

#### Constraints — the mechanisms this section first proposed did NOT survive review

An earlier revision named a sink, a debit primitive and a transport. **All three
were falsified against the tree** (Codex #1574 r1), and the section now records
what the design must satisfy rather than proposing a second set to be falsified
in turn. The two-mode split above, and the append-only finding, were not
challenged and stand.

**On the destination:**

1. **`rewardEmissionsBudget` is TARGET-BOUNDED, so "credit it" is not a
   design.** `LibTreasuryBuyback._routePriority` credits only
   `min(delivered, cfgRewardEmissionsTopUpTarget − current)`, routes the
   remainder to keepers, and **reverts if neither gap can absorb it**. A
   repatriation larger than the rewards gap therefore lands somewhere else or
   fails permanently. Pin one of: this ingress credits rewards directly despite
   the target; each repatriation is capped to the live gap with the remainder
   left on the mirror; or a dedicated overflow sink exists.

1a. **If the live-gap option is chosen, the gap must be RESERVED, not merely
   observed** (Codex #1574 r10 P2). A gap measured on Base *before* dispatch is
   stale by the time the return arrives — an intervening buyback credit or a
   downward `cfgRewardEmissionsTopUpTarget` change can fill or shrink it. The
   promised rewards credit then reroutes to keepers or reverts outright,
   **after the mirror has already debited its bucket**, which is the one
   ordering this design cannot recover from: tokens gone from the source, no
   defined home at the destination. So the pending authorization must either
   **reserve that destination headroom** for its lifetime, or the ingress must
   define an explicit **arrival-time overflow/cancellation path**. A
   cross-chain-stale gap is not a stable cap, and treating it as one converts a
   routing preference into a fund-safety bug.

**On the mirror-side debit:**

2. **`LibVpfiRecycle.consume` is not a generic bucket withdrawal.** It also
   reduces `outstandingCommitRecycled`, advances
   `recycleCommitRetiredCumulative` and increments `paidOutRecycled`. Calling it
   for a surplus repatriation while a mirror holds live claim commitments would
   **retire those claims and record a reward payout that never happened**,
   corrupting the retirement report and the composition metrics the watcher
   checks. Mode A needs a distinct fundable-surplus debit, or an explicitly
   created-and-retired repatriation commitment that leaves pre-existing claim
   commitments alone.

2a. **The surplus debit needs its OWN accounting destination — it must not
   reuse the reward-payout counter.** `creditedCumulative` derives its upgrade
   floor from `recycleBucket + paidOutRecycled − relocated`, and the
   `bucket-composition` watcher check enforces
   `creditedRaw + relocated == bucket + paidOutRecycled + releasedRemitStranded`
   within its stated slack. Decreasing only the bucket therefore makes **every
   healthy repatriation** raise a CRITICAL over-credit finding, and on an
   unseeded upgraded Diamond it can drive the next derived cumulative **below**
   an earlier report. Specify a **seed-before-debit** step and a **monotonic
   repatriated-outflow counter** carried in the composition and reporting
   surfaces — not `paidOutRecycled`, which means "reward paid to users" and
   would book a payout that never happened (constraint 2's error one level up).

**On the transport:**

3. **A separate Base receiver is not reachable from the mirror Diamond as the
   messenger stands.** `CcipMessenger.registerChannel` enforces a one-to-one
   handler→channel binding, and each mirror Diamond is **already** the handler
   for `VPFI_BUYBACK_CHANNEL` — so any Diamond-originated send carries the
   buyback channel and routes to `BuybackRemittanceReceiver`, and registering
   the Diamond on a repatriation channel reverts `HandlerAlreadyBound`. Either
   a separate mirror-side sender/escrow contract owns the outbound leg (with its
   own custody and authorization flow), or the messenger gains explicit
   authenticated channel selection. This is a **transport-layer** decision and
   it gates both modes.

   > **RESOLVED by the C2 transport slice (#1568 part 2): the dedicated
   > sender/escrow.** The shared `vpfi-return` channel is handled by
   > `VpfiReturnSender` on each mirror (Diamond-only send surfaces; a pure
   > transport escrow whose tokens pass through within one transaction, so
   > a failed send strands nothing) and by the kind-dispatching
   > `VpfiReturnReceiver` on Base. The authenticated-channel-selection
   > alternative was NOT taken — every lifecycle marker stays in Diamond
   > storage per 5b/5c, and the satellites stay stateless. Mode B joins
   > the same channel with its own {ReturnWire} kind.

**On reservations and ordering:**

4. **A stranded compensation must be RESERVED on arrival, not left
   un-earmarked.** `RewardClaimFacet` derives `backingRoom` from
   `balance − recycleBucket`, so between arrival and reverse dispatch an
   ordinary claim can spend those very tokens — after which Mode B either fails
   or repatriates VPFI that is backing a different obligation. Needs a
   dedicated stranded-recovery reservation excluded from claim backing and
   retired exactly once, or an atomic forward-back from the inbound callback.
5. **Mode A needs a terminal ledger for its instruction.** It takes its
   availability debit — the **separate repatriation term** of 5a, never
   `consumedCumulative` — before a cross-chain instruction, but declares no
   reservation: if the instruction never executes, the mirror's bucket is
   intact while Base **permanently understates availability**, and without an
   instruction id the Base ingress cannot prove an arriving Mode-A payload
   corresponds to a prior charge. Record a chain/amount-bound pending
   authorization, close it on successful return, and track a release that
   restores availability **only on the authenticated cancellation ACK of 5c** —
   "non-execution is proven" is not a sufficient release condition and must not
   appear as one anywhere, because proof it has not executed *yet* is not proof
   it will not.
5a. **`chainConsumedRecycled` is NOT a free-standing availability debit.**
   `LibMeshFunding` increments it **together with**
   `chainOutstandingRecycledCommit`, and the watcher enforces
   `outstanding + retired == consumed`. Adding a Mode-A amount to the consumed
   cumulative while holding its authorization separately makes **every healthy
   repatriation** violate that identity on the spot — and a failure release
   cannot borrow the existing release cumulative either, because ingress clamps
   `released ≤ retired ≤ consumed` against mirror-reported claim retirement.
   **Define separate repatriation debit/release terms inside availability.**

   An earlier revision of this constraint offered a second option — extend the
   outstanding/retired identity explicitly and carry that extension through the
   reports and the watcher — and that alternative is now **removed, not merely
   deprecated** (Codex #1574 r9 P1). The design has since *selected* the
   separate terms: they are what the availability formula subtracts, what the
   mode table specifies, and what "no direction anywhere may say 'increment
   `consumedCumulative`' for a repatriation" forbids the alternative to. Leaving
   both standing left an implementer a legal-looking route that either
   contradicts those three, or — if followed alongside them — **double-charges
   every Mode-A authorization in availability**, once through `consumed` and
   once through `repatDebited`.

   A constraint that lists options after the choice is made is not neutral: it
   is a live path to a broken ledger.

6. **ACK-first and recovery-first must converge.** A late delivery independently
   produces the existing permissionless, re-sendable remit ACK, so the ACK and
   the Mode-B return are unordered. Accepting only a pending/lapsed reservation
   makes a legitimate return fail forever when the ACK wins; accepting an
   already-ACKed one without a spent marker lets a second message credit the
   same reservation twice. Needs an **amount-bounded recovery entitlement keyed
   by `(remitter, remitId)`** that survives the ACK transition and is consumed
   exactly once.

   **The key alone is not sufficient — bind the SOURCE CHAIN too** (Codex
   #1574 r2). `(remitter, remitId)` does not say the return arrived from the
   chain the reservation was for, so a return routed through *another*
   registered mirror could consume the one-shot entitlement, net the accounting
   on the wrong mirror, and leave the real stranded compensation permanently
   unrecoverable. Require `sourceChainId == reservation.dstChainId` before
   consuming it — the existing ACK ingress (`onRemitAckReceived`) already
   performs exactly this check, so this is consistency, not a new idea.

   **"Amount-bounded" plus "consumed exactly once" is a DUST ATTACK, and 6a's
   Mode-A fix exposed the asymmetry** (Codex #1574 r10 P1). A bound says the
   return may not *exceed* the entitlement; it says nothing about a return far
   below it. A malformed or compromised mirror returning **1 wei** passes every
   transport check in 6a, and one-shot consumption then retires the whole
   entitlement — permanently stranding the remainder, with no second return
   possible because the record is spent. Mode A was given an exact-match rule
   in r9 and Mode B kept the weaker bound purely because they were specified in
   different rounds.

   So: either **require the return to equal the entitlement amount**, or track
   a **remaining amount** and consume the entitlement only when it reaches
   zero. The second composes better with a short delivery — a fee-on-transfer
   return leaves a genuine remainder that a later top-up can settle — but it
   needs its own bounded terminal so a partially-returned entitlement is not a
   new indefinite state. Whichever is chosen, "bounded above" is not a
   settlement condition.
6a. **BOTH modes' ingress needs the same delivery checks both existing
   receivers perform**, and the mode discriminator does not supply them
   (Codex #1574 r2; scope corrected from Mode-B-only in r9 P1). Before
   `actualReceived` is used at all: exactly **one** delivered token, that token
   **must be the local VPFI**, the payload's declared amount must bind to the
   transport-reported amount, and the actual receipt must be **non-zero**.
   Without them a malformed or compromised mirror can deliver some other token
   while naming a valid entitlement — consuming the one-shot record and leaving
   the stranded VPFI exactly where it was.

   **This was written for Mode B and is equally required for Mode A.** Mode A
   traverses the *same* return transport and closes an equally one-shot record
   — constraint 5's chain/amount-bound pending authorization. A mirror naming a
   valid Mode-A authorization while delivering another token or a mismatched
   amount would have Base **close the authorization without the VPFI arriving**:
   the surplus stays where it was, the mirror's bucket is already debited, and
   Base's books say the repatriation completed. Scoping these checks by mode was
   an accident of the order the two modes were specified in, not a property of
   either.

   **Mode A additionally binds to its authorization amount.** Mode B's record is
   an amount-bounded entitlement (constraint 6); Mode A's is an authorization
   for a *specific* chain and amount, so its arrival must match that amount and
   not merely be non-zero and well-formed. Note the interaction with constraint
   7: Mode A's **source debit** must not scale to `actualReceived`, so a short
   Mode-A return is a tracked shortfall against the authorization, never a
   silently-resized settlement.

9a. **Mode-B recovery must be gated on an IRREVERSIBLE LAPSE.** None of the
   entitlement checks proves the referenced day actually reached the lapsed
   terminal — `(remitter, remitId)`, the amount and the source chain are
   equally valid for an **on-time** compensation. A mirror that dispatches
   recovery before lapse returns *valid claim backing*, Base consumes the
   one-shot entitlement, and because `rewardBudgetRemittedGlobal` is
   append-only the intended claimant is left **permanently unfunded**. The
   mirror-side handler must verify an irreversible lapsed state bound to that
   compensation day/remit before dispatch, and the Base entitlement must bind
   to that state.

5c. **Releasing an authorization must be TERMINAL ON THE MIRROR, not merely
   proven-unexecuted on Base** (Codex #1574 r5). Proof that an authorization
   has not executed *yet* is not proof it will not: a non-execution report can
   cross either a permissionless execution transaction or the delayed original
   authorization, after which **Base releases availability while the mirror
   still debits and sends** — and the return arrives with no pending record to
   settle against. Requires a mirror-side **cancellation tombstone, mutually
   exclusive with the execution marker** of 5b, and Base releasing only on an
   authenticated **cancellation ACK** that also terminally records
   authorization ids the mirror had never received.

   **And the tombstone must survive a MIRROR ROTATION** (Codex #1574 r6 P1). A
   deployment-local marker does not make cancellation terminal:
   `CcipMessenger._ccipReceive` resolves `handlerOf[channelId]` at **delivery
   time**, so an old handler can tombstone and ACK a cancellation, Base can
   release the debit, and the delayed original authorization then executes
   against the **new** handler — which holds no tombstone. Bind the tombstone
   to the authorization's issuing era (as 5b already requires of the record
   itself) and carry it across rotation, or make a rotation itself terminal for
   authorizations the outgoing handler had not executed.

   **The EXECUTION marker needs the same treatment, and fixing only the
   tombstone made the asymmetry worse** (Codex #1574 r11 P1). 5b's execution
   marker is equally terminal and was left deployment-local. If the outgoing
   handler **executed** an authorization and its return is still in flight, a
   retry or governance replay delivered after rotation reaches the replacement
   handler with an **empty** marker — so it debits the bucket and bridges the
   same surplus a second time. Base then settles the first return and has no
   live authorization for the duplicate, which arrives as an unattributable
   credit against a closed record.

   Note the direction: the tombstone gap let a *cancelled* authorization
   execute; this one lets an *executed* authorization execute **again**, which
   moves real tokens twice. Both markers must be stored or migrated across
   rotation together, **or** authorizations must be bound to a mirror era that
   a replacement handler rejects outright — the second is the cleaner rule,
   since it makes "did the previous handler already act on this?" a question
   the replacement never has to answer from inherited state.

5b. **A pending authorization must be CONSUMED at the mirror before it sends,
   and be bound to the ISSUING DEPLOYMENT.** Two failure modes, both from
   round 4:

   - *Replay.* In the two-step flow (Base authorizes, mirror executes
     permissionlessly), nothing makes the executor one-shot: while the first
     return is in flight the same authorization can be executed again —
     debiting the bucket and bridging the surplus repeatedly — and Base then
     settles only the first, leaving later deliveries with no live
     authorization. Needs an authorization-id-bound **mirror-side execution
     marker** written before the send, with CEI and retry semantics.
   - *Era collision.* Authorization nonces are naturally per deployment, while
     `CcipMessenger` derives `sourceSender` from delivery-time `channelPeerOf`.
     After a Base or handler rotation a delayed old-era return can collide with
     a same-numbered, same-chain authorization in the **new** era, close the
     wrong record, and strand the genuine one. Carry the **immutable issuing
     deployment (or an unambiguous era)** in both the instruction and the return
     payload, and include it in the pending-record key — the same binding
     remittance receipts already require via `(remitter, remitId)`.

9b. **The mirror→Base return leg needs a FEE SOURCE.** A Base transaction
   cannot forward native value into a later mirror-originated send, and
   `CcipMessenger.sendMessage` is native-funded — it reverts unless its local
   caller supplies the quoted CCIP fee. A "Base-initiated" flow is therefore
   stuck at the return leg unless the mirror sender is deliberately prefunded
   or a mirror-side caller supplies `msg.value`. Specify the execution and
   refund model — **a two-step Base authorization followed by permissionless
   mirror execution** is the shape that fits R2's liveness posture — rather
   than leaving the return without a payer.

**On scaling — and the exception the blanket rule needs:**

7. **Only DESTINATION credits scale to `actualReceived`. Mode A's SOURCE debit
   must not.** The mirror removed `amount` from its bucket; if a short receipt
   scaled the repatriation debit down to what landed, the shortfall would be
   re-offered as mirror availability for tokens that already left. Track any
   delivery shortfall separately instead. (Constraint 13's default still holds
   for every destination credit — this is the stated exception it demands.)

**On the delivered-fresh counter:**

8. **Repatriating Mode-B funds nets the received-fresh position via a
   SEPARATE returned cumulative — never by decrementing a gross counter**
   (Codex #1578 r7 P1; this constraint said "net the received-fresh
   cumulative … bind a subtraction to the receipt", which permits exactly the
   decrement §2h R4 forbids). `rewardBudgetArmedFreshReceived` and
   `rewardBudgetFreshUncounted` are **gross lifetime sums and stay
   append-only** — `RewardRemitLedgerTest` asserts their sum reconciles
   exhaustively over every non-recycled delivery, so a decrement breaks that
   reconciliation and erases the receipt from operator reconstruction. R4 adds
   a **receipt-bound RETURNED cumulative**; spendable backing is the
   difference, derived at read time.

   **Bind it to the receipt's EFFECTIVE classification, not its original
   one.** Constraint 16 permits an overtaking receipt to be re-attributed
   `uncounted → armed` once `D*` installs; if that runs before a late return
   settles, netting against the original side leaves **armed spendable credit
   alive for VPFI already returned**. A quarantined or return-pending receipt
   is therefore ineligible for re-attribution.

   The attribution point below still holds and is why "effective" matters —
   a manual compensation is
   fresh-only, so its arrival normally advances
   `rewardBudgetArmedFreshReceived` (#1556), and sending the tokens back does
   not undo it; once P1-b bounds mirror payouts by delivered-fresh-minus-paid,
   the mirror would treat **returned, no-longer-held** VPFI as funding.

   **A blanket subtraction is wrong** (Codex #1574 r2): a compensation that
   overtakes the arming broadcast is booked to `rewardBudgetFreshUncounted`,
   **not** the armed counter (the §2h constraint-16 case). Netting every Mode-B
   return against the armed cumulative would consume armed credit belonging to
   **unrelated** deliveries and defer their properly-funded claims. Bind the
   subtraction to whether *this specific receipt* was attributed — or ensure an
   authenticated post-lapse arrival never enters the counter at all.

#### Ownership and sequencing

**Corrected 2026-08-06.** An earlier revision made this a *prerequisite* of
#1434 P2, on the basis that P2's lapse had no exit without Mode B. **P2's R4 no
longer routes through C2** — a manual compensation is fresh-only and never
enters the recycle bucket, so C2 could not reach it; R4 specifies a dedicated
fresh-return path instead.

> **#1573 HAS LANDED** (`268e7db10`), so §2h's R1–R6 — including R4's
> dedicated fresh-return — is on `main` and the Mode-B ownership below is
> **settled, not pending** (Codex #1578 r7 P2). This warning previously said
> the opposite and was left standing after the merge, so the section marked
> the same ownership pending in one paragraph and settled in the next — which
> let a reader defer the reservation and sequencing work. Mode A never
> depended on it and was unblocked either way.

So:

- **Mode A is C2 / #1568** — planned surplus out of the recycle bucket. It is
  the §3.6 flow, needs nothing from P2, and is **independent** again.
- **Mode B is #1434 P2 / R4** — the fresh-return of a stranded delivery, held
  in the recovery reservation of constraint 4 from the moment it arrives (it is
  never left as plain un-earmarked balance). Its mechanics are documented here
  because both modes are mirror→Base token returns over one transport, but it
  ships with P2, not C2. §M7's P2 block names R4's fresh-return as one of P2's
  wire paths and §2h ratifies it as a **dedicated fresh-return** — Mode B and
  R4 are the same path.

  > **A correction, recorded so it is not re-made** (Codex #1578 r3→r6):
  > #1434's **M3 ROW** named no reverse transport, and I generalised that into
  > "#1434 does not own Mode B" and cut a duplicate card. The row was the gap;
  > the scope was never missing. The row now names it.

  **⛔ SEQUENCING — DISCHARGED:** R4's **arrival reservation and claim-exclusion
  slice had to land before #1434 lifted the mirror settlement halt.** It did;
  #1434 is closed and P1-b lifted the halt. The reasoning is kept because it
  states what any future change to that ordering must still respect. Otherwise a
  compensation arriving after its day irreversibly lapsed has no
  stranded-recovery reservation, and the ordinary fresh-claim `backingRoom`
  can spend those tokens before the return runs — a claim spending tokens
  earmarked for something else, with nothing marking them earmarked.

What genuinely is shared, and should therefore be decided once rather than
twice, is the **transport** (constraint 3) and the **payload-kind space** that
serves as the mode discriminator — so the CHANNEL is cut once even though the
two modes ship on different cards, while each mode keeps its own payload kind,
decoder and rollout ladder (the ratified layering above; §2h 12a).

**The shared slice has ONE owner: #1568** (Codex #1586 r2 P2 — "cut once"
across two owning cards with no assignee invites either duplicate transport
infrastructure or an undeclared wait). #1568 lands the common transport slice
— constraint 3's resolution, the mirror-side sender leg, the Base-side
receiving endpoint that dispatches on payload kind, channel registration, and
the shared slice's own rollout test — together with Mode A's own payload kind.
**#1434's R4 wire slice declares that slice a prerequisite** and builds Mode
B's protocol on the already-cut channel: its own payload kind, decoder and
handler **plus its own independently versioned rollout-compatibility ladder
and rollout test** (Codex #1586 r3 P2 — "only" here means the channel is not
rebuilt, never that Mode B skips §2h 12a's per-path rollout requirement; that
per-path test is exactly the safeguard against deploying without the
fresh-return receiver).

**This creates no M3→M4 milestone cycle** (Codex #1586 r3 P2: #1434 sits in
the plan's M3, #1568 in M4, and M4 sequences after M3 — read carelessly, the
new prerequisite loops them). The resolution is what the ⛔ SEQUENCING note
already implies: **B2-d4's halt lift — the M3 gate — requires only R4's
arrival-reservation and claim-exclusion slice**, which rides the existing
REMIT ingress and needs no return channel. R4's return-WIRE slice is NOT an
M3-completion gate: it sequences after #1568's shared slice in M4-era order,
and must be live **before the M7 arming ceremony** — the first moment an
armed programme can actually need a lapse-recovery (until arming, the whole
surface is dark and a quarantined late delivery simply waits in its
reservation). A card is not a milestone: #1434 keeps ownership of the wire
slice even though it lands in M4-era order.

### 3.7 Failure modes

| Failure | Behaviour | Why safe |
| --- | --- | --- |
| Recycle report missed past grace | Day finalizes with that chain's recycled delta = 0 (same rule as interest reports) | Conservative in the safe direction: Base over-remits tokens rather than under-funding claims; the cumulative counter catches up next report |
| Broadcast (with `recycleConsume`) delayed/lost | Mirror doesn't consume; claims for that day wait exactly as they already do for the denominator; CCIP redelivery / governance replay as today | Consumption and denominator ride the same message — no new partial-state |
| Remittance (shortfall send) fails | Existing #776 retriable path; claims revert on empty budget until funded — recoverable back-pressure | Unchanged from today |
| Mirror reorg after report | Cumulative reporting self-heals; `(dayId, chainId)` idempotency unchanged | Same guarantees as §4a interest reports |
| Bucket accounting bug suspected | The tracked-balance invariant is watcher-monitored per chain; drift alarms before insolvency. **Must gain the stranded-recovery reservation with Mode B (§3.1, §3.6a) — a three-way check would not alarm on a fresh claim spending recovery-reserved tokens** | Extends the existing supply-invariant watch |

### 3.8 What does NOT change

- `claimInteractionRewards()` — signature, gating, bounded catch-up,
  sanctions Tier-1 status: untouched. Users cannot tell where the funding
  came from.
- The CCT token pools, lanes, rate limits, and the canonical-vs-mirror
  supply invariant: untouched (Option C's rejection is exactly about
  preserving this).
- The finalization rules, grace windows, idempotency keys: untouched — two
  fields added to two existing messages.

> **Scope of that last line: DAILY NETTING only** (Codex #1574 r4). Phase C
> repatriation is **not** covered by it — §3.6a's mode discriminator is a new
> wire shape, and constraint 3 may additionally require a new authenticated
> channel plus a mirror-side sender and a Base-side receiver. Read as-is, this
> bullet would let implementation and rollout planning omit the repatriation
> transport entirely. The §2 Option-B advantage carries the same scoping note
> for the same reason.

---

## 4. Why this is the near-zero-legal-expenditure shape

Tested against the #694 controlling frame:

1. **No investment of money into the protocol for the token.** Receipts are
   fees users chose to pay for services already delivered; recycling is
   internal treasury bookkeeping of protocol-owned tokens.
2. **No redemption, no buyback, no market touch.** Tokens move only between
   protocol-owned buckets over the protocol's own authenticated lanes.
   Nothing is bought, sold, redeemed, or priced. (Treasury buyback stays
   dormant, unchanged.)
3. **No return promise.** Interaction rewards remain usage-based, variable,
   and discretion-free; recycling changes the *funding source* of an
   existing program, not any user-facing promise. Nothing here may be
   marketed as yield, APR, deflation, scarcity, or "reduced sell pressure."
   The only public claim: *"protocol fees re-fund the rewards program,
   extending its life."* — a statement about program longevity, not token
   value.
4. **No discretion in the loop.** Report → net → consume → offset is
   deterministic protocol behaviour; the only discretionary act is the rare
   surplus repatriation, which is an internal transfer between protocol
   buckets — the same legal character as any treasury operation the
   multisig already performs.
5. **Strictly less activity than the alternatives.** Option B moves *fewer
   tokens* than either the status quo (full remittances every day) or
   Option A (round trips). A design whose primary mechanism is "don't move
   tokens, keep ledgers" has inherently less surface for any
   market-operations characterization. This is the sense in which netting
   is not just cheaper ops — it is the legally quietest possible shape.

---

## 5. Phasing

- **Phase A — canonical loop (ships alone, now):** recycle ledger + bucket
  separation invariant on Base; distributor read path funding
  `dailyPool` recycled-first (#1217); `VpfiRecycled` events; R-2 metric
  (#1218). No cross-chain changes. This is most of the user-visible value
  because Base is the canonical activity chain at launch.
- **Phase B — mesh netting (with multi-chain rollout):** the two message
  fields (§3.2, §3.3), mirror bucket consumption, per-chain invariants and
  watcher checks. Lands with (or after) the mirror deployments — before
  mirrors exist there is nothing to net.
- **Phase C — surplus tooling:** governance knob, flagging, batched
  repatriation path (#776 machinery reuse), keeper pass integration.
  Deliberately last; "carry" covers until then.

Spec edits required (per the FunctionalSpecs discipline, each with its
implementing PR): TokenomicsTechSpec §4a (report/broadcast fields), §9
(recycle-first rule + fresh-mint-only cap accounting), §11 (transparency
views for recycled-vs-fresh).

---

## 6. Decision asked of the owner

1. Adopt Option B as the cross-chain recycling architecture (this doc).
2. Confirm the cap-accounting rule: **69M bounds fresh mint only**;
   recycled re-use extends the program past 69M nominal payout without new
   minting.
3. Confirm phasing (A now under #1217; B tied to multi-chain rollout;
   C last).
