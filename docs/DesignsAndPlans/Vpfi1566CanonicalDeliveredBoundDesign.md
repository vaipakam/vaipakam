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
against the tree since. Doing that first changes the shape of the work substantially — but **not simply
in the direction of less**. Two pieces of the card are already built; two failure
modes it never modelled are added in §2. The scope is DIFFERENT, not smaller:

| Card's claim (2026-08-04) | Tree today |
| --- | --- |
| the delivered bound is unbuilt; design it with P1-b | **built for mirrors, ARMED DAYS ONLY.** `deliveredFreshBound` returns `received − paid`; both counters are armed-scoped, and a pre-`D*` slice is paid before the walk that reads them |
| three drifted copies of the headroom arithmetic (#1499) | **collapsed by #1555.** All enforcement sites call `LibVpfiRecycle.backingPosition` |
| the fix must cover every claim path | **partly, and NOT "all enforcement sites"** — #1555 collapsed the PAYOUT and SWEEP gates onto `backingPosition`; `_entryExecutableNow` never used it and still measures `balanceOf` directly on canonical. Searching that helper's callers finds three of four |

So the remaining defect is **differently shaped and more precisely locatable**
than the card describes — two pieces already built, two failure modes it never
modelled. Not narrower. It is worth stating exactly.

## 2. The defect, scoped by chain role

`deliveredFreshBound` opens with:

> `if (!LibVaipakam.isMirrorRewardChain(s)) return type(uint256).max;`

**On a mirror**, an ARMED-day payout is bounded by what was actually delivered
to that chain for rewards. That is the property #1566 asks for, and it is live —
**for armed days only.**

**The legacy slice on a mirror is NOT covered, and it DEFEATS the armed bound
rather than merely sitting outside it.** Both counters
(`rewardBudgetArmedFreshReceived` / `...Paid`) track armed fresh by definition,
and a pre-`D*` entitlement is paid O(1) by `_processEntry` *before* the walk that
consults `deliveredFreshBound` ever runs. Critically, **that spend never
increments the paid counter** — `_processEntry` does not touch it — so the walk
still sees the entire `received − paid` allowance afterwards.

A claimant holding both a legacy slice and an armed tail therefore spends twice
against one balance: 100 VPFI delivered beside 100 VPFI of borrower custody lets
one claim pay 100 legacy plus 100 armed, clear the aggregate `backingPosition`
check against the 200-token balance, and drain the custody — while the armed
bound reports itself satisfied. So the mirror bound is not "correct but partial";
it is **evadable** by any claimant with entitlements on both sides of `D*`.

**There is a THIRD chain role, and it is the least bounded of the three.**
`isMirrorRewardChain` is `!isCanonicalRewardChain && baseChainId != 0`, so
detaching a former mirror with `setBaseChainId(0)` leaves a deployment that is
neither canonical nor a mirror. In that state `deliveredFreshBound` returns
`type(uint256).max` **and** every paid-counter writer stops recording — while
persisted armed-day stamps stay claimable. An armed claim there is bounded by
nothing but the balance, and nothing even tracks what it spent. Any fix must
decide what this role does rather than inheriting the mirror check's negation,
which is how it arose.

**On canonical Base, there is no bound at all** from that function either, so the
claim gate falls through to `backingPosition`'s un-earmarked figure —
`balanceOf − recycleBucket − strandedRecoveryReserved − recovered-position`.
That figure still contains every other owner of the Diamond's VPFI, and **four
of them are user-owned**: a live swap-to-repay intent's `custodialCollateral`,
liquidation `fallbackSnapshot` custody, and — on a Diamond upgraded from
pre-#1352 — `borrowerLifRebate`'s held and settled-but-unclaimed forms (§4). A reward
payout drawing on those spends a borrower's collateral.

**So the axis split is not clean, and an earlier revision of this note said it
was.** What is closed is *armed-day payouts on mirrors, in isolation*. What is open is
*canonical payouts*, *pre-`D*` payouts on mirrors*, *the combination of the two
on one claimant* (which evades the armed bound outright), and *the detached
"neither" role*, which is bounded by nothing at all. The mirror path looks solved
from the armed side, which is precisely why three of those four went unnoticed.

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

**Option A — the day's own stamped pool. NOT a fund-safety closure, and an
earlier revision of this note recommended it as one.** `scheduleFloor` is
computed from the emission schedule and remaining 69M accounting capacity;
stamping it neither mints, transfers, nor earmarks anything in the Diamond. A
payout below one day's stamped half can therefore still be funded from borrower
collateral, and successive days repeat the draw. It bounds *how much a day may
price*, which is a different question from *what is actually set aside*.
It may still be worth having as a sanity ceiling. It does not establish the
delivered-or-set-aside invariant and must not be treated as sufficient.

**Option B — a canonical emissions earmark.** Give Base the mirror's shape: a
`received`-analogue **incremented only when VPFI actually becomes available to
the reward programme, never when emission is merely "allocated"**, and canonical
WRITERS for the paid side.

The funding half is the part that is easy to get wrong, and getting it wrong
reproduces Option A's defect exactly: a canonical claim **transfers existing
VPFI** out of the Diamond (`_deliverReward` → `safeTransfer`), while minting is a
separate admin operation (`TreasuryFacet.mintVPFI`). So a counter incremented at
allocation time is accounting with no funding behind it, and the allowance it
authorises can still be paid out of borrower custody. The credit must be tied to
tokens the programme actually holds. **The canonical writers must also see EVERY payout, legacy included** — adding
canonical versions of the existing writers is not enough, because pre-`D*`
payouts run through `_processEntry` before the armed walk and none of those
writers sees them, so a canonical claimant holding both spends the earmark twice:
the evasion §2 documents on mirrors, ported along with the shape. The existing
paid counter also cannot simply be reused: its writers are **five, not three** —
the claim walk, the expiry sweep, the forfeit sweep, a role-change residual
retirement assigning `paid = received`, and an ADMIN-gated `seedArmedFreshPaid`
that increments with **no** `isMirrorRewardChain` guard at all. The first three
are guarded by `isMirrorRewardChain`, and its storage docs define
it as mirror-era delivered spending. Add a Base `received` analogue without
changing them and canonical payouts never decrement the allowance, so every later
payout reuses the whole earmark. `rewardEmissionsBudget` already exists but is a
**buyback routing target** fed by `LibTreasuryBuyback._routePriority`, not an
earmark the claim path consults — so this is either a new counter or a
deliberate re-purposing of that one.
*Cost:* a new invariant to maintain, and a migration question for a deployment
that has already paid rewards under the old rule.

**Option C — hold the canonical side on the balance figure deliberately**, and
close the fund-safety gap by earmarking the USER-OWNED classes instead of all
owners. There are **four, not two**: a live swap-to-repay intent's
`custodialCollateral`; liquidation `fallbackSnapshot` custody;
`borrowerLifRebate[loanId].vpfiHeld`, which stays non-zero for loans
grandfathered from a pre-#1352 deployment; **and
`borrowerLifRebate[loanId].rebateAmount`**, which is the SETTLED-but-unclaimed
form of the same money — `settleBorrowerLifProper` zeroes `vpfiHeld` and stores
the borrower's retained share there, where it sits in Diamond custody until
`claimAsBorrower` transfers it. Reserving only the held form leaves the settled
form spendable, so a reward payout consumes it and the borrower's later claim
reverts.

That fourth class is worth dwelling on: it is the same storage examined under
#1867 (the prepay-sale stranding) hours before this note was written, and the
connection to this card's custody list was not made. Two cards reading one slot
for different reasons, neither seeing the other's. An earlier revision of this note named
only the first two — reserving those alone would still let rewards consume a
borrower's VPFI and leave the later settlement reverting or underpaying.
It is a bounded list, which is the argument for it; but "bounded" only helps if
the boundary is drawn correctly, and mine was not on the first attempt.
*Cost:* it accepts that an operational over-draw remains possible; it is a
subtraction, which §3 argues against on the general case; **and on an upgraded
Diamond it cannot find what it is meant to protect.** `fallbackSnapshot` and
`borrowerLifRebate` are loan-keyed mappings with no enumerable aggregate, so a
new counter cannot discover existing `vpfiHeld`, `rebateAmount` or fallback
custody on-chain. Writers started at upgrade time reserve **zero** for precisely
the grandfathered balances this option exists to protect. Any costing must
include an aggregation mechanism — an off-chain enumeration seeded ATOMICALLY WITH the
upgrade — not merely before payouts are enabled, because a loan can open a
swap-to-repay intent or take a fallback snapshot between the snapshot being taken
and the aggregate writers being installed, leaving real custody absent from both
the seed and every later delta — or a lazy per-loan reservation on first touch. **The
lazy variant does not work on its own**: an untouched grandfathered loan stays
absent from the aggregate until something touches it, so an intervening reward
claim consumes exactly the tokens it was meant to reserve. Seeding has to precede
enabling, whichever mechanism carries it.

**Option D — segregate the funding physically.** All three options above leave
reward funding in the shared Diamond balance and differ only in how they *reason*
about it — a bound, a counter, or a subtraction list. The alternative is to stop
sharing: hold canonical reward funding in a dedicated escrow, and let claims
spend only from there. Ownership ambiguity is then structural rather than
accounted, so no list can be incomplete and no counter can drift from reality —
the failure mode that produced this card twice.

*Cost:* it is the largest change of the four, and it has to answer for the paths
that currently rely on one pooled balance — mirror remittance arrival, expiry and
forfeit routing, and the recycle bucket's own credits. It also needs a migration
for funds already held. **It is nonetheless the only option that removes the
question rather than answering it**, and it was absent from the first two
revisions of this note because I was looking for a better bound rather than for a
different arrangement.

**This note does not pick one.** A and B differ in what the platform promises;
C narrows the goal. That is an owner call.

## 5. What is true regardless of the option

- **There is NOT exactly one definition to change, and an earlier revision of
  this note said there was.** `backingPosition` is an enforcement gate in
  `RewardClaimFacet`, `RewardHorizonSweepFacet` and `InteractionRewardsFacet`,
  and a read in `InteractionRewardsLensFacet`. But
  `LibInteractionRewards._entryExecutableNow` **does not call it at all**: its
  delivered-bound branch is mirror-only, and on canonical it measures
  `balanceOf(...) >= _userClaimFundingNeedView(...)` directly. A new canonical
  earmark that makes claims reject through `backingPosition` while that
  predicate is untouched keeps executable time accruing against a window claims
  can no longer use — **the exact divergence that got the #1555 attempt
  reverted**, reproduced by a fix aimed at avoiding it.
- **The expiry predicates are separate enforcement sites and must be changed
  explicitly**, not assumed to follow.
- **Arming stays blocked until this closes.** The `BACKING --> ARM` edge is
  live: arming while a reward payout can draw on borrower collateral converts a
  quiet exposure into a routine one, because armed days are when recycled
  claims begin.
- **New custody classes should wait for this**, not be added to a subtraction
  that cannot be completed.

## 6. Recommendation

**No recommendation is offered.** An earlier revision of this note recommended
Option A as a strict-improvement first step; review established that it does not
establish the invariant at all, because the quantity it bounds against is
schedule accounting rather than money set aside. Withdrawing that rather than
softening it, because a fund-safety note whose recommended step leaves the
fund-safety property unmet is worse than one that recommends nothing.

What the options need before a choice is possible:

1. **Option B costed properly** — its true scope is canonical writers for the
   paid side, a `received` side tied to VPFI the programme actually holds rather
   than to an allocation entry, and a migration answer for a deployment that has
   already paid rewards under the old rule.
2. **Option C's boundary re-drawn to all FOUR user-owned classes** —
   `custodialCollateral`, `fallbackSnapshot` custody, `vpfiHeld`, and the settled
   `rebateAmount` — plus an aggregation mechanism for grandfathered balances that
   loan-keyed mappings cannot enumerate, plus an explicit decision that
   operational over-draw is acceptable.
3. **Option D evaluated at all** — a segregated reward escrow removes the
   ownership question instead of accounting for it, and no revision of this note
   before r3 considered it.
4. **Whichever is chosen, three closures are required, not one:**
   the canonical bound; the **legacy settlement paths** — not only a claimant's
   pre-`D*` payout, which spends without recording and lets one claimant reuse
   the delivered allowance, but the pre-cutover branches of the expiry sweep and
   the forfeit chunk, which move legacy value into the recycle bucket without
   charging the delivered ledger either, so a keeper can drain the allowance's
   backing with no claimant involved; and the
   **detached "neither" role**, which is bounded and recorded by nothing.
   Closing only the canonical side leaves two live custody-drain paths and does
   not unblock arming.
5. **Either way, the expiry predicates change WITH the claim gate** — including
   `_entryExecutableNow`, which does not go through `backingPosition`.

What should NOT happen is a sixth subtraction. That is the one path with
evidence against it in this repository's own history — and the near-miss above
is a reminder that "cheap and strictly better" is exactly how that path gets
taken.
