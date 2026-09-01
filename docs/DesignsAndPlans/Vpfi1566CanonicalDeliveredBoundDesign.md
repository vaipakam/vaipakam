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
`type(uint256).max` while the three chain-role-guarded paid writers stop
recording (the administrative two do not: the role change itself can retire the
residual by assigning `paid = received`, and the unguarded seeder stays callable)
— while
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
tokens the programme actually holds. **The canonical writers must see every OUTFLOW, not merely every payout** — an
outbound remittance and a compensation dispatch both move earmarked tokens off
Base with no claimant involved, so charging only the payout and settlement
writers leaves the earmark reusable once its tokens have already left. Legacy
payouts are one of the outflows they must see, and — adding
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
*Cost:* it accepts that an operational over-draw remains possible — and on a
Diamond-as-treasury deployment that is not merely a budget question: a funded
VPFI payroll stream debits `treasuryBalances[vpfi]` while the tokens stay in the
Diamond, so an unreserved reward payout can consume a liability owed to a real
payee. That belongs in the disclosure, not under "operational". It is also a
subtraction, which §3 argues against on the general case; **and on an upgraded
Diamond it cannot find what it is meant to protect.** `fallbackSnapshot` and
`borrowerLifRebate` are loan-keyed mappings with no enumerable aggregate, so a
new counter cannot discover existing `vpfiHeld`, `rebateAmount` or fallback
custody on-chain. Writers started at upgrade time reserve **zero** for precisely
the grandfathered balances this option exists to protect. Any costing must
include an aggregation mechanism — an off-chain enumeration whose PRODUCERS AND
CONSUMERS ARE BOTH FROZEN across it — reward claims paused as well as intent
creation and fallback snapshotting, because a pre-`D*` claim executing after the
snapshot but before the reserve is live transfers the very tokens being counted — pausing intent creation and fallback snapshotting from before
the enumeration's block until the writers are live. Atomicity with the upgrade is
not sufficient on its own: the enumeration necessarily observes an earlier block,
so a loan can open an intent or take a snapshot between that block and the
writers going in, and that custody is absent from both the seed and every later
delta. Only freezing the producers closes the window — or a lazy per-loan reservation on first touch. **The
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

**Option F — do not commingle in the first place: leave user value in the
user's vault under a LIEN.** (Owner proposal, 2026-08-31.)

All of A–E accept that user-owned VPFI sits in the Diamond's pooled balance and
argue about how to reason about it. F removes the premise: the four user-owned
classes stay in their owner's vault, encumbered, and the protocol pulls at the
moment it is entitled to — never in advance. A reward payout transfers from
`address(this)`, so value that is not there cannot be reached. No list, no
counter, no subtraction.

**This is not a new mechanism; it is the repository's dominant one.**
`LibEncumbrance` already provides `createCollateralLien`,
`encumberLenderProceeds`, `encumberBorrowerProceeds`, `encumberActiveHeld`,
`migrateActiveHeld` and `lienIntentCapital`, consumed by `ClaimFacet`,
`DefaultedFacet`, `AddCollateralFacet`, `EarlyWithdrawalDirectFacet` and
`BackstopFacet`. Lender and borrower PROCEEDS are already held this way. The
withdrawal chokepoint is live: `vaultWithdrawERC20` bounds every exit by
`LibEncumbrance.freeBalance`, and `VPFIDiscountFacet.withdrawVPFIFromVault`
reverts `VPFIEncumberedByActiveLoan` above it.

So the four classes #1566 is about are the EXCEPTIONS to the house pattern, not
the rule — and CLAUDE.md states the architecture they depart from outright:
"Each user's assets are held in their own isolated vault — **no commingling**."
Read that way, #1566 is not a bound that needs choosing. It is a commingling
defect in four places, and F is the repair.

*What F does not cover, and must not be assumed to:*

1. **Treasury / payroll.** `treasuryBalances[vpfi]` is a protocol liability, not
   a user vault, and stays in the shared balance. On a Diamond-as-treasury
   deployment an unreserved payout can still consume money owed to a real
   payee. F must be paired with an answer for that class — its own escrow, or
   its own earmark.
2. **Grandfathered balances.** Existing `vpfiHeld`, `rebateAmount` and fallback
   custody are ALREADY in the Diamond, and they are loan-keyed with no
   enumerable aggregate — the same problem C has. F is more tractable here
   (each loan's value can be returned to its vault at that loan's next touch,
   so the exposed remainder shrinks monotonically instead of needing a frozen
   census) but the remainder still needs a bound while it drains.
3. **The chokepoint becomes fund-safety-critical.** Today `freeBalance` protects
   a user from over-withdrawing. Under F it also protects rewards from
   consuming user money, so every bypass of `vaultWithdrawERC20` becomes a
   fund-safety hole rather than an accounting one, and deserves that scrutiny.
4. Each mover must be reworked to pull-at-use: intent fill, fallback seizure and
   LIF settlement currently take custody up front. Seizure remains possible —
   the Diamond controls the vault — so the lien is enforceable.

*Relation to D:* F is D's guarantee reached from the other side. D segregates the
REWARD funding; F declines to commingle the USER funding. Both make the
ownership question structural rather than accounted, but F reuses machinery that
already exists and is already tested, and it does not have to re-home remittance
arrival, expiry routing, forfeit routing or the recycle bucket's credits — which
is the bulk of D's cost.

**The decision is between B, C, D, E and F.** Option A is retained above as an
analysed-and-rejected step, not as a candidate: it does not satisfy the
fund-safety invariant, so presenting it as one of the choices would offer an
owner something that cannot close the card.

**Option E — mint on use.** Anticipated by `TreasuryFacet.mintVPFI`'s own
natspec and materially different from all of the above: for canonical FRESH
emissions, mint at the moment a user pulls, and mint to the Diamond only when
remitting to a mirror or converting expired/forfeited fresh value. Fresh reward
value then never sits in the shared balance at all, so it cannot be drawn from
borrower custody and cannot be double-spent by a legacy path — the emission
schedule bounds it, which is a bound that already exists.

*Cost:* it changes the supply story (tokens exist only once claimed); it does not
by itself cover the RECYCLED half, which really is held value; mirrors still need
the delivered bound they already have; and it needs the same expiry-predicate
reconciliation as everything else.

**Two things it CANNOT be built out of, both worth stating before anyone starts.**
It cannot use `TreasuryFacet.mintVPFI` from a claim: both claim entry points
already hold the shared `nonReentrant` guard and that function re-enters it, so
every pull would revert. Option E requires a claim-callable mint primitive —
guard-compatible and authorised for the claim path specifically — not a reuse of
the admin one. And the emission schedule is not the only ceiling: the token
carries a global supply cap, and other ADMIN-authorised allocation mints can
consume its remaining headroom before a delayed reward is claimed, so a payout
the 69M schedule authorises can still revert at the cap. Headroom has to be
reserved for unclaimed entitlements, or the option converts a custody problem
into a mint-failure one.

**This note does not pick between them.** **B** establishes
"bounded by what was set aside" inside the shared balance, at the cost of a new
invariant, five writers to reconcile and a migration. **C** narrows the goal to
the user-owned classes and accepts an operational — and, on a Diamond-as-treasury
deployment, a payroll — exposure, at the cost of an aggregation it cannot perform
without a frozen migration. **D** removes the ownership question entirely by
holding reward funding outside the shared balance, at the cost of being the
largest change and having to re-home remittance, expiry and forfeit routing. **E** takes fresh emissions out of the shared balance entirely by minting
only on use, at the cost of changing the supply story and leaving the recycled
half still to solve. **F** declines the premise the other four share — it leaves
user value in the user's own vault under a lien, so there is nothing commingled
to reason about and no subtraction to complete, at the cost of reworking each
mover to pull-at-use, of making the withdrawal chokepoint fund-safety-critical
rather than merely user-protective, and of not covering treasury/payroll or the
grandfathered balances already inside the Diamond. That is an owner call, and it
is a five-way one.

**F is the one the owner chose (2026-08-31).** This section records the
trade-off; the decision and everything that follows from it are in §5b — the
per-class assessment that came out of scouting F against the tree, the one
class where it does not fit, and the explicit statement that F settles only
the FIRST of #1566's three required closures.

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

## 5b. DECISION — Option F is ratified (owner, 2026-08-31)

**The owner chose F: keep user value in the user's vault under a lien, and
do not commingle in the first place.** §6 below withheld a recommendation;
it is retained as the reasoning that led here, not as an open question.

### What F settles, and what it does NOT

F answers **the user-owned half of closure 1**, and an earlier revision of this
line said it answered closure 1 outright. It does not, and the counter-example
is already in this note: §2 records that on a Diamond-as-treasury deployment a
funded VPFI payroll stream debits `treasuryBalances[vpfi]` while the tokens stay
in the shared balance, and `backingPosition` does not reserve them.

Payroll value is not user-owned, so no lien on a user vault reaches it. Move or
earmark all four user-owned classes and an unbounded canonical reward claim can
**still** consume tokens already owed to a payee. **Closure 1 needs the
treasury/payroll escrow or earmark as well** — F plus that, not F alone.

It does not touch the other two closures either, and choosing it does not shrink
them:

- **Closure 2 — the legacy settlement paths** remain open. A pre-`D*` payout
  spends without recording, and the pre-cutover branches of the expiry sweep
  and the forfeit chunk move legacy value into the recycle bucket without
  charging the delivered ledger either. That is a keeper-drainable path with
  no claimant involved.
- **Closure 3 — the detached "neither" role** remains bounded and recorded by
  nothing.

**Arming stays blocked until all three close**, per §5. Reporting F as "#1566
done" would be the status-claim failure this programme has already recorded
twice.

### Per-class applicability — F is not uniform across the four

Scouted against the tree 2026-08-31. Three classes take the lien cleanly; one
does not, and that one needs its own decision.

| Class | Verdict | Why |
| --- | --- | --- |
| `vpfiHeld` (grandfathered) | **Draining, but NOT self-bounding** | #1352 retired the peg-custody borrower path, so no new ones are created and next-touch migration drains it monotonically. That is not the same as safe — see below |
| `rebateAmount` (settled, unclaimed) | **Draining, but NOT self-bounding** | Same shape, same drain, and the worse tail: a settled rebate nobody claims may never receive another touch at all |
| `fallbackSnapshot` custody | **Needs every consumer, not one** | The lien is enforceable without moving tokens, but `ClaimFacet` is not the only consumer — see below |
| Intent `custodialCollateral` | **DOES NOT FIT AS WRITTEN** | See below |

#### The drain does not bound the remainder, and cannot prove it reached zero

An earlier revision of the two rows above said "the exposed remainder shrinks
monotonically with no census needed", and treated that as closing the class.
**It does not, and the difference matters because arming is gated on it.**

Next-touch migration is a rule about loans that ARE touched. On an in-place
upgrade every grandfathered loan that has not yet been touched still leaves its
`vpfiHeld` or `rebateAmount` sitting in the Diamond, where a reward payout can
consume it — for however long it stays untouched, which for a settled-unclaimed
rebate can be forever. Monotone decrease says the exposure never grows. It says
nothing about how large it is now.

Worse, the system cannot *prove* the remainder reached zero.
`LibVaipakam.sol:3547` declares `mapping(uint256 => BorrowerLifRebate)
borrowerLifRebate` — loan-keyed, with no enumerable aggregate anywhere in
`src/`. There is no counter to read and no set to walk, so "the drain finished"
is not a question the chain can answer.

So one of three has to be chosen, and this note does not get to skip the choice
by calling the class clean:

1. **An interim remainder bound seeded from a frozen census** — measure the
   exposure once off-chain at the upgrade block, store it, and let each
   migration decrement it. The census is the thing the earlier text claimed was
   unnecessary.
2. **An enumerable migration counter** — add the aggregate the mappings lack, so
   the remainder is on-chain readable. **This is not an independent alternative
   to (1) and must not be read as one:** every existing `borrowerLifRebate` row
   predates the counter, and by this section's own argument there is no on-chain
   set to enumerate them from. A counter initialized to zero would report a
   COMPLETED drain on the upgrade block while untouched `vpfiHeld` and
   `rebateAmount` still sit in the Diamond — the same false all-clear, now with
   an on-chain number backing it, which is worse than no number. It needs (1)'s
   frozen census, or some other exhaustive seed, to start from. What it adds
   over (1) is that the remainder stays readable afterwards.
3. **Arming stays blocked until an externally verified full drain** — cheapest
   in code, most expensive in schedule, and it makes the drain a release gate
   rather than a background process.

Until one is picked, **slice 1 is not closure 1**, and F does not unblock arming
on the strength of these two classes.

#### The fallback class needs every consumer, not just the claim path

`ClaimFacet` clears the snapshot on first claim, which is what made it look like
the single pull point. It is not. A `FallbackPending` loan can be consumed by
several other paths before any claim happens:

- `RiskMatchLiquidationFacet.attemptInternalMatchAutoDispatch` → `_settleLeg`
  pays the lender and the matcher directly out of Diamond custody on its
  `fromDiamondCustody` branch (`RiskMatchLiquidationFacet.sol:538-559`).
- A successful cure in `AddCollateralFacet` transfers the snapshot from the
  Diamond back to the borrower's vault.

`fallbackSnapshot` is referenced by six facets, not one. If F leaves the
collateral in the vault while only the claim path learns to pull from it, those
paths either spend unrelated Diamond custody or revert outright while the
liened collateral sits untouched — and the revert is the *lucky* outcome.

**The class is clean only once internal matching, cure, backstop, retry and
claim all read the new custody source.** That is a slice-2 scope statement, not
a caveat.

### The intent class is the real obstacle, and it is structural

`commitSwapToRepayIntent` decrements the collateral lien and withdraws the
collateral to `address(this)`, because the Diamond is then the **maker** of an
aggregator limit order whose `makingAmount` is that collateral. The order is
filled by an arbitrary third party through the aggregator, which pulls from the
maker. **There is no protocol call at fill time to pull at** — which is exactly
what pull-at-use requires. Leaving the tokens in the vault would make the order
unfillable, not safer.

Two ways out, and they are genuinely different rather than variants:

1. **Maker becomes the VAULT.** The vault grants the aggregator the allowance
   and the order names the vault as maker. Keeps F's premise intact — nothing
   is commingled — at the cost of reworking the order-construction and
   signature path, and of a per-vault allowance surface that did not exist
   before (`vaultApproveNFT721` has no ERC-20 sibling).
2. **This one class keeps custody and gets an EARMARK instead.** Bounded and
   enumerable: `intentAggregateAllowance[asset]` already aggregates exactly
   this quantity per asset, so unlike the loan-keyed classes it needs no new
   census. It is a subtraction — which §6 warns against as a class — but a
   subtraction against an aggregate the code already maintains is not the
   unbounded fifth subtraction that warning is about.

**Recommendation: (2) for the intent class**, with F everywhere else. The
premise of F is "do not commingle where you have a choice"; the aggregator's
maker semantics remove the choice here, and `intentAggregateAllowance` makes
the honest alternative cheap and complete. (1) is defensible but pays a
signature-path rework to avoid one subtraction the code can already compute.

**This split needs owner ratification before code**, because it is the one
place the chosen option is not being applied.

### Slicing

1. The two draining grandfathered classes (`vpfiHeld`, `rebateAmount`) —
   return-to-vault-under-lien at next touch. Self-limiting, lowest risk.
2. `fallbackSnapshot` custody — lien at fallback, and **every consumer** moved
   onto the new custody source, not the claim path alone. The detailed
   correction above establishes why; this slice previously said "pull at claim"
   and would have shipped exactly the defect that correction describes. In
   scope: `ClaimFacet`, internal matching (`RiskMatchLiquidationFacet._settleLeg`
   and its auto-dispatch entry), the cure path in `AddCollateralFacet`, backstop
   and retry, plus full repayment. A fallback loan resolved first through any
   of those would otherwise read or pay the snapshot as Diamond-held collateral
   while the tokens sit liened in the vault — reverting, or spending unrelated
   Diamond custody.
3. The intent class, per the ratification above.
4. Closures 2 and 3, which are independent of all of the above and block
   arming just as hard.

**The chokepoint becomes fund-safety-critical the moment slice 1 lands.**
`vaultWithdrawERC20` / `freeBalance` today protect a user from over-drawing
their own vault; afterwards they also protect rewards from consuming user
money. Every bypass becomes a fund-safety hole. That reclassification should
land in the same PR as slice 1, not after it.

## 5c. Closures 2 and 3 — ROOT fixes exist for both (scouted 2026-08-31)

The owner asked whether these can be fixed at the root instead of patched
per path. Scouted against the tree: **yes for both, and in both cases the
per-path patch is the worse answer — for closure 2 it is not merely worse but
INCOHERENT.**

### Closure 3 — the detached role. One negation, fourteen readers.

```solidity
function isMirrorRewardChain(Storage storage s) internal view returns (bool) {
    return !s.isCanonicalRewardChain && s.baseChainId != 0;
}
```

That negation is read at **14 sites across 6 files**
(`InteractionRewardsFacet` ×2, `RewardCommitmentFacet` ×2,
`RewardHorizonSweepFacet` ×2, `RewardRemittanceFacet` ×1,
`RewardReporterFacet` ×3, `LibInteractionRewards` ×4). Each site
independently decides two things from it: *am I bounded* and *do I record*.

That is why the detached state fails in two directions at once rather than
one. `deliveredFreshBound` returns `type(uint256).max`, and every paid-side
writer stops recording — not through separate bugs but through the same
expression, read fourteen times, with no case for the third state.

**Root fix: replace the boolean with one exhaustive role resolver** —
`{Canonical, Mirror, Detached}` — and give `Detached` a DEFINED behaviour
instead of letting it inherit "not a mirror ⇒ unbounded". Every site then
reads one function, and the third state stops being an accident of negation.
Fourteen call sites collapse to fourteen reads of the same decision.

Fail-closed is the right default for `Detached`: bound `0` (nothing new is
claimable) rather than `max`. A detached deployment has no authenticated
source of further delivery, so anything else is a promise the chain cannot
keep. The role change already has an administrative retirement
(`paid = received`) for the residual, so the operator path exists.

**This is a root fix, but "no per-path change" overstates it, and an earlier
revision said exactly that.** The resolver removes the *accidental* third state;
it does not decide what each reader should do with it, because the fourteen
sites are not all asking the same question.

Two kinds of reader, and one boolean cannot serve both:

- **Accounting readers**, e.g. `deliveredFreshBound`. Fail-closed here means
  bound `0`. If `Detached` collapses to "not a mirror", the site treats it as
  canonical and the bound goes to `max` — fail-OPEN, the exact defect.
- **Authorization gates**, e.g. `RewardCommitmentFacet._assertMirror`
  (`:264-270`) and `RewardRemittanceFacet.sendRemitAck` (`:1528-1533`), which
  revert unless `isMirrorRewardChain`. Fail-closed here means "not a mirror" —
  deny. If `Detached` collapses the other way to satisfy the bound, these gates
  start *permitting* mirror-only cross-chain operations on a chain with
  `baseChainId == 0`.

The two fail-closed directions are opposite, so no single boolean value for
`Detached` is correct everywhere. What the resolver buys is that the third state
becomes **nameable and total** rather than an artifact of negation; each reader
then declares the roles it accepts. That is still a root fix — the source of the
ambiguity is removed once, not fourteen times — but it lands as fourteen small
explicit role selections, not zero edits.

### Closure 2 — the legacy paths. The ledger measures the wrong noun.

The per-path patch would be: make each legacy spend site also increment
`rewardBudgetArmedFreshPaid`. **That is incoherent, and worth saying plainly
so it is not attempted.** Legacy spend is not armed fresh — the counter's own
name and definition say so — and a pre-`D*` payout has no armed commitment to
retire. Patching it in would corrupt the counter's meaning to paper over a
mismatch one level down.

**The actual defect is a noun mismatch.** The ledger tracks a VINTAGE
(`armed fresh received − armed fresh paid`) while the thing it protects — the
Diamond's VPFI balance backing reward payouts — is vintage-BLIND. Legacy and
armed spend the same tokens. So a legacy payout drains backing the armed
bound has already counted as available, and the bound reports itself
satisfied. No amount of per-path bookkeeping fixes a bound that is measuring
a different quantity from the one at risk.

**Root fix: charge the ledger by what MOVES, at the chokepoints where it
moves, regardless of vintage.** The chokepoints already exist and are
narrow — this is the finding that makes the root fix practical:

| Outflow | Chokepoint | Charge what |
| --- | --- | --- |
| value to a claimant | `RewardClaimFacet._deliverReward` (**exactly 1 caller**) | the **fresh** component, passed in explicitly — NOT `paid` — and **rejected if it exceeds the remaining delivered balance, BEFORE the transfer** |
| value to the recycle bucket (forfeit / expiry) | reward-specific forfeit/expiry operations, or an explicit fresh amount at each caller | the fresh component — **not** `LibVpfiRecycle.credit` / `releaseCommitment` |

**The chokepoint must ENFORCE, not merely record.** An earlier revision of this
section described charging the ledger at `_deliverReward` and stopped there,
which records the right quantity and bounds nothing. The reason it bounds
nothing is structural: `_processEntry` computes the pre-`D*` legacy slice
*before* `_walkShareOfPoolDays`, and only that armed-day walk consults
`deliveredFreshBound` (`LibInteractionRewards.sol:1575`, `:1621`). So with 100
delivered and 50 tokens of unrelated Diamond custody, a 150-fresh legacy-only
claim reaches `_deliverReward`, transfers all 150, and leaves `paid > received`
as an after-the-fact observation of an over-draw that already happened.

Charging is what makes the quantity right; **rejecting before the transfer** is
what makes it a bound. Both, at the same point.

**Two further corrections to an earlier revision of this table, both of which
would have broken live accounting if built as written.**

**1. `paid` is the wrong operand — it double-charges the recycled component.**
The earlier text said `paid` "is the TOTAL the claim disburses … charging there
is charging by what actually left". The total is right; the *ledger* is not
vintage-blind about who funded it. `RewardClaimFacet` sets `paid = pending`
where `pending = freshPending + paidRecycled`, and then separately debits the
recycled half with `LibVpfiRecycle.consume(paidRecycled)` (`:404-419`). The
recycled half is backed by the bucket, not by delivered reward funding.

So on an armed mirror with locally bucket-backed rewards, a 5-fresh/5-recycled
claim charges **10** against a bound that only ever received 5 — exhausting it
and blocking later fresh claims that are genuinely funded. Rebasing `received`
onto VPFI-delivered-for-rewards does not supply a matching credit for locally
recycled value, and nothing else does either. **The chokepoint must take the
fresh component as its own argument.**

That costs the table one line of its elegance and none of its substance: the
fresh component is computed at the chokepoint's single caller, so it is still
one place, still impossible for a future path to forget, still a consequence of
spending rather than a declaration about it.

**2. `LibVpfiRecycle.credit` / `releaseCommitment` are not reward-outflow
chokepoints at all**, and naming them was a category error rather than a
detail:

- `credit` is the programme's **inflow** chokepoint. It is called for
  `NotificationFee` (`LibNotificationFee.sol:161`), `FullTariff`
  (`LibFeeEntitlement.sol:202`) and `SpendGatedPerk` (`PerkFacet.sol:238`) —
  every one of them VPFI arriving from a user and *increasing* the bucket.
  Charging a paid ledger there would consume delivered reward allowance every
  time somebody bought a perk.
- `releaseCommitment` moves **no tokens** — it decrements `outstandingCommitRecycled`,
  bumps two cumulatives and emits. It also serves `RemitClampResidual`. Charging
  a bookkeeping-only release against a payout bound would brick valid claims.

And filtering by `RecycleSource` inside those functions would destroy the exact
property the root fix is for: once the charge is conditional on a source tag, a
future path *can* forget, by arriving with a tag the filter does not list.

**"Or an explicit fresh amount handed in at each caller" was the same mistake by
another door**, and an earlier revision offered it as an equal alternative. The
expiry and forfeit paths call the generic `LibVpfiRecycle.credit` from separate
sites; leaving that entry open to reward sources means a future reward terminal
can still credit the bucket while omitting or misstating the adjacent ledger
charge. That is convention, not structure — the very thing this section claims
two paragraphs later to have eliminated.

**The reward-specific operation only closes the hole if reward absorption CANNOT
bypass it.** Concretely: `credit` rejects the reward sources, and the only way
to move reward value into the bucket is the operation that charges the ledger in
the same call. The rejection is what makes it structural; without it, the new
operation is merely the preferred path.

Then the repository's own "make the check BE the operation" pattern holds: today
"spent" is whatever each path *remembered to declare*; afterwards it is a
consequence of *spending*. A future path that forgets to record cannot exist,
because recording is not a separate step it could omit — and, crucially, because
the step it would have to omit is the only one that works.

**Scope honesty.** This is a redefinition of a live ledger, not a patch, and it
carries what redefinitions carry. Two details an earlier revision got wrong,
both of which would have removed working machinery:

**Only THREE of the five paid-side writers are spends.** Those three move into
the chokepoints, each handing in its fresh component rather than its total:
`InteractionRewardsFacet:129`, `RewardHorizonSweepFacet:238`, and
`LibInteractionRewards:1825`. The other two are **administrative state
transitions, not outflows**, and must be retained and redefined in place:

- `RewardReporterFacet:1152-1153` — the role-change assignment
  (`if (paid < received) paid = received`). Delete it and an old delivered
  residual becomes reusable after a mirror role transition and reattachment.
- `RewardReporterFacet:1268` — `seedArmedFreshPaid`. Delete it and a migrated
  deployment has no way to initialize, which is the very migration answer the
  next clause asks for.

**`received` broadens across VINTAGES, not across token deliveries.** The
re-base is onto reward value regardless of vintage — legacy and armed alike —
while still counting **only the authenticated fresh component**. Crediting the
whole delivery would re-open the hole on the other side: a remittance of 5 fresh
plus 5 recycled already credits the recycled 5 to the bucket, so crediting 10
here against a fresh-only paid side leaves 5 of false fresh headroom, and a
later fresh payout consumes bucket backing through it. Both sides count fresh;
neither side counts vintage. And a
deployment mid-flight needs a migration answer for counters already populated
under the old meaning. §6 item 1 already anticipated this shape for Option B
and it applies here. It is more work than five `+=` lines — and the five
`+=` lines do not close the hole.

### Sequencing

Closure 3 is independent and small; it can land first and alone. Closure 2 is
the larger piece and shares its migration question with nothing else. Neither
depends on Option F, and F depends on neither — the three closures are
genuinely parallel, which is why arming waits on all of them rather than on a
chain.

## 6. Recommendation (superseded by §5b — retained for its reasoning)

**No recommendation is offered.** An earlier revision of this note recommended
Option A as a strict-improvement first step; review established that it does not
establish the invariant at all, because the quantity it bounds against is
schedule accounting rather than money set aside. Withdrawing that rather than
softening it, because a fund-safety note whose recommended step leaves the
fund-safety property unmet is worse than one that recommends nothing.

What the options need before a choice is possible:

1. **Option B costed properly** — its true scope is canonical writers for every
   OUTFLOW — not only the five existing counter assignments, but
   `remitRewardBudget` and the compensation dispatches, which move earmarked
   tokens off Base with no claimant involved and would otherwise leave the
   earmark reusable after its tokens have gone — a `received` side tied to VPFI the programme actually holds rather
   than to an allocation entry, and a migration answer for a deployment that has
   already paid rewards under the old rule.
2. **Option C's boundary re-drawn to all FOUR user-owned classes** —
   `custodialCollateral`, `fallbackSnapshot` custody, `vpfiHeld`, and the settled
   `rebateAmount` — plus an aggregation mechanism for grandfathered balances that
   loan-keyed mappings cannot enumerate, plus an explicit decision that
   operational over-draw is acceptable.
3. **Option E costed** — it needs a CLAIM-CALLABLE mint primitive (the admin one
   re-enters the shared reentrancy guard, so a pull through it reverts) and
   reserved supply-cap headroom for unclaimed entitlements (the emission schedule
   is not the token's only ceiling), plus an answer for the recycled half, which
   it does not address.
4. **Option D evaluated at all** — a segregated reward escrow removes the
   ownership question instead of accounting for it, and no revision of this note
   before r3 considered it.
5. **Whichever is chosen, three closures are required, not one:**
   the canonical bound; the **legacy settlement paths** — not only a claimant's
   pre-`D*` payout, which spends without recording and lets one claimant reuse
   the delivered allowance, but the pre-cutover branches of the expiry sweep and
   the forfeit chunk, which move legacy value into the recycle bucket without
   charging the delivered ledger either, so a keeper can drain the allowance's
   backing with no claimant involved; and the
   **detached "neither" role**, which is bounded and recorded by nothing.
   Closing only the canonical side leaves two live custody-drain paths and does
   not unblock arming.
6. **Either way, the expiry predicates change WITH the claim gate** — including
   `_entryExecutableNow`, which does not go through `backingPosition`.

What should NOT happen is a sixth subtraction. That is the one path with
evidence against it in this repository's own history — and the near-miss above
is a reminder that "cheap and strictly better" is exactly how that path gets
taken.
