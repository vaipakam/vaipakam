# #1566 — bounding reward payouts by funding delivered for rewards

**Status:** design note. No code change proposed for merge yet — the decision
this note exists to enable is which quantity bounds a payout on the CANONICAL
chain, and that is a governance-visible choice about what the platform promises
a reward claimant.

**Card:** #1566 (fund-safety; successor to the auto-closed #1498).
**Related:** #1434 P1-b (`83483149e`), #1555 (`e655030026`), #1499, #1460.

---

## 1. What the card says, and what has changed under it

#1566 was filed **2026-08-04**. It describes one defect spanning both chain
roles, and names its remaining dependency as *"#1434 P1-b — the paid side"*.

**P1-b merged on 2026-08-20**, sixteen days later. The card has not been re-read
against the tree since. Doing that first changes the shape of the work
substantially, and the changes are all in the direction of *less* remaining
work than the card implies:

| Card's claim (2026-08-04) | Tree today |
| --- | --- |
| the delivered bound is unbuilt; design it with P1-b | **built for mirrors.** `deliveredFreshBound` returns `received − paid` from `rewardBudgetArmedFreshReceived` / `rewardBudgetArmedFreshPaid` |
| three drifted copies of the headroom arithmetic (#1499) | **collapsed by #1555.** All enforcement sites call `LibVpfiRecycle.backingPosition` |
| the fix must cover every claim path | **one quantity, three enforcement sites** — the drift that made this hard is already gone |

So the remaining defect is **narrower and more precisely locatable** than the
card describes. It is worth stating exactly.

## 2. The defect, scoped by chain role

`deliveredFreshBound` opens with:

> `if (!LibVaipakam.isMirrorRewardChain(s)) return type(uint256).max;`

**On a mirror**, a payout is bounded by what was actually delivered to that
chain for rewards. This is the property #1566 asks for, and it is live.

**On canonical Base, there is no bound at all** from that function, so the
claim gate falls through to `backingPosition`'s un-earmarked figure —
`balanceOf − recycleBucket − strandedRecoveryReserved − recovered-position`.
That figure still contains every other owner of the Diamond's VPFI, and **two
of them are user collateral**: a live swap-to-repay intent's
`custodialCollateral`, and liquidation `fallbackSnapshot` custody. A reward
payout drawing on those spends a borrower's collateral.

**This is the whole of what remains open on #1566.** The cross-chain axis is
closed; the canonical axis is not.

## 3. Why "subtract one more owner" is not the answer

Recorded on the card and worth restating, because it is the option that will
look cheapest to anyone picking this up:

- the list of owners **grew in every review round it was declared complete**;
- a missing entry in a subtraction produces **no visible failure** — which is
  precisely how each one went unnoticed;
- two owners are invisible to the obvious patch: funding a VPFI payroll stream
  or a buyback moves the earmark *out of* `treasuryBalances`, so subtracting
  treasury does not see them;
- and it has been tried. Subtracting `treasuryBalances[vpfi]` during #1555 was
  **reverted in the next round**: it diverged the claim gate from the RL-3
  expiry predicates, so expiry clocks kept running while claims reverted and an
  entitlement could lapse without its holder ever having a usable window. A fix
  that manufactures a fresh way to lose user value is the signal to change
  approach, not to add a sixth subtraction.

`backingPosition`'s own natspec marks its list **NOT AN AUDIT** — what
adversarial review happened to notice, not a systematic sweep.

## 4. The question this note exists to put

On a mirror, "delivered for rewards" has an unambiguous referent: a remittance
arrived, carrying an amount. **On the chain that ORIGINATES rewards, nothing is
delivered** — the budget is scheduled and minted. So the canonical bound has to
be defined, not merely ported, and the options differ in what they promise a
claimant:

**Option A — the day's own stamped pool.** Bound a canonical payout by the
fresh half already stamped at finalization (`scheduleFloor / 2`, or
`halfPoolForDay`). Needs no new storage and no new wire: the figure is written
at day-close and is what every chain prices against.
*Cost:* it bounds per day, not cumulatively, so it does not by itself stop the
aggregate of many days' claims from exceeding what the platform set aside.

**Option B — a canonical emissions earmark.** Give Base the mirror's shape:
a `received`-analogue incremented when emission is allocated to rewards, and
the existing paid counter. `rewardEmissionsBudget` already exists but is a
**buyback routing target** fed by `LibTreasuryBuyback._routePriority`, not an
earmark the claim path consults — so this is either a new counter or a
deliberate re-purposing of that one.
*Cost:* a new invariant to maintain, and a migration question for a deployment
that has already paid rewards under the old rule.

**Option C — hold the canonical side on the balance figure deliberately**, and
close the fund-safety gap by earmarking the two USER-COLLATERAL owners instead
of all owners. That is a bounded list — collateral custody is not open-ended
the way operational budgets are — and it targets exactly the severity that
makes this card fund-safety rather than bookkeeping.
*Cost:* it accepts that an operational over-draw remains possible, and it is a
subtraction, which §3 argues against on the general case.

**This note does not pick one.** A and B differ in what the platform promises;
C narrows the goal. That is an owner call.

## 5. What is true regardless of the option

- **There is exactly one definition to change.** `backingPosition` is called by
  `RewardClaimFacet`, `RewardHorizonSweepFacet` and `InteractionRewardsFacet`
  as an enforcement gate, and by `InteractionRewardsLensFacet` as a read. Any
  change must keep those four consistent — the #1555 revert is what happens
  when the claim gate and the expiry predicates stop agreeing.
- **The expiry path must move with the claim path.** Whatever bounds a payout
  must bound the sweep, or expiry clocks run against a window claims cannot
  use.
- **Arming stays blocked until this closes.** The `BACKING --> ARM` edge is
  live: arming while a reward payout can draw on borrower collateral converts a
  quiet exposure into a routine one, because armed days are when recycled
  claims begin.
- **New custody classes should wait for this**, not be added to a subtraction
  that cannot be completed.

## 6. Recommendation

Take **Option A first** as a strict-improvement step — it needs no new storage,
no wire change and no migration, and it removes the unbounded case on canonical
immediately — then decide A-plus-cumulative versus B with the aggregate
question stated explicitly. Option C is the fallback if the aggregate question
turns out to need a governance decision that is not ready.

What should NOT happen is a sixth subtraction. That is the one path with
evidence against it in this repository's own history.
