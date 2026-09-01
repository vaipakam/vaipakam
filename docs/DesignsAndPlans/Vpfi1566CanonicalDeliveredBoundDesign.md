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
per-class assessment that came out of scouting F against the tree, and the
explicit statement that F settles only the **USER-OWNED HALF** of the first of
#1566's three required closures, not the closure.

The rest of closure 1 is **not** a list of earmarks for the non-user owners.
§5b establishes why that framing fails — the list of owners is provably
incomplete and known to be — and replaces it with the delivered bound, which
makes closure 1 and closure 2 one mechanism. An earlier revision of this
paragraph named payroll and the buyback budget here as though naming them were
the remedy.

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
**still** consume tokens already owed to a payee.

**And payroll is not the only one — but STOP HERE, because enumerating them is
the wrong move and the code says so.**

Two earlier revisions of this passage tried to close closure 1 by naming the
non-user owners: first payroll, then `creditBuybackBudget`'s
`baseBuybackBudget` (`TreasuryFacet.sol:652-664`). Review then produced
`commitBuyback`'s `baseBuybackReserved` — the same value one state transition
later (`LibTreasuryBuyback.sol:274-276`) — and `_routePriority`'s
`rewardEmissionsBudget` and `keeperRewardBudget` (`:615-632`). Four rounds, four
extensions of one list, each presented as the one that completes it.

**`LibVpfiRecycle.backingPosition`'s own NatSpec already carries this list, it
already runs to TEN items, and it already says not to trust it:**

> The invariant's three classes are NOT the whole list, and that is the real
> lesson here. Owners of this one balance keep being found: the list has grown
> in every round it was treated as complete. […] **THIS TABLE IS NOT AN AUDIT
> AND MUST NOT BE READ AS ONE.** It lists what ADVERSARIAL REVIEW HAPPENED TO
> FIND.

`baseBuybackReserved` is not among those ten — the eleventh owner, found by the
same method, in the same round as the document predicting it.

#### So closure 1 inverts: bound by what was DELIVERED, not by what is OWED

A subtractive definition — the balance, minus every other owner — can never be
proven complete, because completeness is a claim about code nobody has written
yet. Every future facet that parks value in the shared balance silently widens
the hole, and the only signal is another review round.

The positive form is complete by construction: **a reward payout may draw only
on VPFI delivered FOR REWARDS**, tracked by the `received` ledger closure 2
already defines. Everything else in the balance is off-limits by default —
payroll, buyback budget, buyback reserved, keeper budget, emissions budget, and
the twelfth owner nobody has written yet — without any of them being named,
because the bound never asks who owns the rest.

This is closure 2's chokepoint inversion applied to the other side, and it means
**closures 1 and 2 are one mechanism rather than two**. Closure 1's remaining
work is F for the user-owned classes (so user value is not in the shared balance
at all) plus the delivered bound (so nothing else in it is reachable). It is not
F plus a list.

**The enumeration above is retained as MOTIVATION, not as specification.** Do
not build an earmark per named owner; if the delivered bound is built, none of
them needs one.

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
| Intent `custodialCollateral` | **FITS — via the fill-time hook** | Resolved after this table was first written. `preInteractionImpl` is an authenticated protocol call at fill; the lien decrement, pull and VPFI restamp happen there. See below |

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

**The remainder IS provable on-chain, and an earlier revision of this subsection
said the opposite.** It argued from `LibVaipakam.sol:3547` — `mapping(uint256 =>
BorrowerLifRebate) borrowerLifRebate`, loan-keyed with no enumerable aggregate —
that there is "no set to walk", and then offered three migration options built on
that premise, two of which required an off-chain census.

The mapping has no aggregate; the **key domain** does. Loan ids are allocated
`++s.nextLoanId`, and `LoanFacet.sol:1386-1393` states that the valid range is
`[1, nextLoanId]` inclusive and that loans are never deleted from `s.loans`.
Reward entries have `nextRewardEntryId` over a sequential mapping
(`LibVaipakam.sol:3486-3491`). An exhaustive walk therefore exists — it just is
not a walk of the mapping.

**Chosen: a paused, paginated sequential-ID scan.** Snapshot each high-water
mark under the pause, scan `[1, snapshot]` across as many transactions as it
takes, migrate the rows that match, and **prove completion when the cursor passes
the snapshot** — including proving an empty range empty, which was the case the
old text called impossible.

It is preferred over a census for a reason beyond convenience: it is
**independently verifiable**. Anyone can re-run the scan against the same
snapshot and check the result. A frozen off-chain census has to be trusted, and
on a migration that decides which balances are claimable, that is the wrong
property to depend on.

The three-option discussion this replaced is gone rather than struck through,
because two of the three were built on the false premise and the third was the
census. Slice 1 carries the chosen mechanism.

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

### The intent class — RESOLVED (this heading previously said "structural")

### The intent class — RESOLVED, and this section previously had it wrong

`commitSwapToRepayIntent` decrements the collateral lien and withdraws the
collateral to `address(this)`, because the Diamond is then the **maker** of an
aggregator limit order whose `makingAmount` is that collateral. The order is
filled by an arbitrary third party through the aggregator, which pulls from the
maker.

**An earlier revision of this section then said "there is no protocol call at
fill time to pull at", called the class structurally unfixable, and put two
expensive reworks to the owner. That premise is false, and the tree contradicts
it directly.**

Every intent order requires `needPreInteractionCall` ON
(`SwapToRepayIntentFacet.sol:105-111`). At fill, the LOP calls
`IntentDispatchFacet.preInteraction`, which dispatches on `orderHashKind` to
`LibSwapToRepayIntentSettlement.preInteractionImpl` — a function that already
does a reverse-index lookup from `orderHash` to `loanId` and **already rejects
any caller that is not the pinned `lopAtCommit`**. The fill sequence is
`preInteraction → balance transfer → postInteraction`.

The dispatcher and hook are exercised today through the **buyback** branch of
that same `orderHashKind` switch — `BuybackEndToEndIntegrationTest.t.sol:151`
and `BuybackIntentLedgerTest.t.sol` call `preInteraction` directly against the
Diamond.

⚠️ **The swap-to-repay branch's fill is NOT tested, and an earlier revision of
this note cited it as though it were.** `SwapToRepayIntentFacetTest.t.sol:15-34`
lists that waterfall under **"Out of scope for this file (lands in a separate
fork test with a real Fusion mock router + EIP-712 signing rig)"**. That is a
description of a test that does not exist, and citing it was precisely the error
this note warns about elsewhere — reading a comment as evidence of behaviour.

The conclusion below still stands, because it rests on source read directly
rather than on that citation: the trait requirement, the authenticated
`preInteractionImpl` body, and the partial-fill setting. But **ratifying it into
code requires the fill test that does not yet exist** — the pull, the transfer,
post-settlement, and a post-pull failure proving the lien decrement and vault
withdrawal revert atomically. That test is a prerequisite of slice 3, not a
follow-up to it.

So there is an authenticated protocol call, at fill time, keyed to the exact
order, immediately before the aggregator pulls. That is precisely the pull point
pull-at-use requires, and it exists today for an unrelated reason (balance-delta
snapshotting).

Two properties make it sufficient rather than merely available:

- **Exactly one fill.** `allowPartialFills` and `allowMultipleFills` are
  required OFF, so the hook fires once and the full `makingAmount` moves. There
  is no partial-pull bookkeeping to design.
- **Atomicity.** If anything after the hook fails, the whole fill reverts and
  the pull reverts with it. The collateral is either in the vault or spent on
  the fill the borrower authorized — never stranded in between.

**So F applies to the intent class after all**: leave the collateral in the
vault under a lien, and have `preInteractionImpl` atomically decrement the lien
and pull the full amount into the Diamond immediately before the LOP takes it.

**The tier restamp moves with the withdrawal.** `commitSwapToRepayIntent` calls
`LibConsolidation.restampUserVpfi(loan.borrower)` immediately after the
withdrawal when the collateral is VPFI, because `vaultWithdrawERC20` only
updates the tracked balance (`SwapToRepayIntentFacet.sol:553-563`). Moving the
withdrawal to fill time without moving that restamp leaves the borrower stamped
at the pre-fill balance after the tokens are sold — inflating their fee tier and
staking credit on VPFI they no longer hold. Lien decrement, pull and restamp are
one atomic step, not a pull with two neighbours.
The window in which value sits commingled shrinks from "the life of the order"
to "within one transaction, between two calls" — which is not commingling in any
sense the closure cares about.

**The two earlier candidates are retained below, because the owner was asked to
ratify a split and should see what it was and why it is withdrawn**, not merely
find it gone:

1. ~~**Maker becomes the VAULT**~~ — reworks the order-construction and
   signature path and adds a per-vault ERC-20 allowance surface that does not
   exist. Unnecessary: the hook gives the same result without touching either.
2. ~~**This one class keeps custody and gets an EARMARK**~~ — was the
   recommendation, on the strength of `intentAggregateAllowance[asset]` already
   aggregating the quantity. It is still the cheapest *fallback* if the hook
   route hits something this scout missed, but it concedes a permanent
   commingled class to avoid work that turns out not to be needed.

**No owner ratification is required for a split any more, because there is no
split** — F applies to all four classes. What remains for the intent class is
ordinary implementation, and it belongs in slice 3.

### Slicing

> Every requirement established in the analysis above appears HERE, because the
> slices are what an implementer follows. Four rounds of review found
> requirements sitting in the prose while this list still said the superseded
> thing; twice that was a scripted edit that aborted before writing and was
> only partly re-run. Anything not in this list is not being built.

**1. The two draining grandfathered classes — different treatments, not one.**

- **`rebateAmount` (settled, unclaimed): credit it, never lien it — and credit
  the CURRENT NFT HOLDER, not the stored borrower.**
  `LibVPFIDiscount.sol:1113-1118` records that `claimAsBorrower` never runs on a
  `Settled` loan, so a frozen claimant and an encumbrance are both inert — "one
  silently, one permanently". A lien would strand the value the migration exists
  to hand back.

  **"Credit it outright" is under-specified in exactly the case that loses
  somebody's money.** A borrower position is transferable, and the live claim
  path authorizes against `ownerOf(loan.borrowerTokenId)` and pays that holder.
  The nearby `creditBorrowerLifRebateToVault` helper instead pays the stored
  `loan.borrower`, because it serves a special no-claim terminal — so reaching
  for it during migration, which is the obvious thing to do, hands the rebate to
  a former holder and clears the current one's claim **irreversibly**.

  So the migration resolves `ownerOf(loan.borrowerTokenId)` and delivers there,
  with the sanctions-safe delivery that resolution implies — or it leaves the row
  claimable and migrates only the custody. Either is defensible; paying the
  stored borrower is not.
- **`vpfiHeld` (live loans): a per-loan ENCUMBRANCE paired with a TIER
  EXCLUSION — two counters, not one.** `tierVpfiBalance` deliberately leaves
  ordinary `s.encumbered` value in-tier (`:119-135`) while
  `settleBorrowerLifProper` prices the rebate from the borrower's current tier
  (`:1001-1011`), so an ordinary lien would raise the borrower's own rebate on
  money they owe. But `frozenVpfiOwedByVault` alone is only a tier exclusion,
  **not a lien**: `LibEncumbrance.freeBalance` subtracts solely `s.encumbered`
  (`:691-702`), and the existing freeze flow calls `encumberLenderProceeds`
  *before* incrementing the frozen counter (`LibCloseoutFreeze.sol:88-102`).
  Use one without the other and the borrower can simply withdraw the returned
  `vpfiHeld` before settlement. Both, with explicit release bookkeeping on each
  terminal.
- **Settling in place is NOT the migration.** An earlier revision called it
  "simpler and probably right". On an arbitrary next touch it prices a rebate at
  the current tier before the terminal outcome exists, while a later default
  should have routed the whole held amount through `forfeitBorrowerLif`
  (`:986-1035`, `:1159-1181`) — paying a premature rebate that survives the
  default. In-place settlement is correct only ON a proper-close terminal, where
  it already happens. It is not a drain mechanism.
- **Both terminal consumers are rewritten, not just the lien.**
  `settleBorrowerLifProper` transfers the matcher and treasury shares from
  Diamond custody today, and `forfeitBorrowerLif` does the same for the whole
  held amount (`:1013-1035`, `:1159-1181`). After migration both must split /
  release / seize from the **vault** source, including the sanctions-safe forced
  move-out path. Migrating the custody without these leaves each terminal
  spending unrelated Diamond VPFI or reverting.
- **Completion is provable on-chain; no off-chain census is required.** An
  earlier revision said there is no set to walk and made option 2 depend on a
  frozen census. **That was wrong.** Loan ids are allocated `++s.nextLoanId` and
  the source states the valid range is `[1, nextLoanId]` with loans never
  deleted (`LoanFacet.sol:277`, `:1386-1393`); reward entries have
  `nextRewardEntryId` over a sequential mapping (`LibVaipakam.sol:3486-3491`).
  So under the pause, a **paginated migration snapshots each high-water mark,
  scans every id across transactions, migrates the matching rows, and proves
  completion when its cursor passes the snapshot** — including proving an empty
  range empty. That is independently verifiable, which an off-chain census is
  not. Prefer it.

**2. `fallbackSnapshot` custody.**

- **Every consumer moves to the new source**, not the claim path alone:
  `ClaimFacet`, internal matching (`RiskMatchLiquidationFacet._settleLeg` and its
  auto-dispatch entry), the cure path in `AddCollateralFacet`, backstop, retry,
  and full repayment. Otherwise a fallback loan resolved through any of them
  reads or pays the snapshot as Diamond-held collateral while the tokens sit
  liened in the vault — reverting, or spending unrelated Diamond custody.
- **Non-tier-bearing lien PLUS restamp, same two-counter shape as slice 1**, and
  the case here is stronger: a fallback snapshot has already allocated lender
  and treasury shares, so an ordinary lien grants the borrower tier and staking
  credit on value owed to somebody else, for the whole life of the snapshot. The
  current path withdraws and explicitly restamps the reduced balance
  (`RiskFacet.sol:720-737`) — F preserves that effect, not merely the accounting.
- **Pre-upgrade rows get a custody-SOURCE discriminator before any consumer is
  switched.** Existing snapshots already hold their collateral in the Diamond
  (`RiskFacet.sol:1884-1917`, `DefaultedFacet.sol:846-877`); the
  lien-at-fallback rule governs only later fallbacks. Switch consumers first and
  every existing row either pulls vault funds nobody deposited, or keeps the
  Diamond branch this slice exists to delete.
- **The discriminator routes consumers; it does NOT protect the tokens.** A
  pre-upgrade row stays commingled for as long as it waits to be consumed, so a
  reward claim can drain it before any consumer reaches the discriminator at
  all.

  **So these rows take the paused migration, and that is now the only option
  here.** An earlier revision also offered "seed them into slice 1's remainder
  bound" — a bound slice 1 no longer defines: the census/remainder framing was
  replaced by the paginated exhaustive scan when the sequential-id correction
  landed, and nothing else introduces a counter a fallback consumer could
  decrement. That branch was unimplementable as written, and worse, it named an
  arming gate it could never satisfy.

  Fallback rows are enumerable on the same terms as slice 1's — a snapshot is
  keyed by `loanId`, and `[1, nextLoanId]` covers them — so the same paused
  paginated scan migrates them, with the same completion proof. **Arming waits
  on that scan.**

**3. The intent class — via the `preInteraction` pull point.**

- **Lien decrement, pull, and VPFI restamp are ONE atomic step** inside
  `preInteractionImpl`. `commitSwapToRepayIntent` calls
  `LibConsolidation.restampUserVpfi` right after its withdrawal because
  `vaultWithdrawERC20` only moves the tracked balance
  (`SwapToRepayIntentFacet.sol:553-563`); move the withdrawal without the
  restamp and the borrower keeps tier and staking credit on sold VPFI.
- **`preInteraction` needs the reentrancy guard it does not have.**
  `commitSwapToRepayIntent` carries `nonReentrant`; `IntentDispatchFacet.preInteraction`
  does not, while `postInteraction` does. The new hook decrements a lien and then
  makes an external token transfer through the vault, so a callback-capable or
  later-upgraded collateral token could reenter another Diamond entry while the
  commit is live and its lien already zero — including a liquidation path
  force-cancelling that same commit. Guard the hook, or route the mutation
  through an equivalently guarded self-call. Callback-token test required.
- **Keep the balance-delta check, at the new location.** The commit path does not
  trust `vaultWithdrawERC20`: it measures the Diamond's balance delta and rejects
  anything other than `loan.collateralAmount` before using it as `makingAmount`
  (`:523-553`). Specifying only "pull the full amount" drops that invariant, and
  a fee-on-transfer or behaviour-changing collateral token would then deliver
  less than the signed making amount — with the LOP taking the shortfall from
  unrelated same-token Diamond custody. Re-measure in the hook; revert unless the
  delta equals the committed amount exactly.
- **Every teardown path moves too.** Borrower, expired and force-cancel routes all
  reach `_teardownCommit`, which transfers `commit.custodialCollateral` from the
  Diamond back to the vault and then increments the lien (`:905-944`). For a
  vault-held commit that is wrong twice over — it spends Diamond funds it should
  not have and re-liens value that was never unliened. Rewrite them, or branch
  them on the custody version.
- **Live commits need a cutover.** A commit predating the upgrade has already
  decremented its lien and withdrawn `custodialCollateral` (`:529-553`), so the
  new hook would withdraw a second time and its fill would revert with the
  original custody stranded. Either a paused cutover gated on
  `intentLiveCommitCount == 0` after cancellation/drain, or a per-commit
  custody-version branch — the same discriminator shape as slice 2.
- **The fill test is a PREREQUISITE of this slice, not a follow-up.** It does not
  exist today (see §5b), and this slice's correctness rests on ordering,
  full-amount pull and transaction-wide rollback — none of which is currently
  asserted anywhere for the swap-to-repay branch.

**4. Closure 1's non-user half — the delivered bound. IN THE ARMING GATE.**

Slices 1–3 remove USER value from the shared balance. They do nothing about
payroll, either buyback state, the routed budgets, or the next owner nobody has
written yet. Since §5b establishes that enumerating those owners cannot be
completed, this slice IS the delivered bound — so it and slice 5 are the same
work approached from two sides.

**Canonical `received` is not inherited from the mirror case, and this slice
CHOOSES its ingress rather than asking an implementer to.** An earlier revision
said "specify the funding event" and admitted it had not been written down,
which leaves the same two failures open: every canonical payout bounded at zero,
or an implementer inventing an unfunded credit.

Base originates rewards and receives no remittances, which is why
`deliveredFreshBound` returns `max` there today.

**Credit — one event, and it is a TRANSFER, not a constant.** `received` on Base
is credited only by an explicit `fundRewardPool(amount)`: an ADMIN-role call that
moves `amount` VPFI **into the Diamond** and increments the counter in the same
call, reverting unless the transfer delivers exactly `amount` (balance-delta
checked, the same discipline as the intent hook). Nothing else credits it.

**`VPFI_INTERACTION_POOL_CAP` is explicitly NOT the ingress**, and this is the
distinction the whole inversion turns on. The 69M cap is a **schedule** — an
upper bound on what may ever be paid — so crediting `received` from it would
publish headroom with no tokens behind it, which is the original defect wearing
the new bound's name. The cap stays as an independent ceiling: a payout
satisfies **both** the cap and the delivered bound, and only the delivered bound
is about money.

**Debits — every FRESH outflow, and the transport ones are checked BEFORE the
send:**

| Debit | Where | Amount |
| --- | --- | --- |
| a claim | `RewardClaimFacet._deliverReward` | the **fresh** component |
| expiry / forfeit absorption | the reward-specific operation above (never generic `credit`) | the **fresh** component |
| ordinary remittance to a mirror | `remitRewardBudget` | **`st.fresh`, NOT `st.totalAll`** |
| manual compensation | `RewardCompensationDispatchFacet.remitManualBudget`, non-recovery branch | its fresh amount |
| supplemental compensation | `…remitSupplementalBudget`, non-recovery branch | its fresh amount |

**Three corrections to an earlier revision of this table.**

**(a) The transport debit is `st.fresh`, not the token transfer.**
`remitRewardBudget` sends `st.totalAll = st.fresh + st.recycled`
(`RewardRemittanceFacet.sol:479-481`), and the recycled share is independently
consumed from `recycleBucket`. "Base's bound must fall by exactly what left"
therefore charges recycled value a second time, and a recycled-heavy remittance
would exhaust canonical fresh headroom and block local claims that are genuinely
funded. Note the facet already checks `st.fresh` against `remaining` at `:535` —
the fresh quantity is the one this ledger has always been about.

**(b) The compensation dispatches are outflows too**, and naming only
`remitRewardBudget` missed them. `remitManualBudget` and
`remitSupplementalBudget` send fresh VPFI through `dispatchRemitTail` and
increment `rewardBudgetRemittedGlobal` on their non-recovery branch
(`RewardCompensationDispatchFacet.sol:303`, `:514`) without ever calling
`remitRewardBudget`. Implemented from the old table, those tokens would leave
Base with the canonical bound untouched — the same funding still available to a
local claimant. **The `…FromRecovery` variants are deliberately excluded**: their
original outflow was already charged, so charging the redispatch would
double-count.

**(c) Recording a debit does not BOUND a send — the same error as the claim
path, one section later.** The dispatches check the 69M schedule and not
`received − paid`, so with 10 fresh delivered, 20 requested, and 10 more in the
Diamond for payroll, the transport sends all 20 and leaves `paid > received`
afterwards. **Every non-recovery fresh transport rejects against remaining
canonical delivered headroom before approving or transferring**, then charges
the same amount atomically. Bound first, charge second, both at the same point.

**Migration for an existing canonical deployment needs a DIFFERENT call, and an
earlier revision reused `fundRewardPool` for it — which cannot work twice over.**
`fundRewardPool` transfers `amount` in and requires an exact positive balance
delta, so pointing it at VPFI the Diamond already holds either imports a second
`amount` from the admin or fails the delta check. And "balance minus every other
owner" is precisely the inventory §5b establishes is **unknown and unclosable** —
using it here would reintroduce the enumeration this whole section replaced,
and would classify unrelated custody as claimable.

So: **`bootstrapRewardPool(amount)` — a separate, ADMIN-only, one-shot,
pause-gated import** that credits `received` with an **independently reconciled
reward-owned figure** (the same off-chain reconciliation the mirror bootstrap
performs), moves no tokens, and is **irrevocably finalized before unpause**. The
finality is the load-bearing part on both sides: any increment to `received`
publishes fresh payout headroom with no transfer behind it, so a writer left
callable after reconciliation defeats the delivered bound entirely. Same shape as
the existing one-shot `seedArmedFreshPaid` on the paid side, and for the same
reason.

**The mirror's received-side migration writer takes the identical contract** —
ADMIN-only, paused, one-shot, finalized before unpause. An earlier revision said
only that such a writer "is needed", which left its authorization and its
shutdown unspecified; those are the two properties that decide whether it is a
migration tool or a permanent hole.

**5. Closures 2 and 3**, independent of the above and blocking arming just as
hard. Closure 3 additionally requires the fourteen-row role matrix in §5c — the
matrix itself, not a note that one is needed.

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

**And "each reader declares its own roles" is not yet an implementable
invariant.** The two examples above are the easy ones. The fourteen readers also
choose pool pricing, allowance construction, compensation handling, reporting
and paid-ledger mutation, and for those a locally plausible choice can still
hand `Detached` canonical schedule funding, or permit a state change that a
bound of zero cannot then fund — a reader can be individually defensible and
jointly wrong.

So **closure 3 is not closed until the design carries an explicit role/behaviour
matrix for all fourteen sites.** An earlier revision said writing it was "the
remaining work" — which is a plan for a matrix, not a matrix, and leaves the
implementer exactly where they were. Here it is.

The fourteen readers of `LibVaipakam.isMirrorRewardChain`, with what each is
actually asking and the answer for each role. **`Detached` means
`baseChainId == 0` on a non-canonical chain: no authenticated source of further
delivery and nobody to report to.**

| # | Site | Real question | Canonical | Mirror | **Detached** |
| --- | --- | --- | --- | --- | --- |
| 1 | `InteractionRewardsFacet.sweepForfeitedInteractionRewards:101` | which bound applies to the forfeit sweep | **delivered bound** (was `max`) | delivered bound | **0** — no delivery, nothing sweepable as fresh |
| 2 | `…:128` | does the sweep record a paid delta | **yes** (was "no") | yes | **yes** — the ledger must still see the outflow |
| 3 | `RewardCommitmentFacet.isDayCommitmentReady:191` | is a day's commitment reportable | n/a | yes | **no** — nobody to report to |
| 4 | `RewardCommitmentFacet._assertMirror:268` | AUTH: may this chain report | revert | allow | **revert** — fail closed |
| 5 | `RewardHorizonSweepFacet.sweepExpiredInteractionRewards:162` | which bound applies to expiry | **delivered bound** (was `max`) | delivered bound | **0** |
| 6 | `…:237` | paid-delta recording on expiry | **yes** (was "no") | yes | **yes** |
| 7 | `RewardRemittanceFacet.sendRemitAck:1529` | AUTH: may this chain ack a remittance | revert | allow | **revert** — fail closed |
| 8 | `RewardReporterFacet.setBaseChainId:1254` | is this a role transition needing residual retirement | n/a | yes | **yes — this is the site that CREATES and CLEARS Detached** |
| 9 | `RewardReporterFacet._retireDeliveredResidualOnRoleChange:1286` | retire the delivered residual | n/a | on transition | **on ENTERING Detached, retire; on LEAVING, start from zero** |
| 10 | `RewardReporterFacet.setIsCanonicalRewardChain:1301` | same, canonical side | yes | n/a | **yes** |
| 11 | `LibInteractionRewards._walkSideDays:1823` | pool pricing / schedule funding | canonical schedule | mirror-delivered | **0 — must NOT fall through to canonical schedule** |
| 12 | `LibInteractionRewards.sweepExpiredEntry:3245` | expiry accounting source | canonical | mirror | **mirror-shaped, bound 0** |
| 13 | `LibInteractionRewards._entryExecutableNow:3776` | may this entry execute now | **if funded** (was "always") | if funded | **no** |
| 14 | `LibInteractionRewards.deliveredFreshBound:4211` | THE bound | **delivered** (was `max`) | delivered | **0** |

**Two rows carry the whole risk and are worth reading twice.** Row 11 is where
treating `Detached` as "not a mirror" silently funds payouts from a canonical
schedule that has no tokens behind it — the fail-OPEN direction. Rows 4 and 7
are where treating it as "a mirror" enables mirror-only cross-chain operations
on a chain with `baseChainId == 0`. Those are opposite errors from the same
missing third state, which is why no single boolean value works and why this
matrix — not the resolver — is the substance of closure 3.

**Every canonical cell marked "(was …)" changes WITH slice 4, not only row 14.**
An earlier revision of this matrix updated the bound and left the canonical
forfeit/expiry allowances at `max`, their paid-delta cells at "no", and
`_entryExecutableNow` at "always" — which would let a canonical sweep absorb
fresh value **without consuming its funding allowance**, and let a canonical
expiry clock run while delivered funding is zero. Fixing the bound alone does not
repair the readers that bypass it.

So slice 4 lands **all** of these together, or Base has a delivered bound with
four documented ways around it.

**Transition tests are required in BOTH directions**, since rows 8–10 are the
only sites that mutate the role: entering `Detached` must retire the delivered
residual (or an old residual is reusable on reattachment), and leaving it must
start from zero rather than resuming a stale figure.

#### The fourteen boolean readers are NOT the whole role surface

The audit above enumerates the readers of `isMirrorRewardChain`, and treating
that as the role surface is a mistake of the same shape as enumerating the
balance's owners — it audits the sites that ask the question, not the sites the
answer should govern.

**The value-bearing receive ingresses do not read the predicate at all.**
`RewardRemittanceFacet.onRewardBudgetReceived:846` and
`onCompensationBudgetReceived:1039` are callable by the configured receiver
regardless of role — `RewardRemittanceFacet` contains exactly one
`isMirrorRewardChain` reference, and it is row 7's `sendRemitAck`. So while a
chain is `Detached`:

1. a delayed packet arrives and **credits receipt, pool and recycle state**;
2. row 7 then **rejects the acknowledgement**, because acking is mirror-only;
3. the role transition (rows 8–10) retires the fresh residual **without
   unwinding the receipt-level mutations step 1 already made**.

The packet is then stranded, or — worse — its credited state consumes later
delivery after reattachment. Nothing in the fourteen rows prevents this, because
none of them is on that path.

**So the receive-and-ack lifecycle needs explicit `Detached` handling as part of
closure 3**: either the ingress refuses while `Detached` (symmetric with the ack,
and the packet retries after reattachment), or it accepts into a quarantined
state that the role transition can unwind. The first is simpler and matches how
row 7 already behaves; the second is only needed if refusing risks losing the
packet at the transport layer, which is a CCIP question rather than a design one.

This subsection exists because the matrix looked exhaustive and was not. Any
future addition to it should start from "what state can move", not "who reads the
flag".

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
| value to the recycle bucket (forfeit / expiry) | a reward-specific operation that `LibVpfiRecycle.credit` **rejects reward sources in favour of** | the fresh component — the rejection is what makes it non-bypassable |

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
another door**, and an earlier revision offered it as an equal alternative — in
the prose AND in the table above, which is how it survived the first correction.
It is now gone from both, because an implementer follows the table. The
expiry and forfeit paths call the generic `LibVpfiRecycle.credit` from separate
sites; leaving that entry open to reward sources means a future reward terminal
can still credit the bucket while omitting or misstating the adjacent ledger
charge. That is convention, not structure — the very thing this section claims
two paragraphs later to have eliminated.

**The reward-specific operation only closes the hole if reward absorption CANNOT
bypass it — and "reject the reward sources" is not that.** An earlier revision
said exactly that, which is a **denylist of known tags**, two paragraphs after
explaining that a denylist of tags is defeated by a future path arriving under a
tag it does not list. The same argument, applied inconsistently to the fix for
the argument.

**Generic `credit` must fail CLOSED: it accepts only an explicit, closed set of
proven non-reward inflows** — today `NotificationFee`, `FullTariff`,
`SpendGatedPerk` — and rejects everything else, including any source added
later. A new absorption class then cannot compile-and-forget its way into the
bucket; it must either be added to that allowlist by someone who has argued it
is not reward value, or go through the reward operation that charges `paid` in
the same call.

That is the difference between "we blocked the ones we know about" and "nothing
gets through unless it was proven safe", and only the second survives a future
contributor who has never read this note.

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
while still counting **only the authenticated fresh component**.

**Every received-side WRITER gets its rule stated here, not inventoried.** An
earlier revision listed the sites and said their meanings "belong in the
specification", which is a promise rather than a specification. The rules:

| Writer | Today (armed-vintage) | **After the re-base (vintage-blind, fresh-only)** |
| --- | --- | --- |
| ordinary remittance ingress (`RewardRemittanceFacet.sol:900-905`) | credits `received` with the armed-scoped amount; the rest lands in `rewardBudgetFreshUncounted` | credits **the authenticated FRESH component of the delivery, any vintage**. `uncounted` keeps only what is not authenticated fresh — never the recycled share, which the bucket already holds |
| compensation credit | credits `received` when a compensation is dispatched | **same rule, same test**: fresh component only. A compensation delivering recycled value credits nothing here |
| provisional confirmation (`:1273-1279`) | moves an amount from `uncounted` into `received` on confirmation | moves **only the fresh component**, and only once. Left on the vintage rule it promotes recycled-backed value into fresh headroom that no delivery backs — headroom manufactured by a bookkeeping step |
| demotion / unwind (`:1397-1425`) | moves an amount back from `received` to `uncounted` | must remove **exactly what confirmation added**, by the same fresh-only rule. Left on the vintage rule it removes less than was added, and the difference is permanent false headroom |

**In-flight OLD-WIRE packets are a cutover problem, and the rule above cannot be
applied to them.** Legacy and d2 wires carry no component split — the live
ingress deliberately supplies `freshShare = 0` and puts the whole mixed delivery
into `uncounted`, because the receiver has nothing to compute a split from. So
"credits the authenticated fresh component, any vintage" is unimplementable for
those packets, and both fallbacks are wrong: promoting the whole amount
manufactures recycled-backed headroom, while leaving it in `uncounted`
permanently strands genuine fresh funding that arrives after the paused
bootstrap has already reconciled everything present.

**The cutover DRAINS AND REJECTS. That is the choice, not a preference**, and an
earlier revision said the choice belonged in the design and then left two
implementations standing with a "prefer" between them — which preserves exactly
the ambiguity it claims to resolve, since the two need different gates and
different authentication rules.

**Mandated: hold the pause until every in-flight legacy/d2 remittance has landed
and been reconciled, then reject those wire versions permanently.** The gate is
a provable terminal condition per lane — every legacy/d2 reservation is either
settled or expired, read back per source chain, with no outstanding receipts —
and the pause does not lift until it holds on all of them.

The rejected alternative was a post-unpause receipt-level reconciliation entry.
It is rejected because it adds a **permanent administrative writer on the
received side, authenticating a split from outside the chain** — the two
properties the inversion exists to eliminate. If a lane genuinely cannot be
drained, that is an escalation to the owner, not an implementer's fallback.

The last two writers are a matched pair and must be changed in one commit: the
failure mode is not that either is individually wrong, but that confirmation and
demotion stop being inverses. **A round-trip test — confirm then demote, assert `received`
and `uncounted` both return to their starting values — is the acceptance case,
and it is the one test that catches a divergence between them.** Crediting the
whole delivery would re-open the hole on the other side: a remittance of 5 fresh
plus 5 recycled already credits the recycled 5 to the bucket, so crediting 10
here against a fresh-only paid side leaves 5 of false fresh headroom, and a
later fresh payout consumes bucket backing through it. Both sides count fresh;
neither side counts vintage. And a
deployment mid-flight needs a migration answer for counters already populated
under the old meaning — and **"needs an answer" is not an answer, which is what
an earlier revision left here.** Closure 2 is not implementable until this is
specified, because the two obvious bootstraps are each wrong in a different
direction:

- **Treating `rewardBudgetFreshUncounted` as fresh over-credits.** A legacy /
  d2 delivery put its ENTIRE amount there, because the recycled share was never
  transmitted on those wire versions (`LibVaipakam.sol:6267-6271`). Seeding
  `received` from it manufactures fresh headroom backed by recycled tokens —
  the same false-headroom defect as crediting a whole delivery, arriving by a
  different route.
- **Omitting it under-credits**, and permanently: genuinely funded legacy claims
  are rejected forever, with no path to correct them, because the paid history
  that would justify them is user-keyed and cannot be summed on-chain
  (`RewardReporterFacet.sol:1378-1385`).

Neither side is recoverable after the fact, so the bootstrap must be
conservative and it must happen while nothing can claim: **pause, reconcile
off-chain, import, unpause.**

**Both sides get imported, and an earlier revision of this paragraph seeded only
one.** `seedArmedFreshPaid` increments the PAID counter and is already a
one-shot writer (`RewardReporterFacet.sol:1397-1405`); it can neither seed the
broadened RECEIVED side nor be reused. Importing paid history alone therefore
produces `paid > received` on every upgraded mirror and rejects funded legacy
claims permanently — the under-credit failure, arrived at by trying to avoid the
over-credit one.

The reconciliation must therefore cover, and the migration must have a writer
for, each of:

- **Received** — the authenticated legacy-fresh amount actually delivered for
  rewards, across every wire version, including the legacy/d2 deliveries whose
  recycled share was never transmitted.
- **Paid** — not only per-user payouts, but **fresh value absorbed by the
  historical expiry and forfeit paths**, which no per-user reconstruction sees
  at all and which is a genuine outflow under the redefined noun.

So the retained administrative writers are a starting point rather than the
mechanism: `seedArmedFreshPaid` covers one side once, and a
migration-capable writer is needed for the other. That is the concrete reason
they are retained rather than collapsed, and the concrete reason retaining them
is not sufficient. §6 item 1 already anticipated this shape for Option B
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
