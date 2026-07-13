# VPFI cross-chain recycling — recycle-at-source, net-remit, offset-at-canonical

**Status:** design proposal for a **decision**. Extends the recycle-first rule
(owner decision 2026-07-13, recorded in
[`UserValueEnhancementOpportunities.md`](UserValueEnhancementOpportunities.md) §5)
from a single-chain idea to the full five-chain deployment. Implements the
"how" behind #1217 (R-1) and feeds #1218 (R-2). Legal frame per #694.

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
  self-funding). No new lanes, no new message types — two new fields in the
  two §4a messages that already flow daily. Detailed in §3.

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
- **Three-way tracked-balance separation** with an on-chain invariant:
  `diamond VPFI balance ≥ userLifCustody + unclaimedRewardBudget +
  recycleBucket`. The recycle bucket is protocol-owned; the other two are
  user-owed. No path may pay users from the bucket except the
  Base-authorized consumption below (this is the structural fix direction
  for the L13 commingling finding, extended cross-chain).

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
   `max(0, B[c][D] − availRecycled[c])`, where `availRecycled[c] =
   reportedCumulative[c] − consumedCumulative[c]` in Base's ledger.
2. **Consumption instruction:** the existing finalized-denominator broadcast
   (Base → mirror) gains a field `recycleConsume[c][D] = min(B[c][D],
   availRecycled[c])`. On arrival the mirror moves exactly that amount from
   its recycle bucket into its local claim budget — **idempotently per
   `dayId`**: the mirror stamps `recycleConsumeApplied[dayId]` on first
   application and a redelivered or governance-replayed broadcast for the
   same day is a no-op on the bucket (Codex round-4: broadcasts are
   retriable by design, and a double-apply would debit the bucket twice
   while Base counted one consumption). Consumption is **only** ever
   Base-instructed — a mirror never self-consumes — so the global ledger
   cannot double-count and the accounting identity below holds by
   construction.

Netting applies **after** the per-day-cap trim (the trim defines what the
chain actually needs; recycling changes the *source*, never the amount).

### 3.4 Offset at the canonical mint

The distributor (R-1, #1217) funds day `D`'s pool as:

```
totalRecycledConsumed[D] = Base's own consumption + Σ_mirrors recycleConsume[c][D]
freshMint[D]             = dailyPool[D] − totalRecycledConsumed[D]
```

Invariants (test + transparency surface):

- `Σ freshMint ≤ 69,000,000` — **the category cap bounds fresh mint only.**
  Recycled tokens were already minted once and already counted; re-using
  them extends the program's effective life without touching the 230M
  global cap (which the token enforces regardless). This is the accounting
  decision that makes "recycling extends the runway" literally true, and it
  needs an explicit TokenomicsTechSpec §4/§9 statement.
- per chain: `consumedCumulative ≤ reportedCumulative`.
- per day: `freshMint[D] + totalRecycledConsumed[D] == dailyPool[D]`.
- The R-2 (#1218) metric falls out directly:
  `netEmission[D] = freshMint[D]`.

### 3.5 Keeper-reward budget — same principle, Base-authorized

The keeper-reward budget is per-chain already, and deep chains should fund
their own housekeeping from local receipts — but a mirror must **never
debit its recycle bucket unilaterally**, or §3.3's
`availRecycled = reportedCumulative − consumedCumulative` view on Base
drifts and Base can broadcast a `recycleConsume` the mirror can no longer
fund (Codex round-1 finding). So keeper allocation flows through the same
single authority as claim funding: at finalization Base computes an
optional `keeperAllocate[c][D]`, carries it in the **same broadcast** as
`recycleConsume`, and counts it into `consumedCumulative[c]`. The mirror
debits its bucket only on arrival of that instruction. One authority, one
message, no local-draw drift.

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
the `consumedCumulative ≤ reportedCumulative` invariant is preserved. A
day whose claims exhaust the bucket simply funds no keeper allocation
that day.

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
   triggers it on Base, which records the amount into
   `consumedCumulative[c]` *before* instructing the mirror send — so
   `availRecycled` never overstates a bucket that has been drained by a
   reverse remittance (Codex round-2 finding). Expected to be rare: only
   structurally quiet chains or chain sunsets.
3. Local keeper-budget credit (§3.5) where that budget is the binding need.

Never: market operations, LP seeding from this bucket, or any automatic
disposal — surplus movement is always a deliberate, bounded, protocol-
internal transfer.

### 3.7 Failure modes

| Failure | Behaviour | Why safe |
| --- | --- | --- |
| Recycle report missed past grace | Day finalizes with that chain's recycled delta = 0 (same rule as interest reports) | Conservative in the safe direction: Base over-remits tokens rather than under-funding claims; the cumulative counter catches up next report |
| Broadcast (with `recycleConsume`) delayed/lost | Mirror doesn't consume; claims for that day wait exactly as they already do for the denominator; CCIP redelivery / governance replay as today | Consumption and denominator ride the same message — no new partial-state |
| Remittance (shortfall send) fails | Existing #776 retriable path; claims revert on empty budget until funded — recoverable back-pressure | Unchanged from today |
| Mirror reorg after report | Cumulative reporting self-heals; `(dayId, chainId)` idempotency unchanged | Same guarantees as §4a interest reports |
| Bucket accounting bug suspected | The three-way balance invariant is watcher-monitored per chain; drift alarms before insolvency | Extends the existing supply-invariant watch |

### 3.8 What does NOT change

- `claimInteractionRewards()` — signature, gating, bounded catch-up,
  sanctions Tier-1 status: untouched. Users cannot tell where the funding
  came from.
- The CCT token pools, lanes, rate limits, and the canonical-vs-mirror
  supply invariant: untouched (Option C's rejection is exactly about
  preserving this).
- The finalization rules, grace windows, idempotency keys: untouched — two
  fields added to two existing messages.

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
