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

Scouted against the tree 2026-08-31 — and at that first scout, three
classes took the lien cleanly and one appeared to need its own decision.
**That is no longer the state: all FOUR classes now have selected,
non-uniform treatments and NO class is decision-blocked** — the intent
class resolved via the fill-time hook (marked FITS in the table below),
and the later analysis concludes F applies to all four with no further
owner ratification required. This paragraph's original wording survived
that resolution and read slice 3 as blocked on a decision already made.

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

**The completion condition is the scan's cursor passing its snapshot**, per
slice 1. An earlier revision ended this subsection with "until one is picked,
slice 1 is not closure 1" — which was correct while three options were open and
became a contradiction the moment the scan was chosen: one reader would treat a
completed scan as sufficient while another kept arming blocked awaiting a choice
that had already been made.

So: **slice 1 is closure 1's user-owned half exactly when the paused scan
completes** over every affected id domain, proven by the cursor. What still
blocks arming beyond that is slice 4's non-user half, which is a different
requirement and is stated there.

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
> slices are what an implementer follows.

**0. A paused PRE-MIGRATION SOLVENCY RECONCILIATION, before any custody row
moves.** The exposure this design repairs may already have been exercised:
reward claims may have spent part of the very backing the grandfathered
`vpfiHeld`, rebate and VPFI-fallback rows assume, so the Diamond may not hold
enough VPFI to back every enumerated row independently of payroll, treasury and
the other commingled owners.

**The enumeration covers all FOUR grandfathered classes — including the
VPFI-denominated live intent commits (`custodialCollateral`) that slice 3
leaves in Diamond custody until fill or cancellation.** An earlier revision
listed three and omitted the intent class, whose teardown branch returns old
custody on fill/cancel: the old-custody COUNT gates arming but proves nothing
about whether the tokens still exist, so an intent teardown could revert — or
return unrelated payroll/treasury custody to the borrower — for exactly the
reason the other three classes are reconciled. Every class whose rows the
migration or its retained old-custody branches will move at face value enters
the same reconciliation: dedicated backing proven or zero, replacement
funding or a recorded shortfall disposition, and the old-custody branch for
intents may not execute ahead of that certification any more than the cursor
may.

**And the freeze is a GATE the fill path reads, not a hope — the LOP
hooks are not pause-gated, so slice 0 carries an explicit
RECONCILIATION-MODE flag checked by both intent hooks and the
old-custody fill branch.** Without it, a pre-upgrade order can fill
while the paginated scan is still deciding whether its commingled
collateral is backed — consuming unrelated payroll or treasury custody
and deleting the intent before the scan reaches it, iteration order
deciding who bears the shortfall in exactly the way slice 0 exists to
prevent. The flag is set before the scan's first page and cleared at
certification; a fill attempted under it reverts retryable.

**And a written-down LIVE intent needs its ORDER changed, not just its
ledger — the standing order immutably hashes the original amount.** The LOP
order key is a keccak over its parameters, `makerAmount` included
(`SwapToRepayIntentFacet.sol:577-610`), so a disposition that writes the
row down while leaving the order standing has changed a number the fill
path never reads: the LOP still pulls the FULL original amount from
commingled custody on fill, and shrinking the approval instead merely
bricks the fill into a revert. For the live-intent class the disposition
menu therefore narrows to two executable forms — **full replacement funding
(the order stays as reviewed), or atomic cancel-and-recreate at the
post-disposition amount** (the Diamond is the maker on custodial commits,
so cancellation is its own act, and tombstone-without-recreate is the
degenerate case).

**And "recreate" means a NEW order in every keyed index, under a FRESH
nonce — not the old order with a smaller number.** These are
no-partial/no-multiple-fill orders invalidated by the LOP bit invalidator
keyed on `(maker, nonceOrEpoch)`, and the protocol's own replay registry
(`intentNonceUsed`, `LibVaipakam.sol:4194`) permanently rejects a reused
nonce — so a replacement recreated with the stored `makerTraits` is
terminally unfillable (its slot was consumed by the cancel), and its later
teardown can read the consumed invalidator as ALREADY FILLED and refuse to
return the custody. The recreation therefore allocates a fresh unused
nonce in `makerTraits`, recomputes the order hash, and atomically rewrites
every keyed index (`orderHashToLoanId`, the `orderHashKind` discriminator,
the nonce registry) in the same act as the cancel — **through a
PAUSE-ONLY MIGRATION PRIMITIVE, because the production entries cannot run
under the freeze**: both cancellation paths are `whenNotPaused` and
borrower/deadline-gated, and slice 0 is explicitly paused, so a live
underbacked intent could otherwise take this disposition only by
unpausing into the exact claim/commit race the freeze exists to prevent
(or block the scan forever). The primitive is migration-role-gated,
callable ONLY while the reconciliation freeze holds, and performs the
cancel + fresh nonce + full keyed-record rewrite in one act.

**And the write-down reaches every STORED copy of the amount — for a
`FallbackPending` position that is FIVE ledgers, not two.** The fallback
custody total is split across the three `fallbackSnapshot` collateral
fields; the lender and borrower claim rows carry their own amounts;
`loan.collateralAmount` keeps driving health and liquidation after a
cure; the lien and `protocolTrackedVaultBalance` shadow them. Reduce only
the snapshot and a claim row still draws the disposed amount; reduce only
a claim and the migration still moves the full snapshot; leave the loan
figure and an 80-token cure resumes as a 100-token-collateralized loan.
**And the FULL-REPAYMENT terminal must not re-count the migrated
snapshot: `RepayFacet`'s branch increments the lien by `held`
(`RepayFacet.sol:691-695`), which was correct while the snapshot lived in
Diamond custody and is a DOUBLE COUNT once migration has already included
it in the live lien.** On a claim asset differing from the collateral,
`claimAsBorrower` reads the doubled lien as additional collateral payout —
overpaying or reverting against the tracked vault balance. For migrated or
newly vault-backed rows the branch retains the existing snapshot lien
instead of recreating it, and the all-consumer certification covers the
full-repayment terminal alongside partial match and cure.

The disposition reconciles them across TWO moments — **slice 0 rewrites
the three ledgers whose referent is the Diamond-held snapshot (snapshot
split, claim rows, loan collateral entitlement); the lien and tracked
vault balance change only at slice 2's migration**, when their referent
actually enters the vault — and the class certification asserts the
mutual consistency of all five at each moment, not any single figure.
(An earlier revision said "reconciles ALL of them atomically" in slice 0,
one sentence above the timing rule that forbids exactly that for the two
top-up counters.)

**With one timing rule inside that atomicity: the PRE-EXISTING lien and
tracked-balance figures are for the TOP-UP, and slice 0 must not touch
them.** A non-curing top-up is deposited into the VAULT and liened there
at once — `AddCollateralFacet.sol:168-207` ticks
`protocolTrackedVaultBalance` and the lien for the top-up while the
snapshot explicitly STAYS in Diamond custody — so those two counters
currently represent real, separately funded vault collateral, not the
Diamond-held snapshot the shortfall disposition is writing down. Reducing
them for a SNAPSHOT shortfall makes backed top-up collateral withdrawable
or erases its tracked deposit. So: slice 0 reduces the snapshot split,
the claim rows and the loan entitlement; the lien and tracked balance
GAIN the post-disposition snapshot amount only when slice 2 actually
migrates it into the vault — the moment the counters' referent arrives.

**The same rule for the intent class — the commit
AND the loan — because each teardown consumer reads its own.** The
settlement's borrower claim and its re-lien are both computed as
`loan.collateralAmount − consumed`
(`LibSwapToRepayIntentSettlement.sol:288-295, 351-356`) — so rewriting the
order and commit to 80 while the loan still says 100 leaves the fill
recording a 20-unit claim no tokens ever backed: it stays unclaimable or
consumes unrelated vault custody, the same loss one ledger further in. The
disposition therefore rewrites `loan.collateralAmount` (the collateral
ENTITLEMENT) atomically with the commit and the order, and the
certification below covers the loan-level figure too.

**The INTERNAL commit is rewritten in the same act, because the
teardown paths read the STORED amount, not the order.** The settlement
residual is computed from `intentCommits[loanId].custodialCollateral`
(`LibSwapToRepayIntentSettlement.sol:147`), the aggregate allowance is
debited by that same stored figure (`:167`), and cancellation returns it
outright (`SwapToRepayIntentFacet.sol:924-948`) — so a recreation that
rewrites the order to 80 while the commit still says 100 has fixed the
fillable surface and left every internal exit paying out the written-down
20 from unrelated Diamond custody. The recreation therefore rewrites
`custodialCollateral` to the post-disposition amount and adjusts
`intentAggregateAllowance` by the delta, atomically with the cancel and
the new order. Certification of the class requires **no live order
exceeding its post-disposition amount, every recreated order FILLABLE, and
every commit's STORED amounts equal to the certified post-disposition
figures** — amount-only certification of the external order passes a
replacement whose teardown still spends the old number, which is the loss
this class's inclusion in slice 0 exists to prevent — the
executable-balance gate applied to the one class whose liability lives
partly outside the migration's own ledgers. A scan that advances because each id was VISITED
then either reverts partway and blocks arming (aggregate short), or — worse,
when unrelated custody keeps the raw balance high — **transfers that unrelated
custody into user vaults and silently reassigns the historical loss to another
owner.**

So before the cursor may certify anything: reconcile the enumerated liabilities
against **dedicated backing**, and where they exceed it, require **replacement
funding or an explicit, recorded shortfall disposition** (who bears the
historical loss is an owner decision, not a side effect of iteration order).

**And the disposition CHANGES THE LEDGERS the migration reads — a record of
who bears the loss is not backing.** An earlier revision stopped at
"recorded", and slices 1–2 would then still transfer each row's FULL recorded
amount: the scan reverts partway or draws the acknowledged loss from ambient
custody anyway, which is the exact outcome slice 0 exists to prevent, now with
a signature on it. So the disposition is executable or it is not a
disposition: **replacement funding lands as tokens in a separately tracked
funded position the migration debits**, or **the affected entitlements are
written down / reassigned so each row migrates at its post-disposition
amount** — and the cursor's certification gate is the resulting EXECUTABLE
balance (enumerated post-disposition liabilities ≤ dedicated backing plus the
funded position), never the existence of the record.

**And "dedicated backing" STARTS AT ZERO unless a provenance ledger proves
it — labeling the ambient balance is not proving it.** An earlier revision
left the initial dedicated amount undefined, and on a Diamond holding 100
owed to payroll against 100 of enumerated user liabilities the gate then
passes by calling the ambient 100 "dedicated" — the migration moves payroll
custody into user vaults without ever entering the shortfall branch, which is
the loss reassignment slice 0 exists to prevent. This document's whole thesis
applies to its own remedy: the commingled balance is subtractively
unattributable (ten owners, "NOT AN AUDIT"), so **preexisting backing counts
only where an on-chain provenance trail proves the segregation** (a
separately held position, a delta-checked funding event) — and even a
PROVEN amount **relocates into the dedicated holder atomically with the
`received` credit** (or the bootstrap verifies the holder already holds
exactly that attributed custody): proof of provenance in the SHARED
balance publishes headroom payroll can still spend — the collision the
holder exists to prevent, reproduced by the bootstrap that cites its
proof — while a proven-but-unallocated `H` against an empty holder is
imported headroom nothing can pay. Everything
else is UNBACKED until replacement funding lands in the tracked funded
position or the owner records the shortfall disposition. Fund-forward is the
rule here for the same reason it is the rule for `received`: what cannot be
proven is not there.

Solvency first, then movement — a migration must not be the mechanism that
decides who eats a loss nobody has acknowledged. Four rounds of review found
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

  **The payee is TERMINAL-SPECIFIC, and an earlier revision of this bullet
  over-corrected into a universal rule.** I said "resolve `ownerOf` for every
  `rebateAmount`", which is right for the ordinary claim path and **wrong for a
  prepay-sale row** — and the sale terminal unlocks the position NFT, so it can
  transfer before the migration reaches it.

  `creditBorrowerLifRebateToVault` pays the stored `loan.borrower` deliberately,
  and says why: `settleBorrowerLifProper` prices the rebate from that party's
  tier, so paying anyone else a figure computed from this one's tier is a
  mispricing. The principle it states is the rule to follow —
  **"sale PROCEEDS follow the position, a fee REFUND follows the fee payer"**
  (`LibVPFIDiscount.sol:1102-1118`).

  So the migration **reads each row's terminal and uses that terminal's payee**:
  `ownerOf(loan.borrowerTokenId)` where the ordinary claim path would have paid
  the holder, the stored fee payer for a prepay-sale row. A universal `ownerOf`
  would irreversibly hand a transferee a refund the original payer was priced
  for — which is the same class of harm as paying the stored borrower on an
  ordinary row, arriving from the opposite direction.

  **A SANCTIONED payee has no immediate-delivery branch, and the migration must
  not stall on one.** The claim path rejects a sanctioned recipient, and this
  bullet already establishes that a frozen claimant or encumbrance is inert on a
  `Settled` loan — so reverting or skipping the row stops the exhaustive scan
  completing, which **blocks arming indefinitely on a single flagged wallet**,
  while paying anyway violates the gate and clearing the row destroys the claim.

  Such a row is therefore **PARKED**: custody moves to a dedicated frozen holding
  keyed by loan, the scan records it as migrated-and-parked so the cursor
  advances, and a **delisting release path** that **re-resolves and re-screens the payee at
  release**, rather than paying the address resolved during migration.

  For an ordinary rebate row the entitlement follows the borrower-position NFT,
  and a sanctioned holder cannot transfer while flagged — but the transfer gate
  reopens on an authoritative clean read. So a holder who delists and then
  transfers **before** the parked release executes would have the rebate paid to
  them rather than to the buyer, irreversibly. Re-resolving `ownerOf` atomically
  at release closes that window; the stored fee payer is retained **only** for
  the prepay-sale terminal, per the payee rule above. Locking the NFT until
  release is the alternative and is worse — it penalises the holder for the
  protocol's parking decision.

  ⚠️ **But re-resolution needs the anchor to still EXIST at release, and an
  ordinary claim can destroy it.** Once the migration has moved the value out of
  `rebateAmount`, a loan carrying collateral, surplus or another borrower-side
  claim still lets `claimAsBorrower` proceed — and it **burns the borrower NFT**
  (`ClaimFacet.sol:1549-1552`). `ownerOf` then reverts and the parked rebate is
  permanently unreachable: parked to protect it, stranded by an unrelated claim.

  So the **claim path recognises the parked rebate and releases it in the same
  call** when the payee screens clean — or, failing that, the migration records a
  durable payee anchor that outlives the NFT. The first is better: one payout
  path, and it removes the window rather than making an anchor survive it.

  **The park/deliver decision uses `LibSanctionedLock.mustFreezeParty`, not a
  claim-style `isSanctionedAddress` check.** The ordinary read fails OPEN when
  the oracle is unset or reverting, so during an outage the scan would deliver
  immediately to a payee already recorded in `sanctionsConfirmedFlagged` —
  turning the exhaustive migration into a **compliance bypass for exactly the
  wallets already confirmed**, and an irreversible one, since delivery is
  terminal. ⚠️ **`mustFreezeParty` fails closed on a REVERTING oracle, not an UNSET one** —
  it returns `false` immediately for `sanctionsOracle == address(0)` as "regime
  disabled", without consulting `sanctionsConfirmedFlagged`
  (`LibSanctionedLock.sol:329-335`). An earlier revision of this paragraph
  claimed it covers the outage case generally; it covers only half of it, and the
  unset case is the one where the scan would deliver and clear a confirmed
  party's rebate **irreversibly**.

  So the scan carries an explicit **precondition: a configured authoritative
  oracle — and so does EVERY LATER PARKED RELEASE, because the scan's
  precondition protects only the scan.** Unset the oracle after migration
  and `mustFreezeParty` returns false for the very payee whose confirmed
  flag parked the value: the release path makes the irreversible payment
  the parking existed to prevent, one step later. A parked release
  therefore requires a configured oracle AND an authoritative clean read
  at release time — absent either, the value STAYS PARKED; parked value
  is never released on a disabled regime. The scan-time precondition is
  cheap because the migration is a one-time
  paused operation, so the operator can simply set the oracle first, whereas an
  ordinary user path cannot demand it; the release-time one is cheap
  because a parked row is already the exceptional case. With the oracle configured, the helper's
  `Flagged` / `Clean` / `Unavailable` branches all behave as this paragraph
  needs, and the flag clears only on an authoritative clean read. Parking is what lets completion stay provable without either
  paying a sanctioned party or abandoning their value — and the scan's completion
  proof is exactly why this cannot be left as an operational follow-up.

  An earlier revision also offered "leave the row claimable and migrate only the
  custody" as equally defensible. **Withdrawn** — that branch names no
  destination for the custody it moves, and every destination breaks something:
  the claim path still expects `rebateAmount` to be backed by Diamond custody, so
  moving it to the holder's vault without a lien lets them withdraw it and claim
  again, while leaving it under the unusable terminal-loan lien (or any other
  source) makes the claim spend unrelated Diamond VPFI or revert.

  Making that branch work would mean specifying the retained claim's custody
  source, its withdrawal protection, and a claim-time release — i.e. rewriting the
  claim consumer for a class the migration exists to empty. Immediate delivery is
  strictly less machinery and leaves nothing behind to be wrong.
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

  **The encumbrance needs its OWN record — `loanCollateralLien[loanId]` cannot
  carry it.** That mapping holds a single `Encumbrance` per loan
  (`LibVaipakam.sol:4684`), already occupied by the ordinary collateral, and it
  encodes one asset and one amount. Reusing it either trips its create guard,
  overwrites the collateral reservation, or simply cannot express `vpfiHeld` when
  the collateral asset is not VPFI — which is the common case, since the peg-
  custody path applied to loans of every collateral type.

  So: a **separate per-loan `vpfiHeld` lien** that contributes to `s.encumbered`
  and carries its own migration, transfer and terminal lifecycle. "A per-loan
  encumbrance" was under-specified in a way that reads as "reuse the existing
  row", which is the reading that breaks.

  **Install the tier exclusion BEFORE the vault credit, or restamp again after
  both.** `vaultCreditFromDiamondERC20` rolls the user's tier up from the
  post-deposit tracked balance and whatever exclusion is stored **at that
  moment**, so a straightforward credit-then-exclude implementation leaves the
  cached tier and staking checkpoint counting VPFI the borrower owes — while
  every stored counter looks correct afterwards, which is what makes it hard to
  notice. Ordering is the cheaper fix; an explicit second restamp is the
  fallback.

  **And the move records `protocolTrackedVaultBalance`, exactly as slice 2's
  fallback move does.** An earlier revision specified this migration's lien and
  tier exclusion and stopped there, while the equivalent fallback slice — written
  later — carries the ledger requirement. Same consequence here: `vaultWithdrawERC20`
  caps availability by the tracked counter and `recordVaultWithdraw` underflows
  when no deposit was recorded (`VaultFactoryFacet.sol:566-624`,
  `LibVaipakam.sol:10150-10162`), so the rewritten proper-close or forfeiture
  consumer fails on a row whose tokens, lien and exclusion are all correct. Use
  the Diamond-funded vault-credit chokepoint, or record the exact deposit in the
  same transaction as the custody move.
- **Settling in place is NOT the migration.** An earlier revision called it
  "simpler and probably right". On an arbitrary next touch it prices a rebate at
  the current tier before the terminal outcome exists, while a later default
  should have routed the whole held amount through `forfeitBorrowerLif`
  (`:986-1035`, `:1159-1181`) — paying a premature rebate that survives the
  default. In-place settlement is correct only ON a proper-close terminal, where
  it already happens. It is not a drain mechanism.
- **Position TRANSFER moves the custody too, not only the terminals.** A live
  borrower position stays transferable after migration, and
  `LibConsolidation.consolidateToHolder` re-keys the side-specific lien and moves
  the loan's ordinary borrower collateral (`:124-147`) — it knows nothing about
  an additional per-loan `vpfiHeld` custody or its tier-exclusion counter. So an
  NFT transfer would update `loan.borrower` while leaving that VPFI in the FORMER
  holder's vault, and the eventual terminal then pulls from the wrong vault or
  strands the lien.

  Borrower-side consolidation therefore moves **all three** — the per-loan
  custody, its dedicated lien, and the tier exclusion — **with both vaults
  restamped**. An earlier revision named only custody and exclusion: leaving the
  lien behind would hand the destination vault **withdrawable** `vpfiHeld` while
  the former holder keeps a phantom `s.encumbered` amount, so the new holder
  drains the value before settlement and the terminal release then targets the
  wrong aggregate. Moving the money without its lien is worse than moving
  neither — the sending vault loses
  the exclusion and the receiving vault gains it, or the tier defect this slice
  exists to prevent simply relocates to whichever holder is not being tracked.

- **Both terminal consumers are rewritten, not just the lien.**
  `settleBorrowerLifProper` transfers the matcher and treasury shares from
  Diamond custody today, and `forfeitBorrowerLif` does the same for the whole
  held amount (`:1013-1035`, `:1159-1181`). After migration both must split /
  release / seize from the **vault** source, including the sanctions-safe forced
  move-out path — **and the borrower is RESTAMPED once the release completes.**

  **The release also CONSUMES the claim entitlement atomically.**
  `settleBorrowerLifProper` writes the same amount to
  `borrowerLifRebate[loanId].rebateAmount` (`LibVPFIDiscount.sol:1013-1014`), so
  a terminal that frees the rebate into the vault **and** leaves that record
  standing pays it twice — the holder withdraws from the vault, then calls
  `claimAsBorrower` and is paid again out of unrelated Diamond custody. Either
  clear the claim record in the same call, or keep the value under protected
  custody and let the claim consumer pull it exactly once. Freeing it in place
  while leaving the claim is the one combination that double-pays.
  A proper close with a non-zero rebate removes the matcher and treasury shares
  from the vault and releases the whole `vpfiHeld` tier exclusion, which leaves
  the rebate as newly free, tier-BEARING VPFI in that vault. Updating the two
  counters does not touch the holder's cached tier or staking checkpoint, so
  without a restamp the borrower stays priced and reported as though the rebate
  were still excluded, until some unrelated later mutation happens to correct it.
  Same omission as the intent-withdrawal restamp, one terminal later. Migrating the custody without these leaves each terminal
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

**2. `fallbackSnapshot` custody — and the PRODUCERS change, not only the
migration and the consumers.**

⚠️ **An earlier revision of this slice referenced a "lien-at-fallback rule" it
never specified**, migrating pre-upgrade rows and rewriting consumers while
leaving `RiskFacet._fullCollateralTransferFallback` and
`DefaultedFacet._fullCollateralTransferFallback` retaining the failed-swap
collateral in the Diamond. So the very next fallback after the scan creates a
**new commingled snapshot** — the reward-drain exposure reopening immediately,
behind an arming gate that was satisfied by a scan whose result the producers
then invalidate.

**Both creation paths return the collateral to the borrower's vault and
atomically install all four: the lien, the tracked-balance record, the VPFI tier
exclusion (VPFI snapshots only), and the custody discriminator** — the same
quadruple the migration installs, so a migrated row and a freshly created one
are indistinguishable afterwards. That is what makes the scan's completion
durable rather than a snapshot of one moment.

- **Every consumer moves to the new source**, not the claim path alone:
  `ClaimFacet`, internal matching (`RiskMatchLiquidationFacet._settleLeg` and its
  auto-dispatch entry), the cure path in `AddCollateralFacet`, backstop, retry,
  and full repayment. Otherwise a fallback loan resolved through any of them
  reads or pays the snapshot as Diamond-held collateral while the tokens sit
  liened in the vault — reverting, or spending unrelated Diamond custody.

  **Forced withdrawals need the sanctions-safe MOVE-OUT path, which the Diamond
  branch never needed.** Every newly vault-backed consumer reaches
  `vaultWithdrawERC20`, whose `getOrCreateUserVault` rejects a sanctioned vault
  owner unless the exact-address move-out exemption is armed
  (`VaultFactoryFacet.sol:254-263`). The current Diamond-custody branch has no
  borrower-vault gate at all, so a borrower who becomes sanctioned **after** the
  snapshot is migrated could otherwise **block lender recovery indefinitely** —
  the migration handing them a veto they never had.

  So each forced fallback withdrawal uses the pinned move-out path, while any
  borrower **residual** stays frozen or screened. Recovery for the lender must
  not depend on the borrower's status; only what the borrower would keep does.

  **Each consumer also gets its COUNTER transitions specified, not just a new
  custody source.** The migration liens the FULL snapshot in the vault, so
  `vaultWithdrawERC20` refuses every one of these withdrawals until the matching
  `s.encumbered` is released — "read the vault instead" on its own makes all of
  them revert. Concretely: a **partial** match decrements the lien, and (VPFI
  snapshots only) the tier exclusion, by **exactly the consumed slice**; a
  **cure** removes the exclusion **without** re-adding the snapshot to a
  collateral lien that `_cureFallback` has already completed. Get either wrong
  and the consumer either reverts or leaves a phantom counter that strands a
  later withdrawal — the migration's own failure mode, relocated to the exit.
- **Migration uses CREATE-IF-ABSENT: it adds to a live lien and creates one
  where none exists — never replaces.** An earlier revision said "never creates",
  which inverts into a fund-safety hole on the **common** row: the fallback path
  calls `releaseCollateralLien` (`RiskFacet.sol:2138`), so a `FallbackPending`
  loan with no post-fallback top-up has **no active lien at all**. Implemented
  literally, the migration would move the full snapshot into the borrower's vault
  and add nothing to `s.encumbered` — immediately withdrawable, before cure or
  liquidation. `LibEncumbrance.incrementCollateralLien` already has exactly these
  semantics (`:192-203`), so the rule is "call it", not "guard it".

  A pre-upgrade `FallbackPending` loan **may** also carry a live vault lien for
  non-curing top-ups — `AddCollateralFacet` increments it precisely so the top-up
  "is not drainable before a later cure" (`:189-198`), and `_cureFallback` folds
  the restored snapshot in with its own increment. So a migration that creates
  the lien from the snapshot amount either reverts on the existing row or
  **discards the top-up reservation and makes that collateral withdrawable**.
  The scan adds only the migrated snapshot amount to the existing lien, and only
  that amount to the tier exclusion.
- **Install the exclusion BEFORE the vault credit** (VPFI snapshots), exactly as
  the `vpfiHeld` migration requires. `vaultCreditFromDiamondERC20` performs its
  tier rollup immediately after the transfer (`VaultFactoryFacet.sol:549-557`),
  so an implementation can reasonably read the helper's built-in rollup as
  satisfying the generic "PLUS restamp" above, then add
  `frozenVpfiOwedByVault` afterwards — leaving the cached tier and staking
  checkpoint counting the owed snapshot while every stored counter looks right.
  Exclusion-before-credit, or an explicit final restamp after both mutations.
- **The tier exclusion applies ONLY when the snapshot is VPFI.**
  `fallbackSnapshot` can hold arbitrary collateral, so adding every snapshot
  amount to `frozenVpfiOwedByVault` would charge a USDC or WETH figure — in that
  token's own decimals — against the borrower's VPFI tier, suppressing unrelated
  tier and staking credit and making the later exclusion release meaningless.
  For a non-VPFI snapshot only the **lien and the tracked-custody record** move:
  there is no VPFI tier to protect, so there is nothing to exclude.
- **Non-tier-bearing lien PLUS restamp (VPFI snapshots), same two-counter shape
  as slice 1**, and
  the case here is stronger: a fallback snapshot has already allocated lender
  and treasury shares, so an ordinary lien grants the borrower tier and staking
  credit on value owed to somebody else, for the whole life of the snapshot. The
  current path withdraws and explicitly restamps the reduced balance
  (`RiskFacet.sol:720-737`) — F preserves that effect, not merely the accounting.
- **Every custody move records the deposit in `protocolTrackedVaultBalance`,
  atomically.** Moving a snapshot from the Diamond into the borrower's vault is
  not only a transfer: `vaultWithdrawERC20` decrements that counter and
  **underflows loudly when no matching deposit was recorded** — its own NatSpec
  calls that "an accounting bug somewhere upstream". So a migrated row whose
  tokens and lien are both correct would still be unable to release collateral,
  and the failure would surface at a consumer rather than at the migration. The
  scan therefore goes through the Diamond-funded vault-credit chokepoint, or
  records the deposit for the exact user, token and amount in the same
  transaction as the custody move.
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
  `preInteractionImpl`, **executed under the pinned sanctions-safe MOVE-OUT
  exemption** — the same wrapper the existing settlement already uses so a
  post-commit flag cannot brick completion
  (`LibSwapToRepayIntentSettlement.sol:149-157`). The new pull goes through
  `vaultWithdrawERC20`, whose vault resolution rejects a sanctioned owner
  (`VaultFactoryFacet.sol:253-264`), so without the wrapper, moving custody into
  the vault introduces a sanctions-dependent fill failure the Diamond-custody
  order never had — a borrower flagged after committing would strand the fill,
  and the LOP retry with it. `commitSwapToRepayIntent` calls
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
  force-cancelling that same commit. **Guard it with the fill-state lock
  specified immediately below.** An earlier revision of this bullet said "guard
  the hook, or route the mutation through an equivalently guarded self-call" and
  left that instruction standing after the correction beneath it — both of those
  release when the call returns, so an implementer following the normative
  sentence still leaves the LOP transfer window open. The prescription itself had
  to change, not merely acquire a caveat under it.

  ⚠️ **A function-scoped `nonReentrant` is NOT sufficient, and an earlier
  revision of this bullet asked for one.** The modifier releases when
  `preInteraction` returns — before the LOP performs its maker-asset transfer and
  before it calls `postInteraction`. The dangerous window is exactly that gap:
  the lien is already zero, the commit is still live, and a callback-capable
  collateral token can reenter the Diamond during the LOP's own transfer. Adding
  the modifier would have protected the vault withdrawal and left the state
  inconsistency it was added to prevent.

  So: a **fill-state lock set before the pull and cleared by `postInteraction`**,
  with the post hook explicitly permitted to run while it is held — a
  transaction-spanning state-machine guard rather than a function-scoped one.
  Every other Diamond entry that could observe a live commit with a zero lien
  must respect it, the force-cancel liquidation path most of all. Callback-token
  test required, and it must reenter **during the LOP transfer**, not during the
  hook, or it passes against the insufficient guard.
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
  **the per-commit custody-version branch.**

  ⚠️ An earlier revision of this bullet also offered "a paused cutover gated on
  `intentLiveCommitCount == 0` after cancellation/drain", with the withdrawal
  stated only in the paragraph beneath it — so the bullet an implementer follows
  still named an unperformable ceremony. Removed from the bullet itself.

  **Why the zero-count option is impossible, retained because it is the kind of
  thing that gets re-proposed:** The zero-count alternative
  is withdrawn because it cannot actually be performed. Draining requires
  cancellation, and `cancelSwapToRepayIntent` is `whenNotPaused`
  (`SwapToRepayIntentFacet.sol:709-743`) while the LOP hooks are **not**
  pause-gated. So pausing first blocks the very cancellations the drain needs,
  and draining first leaves a window in which a new commit can be created — a
  race with no gate available to close it. "Provable zero count" assumed a
  ceremony the pause modifiers do not permit.

  The discriminator has none of that: old commits keep the old custody path, new
  ones take the hook, and the old branch is deleted once the count reaches zero
  on its own.

  ⚠️ **And the count itself needs an OPENING BALANCE.** The live pre-upgrade
  commits bypassed its increment path, so a newly appended counter reads zero
  while their `custodialCollateral` is still commingled — and the arming gate
  passes vacuously on day one. `intentLiveCommitCount` cannot substitute, since
  it also counts buyback and new vault-custody commits. So the old-version count
  is **initialized from a paused scan or a precisely versioned snapshot, and
  arming stays blocked until that initialization is finalized** — the same
  opening-balance rule as the era counters, and for the same reason.

  ⚠️ **But "on its own" can be NEVER, and completion must not pretend
  otherwise.** An abandoned pre-upgrade order's `custodialCollateral` stays in
  the Diamond until someone fills or cancels it — expiry alone executes no
  teardown — so slices 1–3 have **not** removed all user value from the shared
  balance while any old-version commit survives. So the **old-custody count is
  tracked explicitly, and both the "slices complete" claim and ARMING carry it
  as a gate**: either the count reaches zero (through fills, cancellations, or
  an operator-driven cancel-and-recreate sweep of abandoned orders), or the
  residual commits' custody is MOVED into the protected contract's INTENT
  attribution row (the third option once listed here — the "global
  outbound-reserve primitive" — is WITHDRAWN as undefined, per the gate
  rule below: no invariant, no debit sites, no terminal; a gate option
  that exists only in its own sentence arms over drainable collateral).
  (An earlier revision offered "folded into the delivered bound's
  accounting as a recorded, decrementing exclusion" here — retired by the
  rule below: the exclusion is consulted only by reward consumers, so
  payroll spends the collateral straight through it. An exclusion no
  outflow path enforces is a label, and a gate must not accept one.)
  Declaring F complete over an unbounded
  residual is the status-claim failure this programme has already recorded
  twice. Same shape as slice 2's fallback rows — the second time that
  pattern has turned out to be the answer here, which is itself a reason to
  reach for it first.
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

**THREE credit paths, not one** — an earlier revision named only the first
(stranding every terminal era surplus), and a later one counted two after
the third was already registered below; the concluding invariant says three
everywhere, and this opening list is what an implementer follows:

1. `fundRewardPool` — a transfer, below.
2. **The era-terminal transfer**: an atomic **old-era debit / live-`received`
   credit**, moving a terminal era's unused balance into the active role's
   ledger. It moves **no tokens** — the custody stays where it is held (the
   DEDICATED HOLDER on holder-funded deployments; a historical Diamond-side
   amount only via the provenance-or-replacement rule) and
   merely changes attribution — which is precisely why it needs registering as
   an explicit provenance-bound writer rather than being read as a violation of
   "only `fundRewardPool` credits `received`" — a sentence that is true
   only of TOKEN-MOVING EXTERNAL FUNDING, and says nothing against the
   two registered attribution writers (this transfer and its delayed
   pending-to-live form), which move no tokens and are registered
   precisely so this sentence cannot be read as forbidding them. It
   exists on **both** active
   roles, and the mirror's writer table carries it too.
3. **The delayed pending-to-live recovery credit** — the era-terminal
   transfer's `Detached` form, draining the pending recovery position into
   live `received` once an active era exists. Registered below; omitting it
   from this list is exactly how a conforming implementation strands every
   surplus terminalized while `Detached`.

**Credit — one event, and it is a TRANSFER, not a constant.** `received` on Base
is credited only by an explicit `fundRewardPool(amount)`: an ADMIN-role call that
moves `amount` VPFI **into the DEDICATED CUSTODY HOLDER** (see the custody
rule below — an earlier revision of this sentence said "into the Diamond",
which routes new funding into exactly the shared balance the payroll example
below shows being spent by other ledgers; the holder cannot protect funding
that never enters it) and increments the counter in the same
call, reverting unless the transfer delivers exactly `amount` to the HOLDER
(balance-delta checked against the holder's balance, the same discipline as
the intent hook).

**The ONLY other credits are the era-terminal transfer above and its DELAYED
form — the pending-to-live recovery credit.** A `Detached` terminalization
debits the era into a pending recovery position and credits live `received`
only once an active era exists; that later credit is a **third registered
writer**, provenance-bound to the pending position it drains (it may credit
exactly what that position holds, nothing else) and ordered strictly after the
role transition that creates the active era. An earlier revision registered the
atomic transfer, declared the writer set exhaustive, and left the delayed leg
unregistered — following the contract stranded the pending funds, and following
the branch introduced an unlisted writer. Three writers, each provenance-bound, **and the writer contract's concluding
sentence says THREE** — an earlier revision defined the third writer and left
the conclusion reading "two writers, no third", so an implementer following the
summary would omit the delayed credit and strand every `Detached`-terminalized
surplus in its pending position permanently — an earlier
revision said "nothing else credits it", which rejects the terminal-surplus
disposition the era mechanism requires and strands the remainder.
**Three** provenance-bound writers — `fundRewardPool`, the era-terminal
transfer, and its delayed pending-to-live form — and no fourth. (An earlier
revision of this sentence said "no third" after the third had been defined
above it; the edit correcting that left a dangling "Two writers," in front of
the enumeration of three, so the summary contradicted itself mid-sentence for
a further round. The count is THREE, everywhere this contract is stated.) **The mirror's received-side writer table
carries the same transfer**, for the same reason: it moves attribution rather
than tokens, so a table listing only token-moving writers omits it silently.

**The delivered bound constrains REWARD outflows — nothing else respects
it, so the funding needs CUSTODY, not just arithmetic.** `received − paid`
gates every reward payout, but the tokens behind it sit in the shared
Diamond balance, and the OTHER spenders consult their own ledgers:
`PayrollFacet.withdrawSalary` transfers VPFI on the strength of
`stream.funded` alone (`PayrollFacet.sol:229-245`), never reading
`received`. On the historical state this design explicitly anticipates —
a non-reward ledger already underfunded at cutover — an underbacked
100-token payroll stream simply spends a new 100-token `fundRewardPool`
delivery, while the reward ledger still reports 100 of headroom: the
positive ledger was never the part that could fail, custody was. So
**delivered reward funding lives in DEDICATED CUSTODY** — a
Diamond-owned holder that only the registered reward writers credit and
only reward payouts debit, so no foreign `transfer` can reach it — with
the acceptable fallback being a **single outbound-VPFI primitive** every
egress path uses, asserting `balance − outflow ≥ outstanding reward
reserve` at the one chokepoint. What is NEVER acceptable is per-call-site
discipline: "every other spender remembers to check" is the enumeration
this design exists to refuse, pointed the other way.

**A caller-selected `RecycleSource` tag is not provenance, and the
allowlist must not treat it as such.** A generic `credit(source, …)`
whose enum the caller supplies proves neither the call origin nor a
token ingress — a future path passing an allowed tag compiles, bypasses
the delivered-headroom charge, and publishes recycled backing from
unrelated custody: the compile-and-forget failure by the front door.
Every allowed inflow class therefore gets its **own provenance-verifying
operation** — a dedicated, delta-checked ingress (or attribution
transfer) that DERIVES the source tag from what it verified, rather than
accepting it as an argument at a generic chokepoint. The enum names the
classes; the operations prove membership.

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

**(a1b) The delivered-bound EXCLUSION for old intent commits is
accounting, and accounting protects nothing payroll can reach.** Folding a
live pre-upgrade intent's custody into an exclusion satisfies the reward
consumers who consult it and no one else — `withdrawSalary` spends the
shared balance without ever reading it, so the arming gate passes and the
intent collateral is consumed anyway. The gate therefore requires one of:
the old-custody COUNT at zero (torn down), or the commits' custody MOVED
into the protected contract under an INTENT attribution row. An
exclusion no outflow path enforces is a label — **and the previously
listed third option, a "global outbound-reserve primitive", is
WITHDRAWN as undefined**: it appeared in this gate and nowhere else —
no state invariant, no initialization, no debit sites, no terminal —
and an undefined fund-safety primitive in a gate is a box an
implementation can tick while `withdrawSalary` drains the very
collateral the gate exists to protect. Two defined options suffice; a
third may be added only as a fully specified mechanism.

**And the INTENT-row move must carry the FILL path with it, or it breaks
the very order it protects.** The old order names the Diamond as maker
and its parameters are hashed — moving the collateral to the holder while
changing only teardown leaves the LOP fill reverting for missing tokens,
or consuming unrelated same-token Diamond custody, and a later holder
debit delivers nothing to the taker. The move is valid because the
orders already route through the Diamond's own `preInteraction`
(extension bytes pin it, `SwapToRepayIntentFacet.sol:113`), and the
HANDLER behind that pinned target is Diamond-upgradable: for a commit
flagged holder-custodied, the upgraded handler **pulls the row's custody
from the holder into the Diamond just-in-time for the fill**
(delta-checked, debiting the INTENT row in the same act), so the hashed
order is untouched and the tokens are where the LOP transfer expects
them. Where a commit's order does NOT route through the handler, this
alternative is unavailable — cancel-and-recreate or count-zero are the
remaining options.

**(a2) Every fresh OUTFLOW takes its TOKENS from the holder, not only its
accounting from the ledger.** Charging `received − paid` while the tokens
leave the shared balance re-creates the payroll collision in reverse: the
remittance path today has `LibRewardRemitDispatch.dispatchRemitTail`
approve the messenger from the DIAMOND, so a 100-fresh remittance against
an underbacked payroll balance drains payroll's tokens while the reward
100 sits stranded in the holder. So: claims, remittances and the compensation dispatches MOVE fresh
custody out of the holder (delta-checked, in the same act as their ledger
charge) — but an **ABSORPTION (expiry, forfeiture) into `recycleBucket`
is an IN-HOLDER attribution transfer, fresh row → recycled row, moving no
tokens**: the recycled backing must live in the same protected contract,
so exporting it to the shared balance would unback the very credit the
absorption writes (only actual external payouts and transports move
tokens out) — and a
mixed fresh/recycled CCIP send combines its two custody sources
explicitly — the fresh share pulled from the holder into the outbound
escrow at dispatch, the recycled share from the bucket's PROTECTED
custody — so neither side's tokens can substitute for the other's.

**The funding GATES move with the funding — every check that inspected
the Diamond balance reads the holder attribution once custody lives
there.** `RewardClaimFacet` and both sweep paths gate through
`LibVpfiRecycle.backingPosition`, whose balance term is
`balanceOf(address(this))`, and `_entryExecutableNow` derives its
funding check from the same position — so a fully funded state (100 in
the holder, no spare Diamond VPFI) would be REJECTED by the very gates
that run before the new holder-debiting transfer logic ever executes.
The gate replacement is part of the custody change, not a follow-up:
`backingPosition`'s balance term and `_entryExecutableNow`'s funding
read become the consumer's ELIGIBLE holder attribution (its era,
transport, and bucket rows as applicable), and no gate anywhere reads
the shared Diamond balance for reward funding again.

**And "the bucket's custody" means protected custody too — the recycled
side has the same enemy.** A `recycleBucket` counter over shared Diamond
balance is the payroll collision again: `withdrawSalary` consumes the
tokens without decrementing the bucket, and the next recycled claim or
remittance fails or substitutes unrelated custody while its ledger
reports funding. The protected custody contract therefore carries a
RECYCLED attribution row alongside the per-era fresh ones — one holder,
attributed rows per ledger — and recycled ingresses, classifications and
outflows move that attributed custody exactly as the fresh rules
prescribe for theirs.

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

**The two bootstraps are ONE operation, not two independent ones.** An earlier
revision seeded `received = H` (the reconciled reward custody) while the paid
rebase separately installed `paid = P` (historical paid value) — leaving the
bound at `H − P` rather than the intended opening headroom `H`, and **rejecting
every funded claim whenever `P ≥ H`**, which on a long-lived deployment is the
normal case rather than an edge one.

⚠️ **On an EXISTING canonical deployment there is no ledger that can prove any
`H` at all, and an administrator importing a figure is the enumeration problem
by another name.** §5b establishes that "balance minus every other owner" is
unknown and unclosable — so an over-estimated `H` publishes claim headroom
backed by exactly the borrower, payroll and treasury custody this bound exists
to protect, with no check able to catch it.

**So the legacy canonical bootstrap opens at ZERO HEADROOM and funds forward —
and "zero headroom" means `received = paid`, NOT `received = 0`.** An earlier
revision said the latter, which is a different and much worse thing: with the
paid rebase installing a historical `paid = P`, starting `received` at zero
means every subsequent `fundRewardPool(F)` is swallowed until cumulative funding
exceeds `P`. On a long-lived deployment that can absorb a large amount of
**provably new** funding and block claims indefinitely — punishing the operator
for the deployment's history rather than bounding it.

Seeded at `received = paid`, the bound opens at exactly zero and each
delta-checked transfer raises usable headroom one-for-one, which is what the
`received = H + paid` formula already implied for the provable case.

**And `bootstrapRewardPool` is REMOVED for this deployment class, not merely
deprecated.** Leaving it alongside the zero-and-fund-forward rule gives an
implementer two contradictory bootstrap contracts, and the one that takes an
administrator-supplied `H` is precisely the unverifiable path this correction
exists to eliminate. It survives only where a **provable provenance ledger**
exists — and a deployment with one is not the deployment being discussed here.

The definition below therefore applies **only** where a provable provenance
ledger exists:

**`H` is FREELY SPENDABLE fresh reward custody, not "reward-owned VPFI".** An
earlier revision said the latter, which double-counts the recovery position: if
`H` includes fresh VPFI sitting in the Base recovery position, its original
dispatch is already in `paid`, and the `…FromRecovery` redispatches are
deliberately exempt from future debits. Concretely — 100 dispatched and returned
gives `paid = 100` and recovery custody `100`; the bootstrap then publishes 100
of local headroom, an uncharged recovery redispatch sends the same 100 away, and
the headroom remains to consume unrelated Diamond custody.

So `H` excludes `rewardBudgetRecovered − rewardBudgetRedispatched` and every
other restricted reward position — the test is **"can a local claim spend
this?"**, not "does this belong to rewards?".

So the canonical bootstrap sets **`received = H + paid`** after the paid rebase
has installed `P` — or, equivalently, resets the paid baseline to zero and sets
`received = H`. The first is preferable because it preserves the paid counter's
continuity for anything else reading it; either way **the pair is applied
together, in a fixed order, under the same pause**, and neither is meaningful
alone.

**Migration for an existing canonical deployment needs a DIFFERENT call, and an
earlier revision reused `fundRewardPool` for it — which cannot work twice over.**
`fundRewardPool` transfers `amount` in and requires an exact positive balance
delta, so pointing it at VPFI the Diamond already holds either imports a second
`amount` from the admin or fails the delta check. And "balance minus every other
owner" is precisely the inventory §5b establishes is **unknown and unclosable** —
using it here would reintroduce the enumeration this whole section replaced,
and would classify unrelated custody as claimable.

~~**`bootstrapRewardPool(H)`**~~ — ⚠️ **NOT CUT INTO THE DIAMOND for a
deployment without a provable provenance ledger.** An earlier revision described
it here as the migration path and then, three sections later, said it was
"removed for this deployment class" — leaving the normative contract standing.
The contract cannot enforce an off-chain distinction, so a selector that exists
can be called: an administrator overstating `H` still exposes unrelated Diamond
custody as canonical claim headroom, which is the whole failure. **The selector
is omitted from that deployment's upgrade**, not merely discouraged; the
zero-headroom seed plus delta-checked `fundRewardPool` is the only path.

The description below is retained for the deployments that DO have a provenance
ledger, where the call is cut: a separate, ADMIN-only, one-shot, pause-gated
import whose argument is exactly the `H` defined above: **freely spendable
fresh reward custody, with `rewardBudgetRecovered − rewardBudgetRedispatched`
and every other restricted position excluded.** An earlier revision described
the argument as an "independently reconciled reward-owned figure", which is the
ownership test this section has already rejected — an implementer following the
call contract would reproduce the recovery-position double-spend exactly (the same off-chain reconciliation the mirror bootstrap
performs), **RELOCATES the proven custody into the dedicated holder in
the same act — or verifies the holder already carries exactly that
attributed amount — and** is **irrevocably finalized before unpause**
("moves no tokens" was the pre-holder wording, and it published
spendable headroom while the proven backing sat payroll-exposed in the
shared balance — or unusable against an empty holder — per the
provenance-relocation rule above). The
finality is the load-bearing part on both sides: any increment to `received`
publishes fresh payout headroom with no transfer behind it, so a writer left
callable after reconciliation defeats the delivered bound entirely. Same shape as
the existing one-shot `seedArmedFreshPaid` on the paid side, and for the same
reason.

**The paid side needs a NEW importer; `seedArmedFreshPaid` cannot serve.** An
earlier revision routed the broadened paid history through it, and it is
unusable for two independent reasons: it is one-shot, guarded by
`armedFreshPaidSeeded` (`RewardReporterFacet.sol:1266`), and on a live mirror it
**may already have been consumed by the P1-b migration** — such a deployment
simply cannot call it again for the newly included legacy payouts and
absorptions. Even unused, its `+= amount` semantics take a delta while this
section describes reconciling a *total*, which the earlier text never
disambiguated: importing the total on top of an existing counter double-counts,
importing a delta against an unseeded counter under-seeds.

So: **a new paused, one-shot `rebaseArmedFreshPaid(total)`** that sets `paid` to
`max(existing, total)` — **never below what it already holds** — rather than
adding to it, **and atomically sets `received` to that same resulting figure on
the canonical chain**, installing the zero-headroom baseline in the same call.

That second clause is not tidiness. With `bootstrapRewardPool` removed and
`fundRewardPool` unable to initialize anything (it requires a positive token
delta), this is the **only** migration call a no-provenance canonical deployment
has — so without it such a deployment ends at `paid = P, received = 0`, which is
negative headroom, and every subsequent transfer is swallowed until funding
exceeds `P`. The `received = paid` rule was stated three sections away and had
no call to implement it. An earlier revision of this contract said "SETS",
with the non-reduction floor stated only three sections later; an implementer
following the call contract would lower `paid` whenever the off-chain
reconstruction omitted a prior administrative retirement watermark, which is
exactly the case the floor exists for, and republish already-retired delivered
headroom, with its own guard flag
so it is independent of whether the P1-b seeder ran — **and which also consumes
or disables the old seeder's guard.**

That last clause is not tidiness. If P1-b never ran, `armedFreshPaidSeeded` is
still false, so after the absolute total is installed the old additive
`seedArmedFreshPaid` remains callable and a stale migration call would `+=`
historical paid value on top of it. That double-counts, **permanently removes
valid delivered headroom, and arrives after the one-shot rebase can no longer
correct it** — a one-way loss from a leftover selector. Either the rebase sets
the old guard, or the old selector rejects once a rebase has occurred; the first
is fewer moving parts. Setting rather than adding
is what makes it correct regardless of the deployment's history — the
reconciliation already produces an absolute figure, and asking it to produce a
delta reintroduces exactly the ambiguity above.

**The mirror's received-side migration writer takes the identical contract** —
ADMIN-only and paused per entry, a **multi-entry EPOCH**, NOT a one-shot call
finalized before unpause. **And for the pre-d2 LEGACY lane it is closed by
nothing**: §5c establishes that no observable transport terminal exists there,
so finalization is available only where an actual observed terminal does exist.
An earlier revision of this contract said "closed by a single explicit
finalization" without that qualification, which lets an implementer finalize
after bootstrap and leave a later-executed legacy packet permanently
unreconcilable. An earlier
revision of this line said one-shot; §5c establishes why that cannot work — the
bootstrap consumes it before claims resume, so the first delayed legacy packet is
stranded. Every "one-shot" and "time-bounded" description of this writer is
superseded by the epoch-and-finalization contract. An earlier revision said
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
| 1 | `InteractionRewardsFacet.sweepForfeitedInteractionRewards:101` | which bound applies to the forfeit sweep | **matching transport → eligible ERA balance → delivered bound** (was `max`; the era term is §5c's own order — an era balance is invisible to the live bound, so transport-then-live gave a retired-era obligation zero allowance) | matching transport → eligible era balance → delivered bound | **matching transport-epoch balance FIRST, then the eligible ERA balance** (live headroom 0) — transport-first is ROLE-COMMON, per the lifecycle's debit order and row 13 |
| 2 | `…:128` | does the sweep record a paid delta | **only the fell-through-to-live portion** (was "no", then an unqualified "yes" — a sweep funded by transport or a retired-era balance must not also suppress future live headroom) | same — fell-through only | **only the portion that FELL THROUGH to live funding** — an era-funded outflow debits its era balance and nothing else |
| 3 | `RewardCommitmentFacet.isDayCommitmentReady:191` | is a day's commitment reportable | n/a | yes | **no** — nobody to report to |
| 4 | `RewardCommitmentFacet._assertMirror:268` | AUTH: may this chain report | revert | allow | **revert** — fail closed |
| 5 | `RewardHorizonSweepFacet.sweepExpiredInteractionRewards:162` | which bound applies to expiry | **matching transport → eligible ERA balance → delivered bound** (was `max`) | matching transport → eligible era balance → delivered bound | **matching transport-epoch balance FIRST, then the eligible ERA balance** (live headroom 0) |
| 6 | `…:237` | paid-delta recording on expiry | **only the fell-through-to-live portion** (was "no", then an unqualified "yes") | same — fell-through only | **only the fell-through portion** — same rule as row 2 |
| 7 | `RewardRemittanceFacet.sendRemitAck:1529` | AUTH: may this chain ack a remittance | revert | allow | **revert** — fail closed |
| 8 | `RewardReporterFacet.setBaseChainId:1254` | is this a role transition needing residual retirement | n/a | yes | **yes — this is the site that CREATES and CLEARS Detached** |
| 9 | `RewardReporterFacet._retireDeliveredResidualOnRoleChange:1286` | retire the delivered residual | n/a | on transition | **on ENTERING Detached, retire the counter AND relocate its backing; on LEAVING, start from zero** — see below |
| 10 | `RewardReporterFacet.setIsCanonicalRewardChain:1301` | same, canonical side | yes | n/a | **yes** |
| 11 | `LibInteractionRewards._walkSideDays:1823` | pool pricing / schedule funding | canonical schedule | mirror-delivered | **0 — must NOT fall through to canonical schedule** |
| 12 | `LibInteractionRewards.sweepExpiredEntry:3245` | expiry accounting source | canonical | mirror | **mirror-shaped, bound 0** |
| 13 | `LibInteractionRewards._entryExecutableNow:3776` | may this entry execute now | **if funded, measured VINTAGE-BLIND** (was "always") | **same — see note** | **if the PREPARED transport coverage plus the eligible ERA BALANCE covers it** (live headroom stays 0). The predicate is a VIEW and cannot run the bounded batch scan — coverage spread across more small batches than one scan permits would read false forever, the sweep never reaching the allocator it needs to become true. So discovery is a separate, permissionless, stateful **PREPARATION operation**: it runs the paginated scan-and-stage machinery for an obligation ahead of time, accumulating staged coverage across calls, and the predicate reads the O(1) result — staged total plus cursor-visible balance, **applied through the same per-day TWO-LEG allocation as settlement BEFORE any drought check runs**: the recycled drought test compares recycled need against the bucket first today, so a transport-backed recycled claim (the 5-fresh/5-recycled example) would read non-executable against an empty bucket even with full prepared coverage — the drought computes on the recycled residual NET of prepared transport, the fresh check likewise on its net leg. Prepare until covered, then the clock and the sweep see it — both legs. **The
prepared-coverage term is ROLE-COMMON, not Detached-only**: legacy
packets route into the transport epoch after reattachment and after
permanent promotion too, and their targeted obligations must consume it
before era/live funding under every role — a retired claim backed
solely by a late batch must read executable on Canonical and Mirror
exactly as on Detached, or its era never terminalizes |
| 14 | `LibInteractionRewards.deliveredFreshBound:4211` | THE bound | **delivered** (was `max`) | delivered | **0** |

**Two rows carry the whole risk and are worth reading twice.** Row 11 is where
treating `Detached` as "not a mirror" silently funds payouts from a canonical
schedule that has no tokens behind it — the fail-OPEN direction. Rows 4 and 7
are where treating it as "a mirror" enables mirror-only cross-chain operations
on a chain with `baseChainId == 0`. Those are opposite errors from the same
missing third state, which is why no single boolean value works and why this
matrix — not the resolver — is the substance of closure 3.

**An ERA-FUNDED outflow debits its era balance ONLY — it must not increment the
live `paid` counter**, and rows 2 and 6 said it should. The consequence is a
double charge against future funding: a transition from `received = 100,
paid = 90` carries 10 into the era and sets live headroom to zero; sweeping that
10 while also recording a live paid delta means the next 20-token delivery
exposes only 10 of headroom, though the era funds — not the live ledger — paid
the sweep. The claim chokepoint takes the same qualification: **charge live
`paid` only with the portion that fell through to live funding.**

**Rows 1, 5 and 13's `Detached` answers all carry the ERA BALANCE, and an
earlier revision set them to a flat zero.** A retired-era obligation that
becomes forfeitable or expires while the chain is `Detached` must be able to
consume the funding already carried for that era — otherwise the reward-specific
absorption is refused, the era's obligations never terminate, and the
all-obligations-terminal transition that disposes of the residual **can never
fire.** A flat zero there does not merely block a sweep; it makes the era
immortal.

**Row 13 also needs its MEASUREMENT changed, not just its role answer.** The
predicate today takes only `armedFresh` from `_userArmedFreshNeedWithLegs`
(`LibInteractionRewards.sol:3771-3775`) and compares that against the bound. Once
the ledger is vintage-blind and `_deliverReward` rejects on the **total** fresh
component, a claimant whose need is entirely pre-`D*` has `armedFresh == 0` and
therefore passes a predicate their claim cannot satisfy: their expiry clock keeps
running while exhausted delivered headroom makes the claim impossible, and the
entry can expire the moment funding arrives. Switching the row from "always" to
"if funded" without widening the measurement leaves that gap on both roles, which
is why the Mirror cell is not unchanged either.

So the predicate compares the claimant's **aggregate vintage-blind fresh need**
against the delivered bound — the same quantity `_deliverReward` rejects on.
Anything narrower makes the two disagree, and the expiry clock is the one that
runs silently.

**Every canonical cell marked "(was …)" changes WITH slice 4, not only row 14.**
An earlier revision of this matrix updated the bound and left the canonical
forfeit/expiry allowances at `max`, their paid-delta cells at "no", and
`_entryExecutableNow` at "always" — which would let a canonical sweep absorb
fresh value **without consuming its funding allowance**, and let a canonical
expiry clock run while delivered funding is zero. Fixing the bound alone does not
repair the readers that bypass it.

So slice 4 lands **all** of these together, or Base has a delivered bound with
four documented ways around it.

**Retiring the counter must relocate the BACKING, not just the number.** A
mirror entering `Detached` with `received = 100`, `paid = 0` has 100 delivered
VPFI sitting in the Diamond. Setting `paid = received` removes all 100 of claim
headroom and moves nothing — and the zero baseline on reattachment then leaves
existing claims waiting for a **second** delivery while the first 100 is
untracked and unusable. The retirement was introduced to stop an old residual
being reusable; done to the counter alone it strands the tokens instead.

**This applies to EVERY effective role change, not only entry into `Detached`.**
`setIsCanonicalRewardChain` permits direct Mirror→Canonical and
Canonical→Mirror transitions and calls the same retirement helper
(`RewardReporterFacet.sol:1296-1339`), so a rule scoped to `Detached` leaves
those paths retiring the live counter without re-keying its backing — the
stranded-custody defect again — or retaining a prior-era residual for reuse,
which is the defect the retirement exists to prevent. Same counter, custody and
era transition on all of them.

**Chosen: an ERA-BOUND CARRY-FORWARD.** An earlier revision offered this or a
repatriation position as equivalents; they are not. Repatriating the backing
leaves the mirror's already-accrued claims waiting on a fresh delivery — the
liveness failure described immediately above — so it trades a stranding for a
freeze.

The carry-forward, specified so neither the funds nor their obligations can be
retired by accident:

- **Counter.** On **every effective role change** — entering `Detached`, and
  the direct Mirror→Canonical and Canonical→Mirror transitions
  `setIsCanonicalRewardChain` permits — the residual **`max(received − paid, 0)`** moves to
  an **era-scoped** balance keyed by the retiring era — **and a NEGATIVE
  residual is carried as an opening DEFICIT on the new baseline, never
  forgiven.** The saturation protects the role change from reverting; it must
  not also zero the debt: with `received = 100, paid = 100` and a 20-unit
  demotion (`80/100`), a reset-to-zero makes the next 20-unit delivery fully
  spendable — **cumulative fresh payouts of 120 against 100 authenticated
  receipts.** So the new era opens with `paid − received` pre-charged against
  it (equivalently: the deficit must be resolved before the role change is
  permitted). Saturate the era balance; carry the deficit. The saturation is not
  defensive padding: a demoted or unwound confirmation can legitimately leave
  `paid > received` after some of the credited value was already paid, which is
  exactly why the live bound floors at zero
  (`LibInteractionRewards.sol:4199-4214`). A bare subtraction would either revert
  the administrative role change under checked arithmetic or, unchecked, mint an
  enormous era balance out of an underflow — **a valid unwind wedging role
  reconfiguration, or funding an era from nothing.** An earlier revision of
  this bullet said "on entering `Detached`", which left the direct transitions
  with no counter rule even after the paragraph above extended the scope: the
  contract an implementer follows is this list. The live counters go to the
  required zero baseline; the residual is not deleted, it is re-keyed.
- **Custody.** The delivered VPFI does not move — **and "does not move"
  now means it stays in the DEDICATED HOLDER**, re-attributed to the
  era's balance rather than the live one. An earlier revision said "stays
  in the Diamond", which the custody rule has since made exactly wrong:
  holder-funded backing left in the shared balance at a transition is
  re-exposed to the payroll drain the holder exists to prevent, and an
  era ledger pointing at the Diamond points away from its actual tokens.
  A HISTORICAL Diamond-side amount (pre-holder inventory) backs an era
  only after passing the same provenance-or-replacement rule as every
  other ambient claim of backing — labeling is not proving, here either.
- **Claims.** Claims accrued under the retired era consume the era-scoped
  balance **first**, and any excess then debits the **live** delivered headroom
  like any other claim. **The era balance is threaded through the ENFORCEMENT
  and EXECUTABILITY checks too, not just the settlement arithmetic** — otherwise
  a claim fully backed by its era balance is rejected by `_deliverReward`
  against a zero live bound, and matrix row 13 simultaneously reports it
  unexecutable, so **an abandoned retired claim can never even become
  terminal.** Both checks take `eraBalance + liveHeadroom` as the available
  figure and consume in that order — **PER ERA, never in aggregate.**

  A single `claimInteractionRewards` window or expiry batch can span days from a
  retired era and the current one, and the design otherwise passes one aggregate
  fresh component to `_deliverReward`. A call carrying 10 of old-era need and 90
  of live-era need would then consume **100** from the old era — current claims
  spending funding reserved for the old era's other obligations, leaving those
  dependent on a future delivery that may never arrive.

  So the fresh component is decomposed **per era** and threaded that way through
  claims, absorptions, enforcement and executability, with **each era's debit
  capped by the need accrued in that era.** An era balance is a fund for its own
  obligations, and an aggregate figure cannot express that. Making the era balance their ONLY source would freeze
  the excess permanently: with `received = 100`, `paid = 90` and 50 of
  outstanding retired-era claims, only 10 carries forward, and the other 40 would
  wait forever while later deliveries land in a balance they may not touch.

  Falling through is also what keeps this consistent with the vintage-blind
  funding rule above — a claim is funded by delivered reward value, not by the
  era it happened to accrue in. The era balance is a **priority**, not a
  restriction: it exists so the residual is spent before new funding, never so a
  claim can starve beside money that would otherwise pay it.
- **`deliveredFreshBound`.** The era-scoped balance is **invisible** to the live
  bound. This is the property the retirement existed for: a residual cannot be
  spent twice by reattaching, because the new era never sees it.
- **Reattachment.** The new era starts at zero, per row 9. The old era's balance
  continues to drain against its own claims.
- **Terminal disposition.** An era balance is **not** necessarily exhausted when
  its claims are — mirror remittances may deliberately overfund eventually-capped
  claims, so a transition carrying 100 against 20 of remaining retired-era
  liability leaves 80 behind. Since that balance is invisible to the live bound
  and only retired-era claims may consume it, the surplus would sit in the
  Diamond forever: stranded by the mechanism built to stop stranding.

  So the era needs a **provable all-obligations-terminal transition** — every
  retired-era claim and sweep **settled, or expired AND its absorption booked**,
  **and every old-wire packet attributed to the era CLASSIFICATION-FINAL.** The
  legacy reconciliation epoch stays open indefinitely, so a packet's
  fresh/recycled split can be corrected after its era retires — and if the era
  has already terminalized and released its surplus, the correction has no
  source to debit: the attribution left with the transfer, and debiting live
  `received` consumes unrelated current-era funding. So a packet's
  classification is **finalized per packet** (its reclassification right
  explicitly closed) before its era's balance may release — or the terminal
  transfer carries the packet attributions forward so a later correction debits
  the moved balance rather than the live one. Finality-first is simpler and
  keeps the terminal proof self-contained.

  **And "every packet finalized" must be ENUMERABLE, or the terminal cannot
  check it.** Classification state is keyed by packet hash, so without a
  registry the terminalizer inspects an unknowable subset. Each era therefore
  maintains a **per-era OPEN-CLASSIFICATION COUNT** — incremented when the
  authenticated wire ingress LANDS the packet, decremented when its
  classification AND reclassification rights are closed — and the terminal requires it at zero,
  exactly parallel to the liability counter (which covers claims and sweeps and
  says nothing about packets). Two counters, two obligation classes, one
  terminal condition.

  **Increment at INGRESS, not at first classification — an earlier revision
  counted the operator's act instead of the arrival.** Classification can lag
  arbitrarily behind the wire: a packet landing in `uncounted` shortly before
  its era retires had, under first-classification counting, a zero open
  count — the era terminalizes and releases its balance, and the later
  classification must then credit a finalized era or draw unrelated live
  funding. Arrival is the authenticated, unfakeable event (the same
  delta-checked ingress that wrote `uncounted`), so arrival is what opens the
  obligation — and the backfill below therefore includes **already-arrived,
  not-yet-classified packets**, which the first-classification rule would
  have silently excluded from the initialization scan.

  **And the ingress stamps the packet's ERA, which its eventual
  classification CREDITS — the counter alone preserves finality but not
  destination.** A packet arriving in era A, classified after the role
  changed, would otherwise credit its fresh share to the LIVE `received`
  counter — era B's — so B's claims consume backing that era A's targeted
  obligations were counted open FOR: the open-classification count
  correctly blocks A's terminalization and then watches the money go out
  the wrong door. The packet record therefore persists its ingress era,
  and classification writes to THAT era's balance — live `received` only
  while the era is still current; the retired era's carried balance (the
  same retired-era routing every other late credit follows) once it is
  not. Two stamps at ingress — the count that holds the era open, and the
  era id that tells the eventual credit where home is.

  **On an existing deployment BOTH counters start WRONG, and must be backfilled
  before any terminalization — into a CONSERVATIVE BOOTSTRAP ERA, because
  "its era" is not derivable from current storage.** `RewardEntry` carries
  a day range and no era field (`LibVaipakam.sol:2451`), and the rotation
  state retains only the last nonzero Base deployment and a boolean — so
  on a deployment that changed role or source BEFORE this upgrade, an
  operator-SELECTED assignment can place an old obligation outside the
  counter guarding its backing, and one era terminalizes and releases
  funds before that obligation is absorbed. The backfill therefore
  assigns **every unstamped pre-upgrade obligation, and the matching
  backing, to ONE bootstrap era** that follows the retired-era rules
  (carried balance, both counters, no terminalization until ITS
  conditions hold); a FINER assignment is permitted only where immutable
  per-day source evidence proves it — the same evidence bar as every
  other privileged attribution in this design.** Every pre-upgrade `rewardEntries` row bypassed
  the new increment paths, so a retiring era's liability counter reads zero
  while old claims and sweeps are still live — and the first role transition
  would satisfy the O(1) terminal check and **release their backing
  prematurely**. Maintaining the counters for future mutations is not enough: a
  **paused, paginated backfill** assigns every existing outstanding component
  (and every open classification) to its era, and **role changes and
  terminalization are gated until that initialization is finalized** — the same
  high-water-mark completion proof as the other scans. A counter is only as good
  as its opening balance.

  ⚠️ **"Read back" is not an executable condition at scale.** `rewardEntries` is
  append-only and unbounded, so a single terminalization call that walks the era
  eventually exceeds the block gas limit — **permanently stranding the surplus**
  — while checking a subset can release backing before another obligation is
  absorbed. So terminality is established by an **incrementally maintained
  per-era outstanding-liability counter reaching zero**, or by the same
  **paginated high-water-mark scan** slice 1 uses, with the additional
  requirement that **membership cannot grow between the proof and the move** (a
  retired era admits no new obligations, so the high-water mark is genuinely
  final — which is what makes pagination sound here and not in slice 1's
  live-id case). The counter is preferable: O(1) to check, and it cannot be
  raced. ⚠️ **Crossing the expiry horizon is NOT the terminal**, and an
  earlier revision accepted it as one: the permissionless sweep may not have run
  yet, so releasing the era balance then lets a live claim spend it, after which
  the pending sweep either fails for want of era funding or consumes unrelated
  live funding. It also contradicts this note's own rule that an expired
  obligation stays live until its reward-specific absorption completes.
  **Fully processed, with the absorption recorded — not merely due.** after which
  the unused remainder moves to **live headroom** (it is delivered reward funding,
  and the era that scoped it is finished) — **but NOT while the chain is
  `Detached`.** The matrix keeps a `Detached` live bound at zero, so crediting
  there makes nothing usable, and the next effective role change carries that
  live residual into yet another retired-era balance while the new era starts at
  zero: the surplus **cycling through an obligation-free era** instead of funding
  anything.

  So while `Detached` the remainder goes to a **pending recovery position**,
  credited to live headroom only once an active Canonical or Mirror era exists —
  or it is repatriated. The rule: a terminal surplus is credited to a live era or
  held, never to an era that cannot spend it. Retiring the obligations without dispositioning the money is the same
  half-measure as retiring the counter without moving the backing.

Retiring a claim on money without deciding where the money goes is the shape this
whole note exists to reject — and offering two under-specified branches was that
shape one level up.

⚠️ **Closure 3 cannot land "first and alone" on an existing canonical
deployment.** The matrix's canonical cells switch `deliveredFreshBound`, the
sweep allowances, the paid-delta recording and executability from `max` to the
delivered bound — but canonical `received`, its zero-headroom migration and its
funding writers all arrive in **slice 4**. Landing the matrix first therefore
moves every canonical reward consumer from `max` to an **uninitialized zero**
and freezes them all.

So either **slice 4 and the ledger migration sequence BEFORE these matrix
cells**, or the independently deployable piece is scoped to **`Detached`-only
behaviour** — and in that case it must not be called closure 3, because the
canonical column is where the bound actually binds.

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

**Chosen: the ingress REFUSES while `Detached`.** An earlier revision named two
options and delegated the choice, which leaves a fund-safety decision to
implementation — and the two need different transport guarantees, receipt and ack
behaviour, storage, unwind logic and reattachment transitions, so "either" is not
a specification.

The complete lifecycle, since half-describing it is what left the previous
revision unimplementable:

0. **The ingresses accept only their INTENDED era, not merely "not
   `Detached`".** Gating on `Detached` alone leaves the direct Mirror→Canonical
   promotion open: an in-flight remittance lands after the transition and credits
   the **new canonical era**, even though `fundRewardPool` is defined as
   canonical `received`'s only ingress — and the mirror-only acknowledgement then
   reverts under row 7, so the packet is credited and unacknowledgeable. Each
   ingress therefore checks the era it was addressed to and rejects anything
   else, or the transition quarantines in-flight packets keyed to the retired
   era. `Detached` is one case of this rule, not the rule.

   ⚠️ **Refusal is only safe while the condition can clear, and after a
   PERMANENT promotion it cannot.** The `Detached` case retries after
   reattachment; a direct Mirror→Canonical promotion never restores the Mirror
   role, so the packet can never pass the ingress gate — and since CCIP has no
   maximum lifetime, the source-side reservation cannot obtain a
   never-will-execute terminal either. **The remittance and its reservation both
   stick indefinitely.**

   So a permanent role change is not a refusal case at all — and for the LEGACY
   lane, "drain first" is not available either: §5c proves there is no on-chain
   way to establish that lane has drained. So the precedence is explicit:

   - **d2 and V3 lanes:** drain first (their reservations are observable), or
     quarantine keyed to the retired era.
   - **Legacy lane:** quarantine — but **into the separately backed,
     NON-FINALIZED transport epoch, not into the retired era's own ledger.** An
     earlier revision keyed the quarantine to the retired era, which collides
     with that era's terminal: the legacy lane never provably drains, so the era
     would either stay non-terminal forever (its surplus stranded) or release
     early and have a late packet create an unfunded liability in a finalized
     era. The transport epoch has no terminal and needs none — it is backed
     packet-by-packet by what each late arrival delivers, terminalization does
     not depend on it, and its reconciliation is the standing legacy epoch that
     already never closes.

     **And it is CONSUMABLE, not just backed.** Storage without a debit path is
     stranding with better bookkeeping: the enforcement rule reads
     `eraBalance + liveHeadroom`, and a separate transport epoch appears in
     neither term. So the transport epoch's balance is **readable as a third
     term by the obligations its packets TARGET** — a retired-era claim or sweep
     whose funding arrived late draws `transportEpoch(target) → eraBalance →
     liveHeadroom` in that order, debiting the packet-backed balance first.

     **A classification exit that lands AFTER the addressed era finalized
     routes to the RETIRED era's carried machinery — never to a
     resurrection, never to the live ledger.** The transport epoch
     deliberately does not block its era's terminalization, so a late
     packet can still be classifiable when the era's terminal proof has
     run and its surplus is released — and the universal ingress-era
     rule then points at a finalized balance (crediting it resurrects an
     era after its terminal proof) while the live ledger is forbidden by
     the same era binding. The destination is the one built for exactly
     this — split by whether the addressed era has actually FINALIZED.
     A RETIRED-but-unfinalized era (carried balance live, terminal proof
     not yet run) takes the credit into that carried balance, normally.
     After FINALIZATION nothing may credit the era at all — the terminal
     proof asserted its obligations complete and its surplus is gone, so
     a late credit either resurrects state behind a completed proof or
     strands (no consumer, no repeatable terminal). Post-terminal shares
     go to **component-appropriate non-finalized destinations**: the
     fresh share to the pending recovery position under the batch's key
     (exiting through the registered writers), the recycled share to the
     global recycled bucket through its protected ingress — recycled is
     not era-bound, so no era rule is violated. Never a finalized era
     row, never an era it was not addressed to.

     **A legacy kind-2 BROADCAST is not transport material at all — the
     epoch is packet-backed FUNDING, and a broadcast carries STATE.** A
     state-only broadcast installs day/era state and reserves
     obligations; no transport-epoch operation can safely "apply" that,
     so routing one into the epoch just parks a thing the epoch cannot
     digest. A parked legacy broadcast follows the PARKED-MESSAGE lane
     instead — **with no era-recovery attempted, because the legacy wire
     cannot supply one**: it carries neither era nor message id, and a
     reverted receipt leaves no destination stamp, so "the era it was
     addressed to" is not a recoverable fact. The rule needs no such
     fact: on retry the broadcast is **applied ONLY if the intended-era
     gate accepts it against the LIVE era** — acceptance IS the
     authentication that it still belongs — and refused otherwise, back
     to parked. And the tombstone is **AVAILABLE BEFORE FINALIZATION — it IS the
     parked lane's drain for an era-unroutable broadcast**, not a
     consequence of the terminal it would otherwise deadlock: the
     terminalization rule requires the parked lane drained BEFORE the
     era finalizes, so a tombstone gated on finalization parks the
     broadcast forever and blocks the very terminal it waits for.
     **And the association runs on RECEIPT TIME, because "the addressed
     era" is not a recoverable fact**: parking is committed state, so
     each parked entry carries its own local id and receipt stamp, an
     era's terminal requires **no parked entry with receipt at or
     before that era's retirement watermark outstanding**, and the
     tombstone discharges the parked ENTRY by its id — no unknowable
     era named, no wrong terminal releasable. Once
     a retry has been REFUSED by the live-era gate (the evidence it
     does not belong to the live era), the operator records the
     disposition and the entry is
     **tombstoned** (likewise on
     permanent promotion past the mirror role) (its accrued
     obligations acknowledged as unservable, its source-side
     implications released through the charged-side machinery), never
     applied under a wrong accounting boundary.

     **A batch with UNARRIVED listed days is drawn LAST — necessity only,
     inverting transport-first for exactly those batches.** A listed
     member day whose broadcast has not landed is not a "known unmet
     obligation", so the contested-allocation machinery cannot see it —
     yet the design itself says these broadcasts arrive late: an early
     obligation draining a shared batch transport-first leaves the late
     day unfunded though other sources covered the early one. So an
     arrived obligation draws such a batch only for what its OTHER
     eligible sources cannot cover; the batch's remainder stays for the
     unarrived days until they arrive, terminal, or are dispositioned —
     and a late day still short then follows the late-obligation
     machinery as before.

     **The transport balance is UNTYPED, and consuming it writes NEITHER
     the fresh nor the recycled ledger.** The wire authenticates only the
     aggregate, so exposing a mixed packet's whole balance to a targeted
     FRESH claim would classify by consumption — 10 tokens spent as fresh
     on the strength of an assertion the fresh-evidence rule below exists
     to refuse. A targeted obligation's transport draw is therefore a
     **TOTAL-OBLIGATION debit**: it pays the obligation's amount from the
     packet's aggregate and publishes nothing — no fresh headroom, no
     recycled custody, no `received` write (the packet was delivered FOR
     those obligations; paying them is what the aggregate is). And the
     same typing rule governs every EXIT: a pending-to-live drain of an
     unsplit remainder cannot credit `received` (that is fresh publication
     by another door) — the remainder first passes CLASSIFICATION under
     the fresh-evidence rule, or leaves untyped through repatriation.

     **`transportEpoch(target)` resolves through the BATCH, because the legacy
     wire is batched and carries no per-day split.** A legacy remittance is
     `abi.encode(uint256[] dayIds, uint256 total)`
     (`RewardRemittanceReceiver.sol:221-223`) — one aggregate over many days,
     while each legacy broadcast names only its own `dayId` — so a per-target
     balance cannot be constructed from the wire at all: crediting the
     aggregate to every listed day duplicates the backing, and inventing a
     split asserts a fact the packet never carried. The epoch's unit is
     therefore the PACKET: one balance per batch, bounded by that packet's
     **`actualReceived`** (never the declared total — short delivery must
     shrink the funding, not the obligations), with the listed `dayIds` as a
     MEMBERSHIP filter. A targeted obligation draws from the batches that
     list its day — and **the contract checks the VALIDITY of an
     assignment, never its optimality: any assignment drawing each unit
     from an eligible batch within its balance is accepted, with
     fewest-remaining-member-days-first (oldest on ties) as the DEFAULT
     a preparer may override.** No local greedy survives overlapping
     memberships — oldest-first starves the shared-batch case, and even
     degree-ordering falls to `X={A,B}, Y={A,C}, Z={C}` with unit
     demands, where spending tied-degree X on A strands B though
     Y→A, X→B, Z→C settles all three. Feasibility over overlapping sets
     is a matching problem, and matching belongs OFF-chain: the
     permissionless preparation operation computes a
     feasibility-preserving assignment over the known obligation set,
     the chain verifies only validity — **and a CONTESTED allocation
     cannot settle irreversibly before it can be outdone**: a staged
     draw from a batch listed by a known UNMET obligation's day waits
     out a short challenge window before final settlement, during which
     a superseding plan displaces it by **covering at least the
     incumbent's obligations while drawing NO MORE from every contested
     batch, with at least one strict improvement — more coverage, or
     strictly less contested-batch usage** ("strictly more coverage"
     alone fails under block limits: a valid plan already covering the
     maximum processable count but choosing shared batches poorly could
     never be outdone by the same-count plan that swaps X→A for Y→A and
     leaves X for B; the per-batch usage comparison is O(plan size) to
     verify and captures exactly that swap). Uncontested allocations
     settle immediately —
     "outdone later" is no remedy once X is spent on A and B's only
     source is gone. Permissionless improvement, on-chain
     verification, no hardcoded
     greedy to beat — **through a per-day CURSOR that advances past
     exhausted batches permanently, because a bare oldest-first scan is
     unbounded on a hot path**: the legacy lane can mint arbitrarily many
     small batches listing one day, and a claim or permissionless sweep
     forced to traverse that whole history exceeds the gas limit,
     permanently blocking the obligation and its era's terminalization
     behind backing that exists. Each day keeps an arrival-ordered batch
     index and a consumption cursor; allocation resumes at the cursor,
     and **exhausting a batch updates EVERY member day's index in that
     act — with the `dayIds` fan-out BOUNDED AT INGRESS**: "wire-bounded"
     alone is not a bound, since the remitter supplies any nonempty list
     and a batch that fit the source transaction can exceed the
     destination's gas limit when retirement writes one index per
     member — never retiring, parked at the front of every member
     cursor. The cap is enforced at DISPATCH (the send side refuses to build an
     over-cap packet), and the receiver **ADMITS any transport-authentic
     oversize packet through a COMPACT admission whose storage cost does
     not scale with the list** — a CCIP payload is immutable, so a
     receive-side refusal retries the same over-cap packet forever; and
     an admission that persists the full attacker-length `dayIds` array
     element-by-element can itself exceed the destination gas limit and
     revert before ever reaching `RETIRING`, the same permanent bounce
     one step later. Admission stores the aggregate, the token delta, and an
     authenticated commitment to the day list — **split by what the
     WIRE can carry, because the old formats carry no root**. A NEW
     wire version (d6 — the existing d5 shape is
     `(tag, dayIds, total, remitId, remitter, recycledShare)` and
     carries neither root nor extent, so reusing its tag would fail
     in-flight d5 packets forever or leave them page-unauthenticated;
     **existing d5 packets are admitted through the compact flat-hash
     path exactly as the older wires are**) embeds a **Merkle root over
     fixed-size chunks TOGETHER WITH the authenticated EXTENT — element
     count, chunk count, and the indexed-leaf encoding** (a root alone proves a
     submitted chunk belongs to SOME tree, never that every member day
     has been seen: accepting a subset omits legitimate targets, and
     waiting for unspecified more strands the packet). Each
     materialization call supplies one bounded, INDEXED chunk plus its
     proof — O(page) verification — and completion is tracked against
     the authenticated extent: the batch becomes allocatable, and its
     retirement terminal reachable, only when every indexed chunk
     through the committed count has landed. An OLD-wire over-cap packet cannot be given a root the
     payload does not carry (a later-supplied root is invented
     membership), so its admission stores `keccak(payload)` — computed
     once over calldata the transaction already paid for, LINEAR-CHEAP
     next to the per-element storage writes that were the actual gas
     wall — and each materialization call **re-supplies the full
     payload as calldata, verifies the flat hash (linear, cheap), and
     writes only its bounded page of storage**. The arithmetic is the
     point: a packet whose full index writes burst the block holds
     thousands of days at ~20k gas per slot, while re-hashing its
     ~tens-of-KB payload costs well under a million — every page call
     affords the verification, none affords the writes, which is
     exactly the split this mechanism makes. The packet is safe and
     accounted from the first transaction, and its per-day machinery
     arrives page by page, each page authenticated against the stored
     commitment. Resumable retirement: bounded index-updates per
     call, batch marked RETIRING and skipped by allocation meanwhile. Exhaustion
     happens once per batch, so the removal cost is paid once by the
     settlement that exhausts it, not rediscovered by every other listed
     day's next scan (a cursor advanced only by its own day's draws
     leaves day B skipping the corpses of everything day A consumed —
     the unbounded scan by another door). A settlement touches at most
     the batches it draws from plus the ones it retires; a **hard
     per-call scan cap with resumable cursor advance** backstops the
     bound — a call that hits the cap advances the cursor and returns
     retryable rather than reverting. **And a capped call that has
     already DRAWN stages its draws obligation-bound rather than
     dropping or orphaning them**: draws persisted loose remove packet
     backing with no completed settlement, draws reverted leave the next
     retry facing the same live batches with no progress — so partial
     draws land in a per-obligation staging allocation (debited from the
     batches, credited to no one), each retry adds to it, and the final
     call settles the staged total atomically with the obligation —
     **with the EXHAUSTION transitions (member-day index advances,
     `transportConsumed` increments) deferred to that final
     settlement**: staging moves balance only. Fire them at staging time
     and a cancellation has nothing clean to reverse — the indexes have
     advanced past the batch for every member day and the packet budget
     is spent, so the restored balance is skipped by every future scan
     and rejected by the combined bound, stranded twice over. Deferred,
     a cancellation simply returns the staged amounts to batches whose
     indexes never passed them and whose budget never counted them —
     nothing to reverse. Retries resume from the staging record (which
     names its batches) rather than re-scanning, keeping the bound.
     **And a batch with OUTSTANDING STAGING REFERENCES cannot be retired
     by anyone** — staging increments a per-batch reference count that
     defers the exhaustion transitions for EVERY consumer, not just the
     stager: otherwise B stages-and-settles the other half of A's batch,
     the zero available balance lets B fire the member-day index
     advances, and A's later cancellation restores 5 into a batch every
     cursor has passed — stranded by a neighbour. The last reference to
     resolve (settle or cancel) fires the retirement if the balance is
     then zero; until then the batch reads empty-but-referenced and no
     index passes it. **And a staging record carries a DEADLINE, past
     which anyone may unwind it** — the claim entry points are
     caller-bound, so without permissionless expiry a claimant who
     stages the oldest batch's remainder and stops (malice, a lost key,
     a later sanctions flag) holds every obligation sharing those days
     hostage and the era never terminalizes. Expired staging unwinds
     exactly as a cancellation does — balance back to its named batches,
     references decremented, nothing half-paid — and the deadline is
     generous enough for honest retry chains (a bounded multiple of the
     retry cadence). **And an unwound stager does not go first in line
     again — with the cooldown keyed to the BATCH, not the obligation**:
     an obligation-keyed rule falls to a claimant controlling two
     eligible obligations, alternating A and B across expiries with each
     observing "its" cooldown while the batch never breathes. During the
     priority window after **ANY non-settlement release of a live
     staging allocation — permissionless expiry AND voluntary
     cancellation alike** — **the
     restored coverage is DIRECTLY CONSUMABLE by any competing
     obligation's settlement**, and for a competitor too large for one
     bounded scan, **consumable through PRIORITY-MODE STAGING: an
     obligation-bound reservation that DEBITS its amount from the
     restored coverage into staged form** — under the ordinary
     staged-balance conservation and unwind rules, so only the
     UNRESERVED REMAINDER stays directly consumable — **and it holds
     cursors: member-day indexes do NOT pass a batch with outstanding
     priority reservations** (an earlier phrasing said "no cursor
     block", which contradicted the retirement-deferral rule outright:
     advance the cursor past a fully-reserved batch and an expiry
     restores into a batch that member never revisits). What the
     reservation does NOT hold is an exclusive lease — others consume
     the batch's remaining balance freely — and it DOES carry
     **non-locking packet provenance** (packet id, batch id, per-leg
     amounts) and counts in the batch's RETIREMENT-DEFERRAL references:
     settlement must charge the right packet's leg counters, and an
     expiry must restore into a batch no member-day index has passed —
     "no batch reference at all" would let the batch retire under the
     reservation and strand both. And priority-mode is
     **NON-RENEWABLE per (obligation, batch) and FIFO by preparation
     age**: one priority reservation ever — an obligation whose
     reservation expires unsettled is permanently ineligible for
     priority mode on that batch — because an attacker with two prepared
     obligations could otherwise atomically unwind A and priority-stage
     under B, alternating forever; non-renewability burns each
     controlled obligation once, the finite pre-aged inventory drains,
     and FIFO puts the oldest blocked competitor first at every burn.
     Ordinary
     leases on that batch resume only after the window closes and any
     priority-mode reservations resolve.
     (Expiry-only was one round's scope: cancel-just-before-deadline
     and atomically restage re-created the hostage with no expiry ever
     firing.) This is
     what actually kills the hostage: a stage-first priority rule loses
     to serialization (pre-age obligations A and B, let A's lease
     expire, stage instantly through equally-old B — the window's
     "alongside" is no defence when one transaction takes the whole
     balance first), where a settlement that needs no lease cannot be
     outrun by re-leasing at all — the attacker can hold coverage only
     until expiry, and at expiry anyone ready to SETTLE simply does.
     Per-obligation cooldowns still apply to the expired lease's own
     obligation. Honest stagers
     who settle within the deadline never meet any of this. Staged allocations are release-on-cancel, so a
     dead obligation cannot strand what it staged. Bounded, resumable, and nothing
     half-paid — three properties, one mechanism. So
     conservation holds per packet — listed days can
     contend for an aggregate, because an aggregate is what the wire
     delivered, but no day outside the list can touch it and no token is
     counted twice. Remainder, pending-recovery keying, the restore path and
     the post-drain acknowledgment all follow the batch: the pending entry is
     `(batchId, dayIds, amount)`, and a late obligation restores through its
     day's membership. Any
     remainder after the currently-known targeted obligations terminate goes to
     the **pending recovery position — NEVER directly to live headroom**, for
     two reasons an earlier revision missed at once:

     - **The target set can still grow.** A legacy remittance can arrive before
       its separately transported kind-2 broadcast, so "the obligations
       terminated" is only true of the obligations known so far — the unclosable
       lane can later install more day state for the same target, and a
       remainder already released to live headroom would leave those late
       obligations unfunded. The legacy lane cannot prove a per-target closure,
       so the remainder is **retained where it stays visible and recoverable**
       (and repatriation from the pending position remains available to the
       operator).
     - **A direct transport-to-live credit would be a FOURTH writer**, which the
       three-writer contract forbids. Routing through the pending position uses
       the already-registered **pending-to-live** writer — same machinery, no
       new ingress — and that writer's own gate (an active era, and a deliberate
       drain of the position) is the right severity for money whose obligations
       may not be finished.

     **And the remainder keeps its BATCH identity inside the pending
     position — the move must not launder away the association the first
     reason above depends on, and "keyed by target" was the wrong key.** An
     earlier revision routed the remainder to the pending position as one
     undifferentiated balance (stranding it); the correction re-keyed it by
     TARGET, which the batch model above then falsified — no per-day amount
     exists on the wire, so splitting an aggregate remainder into target
     entries either invents an allocation or duplicates backing, exactly
     what batch keying was introduced to prevent. The association that must
     survive the move is the batch's: the debit order reads
     `transportEpoch(target) → eraBalance → liveHeadroom` with the first
     term resolving through batch membership, so once the batch's epoch is
     zeroed, a late kind-2 broadcast's obligations can no longer reach the
     money retained FOR them. So:

     - The pending entry records **`(batchId, dayIds, amount)`** — the
       batch, its membership filter, and its undivided remainder. A late
       obligation whose day is IN a parked batch's membership first
       **restores that batch's pending remainder into its transport
       epoch** — a bounded reversal of the move, debiting the pending entry
       by at most what it holds; not a fourth live-headroom writer, because
       it feeds the transport epoch, whose consumption path is already
       specified — and then settles through the normal membership-filtered
       order.

       **And the transport-funded portion is THREADED THROUGH the claim's
       ledger accounting, or the chokepoint rejects what the third term
       admitted.** `_deliverReward` is separately required to charge a
       claim's fresh component against the delivered ledger — so a claim
       fully funded by a transport batch (zero era/live headroom, 10 in a
       matching batch) passes the three-term check and then fails the
       chokepoint against zero, and one with partial ledger headroom is
       charged TWICE for the transport-paid share. The settlement records
       the split — `transportPaid / eraPaid / livePaid` — and each
       downstream chokepoint (delivery, sweep, absorption accounting) sees
       only ITS residual component: the transport-paid share reaches no
       delivered-ledger or bucket check, because the aggregate it drew
       from was never published into either ledger. **A transport-funded ABSORPTION recycles in place — there is no
       claimant to transfer to, so "reaches no bucket operation" would
       DROP the tokens.** An expiry or forfeiture funded by a matching
       batch keeps its tokens in protected custody; excluding the
       transport-paid share from absorption accounting debits the batch
       while crediting nothing, leaving the tokens attributed nowhere and
       `recycleBucket` undercounted. So: a claim's transport-funded share
       transfers OUT to its claimant, but an absorption's performs an
       **in-holder transport→recycled attribution transfer** — the
       batch's balance decrements, the recycled row increments, the
       commitment releases — the absorption analogue of the
       fresh→recycled rule.

       **And the per-day pass runs over DECREMENTING shared typed
       capacities — each day's shortfall is computed against what the
       EARLIER days left — with scarce transport allocated by
       SYSTEM-WIDE typed-source contention, not local shortfall alone.**
       A local tie rule starves later days: A before B, A needing 5F/5R
       with a matching 5-batch, B needing 5R, live fresh 5 and bucket 5
       — A's local shortfalls are both zero, fresh-first parks the
       batch on fresh, the bucket drains on A, and B reverts against
       nothing while a feasible assignment existed (A: live fresh +
       transport recycled; B: bucket). So the pass FIRST totals each
       typed source's remaining demand across the whole obligation,
       and each day's matching transport relieves the leg whose typed
       source carries the greater system-wide deficit (ties
       fresh-first). With one shared fresh source and one shared
       recycled source, relieving the more-contested source first is
       globally optimal by the exchange argument — the pass finds a
       feasible assignment whenever one exists.** Days A
       and B each needing 5/5, with 5 live fresh, 5 bucket, and a
       matching 5-batch per day: independent evaluation sees both typed
       legs "funded" twice, assigns no transport, and the aggregate
       10/10 residual fails against 5/5 — total backing exactly
       sufficient, claim rejected. One deterministic pass in day order,
       consuming the shared era/live and bucket figures as it
       allocates, transport covering each day's true residual —
       settlement and `_entryExecutableNow` running the SAME pass.

       **And transport coverage allocates PER MATCHING DAY before anything
       else, because batch membership is a per-day filter.** A claim
       spanning days A and B cannot apply a batch listing only B to A's
       need: coverage is computed day by day — the batches listing THAT
       day contribute, capped by that day's own component need — and only
       then do the residuals aggregate into the chokepoint charges. A
       batch-aggregate figure applied to the claim's aggregate marks the
       wrong day covered, leaving one ledger uncharged while another's
       protected custody is consumed. **Within each day's allocation,
       `transportPaid` carries TWO legs, because the components it pays
       are two.** A
       claim is fresh-pending plus recycled; a scalar transport figure
       leaves a 5-fresh/5-recycled claim with 6 transport-paid unable to
       say which 4 reaches which chokepoint — double-charging one ledger
       or preserving the wrong reserve, implementation's choice. The
       allocation **preserves transport-first per component while using
       SHORTFALLS only to split scarce transport** — two rules, in order.
       First: matching transport is DRAWN before era/live or bucket
       funding for whatever it is allocated to (the
       `transportEpoch → eraBalance → liveHeadroom` order is not
       optional — typed-covered components must not pull the shared era
       balance while their matching transport sits parked: claims A and B
       sharing 10 of era funding, with A alone holding a matching
       10-token batch, settle as A-from-transport and B-from-era, never
       A-draining-the-era). Second: when the untyped balance cannot cover
       both components, it is allocated by SHORTFALL — each component's
       need net of its own typed sources (era/live fresh; bucket
       funding), fresh-shortfall first on ties — so transport is never
       assigned to a component whose typed funding already suffices while
       the other component reverts against nothing. Blind fresh-first
       rejected fully-backed claims: 5-fresh/5-recycled with 5 live fresh
       headroom, an empty bucket, and a matching 5-token batch has enough
       total backing — live pays fresh, transport pays recycled — but
       assigning transport to fresh leaves the recycled residual against
       the empty bucket, reverting a claim the funding fully covers. Each
       leg's chokepoint sees only its own residual, as before. **The recycled leg additionally RELEASES its
       covered commitment without debiting the bucket** — a
       transport-specific retirement, exactly as the absorption branch
       already does: a broadcast that reserved 5 in
       `outstandingCommitRecycled` and was then paid by the batch would
       otherwise leave `consume(0)` retiring nothing (the commitment
       outstanding forever, suppressing spendable bucket funding for a
       terminal obligation) while an ordinary `consume(5)` debits
       protected custody that never funded this transfer. Release the
       commitment, touch no custody — the obligation ended, the bucket
       never paid.
     - A **repatriation, or an evidence-backed classification, of a parked
       batch remainder** — never the generic pending-to-live drain, which
       the typing rule above forbids for untyped value (this bullet said
       "pending-to-live drain (or repatriation)" for one round after that
       prohibition landed) — is a **deliberate operator disposition
       carrying a recorded acknowledgment, keyed by the batch**: obligations arriving for any of
       that batch's listed days afterwards are REFUSED to the extent they
       looked to that batch, never silently paid from live headroom. Same
       family as slice 0's shortfall disposition — the lane cannot prove
       closure, so choosing to stop waiting is an owner decision with its
       consequence written down.

       **And the refusal has a defined EXIT, or it is a permanent failure
       wearing an acknowledgment.** An earlier revision said "pending fresh
       funding through the registered writers" — but the registered writers
       feed LIVE headroom, which the same sentence forbids the refused
       obligation from consuming: funding could arrive forever without the
       refusal ever clearing, and an implementation would quietly fall back
       to the live funding the rule prohibits. The clearing operation is
       **batch-bound replacement funding: a delta-checked token transfer
       that atomically credits the batch's transport epoch and clears its
       acknowledgment** — the epoch-scoped sibling of `fundRewardPool`,
       feeding the transport epoch (whose consumption path is already
       specified) rather than live headroom, so the writer contract is
       untouched. **And the acknowledgment clears by AMOUNT, not by
       event**: the disposition stores the disposed remainder, replacement
       transfers decrement it, and obligations are admitted only against
       what has actually been re-funded — a 40-unit transfer against a
       100-unit disposed remainder funds 40 of obligations and leaves the
       refusal standing for the other 60, because the legacy target set
       can still grow and a first small top-up must not silently
       re-expose later obligations to era or live headroom. The refusal
       ends when the outstanding disposed amount reaches zero, not when
       the first transfer lands. The refused obligations then re-execute
       and settle through the normal membership-filtered order, bounded by
       the funded balance.

     So the flow is `transportEpoch(target) → targeted obligations` (the
     first term resolving through batch membership), and any batch
     remainder `→ pending recovery position, keyed by the batch`, exiting
     only through the membership-bound restore above, **evidence-backed
     classification, or repatriation — the registered pending-to-live
     writer is NOT an exit for an untyped batch remainder**, because that
     writer credits `received` and an unsplit legacy aggregate flowing
     through it is recycled-or-unknown value published as fresh headroom
     (the typing rule above, evaded through the pending position). A
     remainder that passes classification under the fresh-evidence rule
     exits as what the evidence proved; one that never can leaves
     untyped, through repatriation. If a deployment refuses to carry it, the honest
     alternative remains **disallowing the permanent transition while the
     unverifiable lane exists** — never promote-and-strand.

   Refusal with retry is for conditions that end.
1. **Receive while `Detached`** — `onRewardBudgetReceived`,
   `onCompensationBudgetReceived`, **and ALL THREE reward BROADCAST ingresses —
   `onRewardBroadcastReceived` (legacy), `onRewardBroadcastV2Received` and
   `onRewardBroadcastV3Received`** — revert. No
   receipt is written, no pool, recycle, day or era state moves, nothing to
   unwind.

   **The broadcasts were missing from an earlier revision of this list**, which
   gated only the two token ingresses and called the lifecycle complete. They
   accept configured-messenger packets without checking the chain role at all, so
   a delayed broadcast executing while `Detached` reaches
   `_reserveMirrorCommitOnce` and `_applyKeeperEarmarkOnce` — **reserving
   recycled custody and installing day and era state** for an obligation that
   rows 3 and 11 make unreportable and unpriceable. The role transition unwinds
   none of it, so the effect is locked funds or a poisoned later era.

   **The LEGACY ingress was still missing after that correction**, which added
   only V2 and V3 — so a delayed kind-1 broadcast stayed callable and writes
   `knownGlobalLenderInterestNumeraire`, `knownGlobalBorrowerInterestNumeraire`,
   `dayPoolStamp`, `governorCommitArmedFromDay` and `knownGlobalSet`
   (`RewardReporterFacet.sol:399-462`), directly contradicting this list's own
   claim that no day state moves. Three ingresses, not two.

   They carry state rather than tokens, which is exactly why they were easy to
   miss and not a reason to treat them differently: the test is "what state can
   move", the same one the matrix's own scope note now states. Twice now that
   test has been stated and then applied to an incomplete set, which is why the
   list names all three selectors explicitly rather than describing a class. This is symmetric with row 7's ack,
   which already refuses.

   **Permanent promotion COORDINATES the messenger, or the transport
   epoch is unreachable by the very packets it exists for.** The satellite
   messenger rejects every broadcast when its own flag says canonical —
   `if (isCanonical) revert BroadcastOnCanonical()`
   (`VaipakamRewardMessenger.sol:1751-1755`) — BEFORE the facet could
   quarantine it; leaving the flag false instead preserves the whole
   mirror report/broadcast authorization surface on a chain that is no
   longer one. So the promotion ceremony flips the flag AND installs a
   **narrow legacy-quarantine route**: broadcasts are accepted
   post-promotion for APPLICATION only from the closed set of legacy
   source lanes certified at transition — while the **state-free
   TOMBSTONE leg accepts any TRANSPORT-AUTHENTIC broadcast, certified
   lane or not** (the any-authentic rule for tombstone legs, stated with
   the kind-8/9 route: a straggler from an omitted lane otherwise
   reverts at the messenger before it can be parked or tombstoned, its
   source-side implications charged forever) — authenticated exactly as
   before, and routed
   solely into the PARKED-MESSAGE lane (acceptance-or-tombstone, as the
   broadcast rule specifies — an earlier phrasing here said
   "parked/transport-epoch machinery", and the transport epoch is
   packet-backed FUNDING that cannot digest a state-bearing broadcast)
   — never to the
   canonical report surface. Everything else still reverts
   `BroadcastOnCanonical`.

   **The BUYBACK lane joins the same transition gate.** The
   "what state can move" audit repeatedly found survivors by asking the
   question of an incomplete surface, and the buyback custody is
   another: a mirror can enter promotion with a nonzero `buybackBudget`
   (populated by `creditBuybackBudget`'s noncanonical branch), and
   `remitBuyback` carries no role guard and sends to the retained
   `s.baseChainId` — post-promotion that balance is stranded if the
   binding cleared, or still SENDABLE TO THE RETIRED BASE if it did
   not. The ceremony therefore drains, quarantines, or re-attributes
   the buyback budget with everything else, and `remitBuyback` gains
   the explicit role guard the audit's own test demands — **against a
   COMMITTED token universe, because the budget is a bare mapping with
   no enumerable index**: the ceremony commits the token set (from the
   allowlist's own configuration history, owner-attested with the same
   recorded-disposition terminal as the lane universe), each member
   drains to zero or takes its disposition, and a token surfacing
   outside the committed set takes a **BUYBACK-SPECIFIC straggler
   operation — not the repatriation lanes' path, which does not fit**:
   that path is a local tombstone plus a release against a REMOTE
   charged ledger, and a local `buybackBudget[token]` has neither a
   remote ledger nor anything a tombstone would move. The operation
   **atomically debits the budget entry and transfers the tokens into
   quarantine/recovery custody** (owner-disposable — repatriation or a
   recorded release), so the anticipated out-of-universe balance is
   recovered rather than stranded behind the new role guard. An
   uncommitted drain over a non-enumerable mapping is a completion
   claim nothing can check — the omitted balance strands the moment
   the role guard lands. **And the census is STABLE or it is not a
   census**: `creditBuybackBudget` stays callable while the promotion
   setters run, so token T can read zero at the check and be credited
   before the role flip — inside the committed set, outside the
   straggler operation's scope. Every buyback-budget producer FREEZES
   for the ceremony, and any credit landing after the census (a race
   the freeze missed, an unpaused path) VERSIONS the certification
   invalid — re-census before the flip, never a certified drain over a
   moved mapping.

   **A direct `setBaseChainId` REBIND (nonzero → nonzero) is PROHIBITED —
   every source-identity change goes through the Detached ceremony.** The
   setter (`RewardReporterFacet.sol:1249`) currently accepts A → B while the
   chain stays `Mirror`, which changes the authenticated funding source with
   NO era rotation: no retired era, no carry-forward, and the intended-era
   gate then either accepts delayed A-packets into B's live accounting
   (funding attributed to a source that never sent it) or refuses them
   permanently with their source reservations stuck. The era machinery keys
   on the source IDENTITY, so a rebind IS a role transition in everything
   but name — it gets the same ceremony: drain to `Detached`, retire the
   era with its carry-forward, rebind while detached, reattach to B under a
   fresh era. The setter enforces it (nonzero → nonzero reverts). **And
   "source identity" includes the DEPLOYMENT ADDRESS, not just the chain:**
   `setBaseRewardDeployment(A → B)` on the same Base chain currently
   accepts a nonzero rotation and updates only `rewardEraRotated` and the
   expected V3 deployment (`RewardReporterFacet.sol:1164-1185`) — no
   retired era, no carry-forward — so B's funding shares A's live
   accounting while delayed A-packets are refused against no matching
   retired balance. Same identity change, same ceremony — **and the setter rule keys on the
   RETAINED identity, not the live value, because `A → 0 → B` is otherwise
   a two-write bypass**: zero is a legitimate ingress-disable that keeps
   `rewardEraLastNonzero = A`, and the later `0 → B` write is not
   nonzero → nonzero while changing the authenticated identity exactly as
   a direct rebind would. So: **any write installing a nonzero identity
   DIFFERENT from the retained last-nonzero one requires `Detached`**,
   whatever the live value reads — for the deployment setter and the
   chain-id setter both. `A → 0 → A` (disable, re-enable, same identity)
   stays an ordinary operator action.

   **THIRD correction to the same list: the REPATRIATION instruction
   ingresses (kind-8/9) were still missing.** `RepatriationFacet.onlyMirror`
   is not a role check — it is `!isCanonicalRewardChain`
   (`RepatriationFacet.sol:400-402`), which a `Detached` chain passes — so a
   delayed instruction packet mutates repatriation state on a chain with no
   role, its later execution derives a destination from the now-zero
   `baseChainId`, and a permanent promotion afterwards makes every
   mirror-only execute / cancel-ack path unavailable while the old Base-side
   authorization stays charged indefinitely. So: these ingresses (and the
   execute/cancel exits) gate on the EXPLICIT role, refusing while
   `Detached` exactly as the broadcasts do — and because instructions that
   arrived BEFORE detachment can be pending across the transition, the role
   change itself must **drain, tombstone, or quarantine the pending
   repatriation set, which the instruction registry keeps enumerable** — the
   lifecycle rule the broadcasts' parked lane already follows.

   **And the registry needs a BACKFILL, because current storage cannot
   enumerate what is already pending.** `repatInstructionState` is a bare
   `mapping(bytes32 => uint8)` (`LibVaipakam.sol:6332`) with no key list — a
   registry installed only at the new ingress lets the transition certify an
   EMPTY set over a live pre-upgrade `PENDING` instruction, and permanent
   promotion then strands it exactly as described above. A counter is only as
   good as its opening balance, and a registry is only as good as its opening
   set. So, the same paused-initialization pattern as the era counters: the
   operator registers the pre-upgrade keys (each VERIFIED on-chain — the
   claimed key must read non-`INSTR_NONE`), and **completeness is proven
   against the CHARGED side of the pair, by AUTHENTICATED ATTESTATION —
   not by trusting the operator to have looked**. Local verification
   proves each SUBMITTED key exists; it cannot prove the operator
   submitted every remotely charged one, and an omitted pending key would
   pass promotion and strand its instruction and Base-side draw. So each
   charged chain sends, over the authenticated messenger lane, a
   **manifest attestation**: the enumerated set (or its Merkle root) of
   its charged, unresolved authorizations targeting this chain, with a
   completion watermark (charged-side block/sequence) marking the
   enumeration's end. The mirror verifies its registry against EVERY
   source chain's attestation — every attested key present, every
   registry key attested — **against a source-lane UNIVERSE committed
   before reconciliation begins**, because per-manifest authentication
   cannot prove a whole chain was not omitted: reconcile only chain A,
   promote, and chain B's charged authorization strands outside even the
   kind-8/9 route, which accepts certified lanes only. The universe is
   an **OWNER-COMMITTED lane enumeration, honestly labelled** — the
   messenger's live state cannot supply it: peers live in mappings,
   rebinding clears prior entries, and `backfillChannelPeerIndex` itself
   records that configured pairs are not discoverable on-chain and
   completeness is the operator's. So the commitment enumerates every
   current and historical lane the owner can establish, its completeness
   is an explicit OWNER ATTESTATION carrying a recorded loss disposition
   for any lane that cannot be verified (slice 0's family: who bears an
   unverifiable lane's loss is an owner decision, written down) — and a
   lane surfacing OUTSIDE the committed universe later follows the
   straggler path: local tombstone, charged-side release against its own
   ledger, never silent — **VERSIONED, with the ceremony pinned to one
   version**: lane mutations are frozen for the ceremony's duration (or,
   equivalently, any registry change bumps the version and voids every
   attestation gathered under the old one), because a lane configured
   after the snapshot but before the role change can charge an
   authorization the snapshot never covered while the gate happily
   accepts the old set's attestations. The gate requires from every
   member of the PINNED version one of THREE terminals: a finalized
   manifest, an **explicit empty attestation** ("nothing charged, as of
   watermark W"), or — for a lane that can honestly produce neither
   remote-state assertion — the **recorded loss disposition itself, with
   its charged-side accounting executed** (the lane's unresolved
   authorizations written off on the owner's recorded authority,
   disclosed as such). Without the third terminal the disposition clause
   is unreachable: an unverifiable lane blocks the ceremony forever or
   gets falsely attested empty. Role changes gate on all of that
   received and reconciled, not on the operator's word that it would
   have matched. Any key that
   nevertheless surfaces later (outside the certified set) is **refused —
   tombstoned by default, with its Base-side authorization released through
   the recorded-disposition path**, never executed against a role-less or
   promoted chain.

   **And the release of a LATE tombstone runs on the CHARGED side, because
   the promoted chain can no longer send the acknowledgment.**
   `sendRepatriationCancelAck` is `onlyMirror` and routes to the CURRENT
   `baseChainId` (`RepatriationFacet.sol:834-856`) — after a permanent
   promotion the first gate fails and the second is zeroed or rebound, and
   the instruction key (`keccak(issuingBase, authId)`) retains no
   authenticated source chain to route by — **and persisting the chain
   BESIDE that key is not enough: it must be IN it.** Two Base chains can
   deploy `issuingBase` at one address (CREATE2 makes this ordinary) and
   independently allocate the same Base-local `authId`; the two-field key
   then collides, the second ingress no-ops against the first's state, and
   the attestation routes to whichever chain the surviving record stored —
   one authorization released against the wrong instruction, the other
   charged forever. The state, the registry, and the attestation all key on
   **`(sourceChainId, issuingBase, authId)`**, with backfilled entries
   taking the source component from the charged-side reconciliation that
   certified them.

   **A collision that ALREADY happened under the old two-field key cannot
   be disambiguated by the new one, and the backfill must refuse to
   guess.** If two Base chains used the same `issuingBase` and `authId`,
   both charged ledgers claim the key but the mirror retained only
   whichever instruction arrived first (the second ingress no-oped) — and
   nothing on the mirror says WHICH. Backfilling both triple keys
   duplicates one instruction; picking either is an operator assertion
   about an authenticated fact. So ambiguous keys are a CERTIFICATION
   FAILURE, resolved on the charged sides: every Base authorization
   participating in an ambiguity is **cancelled/released through its own
   chain's recorded-disposition path**, the mirror-side instruction (whichever
   it was) is tombstoned with its funds handled through the pending
   recovery machinery, and certification requires ZERO ambiguous keys
   outstanding. Losing two authorizations to explicit release is
   recoverable; attributing one to the wrong chain is not. **A late kind-8/9 packet needs its own post-promotion route, because
   the broadcast route does not carry it and the attestation gate is
   unreachable without one.** The messenger rejects both instruction
   kinds when canonical, and the narrow legacy-quarantine route above is
   defined for broadcasts only — so a key first surfacing after
   promotion could never reach `TOMBSTONED` state, and the role-agnostic
   attestation (gated on exactly that state) could never fire: the Base
   draw stays charged forever, the disposition unreachable. The
   promotion ceremony therefore also installs a **kind-8/9 sibling of
   the legacy-quarantine route** — able to do exactly TWO
   things — persist the triple key and set it `TOMBSTONED` —
   **IDEMPOTENT over terminals: a key already `EXECUTED` or already
   `TOMBSTONED` is a NO-OP, exactly as the live state machine treats it
   (`RepatriationFacet.sol:748-750`)** — a duplicate delivery of an
   instruction that executed just before promotion, its return still in
   flight, would otherwise overwrite `EXECUTED`, race the attestation to
   Base, release the pending authorization, and fail the already-sent
   return permanently. And **this
   tombstone-only leg accepts any TRANSPORT-AUTHENTIC packet, certified
   lane or not**: lane certification gates APPLICATION (anything that
   touches funding or state), but the straggler clause exists precisely
   because the certified universe can be incomplete, and a route that
   rejects out-of-universe packets rejects exactly the stragglers it
   promises to terminalize — the source authorization charged forever.
   Persisting a key and tombstoning it is safe for ANY packet the
   transport authenticates (it enables only the release attestation);
   the same openness applies to the broadcast quarantine route's
   tombstone leg. No
   execution, no custody movement, no state but the tombstone; it
   exists so the attestation can be sent and the charged side released.
   So: (a) source-chain persistence,
   split by WHEN the instruction arrived, because the two cases have
   different provable facts: **new ingresses persist the messenger's
   authenticated `sourceChainId` at arrival** — while for PRE-UPGRADE
   entries that moment has already passed and nothing on the mirror recorded
   it, so their binding comes **from the charged-side reconciliation
   itself**: each Base chain's certification enumerates ITS OWN charged
   authorizations, so every backfilled key inherits the source chain of the
   ledger that certified it, and a key no charged ledger claims fails
   certification outright. An operator-supplied source value is prohibited
   in both cases — an earlier revision said the backfill "persists the
   authenticated source chain (known at ingress and only at ingress)",
   which for historical entries required recovering after ingress a fact
   only ingress could authenticate, leaving exactly the spoofable
   operator-asserted slot this design refuses everywhere else; (b) the
   promotion gate requires every
   CERTIFIED instruction resolved — executed or cancel-acked — while the
   chain can still speak as a mirror, and **"observed drained" counts as
   resolved only behind an AUTHENTICATED SOURCE-SIDE SEND FREEZE with a
   sequence watermark**: a source can authorize a send after the
   destination's final readback and before the role-change transaction,
   and out-of-order delivery lands it after the retired era finalized —
   a drain-first implementation holding no quarantine state for it then
   strands the packet or reopens finalized accounting. The source
   attests "no further sends past sequence W", and the destination
   verifies **CONTIGUOUS receipt through W — a gap-free acknowledgement
   watermark, not a highest-received check**: CCIP executes out of
   order (`allowOutOfOrderExecution`), so W landing proves nothing about
   W−1, which can still be in flight and land against finalized
   accounting after a highest-received gate passed. Every sequence
   through W received, and only then is the lane drained; a lane
   whose source cannot attest the freeze takes the mandatory quarantine
   path instead; and (c) a key surfacing after
   promotion is tombstoned locally and its Base-side draw released **only
   on an AUTHENTICATED TOMBSTONE ATTESTATION** — an earlier revision let
   the Base-side recorded-disposition operation release on its own,
   "verified against the persisted source-chain record", but that record
   lives on the DESTINATION: the charged side would be releasing
   `chainRepatriationDebited` on an assertion it cannot read, and a
   mistaken or malicious disposition then leaves the delayed instruction
   executable while its backing authorization is gone — the same mirror
   surplus backing two draws, which is the double-spend the authenticated
   cancel-ack invariant exists to prevent. The existing ack cannot carry
   this (it is `onlyMirror` and routes to the CURRENT `baseChainId`), so
   the transition defines its role-agnostic sibling: a **tombstone
   attestation** message, sendable regardless of the chain's current role,
   gated ONLY on the persisted instruction state being `TOMBSTONED`, and
   routed to the instruction's PERSISTED source chain rather than the
   current role binding. The charged side consumes it exactly as it
   consumes a cancel-ack — same authentication, same one-shot release —
   and the recorded-disposition operation on Base is thereby reduced to
   bookkeeping AFTER the attested release, never a release lever of its
   own. No attestation, no release: a straggler that cannot yet attest
   stays charged, which is the safe side of the ledger. Three times
   the "what state can move" test found a survivor; the matrix row for
   repatriation now cites this item rather than assuming token-lessness
   means harmlessness.
2. **Transport** — a reverted CCIP inbound is a failed message, **manually
   re-executable once the condition clears**. That is the property that makes
   refusal safe here and is why it is chosen over quarantine: the packet is not
   lost, it is parked in the transport layer where it already has a retry story.
3. **Reattachment** — the operator re-executes the parked messages after the
   role is set, and they are routed to **the era they were ADDRESSED to**, not
   to the fresh one. An earlier revision said they "arrive as ordinary ingresses
   against the fresh post-transition ledger" — which the intended-era gate then
   rejects, since every effective role change creates a new era. **The packet
   would be refused on retry exactly as it was on arrival**, leaving its funds
   and its source reservation stuck permanently.

   ⚠️ **And the parked lane must CLOSE before that era terminalizes.** The
   broadcasts install day and era state and reserve obligations, so a retry
   arriving after the liability counter hit zero and the surplus was released
   would **create an unfunded liability in a finalized era** — contradicting the
   terminal proof's own premise that a retired era admits no new obligations.
   So the era's terminalization requires the parked lane drained and closed as
   part of its all-obligations condition, or retries are held in a
   **non-finalized transport epoch** that terminalization does not depend on.

   So a re-executed packet is credited through the **retired era's own
   reconciliation** (its funding belongs to that era's obligations, which is
   where the claims it was sent to fund also live), or the design defines a
   transport epoch that survives a temporary detachment. The first is
   consistent with the era mechanism already in place.

   ⚠️ **EXCEPT the legacy kind-2 broadcast, which cannot be routed by era at
   all**: its wire carries no era field, the cross-chain callback exposes only
   source chain, sender, payload and tokens — not the transport message id —
   and a revert leaves no destination-side stamp. After reattachment the
   application cannot distinguish the refused old-era packet from an identical
   broadcast addressed to the fresh era. So legacy broadcasts take the
   **PARKED-MESSAGE lane** (apply only if the intended-era gate accepts
   against the LIVE era; tombstone with recorded disposition once no
   acceptable era can exist) — NOT the transport epoch, which an earlier
   revision of this sentence named: that epoch is packet-backed FUNDING
   and cannot digest a broadcast's day/era state, and routing one there
   just strands state-bearing data in machinery with no application
   semantics. The parked lane needs no era recovery either — acceptance
   by the live gate IS the authentication — rather than
   pretending a routing rule can run on information the frame does not carry.
4. **The role transition itself** therefore has no receipt-level mutations to
   reverse — the property that makes rows 8–10 sound rather than merely
   convenient.

Quarantine is rejected **for TEMPORARY detachment** — there, refusal costs
nothing because the condition ends and the transport retries. **For a PERMANENT
role change the precedence above governs instead**: the condition never ends, so
refusal strands, and the legacy lane's quarantine into the non-finalized
transport epoch is mandatory. An earlier revision of this conclusion rejected
quarantine without the qualifier, contradicting the permanent-transition rules
and instructing exactly the promote-and-strand they forbid. The cost argument
stands where it applies: for a lane that will retry on its own, a parallel
state with an unwind path buys nothing.

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
| value to the recycle bucket (forfeit / expiry) | a reward-specific operation, bounded and charging in one call. Generic `credit` accepts **ONLY a closed allowlist** of proven non-reward inflows (`NotificationFee`, `FullTariff`, `SpendGatedPerk`) and rejects every other source, present or future | the fresh component — the allowlist is what makes it non-bypassable |

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

**The reward operation REJECTS before it credits, exactly like the claim
chokepoint.** An earlier revision specified only that it charges the fresh
component before crediting the bucket — which is a ledger entry presented as a
bound for the third time in this document. The two current sweep callers happen
to carry their own bounds, but the whole point of a non-bypassable operation is
that a *future* reward terminal is forced through it; such a caller could submit
more than `received − paid`, convert unrelated Diamond VPFI into recycled
backing, and leave the ledger overdrawn with the bucket credit already made.

So: **reject against remaining delivered headroom, atomically with the credit.**
Same rule as `_deliverReward` and the transports — bound first, charge second,
one call.

**Generic `credit` must fail CLOSED: it accepts only an explicit, closed set of
proven non-reward inflows** — today `NotificationFee`, `FullTariff`,
`SpendGatedPerk` — and rejects everything else, including any source added
later. **And "allowed" means an allowed OPERATION, not an allowed tag on the
generic entry point**: per the provenance rule, each allowlisted class is
reachable only through its own dedicated, delta-checked operation that
derives the tag from the ingress or attribution transfer it verified — the
generic caller-selected-enum interface is not a usable route to any of
them, or an allowed tag passed by a future path publishes recycled backing
without the delivered-headroom charge, the compile-and-forget failure
through the front door. A new absorption class then cannot
compile-and-forget its way into the
bucket; it must either gain its own provenance-verifying operation from someone
who has argued it
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

**Mandated: hold consumers frozen until every in-flight d2 remittance has landed
and been reconciled.** The gate is per lane, read back per source chain.

⚠️ **The ordinary Diamond pause cannot be that freeze, and an earlier revision
said "hold the pause".** Both token ingresses are `whenNotPaused`
(`RewardRemittanceFacet.sol:846-855`, `:1039-1053`), so pausing makes every
arriving packet **revert before it can land** — the ceremony would block the very
deliveries it is waiting for and could never reach its own gate. Unpausing
instead exposes claims and sweeps while the old-wire accounting is unreconciled.

So the cutover needs a **migration mode**: a state in which the reward
CONSUMERS — claim, expiry sweep, forfeit sweep, the transports — are refused,
while the receive ingresses alone remain executable. Whether that is a dedicated
flag or a `whenNotPaused` exemption on the two ingresses is an implementation
choice; what is not optional is that the freeze blocks consumers **without**
blocking the packets being drained.

**If the dedicated-flag route is taken, the flag must participate in the EXPIRY
predicates too** — blocking the entry points is not enough. `sweepExpiredEntry`
and `_entryExecutableNow` consult `LibPausable.paused()` directly
(`LibInteractionRewards.sol:3253`, `:3751`), so a migration flag they do not
read leaves entries executable to the horizon machinery, and the accumulator
credits the interval since its previous observation once the mode clears. An
entry near its threshold then **expires immediately after a short cutover,
during which its owner could not have claimed** — value destroyed by the
ceremony rather than by the clock.

So the flag enters both predicates, **and the observation boundary is stamped
when the mode is entered and reset when it clears**, so the frozen interval is
never credited. A `whenNotPaused`-exemption implementation gets this for free,
which is a real argument for it. A single global pause cannot express that,
which is the reason this needs stating rather than being left to the ceremony.

⚠️ **"Settled or EXPIRED" is not a terminal, and an earlier revision used it as
one.** Application-level expiry says the reservation lapsed; it says nothing about
the transport, and the very next paragraph establishes that CCIP will still
execute an aged message. `LibVaipakam.sol:5807-5813` makes the same distinction
for release — it requires a never-will-execute terminal, not ordinary expiry. So
permanently rejecting d2 on an expiry-based gate strands its VPFI exactly as the
legacy case does.

The gate is therefore **acknowledgement or observed delivery**, or positive
evidence that the transport message can never execute — never expiry.

⚠️ **That gate CANNOT cover pre-d2 legacy packets, and an earlier revision said
it could.** `RewardRemittanceReceiver` states it outright: a legacy delivery
carries no `remitId`/`remitter`, "the Diamond records no receipt and no ack
flows (Base holds no reservation for pre-d2 sends)". So every visible
reservation can be settled while an unobservable legacy CCIP packet is still in
flight — and a permanent rejection after unpause then **strands that delivery
and its VPFI**, which is the outcome the cutover exists to prevent.

Legacy therefore needs the recovery path d2 does not — and an earlier revision
specified it in two ways that do not work:

⚠️ **There is no CCIP message lifetime to bound the window with.** The vendored
v1.6 `OffRamp` defines `permissionLessExecutionThresholdSeconds` as a MINIMUM
age *after which manual execution becomes permitted* — "manual execution is fine
… if the commit report is just too old" — and committed roots are retained with
no automatic maximum-age rejection. So an aged message becomes **more**
executable, not less. A deadline "chosen from CCIP's own maximum lifetime" was
resting on a bound that does not exist, and closing the window on that basis
would strand exactly the packets it was meant to rescue.

⚠️ **And the one-shot importer is already spent.** An upgraded mirror must use
the received-side importer to bootstrap its counters before claims resume, so by
the time a delayed pre-d2 packet lands, the guard is consumed. Moving when
finalization happens does not un-consume it.

**So: a migration EPOCH, not a one-shot call.** The received-side reconciler
accepts authenticated entries — the bootstrap first, then any legacy packet that
arrives. Finalization is available **only where an actual observed terminal
exists**, which for the pre-d2 legacy lane it does not (see below), so **for
that lane the epoch does not close.** An earlier revision of this paragraph said
"until a single explicit finalization" without the qualification, which lets an
implementer finalize after bootstrap and permanently strand a later-executed
packet. Claims may resume before finalization; the
reconciler is ADMIN-only and paused-gated per entry, so the window it leaves open
is authorization-bounded rather than time-bounded.

**Closing it needs a protocol-owned bound, because the transport has none — and
for LEGACY that bound does not exist today.** An earlier revision proposed
finalizing on "every source chain's legacy sequence acknowledged". There is no
such sequence: the legacy payload carries no `remitId` or `remitter`, records no
receipt and flows no ack (`RewardRemittanceReceiver.sol:230-232`), so there is
nothing to read back. Nor can a barrier message stand in for one —
`CcipMessenger._buildMessage` sets `allowOutOfOrderExecution: true`
(`:686-711`), so a later message arriving proves nothing about earlier ones.

Building one would mean a **protocol-owned sequence**: a counter each legacy
arrival advances, an ordering guarantee, and a closure rule covering packets
**already in flight** — which is the part no new mechanism can retrofit, because
those packets were sent without it.

**So the honest position, stated as the design's answer rather than as a
caveat: for the legacy lane the epoch STAYS OPEN.** It is ADMIN-gated and
paused per entry, so what it costs is an administrative surface that never
formally closes. That is strictly better than a finalization which can occur
while an executable delivery is still in flight, which is what any deadline or
synthesised terminal would give. If the operator later establishes out-of-band
that a lane is drained, closing it is their decision on evidence — not a rule
this document can state in advance.

**The reconciliation is ATOMIC over BOTH shares, not just the fresh one.** A
pre-d2 delivery passes both component shares as zero, so `onRewardBudgetReceived`
puts the **entire** amount into `rewardBudgetFreshUncounted` and credits no
relocated recycle custody. Sending only the authenticated fresh portion through
the importer would then leave the recycled portion outside `recycleBucket` and
stale mixed value sitting in `uncounted` — so a later recycled claim either fails
or consumes unrelated bucket backing.

One reconciliation entry, three effects, all or nothing:

0. **assert the CUMULATIVE FRESH and CUMULATIVE RECYCLED totals separately,
   each against the authenticated component on the packet evidence** —
   `alreadyFresh[h] + freshShare <= authenticatedFresh[h]` and
   `alreadyRecycled[h] + recycledShare <= authenticatedRecycled[h]`, **AND the
   cumulative sum bound against `oldWireAmount[h]` retained alongside them.**

   **`oldWireAmount[h]` is the destination-observed `actualReceived`, NEVER the
   payload's declared total**, and the authenticated component caps are scaled to
   that same basis. `RewardRemittanceReceiver` already books only what landed and
   explicitly scales the components to it (`:290-345`). Take the declared wire
   value instead and a 10-token payload that lands 9 permits classification up to
   10 — so once another packet has arrived, **the final unit is taken from that
   later packet and credited to the first.** The bound has to be denominated in
   the same quantity the ledger it guards was credited with

   An earlier revision said the sum bound "follows from" the component bounds. It
   does not, unless `authenticatedFresh + authenticatedRecycled <= oldWireAmount`
   is itself enforced — and old-wire packets carry no split, so those figures come
   from the operator's reconstruction. A mistaken 6-fresh/6-recycled
   authentication for a 10-token delivery passes both component checks, and with
   another packet having replenished the global `uncounted` balance it removes and
   credits **12** against a 10-token packet. Three bounds, not two.

   **A cumulative TOTAL alone cannot catch a wrong SPLIT**, and an earlier
   revision tracked only the total. For a packet authenticated as 4 fresh + 6
   recycled, an entry of 6 fresh + 4 recycled sums to 10, passes the total bound,
   **exhausts the hash**, and permanently publishes 2 of false fresh headroom
   while leaving the recycle bucket 2 short — with no follow-up entry able to
   reverse either mutation. Binding each component to the authenticated figure
   rejects that entry at submission instead of discovering it afterwards.

   ⚠️ **This catches disagreement with the reconstruction, NOT an error IN it.**
   The caps are themselves the operator's reconstruction, since old-wire packets
   carry no split — so a 10-token packet whose real composition is 4 fresh / 6
   recycled but is reconstructed as 6/4 accepts a 6/4 entry against its own
   caps, exhausts the packet, and still publishes 2 of false fresh headroom.
   Separate counters cannot detect a consistent mistake.

   So the epoch carries a **bounded RECLASSIFICATION operation** — ADMIN-only,
   paused, packet-hash-bound, moving value between the fresh and recycled
   attributions of an already-classified packet without changing its total, and
   itself replay-guarded — **and bounded by the still-UNSPENT source
   attribution.** Moving attribution cannot move custody that has already left:
   if a reconstructed 6-fresh/4-recycled packet has already paid all 6 fresh and
   is then corrected to 4/6, crediting 2 to the recycle bucket claims backing
   that is gone. Pausing the correction call does not help, since the epoch
   deliberately allows claims to resume before it closes.

   So the operation may reclassify at most what remains unspent on the source
   side; beyond that it requires **replacement funding ONLY where no
   authenticated destination ledger inherits the debit** (the boundary
   stated with the historical-debit rule below: the spent 6/4→4/6
   correction moves its two-unit debit into recycled-consumed accounting
   with `paid` reducing alongside — custody conserved, no replacement —
   and demanding capital there blocks a valid correction), or another
   custody-preserving recovery, rather than a bookkeeping move.

   **And it must state what happens to the HISTORICAL DEBIT, not only the
   custody.** Take the 6-fresh/4-recycled packet that already paid all six fresh
   and is corrected to 4/6: moving 2 out of `received` while leaving `paid = 6`
   opens a **two-unit deficit that swallows the next genuine fresh delivery**,
   while leaving `received` untouched simply preserves the wrong split. Neither
   is acceptable, and the correction is under-specified until it says which.

   The rule: it adjusts `received`, `paid` **and** the recycled-consumed
   attribution **atomically and consistently**, so the post-correction ledger is
   exactly what it would have been had the packet been classified correctly at
   ingress — with the replacement funding covering the custody that has already
   left. Anything less relabels history without reconciling it.

   **"Replacement funding" means an atomic custody transfer, and saying the
   words is not enough.** Without naming an ingress an implementation can treat
   unrelated VPFI already sitting in the shared Diamond as the replacement and
   credit the destination attribution while adding no custody at all —
   reproducing the solvency defect the bound exists to prevent, through the
   remedy for it. So the correction **atomically transfers the exact shortfall
   with a verified balance delta**, or **atomically debits a separately tracked
   recovery position**, before crediting the destination. New money or an
   identified source; never the ambient balance. Without the
   reclassification at all the reconstruction is unfalsifiable and its first
   error permanent — but an unbounded one converts a labelling error into a
   solvency one. (Deriving the caps from independently provable
   source evidence would be better and is not available: that evidence is what
   the legacy wire does not carry, which is the root of this whole section.) —
   the CUMULATIVE total, not this submission alone. An earlier revision bounded
   only the current entry, which the correction permitting follow-up entries then
   made exploitable: for a 10-token packet, submissions of 6 and 6 each pass a
   bare `6 <= 10`, and with another packet having replenished the global
   `uncounted` balance the second succeeds — classifying 12 against a 10-token
   delivery. The invariant the slice claims is only enforced if the algorithm
   carries it — checked BEFORE any
   of the three mutations, so a malformed or mistaken entry reverts whole rather
   than half-applying.

   **An earlier revision asserted `freshShare + recycledShare == the amount
   removed`, which became tautological the moment step 1 was corrected to remove
   exactly that sum — `x == x`, checking nothing.** Without a bound to the
   entry's OWN packet, an entry for a 10-token packet can classify and remove 20,
   silently consuming a later packet's contribution to the global `uncounted`
   balance. The nonce stops the same entry being applied twice; only this bound
   stops one entry consuming another packet's value, and the two are not
   substitutes;
1. **remove `freshShare + recycledShare` from `uncounted`** — NOT the full
   old-wire amount. An earlier revision required both the equality AND removal
   of the whole amount, which makes a legitimately rounded entry impossible: the
   dust left by component scaling has to go somewhere, and the operator's only
   options were to revert or to falsely assign it to fresh or recycled value.
   **Any `oldWireAmount − removed` residual STAYS in `uncounted`**, which is the
   fourth disposition the rule was missing — unclassified value sitting where
   unclassified value belongs, rather than being distributed into a ledger it
   does not belong to;
2. **credit only its authenticated fresh share to `received`**;
3. **credit its authenticated recycled share as relocated custody** into
   `recycleBucket`.

**Every entry also carries a REPLAY GUARD.** The epoch stays open indefinitely
and each entry debits a **global** `rewardBudgetFreshUncounted` aggregate, so an
ordinary operator retry of an already-applied entry consumes a LATER packet's
equal-sized uncounted balance while re-crediting the first packet's split.
Conservation still passes — the sums are internally consistent — and recycled
custody is silently reclassified as fresh headroom, or the reverse. A check that
validates each entry in isolation cannot see this.

So each entry carries a **canonical packet hash — the INGRESS STAMP
(`keccak(sourceChainId, messageId)`) for post-upgrade arrivals, or an
on-chain-verifiable inclusion proof; never an operator-supplied
transaction/log tuple** — with the `oldWireAmount` bound and the
classified totals keyed to that hash. (This sentence said "source chain
plus transaction/log identity" for one round after the historical-identity
rule below rejected exactly that: for anything unstamped, the contract
cannot detect two encodings of one arrival, and each encoding would carry
its own `oldWireAmount` allowance against the global `uncounted`
aggregate. Unstamped historical inventory has NO per-packet entries — the
snapshot-keyed aggregate envelope is its only vehicle.)

**Split by WHO stamps it — and only the INGRESS actually stamps.**
HISTORICAL unstamped inventory does NOT get per-packet identities at all:
an operator-supplied transaction/log hash is only off-chain-verifiable,
and the contract cannot tell one arrival honestly encoded from the same
arrival encoded twice — two hashes, two `oldWireAmount` caps, and the
duplicate classifies a later packet's `uncounted` custody, which is the
exact failure the operator-identity rejection below already names. So
history stays in the **bounded aggregate scheme** (the snapshot-keyed
envelope, netted and conservation-bound), and a per-packet HISTORICAL
entry exists only where an **on-chain-verifiable inclusion proof**
establishes the packet's identity — not operator assertion with off-chain
homework. But a POST-UPGRADE legacy arrival is
stamped by the INGRESS itself, on-chain, where transaction hashes are
unreadable and the payload cannot distinguish its own twins: two
legitimate remittances from one chain can carry identical day arrays,
totals and token amounts (the legacy wire has no `remitId`,
`RewardRemittanceReceiver.sol:221-232`), so hashing the visible tuple
ALIASES them — colliding `oldWireAmount`, classification totals and
transport-batch balances, stranding the second delivery or breaking
per-packet conservation. The ingress therefore takes uniqueness from the
layer that already has it: **the CCIP message id — which requires an
explicit PORT change, stated here so nobody discovers it at
implementation time**. `_ccipReceive` has `message.messageId`, but the
provider-agnostic port (`ICrossChainMessenger.onCrossChainMessage`)
forwards only source chain, sender, payload and tokens, and today the id
is merely emitted after the handler returns — the handler cannot read
it. The port therefore gains a `transportMessageId` parameter (adapter
and every recipient upgraded together — one interface version, five
receivers, all in this repo), zero for a transport that has none, in
which case the ingress falls back to the monotonic per-source counter.
**And the id crosses the SECOND seam too — the receiver-to-Diamond
ingress — because the ledger that enforces the packet cap lives in the
Diamond, not the receiver.** `RewardRemittanceReceiver` calling
`IRewardBudgetIngress.onRewardBudgetReceived` with no id field leaves
the `uncounted` accounting stamping nothing: reconciliation would then
accept a later operator-supplied hash at exactly the ledger the stamp
exists to protect. The ingress interface gains the same
`transportMessageId` parameter in the same upgrade batch, the DIAMOND
stores the stamp with the packet's `uncounted` entry, and every
reconciliation entry verifies against that stored stamp — never an
operator-supplied hash.
The stamp is `keccak(sourceChainId, messageId)`, unique per delivery and
unfakeable by payload construction. A transport without a message id falls back to a
**monotonic per-source counter allocated inside the authenticated
ingress** — never a hash of contents two honest packets can share.

**The guard is a cumulative INCREMENT, not a one-shot consumed flag**, and an
earlier revision of this paragraph said "marked consumed BEFORE any ledger
mutation". Read literally that rejects every follow-up correction, so a zero or
understated first submission strands the packet — the exact defect the
cumulative marker was introduced to remove, restored by the sentence describing
the marker. The bound is checked first, the effects apply, and **`alreadyFresh[h]` and
`alreadyRecycled[h]` each increment atomically with their own ledger credit** —
the total is DERIVED from them, never maintained alone. An earlier revision
incremented only the total, which leaves the component accumulators frozen: a
4-fresh/6-recycled packet would then accept 4/0 followed by 4/2, because nothing
advanced `alreadyFresh`, publishing **8 fresh against an authenticated maximum of
4** before the total reached 10 and exhausted the hash. A check is only as good
as the counter it reads.

**A merely "unique migration nonce" does not work, and an earlier revision
offered one as an equal option.** A fresh nonce establishes only that this
SUBMISSION is new, not that this PACKET is. An operator reconstructing the same
legacy packet twice under two fresh nonces passes both the nonce guard and the
`oldWireAmount` bound — and once later packets have replenished the global
`uncounted` balance, the duplicate classifies another packet's funds. The
identity has to come from the delivery, or the phrase "this entry's OWN packet"
means nothing.

The legacy wire supplies no `remitId` — but **the operator must not be the one
asserting the identity either, and an earlier revision left it there.** A hash
"assigned from the delivery's evidence" is unverifiable on-chain: two differently
encoded transaction/log identities for the same arrival, or a single mistyped
one, produce two hashes that the contract cannot tell apart. Each then gets its
own `oldWireAmount` bound, and once a later packet replenishes global
`uncounted` the duplicate classifies **that** packet's custody — which is
precisely the fresh-nonce scheme this paragraph rejects, reintroduced by the
remedy for it.

So the identity is **recorded AT INGRESS by the contract**: the legacy receive
path stamps an immutable delivery identifier when the packet lands — it is
already executing there, and the transport metadata it sees is not
operator-supplied — and the reconciliation **references that stamp** rather than
constructing one. If for some layout no such stamp is available, the entry
requires a verifiable uniqueness proof; what it may never do is trust the
operator not to mint a second hash for one delivery.

**The PRE-UPGRADE inventory has neither, and needs its own bounded scheme.**
Ingress stamping starts when the code ships; the value already sitting in
`rewardBudgetFreshUncounted` arrived before it existed, so those packets have no
stamp and — being long past — no practical uniqueness proof either. Falling back
to operator-assigned identity for them re-opens the hole for exactly the
inventory the bootstrap must classify.

So the pre-upgrade inventory is handled as **one bounded aggregate, not as
per-packet entries**: its total is the `uncounted` balance at the upgrade block
**NET of every on-chain restricted position that overlaps it** — an on-chain
figure the operator does not assert. The netting is load-bearing:
`_quarantineCompensation` increments both `strandedRecoveryReserved` and
`rewardBudgetFreshUncounted` for the same tokens, and the demotion branch does
the same for its counted portion — so the raw aggregate includes
recovery-reserved custody, and classifying it into live `received` or
`recycleBucket` would let claims spend tokens that must stay available for
recovery. Subtract each overlapping subledger at the snapshot — **including the
already-RETURNED overlap, not just the live one.** `sendStrandedReturn`
decrements `strandedRecoveryReserved` and transfers the tokens **without
decrementing `rewardBudgetFreshUncounted`** (`RepatriationFacet.sol:926-930`),
so after quarantining and returning 100 the naive envelope reads
`uncounted 100 − reserved 0 = 100` — classifying value whose tokens have left
the Diamond entirely, headroom backed by unrelated custody. The returned
overlap is on-chain too: `strandedReturnedCumulative` records exactly it, so the
netting stays assertion-free — `uncounted − reservedLive − returnedCumulative`
(each clamped to the overlap actually attributable to the envelope). Or carry
the exclusions through classification — and the bootstrap classifies
against that single recorded bound, under the same conservation and
per-component rules — with a **SNAPSHOT-KEYED aggregate reclassification as
the error path, because the packet-keyed one cannot reach it**. The
reclassification operation defined above binds to a packet hash, and this
envelope exists precisely because the history has no usable packet
identities — so an aggregate imported with a mistaken fresh/recycled split
would otherwise be permanent, leaving false fresh headroom or an underfunded
recycle bucket while the text promised an error path it could not execute.
The bootstrap envelope carries its own identity (the snapshot id the
high-water-mark proof already records), and the aggregate correction keys on
it under the SAME rules as the packet operation: spent attribution first,
replacement custody where the correction moves value, conservation against
the recorded bound.

**A correction MOVES CUSTODY for the unspent share it reattributes, not
only for the spent shortfall.** An unspent fresh share physically sits in
the holder; correcting it to recycled without moving tokens leaves the
recycled ledger pointing at the wrong pool — its next consumer fails or
spends unrelated custody — and the reverse correction strands bucket
custody outside the holder that fresh outflows now debit. So
fresh→recycled moves the amount from the holder's attribution to the
bucket's protected custody, recycled→fresh moves it back, atomically with
the ledger reattribution. **Replacement custody is required only where
the spent debit transfers NOWHERE** — the retain-`paid` boundary, applied
here: a corrected spent split moves its historical debit to the other
side's consumed accounting (`paid` reducing with it, the destination's
consumption rising), so the 6/4-spent-corrected-to-4/6 case settles as
`received = 4, paid = 4`, recycled credit 6 with 2 consumed, original
custody intact — demanding 2 replacement tokens there either blocks a
valid correction or leaves 2 unallocated. Replacement funds only a debit
no authenticated ledger inherits.

**"Spent attribution first" now has a deterministic definition, because
without one it was unanswerable.** Outflows are not debited per packet —
`alreadyFresh[h]` / `alreadyRecycled[h]` record what each packet PUT IN,
while payouts and recycle consumption debit only the aggregates — so "was
packet A's credit spent?" had no ledger to consult, and a correction could
move attribution that had already funded a completed payout, printing an
unbacked credit on the other side (the snapshot-keyed aggregate inherits
the same question). The rule is **FIFO by classification order — per credited era on the
FRESH side, GLOBAL on the RECYCLED side — because each queue must live
where its spending is actually recorded.** The recycled bucket is one
global balance in code: `LibVpfiRecycle.consume` and
`debitRepatriationSurplus` debit it with no era, so era-scoped recycled
queues would face a debit no rule can assign — charge era B's counter and
era A's packet reads forever-unspent, reclassifiable into fresh headroom
after its backing already left. The recycled queue is therefore GLOBAL:
every recycled credit (packet-classified, aggregate-bootstrap, and
non-packet alike) enters one classification-order queue whose outflow
total is the bucket's own cumulative consumption. The FRESH side is the
opposite for the same reason — `received`/`paid` genuinely partition by
era, retired-era claims debit carried balances that never touch live
`paid`, so fresh queues live per credited era. A packet classified into
retired era A is spent by A-era claims that debit A's carried balance and
never touch live `paid`, so a single global `sideOutflowTotal` cannot see
that spending: the credit would read forever-unspent and be movable
without replacement, reusing backing that already paid the claim. Each
credited era therefore keeps its own per-side outflow total and its own
classification queue (the era stamp from ingress already says which), and
each classification entry records ITS era-side's cumulative prefix at the time
it landed; an entry's credit is SPENT to the extent that era-side's
cumulative outflow total exceeds its recorded prefix —
`spent = clamp(sideOutflowTotal − prefixBefore, 0, credit)` — a pure
derivation from totals already kept, no per-outflow bookkeeping. A
correction may move only the provably-UNSPENT **and UNRESERVED**
remainder under that order without further requirement — beyond it,
replacement custody is required **only for a spent debit no
authenticated destination ledger inherits** (the boundary stated with
the retain-`paid` rule: a corrected spent split that moves its debit to
the other side's consumed accounting needs no replacement — demanding it
blocks the valid correction). Absence of a completed outflow is not proof
that the credit is free. `recycleBucket = 10` with
`outstandingCommitRecycled = 10` shows zero outflow and zero freedom:
the FIFO test alone would move all 10 to fresh and leave the commitment
outstanding against nothing, failing the next recycled claim or feeding
it unrelated later funding. Movable recycled custody is bounded by the
UNCOMMITTED balance — net of `outstandingCommitRecycled`, the keeper
earmark, and every other standing reservation — unless the correction
atomically retires or reassigns the reservation itself; anything else
requires replacement custody.

**And a correction that REMOVES an unspent entry must shift every later
entry's effective position, or the prefixes it left behind lie.** The
recorded prefix counts the removed credit: classify A then B at 100 each
(B's prefix = 100), reclassify the still-unspent A away, then pay 100 — the
tokens consumed are B's, yet the stale formula reads B as entirely unspent
(`clamp(100 − 100, 0, 100) = 0`) and permits moving B too, without
replacement — an underbacked destination attribution, twice over. So the
normative rule is **spent-ness over the LIVE queue**: outflows consume the
entries that still exist, in classification order, and an entry's effective
prefix is its recorded prefix **net of every reclassification touching
entries classified before it — amounts moved OUT subtract, and amounts
moved IN add**. The adjustment is bidirectional because a correction has a
destination as well as a source: credit moved INTO a side takes its
ORIGINAL classification-order position there (the order is the immutable
thing), so it lands BEFORE later entries and their effective prefixes must
grow by it — subtract-only, after moving 100 into recycled ahead of entry
B, would read a 100-unit recycled outflow as having consumed B when FIFO
consumed the moved credit, and a later valid correction of B would then
demand replacement custody it does not owe. Same ledger, net figures, both
signs. The realization puts the cost where the
rarity is: outflows (hot, permissionless) stay O(1) against the untouched
running totals; a reclassification (a PAUSED, operator-driven correction)
carries a paginated suffix adjustment — or an equivalent removal ledger the
effective-prefix read subtracts — under the same completion proof as every
other paused scan in this design. An earlier revision called the prefix
immutable, "so no later event can re-argue it"; the immutability claim was
the bug — what must be immutable is the ORDER, not the arithmetic.
Per-packet identity is required only where per-packet classification is
attempted; for history, one provable envelope replaces many unprovable
identities.

Step 0 is not defensive padding, but its rationale had to be rewritten with it:
an earlier revision argued in terms of shares summing **above or below the
removed amount**, which step 1 made impossible in both directions — and the
"below" half actively contradicted step 1's requirement that the residual REMAIN
in `uncounted`.

**An untyped arrival is PROTECTED AT INGRESS — `actualReceived` routes
into an `UNCLASSIFIED` holder attribution the moment it lands.** Leaving
the delivery in the shared balance until an administrator classifies it
reopens the window this custody design closes: `uncounted` is a counter,
the legacy epoch stays open indefinitely, a foreign outflow spends the
packet first — and the later delta-checked relocation still SUCCEEDS
whenever any other owner's VPFI remains in the shared balance, moving
that owner's tokens into the holder and publishing apparently-backed
headroom. So the ingress transfer lands in protected custody under the
`UNCLASSIFIED` row, and classification is an IN-HOLDER reattribution —
**unclassified → fresh, recycled, OR restitution**, because the fresh
destination is deficit-aware: an untyped packet is not credited to
`received` until classified, and if `paid > received` at that moment,
the deficit rule above routes the fresh amount it absorbs into the
RESTITUTION attribution — putting it in the live row instead allocates
tokens against zero headroom, unusable and strandable at the next
transition. The authenticated fresh amount splits at the pre-credit
deficit: the absorbed portion to restitution, only the excess to live
backing. Nothing for payroll to race, and nothing for the deficit to
strand.

**The same deficit split governs RECLASSIFICATION into fresh, and the
reverse direction names its debit order.** A recycled→fresh correction
raises `received` exactly as a classification does — under
`paid > received` the absorbed portion creates no headroom, so it routes
to restitution identically, only the excess to the live row. And a
fresh→recycled correction debiting a fresh attribution that spans
restitution AND live custody takes from **LIVE first**: the live portion
is the spendable one whose reattribution the correction machinery
already handles, while restitution-held custody moves only through its
own disposition rules — a correction is not a back door out of the
restitution position.

**A fresh classification MOVES ITS TOKENS, not just its numbers —
in-holder, per the ingress rule above. The Diamond-to-holder relocation
exists ONLY for HISTORICAL pre-holder inventory** (and inherits slice
0's provenance bar there): every post-upgrade untyped arrival is
ingress-protected into the `UNCLASSIFIED` attribution the moment it
lands, so a classification-time relocation for such a packet would mean
it had sat payroll-exposed in the shared balance for the whole
indefinitely-open legacy epoch — and a late relocation over a spent
packet seizes another owner's VPFI, per the ingress rule's own
delta-check argument. And a batch with OUTSTANDING listed obligations is not
classifiable at all**: classification converts batch-scoped backing
into era-wide or global credit, so classifying a live batch lets an
unrelated claim spend what the packet was delivered FOR — day A's sole
eligible batch emptied by a day-B claim through the global ledger. The
ONLY route to classification is the acknowledged PARKED-REMAINDER path
(listed obligations terminal or dispositioned, the batch-bound
acknowledgment recorded); the general reconciliation path classifies
no live batch.** Classification that only debits `uncounted` and
credits `received` publishes holder-capped headroom the holder does not
hold. So classifying a share as FRESH performs an **IN-HOLDER
reattribution — `UNCLASSIFIED` row to fresh row — for every post-upgrade
arrival** (which the ingress rule already protected into the holder at
landing; a shared-balance relocation here would transfer the same
custody twice or seize unrelated Diamond VPFI), while **HISTORICAL
pre-holder inventory alone relocates from the shared balance**
(delta-checked, same act as the ledger credit, under slice 0's
provenance bar). The typed post-upgrade ingresses route their fresh
share into the holder at arrival, same as the untyped ones.

**The EXISTING `recycleBucket` balance gets a paused bootstrap
reconciliation BEFORE the custody switch, and arming gates on it.** An
upgraded deployment can carry a nonzero bucket whose historical custody
sits (or sat) in the shared balance: seeding the new protected row from
the counter or the ambient balance seizes payroll or user custody
wherever the historical bucket is underbacked, while a zero row freezes
already-funded recycled claims and commitments. So the switch runs the
slice-0 family over the bucket itself — provenance proven, replacement
funded, or written down — and the reconciled backing moves into the
protected recycled row before any recycled gate reads it.

**The RECYCLED share of the bootstrap aggregate gets the same
executable-backing reconciliation as the fresh side, because `uncounted`
is a counter, not custody.** The same pre-holder outflows that make
imported fresh history unprovable can have spent this inventory too, and
only the fresh side is holder-capped downstream — so an `uncounted = 100`
snapshot with no tokens behind it would credit `recycleBucket` with 100
that later recycled consumers either fail on or take from unrelated
custody. Before the bucket credit: dedicated backing proven, or
replacement funding, or a write-down of the aggregate's recycled share —
the slice-0 disposition family, applied to the recycled aggregate.

**And the FRESH side of any split is the PRIVILEGED direction, because
fresh is what claims can SPEND.** The component caps validate an entry
against the operator's own reconstruction, so a wrong (or, with a
compromised admin key, hostile) 6/4 split passes its own arithmetic and
immediately exposes tokens as spendable headroom that should back recycled
obligations — and once a false fresh credit is spent, the error path below can
demand replacement funding (where no authenticated ledger inherits the
debit — a correction that moves the debit to the destination's consumed
accounting needs none, per the boundary below), so the reclassification
machinery is corrective, not preventive. A fresh share therefore requires
**authenticated source evidence** (the broadcast-side recorded splits where
the lane carries them) **or delta-checked replacement custody**; absent
both, the entry classifies **conservatively — recycled or unclassified —
and a later evidence-backed reclassification lifts it**. Mis-classifying
real fresh as recycled under-publishes headroom, which is recoverable by
exactly that correction; the reverse spends someone else's backing first
and asks questions later. Asymmetric risk, asymmetric rule.

The live case is a share sum exceeding **`oldWireAmount`**: the writer then
publishes fresh headroom and recycled custody backed by unrelated Diamond VPFI,
and — with the global aggregate — consumes another packet's balance while doing
it. That is an ordinary operator mistake on an administrative entry, so nothing
else catches it.

A share sum **below** `oldWireAmount` is permitted and expected: the difference
is rounding dust, and it **stays in `uncounted`**, never distributed.

**But "permitted" plus a one-shot consumed marker strands the remainder.** An
operator who understates a share — or submits zero by accident — passes the
bound, leaves the balance in `uncounted`, and **burns the packet hash**, so a
corrected entry for that immutable delivery is refused forever. The rule that
tolerates rounding dust would then also tolerate stranding an entire packet.

**And the marker's bound is COMBINED across every way a packet's value
can leave — `transportConsumed + alreadyFresh + alreadyRecycled +
repatriatedOrDisposed ≤ oldWireAmount` — maintained atomically on each
transition, REPATRIATION INCLUDED — with `transportConsumed` SPLIT BY
LEG against the authenticated component caps.** A scalar closes the
total and leaves the components blind: a 4-fresh/6-recycled packet can
fund a 4-fresh transport draw and then still classify 4 fresh — 8 fresh
funded against 4 authenticated, with 4 of recycled commitments left
unbacked, every stated check passing. So `transportConsumedFresh` and
`transportConsumedRecycled` accumulate per packet, and each
authenticated component bound covers its classification counter PLUS
its transport leg (`alreadyFresh + transportConsumedFresh ≤ freshCap`,
recycled likewise), alongside the aggregate wire bound. **Where NO
authenticated component caps exist — the untyped legacy wire — only the
aggregate bound binds, and the leg counters RECORD rather than
enforce**: the legacy frame authenticates the total alone, so demanding
cap checks against caps nobody can authenticate either freezes
transport draws (zero/unset caps) or launders operator-selected numbers
into "authenticated" ones. When evidence-backed classification later
fixes the caps, **the fixing transaction RECONCILES FIRST and the caps
become immutable only after the component invariant holds**: an
already-recorded leg in excess of its incoming cap is (a) REATTRIBUTED
across legs where the other component's cap covers it — the aggregate
was authentic, so a fresh-leg draw against what the evidence now says
was recycled value becomes recycled-leg use, counters moved atomically —
then (b) any excess beyond both components enters the slice-0
disposition family with a **bounded replacement term added to that
component's invariant** (`alreadyFresh + transportConsumedFresh ≤
freshCap + replacementFresh`, the replacement delta-checked custody).
Fixing caps against unreconciled counters would make the invariant
false at birth — the transaction reverting forever or persisting
invalid state, classification unfinalizable, the era terminal blocked. The fourth term counts
NON-CLASSIFICATION exits only** (repatriation, write-off — debited by
the exact remainder leaving through them): an evidence-backed
classification is elsewhere called a "disposition" of a parked
remainder, and letting that meaning bleed in here double-counts it —
100 classified would post 100 to the classification counters AND 100 to
`repatriatedOrDisposed`, 200 against a bound of 100, reverting a valid
operation. A classification debits the classification counters, full
stop.** A packet parked to pending and then
repatriated leaves through a fourth door: no transport draw, no
classification, all counters zero — and once another delivery replenishes
the global `uncounted` aggregate, the departed packet's hash could still
classify its full amount against the newcomer's custody. Executing a
repatriation (or any disposal) of packet-attributed value therefore
exhausts that packet's classifiable remainder in the same act.** The
transport path and the classification path are two doors out of one
packet: pay a targeted claim 10 through the batch and the classification
counters still read zero, so a later full classification — once another
packet has replenished the global `uncounted` aggregate — consumes THAT
packet's custody and publishes backing for tokens already paid out
(classify first and the batch balance is the stale one, symmetrically).
Every transport draw therefore increments the packet's
`transportConsumed` and reduces its classifiable remainder in the same
act; every classification — which the parked-remainder rule makes possible
only AFTER parking — **debits the batch-keyed pending
`(batchId, dayIds, amount)` entry, not the transport balance the
parking already zeroed** (a drawable-balance debit at that point
reverts or double-debits value already moved);
and the three counters share one wire-bounded budget a packet can never
exceed from either direction.

So the marker tracks the **cumulative amount classified per packet hash**, not a
boolean: later entries may classify the remainder up to `oldWireAmount`, and the
hash is exhausted only when the cumulative total reaches it. Replay protection is
preserved — no packet can ever be classified beyond its own amount — while a
mistaken under-classification stays correctable, which a boolean cannot express.

Doing (2) without (1) and (3) is the failure mode; the window exists to land all
three together.

**This window is NOT time-bounded, and an earlier revision of this paragraph
said it was** — directly contradicting the finding above, which establishes that
no safe terminal exists for the legacy lane and makes an **explicitly open**
epoch the design's answer. An implementer following the earlier wording would
close the reconciler on a deadline and strand a legacy packet executed after it.

The contract is: **ADMIN-only and paused per entry, multi-entry, open until a
single explicit finalization that only an observed terminal justifies** — and
for legacy, no such terminal exists today, so it stays open. It is not a
permanent second *ingress*: nothing arrives through it without an administrator
submitting a reconciled entry, which is what bounds it. Authorization, not time.

⚠️ **This rejection applied to d2 and is SUPERSEDED for the legacy lane.** The
argument below — that a post-unpause receipt-level entry adds a permanent
administrative writer authenticating a split from outside the chain — is exactly
why d2 gets a closable gate. But §5c then established that the legacy lane has no
observable terminal, and **selected precisely this mechanism for it**, bound to
packet evidence and paused per entry. Left unqualified, this paragraph rejects
the design's own choice and leaves a delayed pre-d2 packet with no way to be
classified at all.

So: for **legacy**, the packet-evidence-bound, pause-gated epoch **is the
accepted exception and remains open**. The rejection stands for d2, where a
terminal exists and the writer therefore buys nothing.

The original reasoning, which is why the exception is narrow: it adds a
**permanent administrative writer on the received side, authenticating a split
from outside the chain** — the two properties the inversion exists to
eliminate. If a lane genuinely cannot be
drained, that is an escalation to the owner, not an implementer's fallback.

The last two writers are a matched pair and must be changed in one commit: the
failure mode is not that either is individually wrong, but that confirmation and
demotion stop being inverses. **Two separate fixtures, not a round trip.** An earlier revision required a
confirm-then-demote round trip, which **cannot occur through the production state
machine**: `onCompensationDayBroadcastArrived` clears `dc.provisional` on
confirmation, and every later call returns immediately on `if (!dc.provisional)
return;` (`RewardRemittanceFacet.sol:1363-1368`). A test asserting that sequence
either never reaches demotion or bypasses production behaviour — so it could not
have provided the evidence it was cited for.

Instead: a **provisional-confirm fixture** asserting the promotion moves exactly
the fresh component, and a **provisional-demote fixture** asserting the demotion
branch **alone reverses exactly the original provisional credit**. The inverse
property is then proven against the credit each starts from, rather than by
composing two transitions the machine will not compose. Crediting the
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

  **And administrative role-transition retirement**, which is not an outflow at
  all and is the reason a reconstructed total can be too LOW. On a mirror that
  detached and reattached, the retained role-change writer may already have
  raised `paid` to `received` specifically to retire an otherwise reusable
  residual — with no payout or absorption behind it. A total reconstructed only
  from outflows therefore sits below that watermark, and SETTING the counter to
  it **republishes the residual the retirement existed to kill**.

  So the imported total includes the retirement watermark, **and the rebase never
  reduces the existing paid counter** — `paid = max(existing, reconciled)`. The
  belt-and-braces is deliberate: the watermark is the one input the
  reconciliation cannot derive from history, so a floor protects against getting
  it wrong in the only direction that matters.

**An ingress landing against a carried DEFICIT routes its
deficit-covering portion to an explicit restitution position — allocating
it as live backing strands it.** A new era can open with `paid − received`
positive; the next funding transfer increments `received` without creating
headroom until the deficit clears, so tokens allocated to the live ledger
for that portion back nothing, no claim can ever debit them, and the next
transition carries only `max(received − paid, 0)` — a holder allocation
with no ledger balance and no terminal path. The deficit-covering portion
of any ingress — **and of the two attribution-only credit writers, the
era-terminal transfer and the pending-to-live recovery, which absorb a
deficit exactly as a token ingress does** (a 20-token surplus drained
into a 20-unit deficit leaves zero headroom and 20 tokens the next
transition carries as zero residual — stranded with no terminal path) —
therefore lands in an explicit **restitution/recovery
position** (owner-disposable: repatriation, or a recorded release into
live backing once the deficit's cause is dispositioned), and only the
excess above the deficit is allocated as live era backing.

**And the release INTO live backing has a defined ledger leg, because
custody reattribution alone moves nothing a claim can see.** After a
20-deficit absorbs a 20-ingress, `received == paid` — reattributing the
tokens to the live row leaves headroom at zero; crediting `received`
again would be an unregistered fourth writer double-recording a receipt
already counted. The release SPLITS BY THE DEFICIT'S EVIDENCED CAUSE, which the recorded
disposition must name — because a `paid`-debit is only honest when the
payment never really happened. For an **evidenced ACCOUNTING error**
(a double-recorded payout, a counter written with no transfer behind
it), the release is a **registered corrective `paid`-debit**: owner-gated,
bounded by the evidenced overstatement, atomically moving the custody
restitution→live and reducing `paid` — the record of a payment that did
not occur is corrected, the three-writer `received` contract is
untouched, and `paid`'s writer set carries the entry with the
disposition id. For a **GENUINE deficit** — tokens that really left
beyond authenticated receipts, with **no other authenticated funding
ledger inheriting the debit** — **`paid` is retained**. That qualifier is
the boundary against the reclassification rule, which governs the OTHER
case: a spent entry whose split is corrected (6/4 → 4/6) moves its
historical debit to the recycled-consumed attribution atomically, and
`paid` reduces there WITH the debit — the payment still happened, its
record now lives on the side that actually funded it, and the result
matches a correct-at-ingress split. Retain-`paid` is for a debit that
transfers NOWHERE — money gone from the funding universe (an earlier revision debited it here, which
republishes spent allowance: `received = 80, paid = 100`, fund 20,
debit `paid` to 80, and cumulative payouts reach 120 against 100
authenticated receipts — and it contradicts the `paid = max(existing,
reconciled)` floor stated for exactly this reason). The restitution
custody then never becomes live backing by ledger surgery: it routes to
the harmed/recovery side (repatriation, or funding the harmed position),
and new headroom exists only when funding arrives through the ordinary
`received`-crediting writer, genuinely backed.

**And an imported POSITIVE `received − paid` is history, not money: usable
headroom is capped by the DEDICATED HOLDER'S balance, which starts at
ZERO.** The reconstruction proves what once arrived; it cannot prove the
backing still exists — unrelated shared-balance outflows may have spent it
years ago — and the new holder holds nothing until something funds it. An
imported ledger that authorizes claims against an empty holder either
reverts them or tempts the migration to seed the holder from ambient
custody, which is slice 0's labeling-is-not-proving mistake with a
contract address on it. So the mirror bootstrap follows the canonical
rule: **usable headroom = min(ledger headroom, the ledger's ALLOCATED
holder custody)** — allocated, not the holder's global balance, because
the holder backs several ledgers at once (live era, each retired era's
carried balance, the pending recovery position) and a global-min lets an
unfunded ledger spend a funded one's custody: era A imports a 100 gap and
retires, `fundRewardPool(100)` funds era B, and A reading
`min(100, holderTotal=100)` empties the holder that B's tokens filled.
The holder therefore keeps an internal attribution ledger — every credit
names the ledger it funds, every debit is capped by its consumer's
allocation — and "holder balance" anywhere in this design means the
consumer's allocated share. The
imported figures record history, and headroom becomes SPENDABLE only as
replacement or provenance-backed funding actually lands in the holder;
the gap between the two is an instance of slice 0's shortfall
disposition, decided by the owner, never papered over by a seed.

**And the funding half of that disposition needs a CUSTODY-ONLY writer,
because `fundRewardPool` cannot close an imported gap.** `fundRewardPool`
credits the holder AND `received` in one act — fund 100 against a
100-gap and ledger headroom reads 200 over a 100-token holder: the
shortfall is preserved, one claim later the holder is empty again. The
two executable forms of the disposition are therefore: (a) a
**delta-checked holder credit that does NOT touch `received`** — bounded
by the recorded gap and decrementing it, which keeps the writer contract
intact because it writes no ledger the three registered writers own
(custody in, no headroom published; the imported history it funds was
already recorded); or (b) an **atomic write-down of the imported ledger
figures** — history retained in the record, headroom reduced to what the
holder actually backs. Fund the history or shrink it; what is not
executable is a disposition that promises either while the only funding
writer inflates both sides at once.

So the retained administrative writers are a starting point rather than the
mechanism: `seedArmedFreshPaid` covers one side once, and a
migration-capable writer is needed for the other. That is the concrete reason
they are retained rather than collapsed, and the concrete reason retaining them
is not sufficient. §6 item 1 already anticipated this shape for Option B
and it applies here. It is more work than five `+=` lines — and the five
`+=` lines do not close the hole.

### Sequencing

Closure 3's RESOLVER is independent and small and can land early — but its
**canonical matrix cells cannot land before slice 4**, and an earlier revision
of this sequencing line said the whole closure could go "first and alone".
Landing the cells first switches every canonical reward consumer from `max` to
an uninitialized zero `received` and freezes them (§5c states this in full). So
the standalone early piece is the resolver plus the **`Detached`-only**
behaviour; the canonical column lands with slice 4 and its migration. Closure 2 is
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
