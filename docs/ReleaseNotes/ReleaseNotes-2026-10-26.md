# Release Notes — 2026-10-26

Today's work closes many of the security findings filed on 2026-10-24. Split liquidations carry a floor on every leg; discounted liquidations respect the internal-match window and sell only through governed venues; the oracle gates bind the tier box at read time and let overrides only tighten it; and every chain prices through its own Chainlink feed registry. Off chain, every alert settings change is signed and each signed request is used once, public endpoints do bounded work before expensive work, and failures are reported without the credentials they touched. Several upgrade-in-place shims were removed, since every chain gets a fresh deploy. Every off-chain table now has a decided restore treatment. None of the contract changes has reached the testnets yet.

## Thread — every off-chain table has a decided restore treatment (PR #2900)

The off-chain restore runbook used to leave a set of tables marked "decision needed", so a restore after losing the hosting account would have silently dropped some user records and left others half-restored. Every table the indexer, keeper and agent write now has one of three treatments, and a check in the indexer's typecheck holds the backup set, the runbook's import and clear lists, and the restore converter to it. Records users create off chain and that the chain cannot give back are archived and imported. Records the chain can rebuild are cleared before the replay from block zero, which now includes every keeper-private table, so a recovery in place behaves the same as a restore onto a fresh account. A new third class covers records that are partly both: signed offers and the two-step match breadcrumbs are now in the backup, and on restore the converter imports the user's part and resets the part the chain owns (an offer comes back open and unfilled, and the replay re-derives its fills and cancellations; it is restored only in the exact form the indexer itself stores, read from one shared rule both use, so a damaged archived order cannot break the order book, and the few signed offers still stored in the pre-#1949 shape, which could never be filled and were already hidden from every read, are deleted so every stored order is in the current shape; a breadcrumb the chain itself wrote is left for the replay to rebuild).

Replaying history also exposed that the indexer would post old prepay listings to OpenSea. Its publish rebuilt each order from the block the listing was posted in, so catching up on past blocks, or rebuilding after a restore, offered OpenSea orders the borrower had since cancelled, repriced or sold through. The publish now reads the loan's current listing first and offers only that one; this costs one more chain read per publish, and the listing sweep's budget per row is now eight requests. The pre-notify cursor table, unused since the pre-notify scan moved onto the shared cursor, is dropped, now that the agent serving the shared database no longer uses it (#2838).

The backup change takes effect when the backup Worker is next deployed, and archives taken before it hold neither of the two new tables, so a restore from one of those starts the signed-offer book empty, as the runbook states. Re-verifying each imported offer's signature before it is restored is tracked separately (#2899). Closes #1481 and #2838.

_Committed 2026-10-26 12:42 UTC (8951eebc6)._
<!-- assembled-fragment: 1481-restore-classification.md sha256=37e54086da77bb77c791c3ae11a7cdf9d8bbd9428010e60afaa6cc977031f7d7 -->

## Thread — a legal-hold action and its audit row are recorded together (PR #2894)

Each legal-hold action (place, lift, or changing whether disclosure is allowed) used to write its change to the hold register and its row in the append-only audit trail as separate steps. A lift that landed between a disclosure change's check for a hold and its update could leave an audit row recording a disclosure change for a wallet that had no hold. The archive restore reads that as tampering, and because the trail is append-only, every later nightly archive would have failed to reconcile until someone fixed it by hand.

The change and its audit row are now written in one database transaction. The trail can no longer record an action that did not apply or miss one that did. A disclosure change that finds no hold writes nothing and answers "no hold for this wallet", even when a lift lands while the request is in flight. The audit row's time, and the hold's own timestamps, now come from the database's clock at the moment of the write rather than from when the request arrived. A request that spent seconds uploading its legal document can therefore no longer be stamped ahead of an action that took effect before it. The tests run against real SQLite and check the result with the restore's own replay. Closes #1488.

_Committed 2026-10-26 10:54 UTC (67836c0a2)._
<!-- assembled-fragment: 1488-legal-hold-audit-atomic.md sha256=161a34bef55afe39aa5d388d2037398176460f3e4210b3dba94c3b16676d4d4c -->

## Thread — the marketing site ships only the translations it renders (PR #2904)

The marketing site's translation bundles carried 54 sections of text that belong to the connected app and that the site never shows. That was about 1,060 of its roughly 1,500 strings. English is loaded up front, so every visitor downloaded them on first paint: the English bundle drops from about 138 KB to 49 KB, and each translated language's bundle shrinks by a similar share. Nothing a visitor sees changes.

A new check in the site's typecheck keeps it that way. Every section in the English bundle must be named somewhere in the site's code. No translated bundle may carry a section English does not have. And the code may not reach translations through an implicit prefix the check cannot see. The change reaches the live site with its next deploy. Closes #1767.

_Committed 2026-10-26 13:36 UTC (1cae6f411)._
<!-- assembled-fragment: 1767-www-dead-translation-namespaces.md sha256=5d7ae4419657a839288cb636ab7c80bfd68ddec8d4236afb7890b7a8211f653f -->

## Thread — VPFI tier record refreshed at the balance, pushed once per action (PR #2862)

A user's VPFI fee-discount tier record on Base used to be refreshed by each
facet that moved their VPFI, one call site at a time. A path that nobody
wired left the record behind the balance: lending VPFI through an offer
(the escrow going into the vault on create and back out on cancel) and the
buyer's price pull when accepting a listed loan sale never refreshed it, so
the user was priced on a balance they no longer held, or not priced on one
they now did, until some unrelated movement. The refresh now sits where the
balance is written: the tracked vault counter's deposit and withdraw, and the
writes of the VPFI held back from a transferred position's holder. Every path
that changes a user's tracked VPFI refreshes their record there, including
any added later, and the twenty-odd per-facet stamps are gone. A movement
in the middle of an action is recorded as it happens, so the day's minimum
sees a balance that dipped and recovered within one action.

Refreshing the record and pushing the tier to the mirrors are now separate.
The record updates at once. While an action holds the Diamond's reentrancy
guard (or a 1inch fill holds the fill lock), the user is queued instead of
pushed, and when the action releases the guard each queued user's tier is
pushed once, carrying the tier they hold at the end. A settlement that moves
one user's VPFI five times commits one push, not five. The broadcast-free
"local" stamps are retired with it: a time-based default, a fallback custody
move and a reward credited to the vault now push like every other movement
(the health-factor liquidation already did), so no close-out leaves the
mirrors waiting for the user's next action. An unguarded entry point pushes
where it writes, as before. A Diamond whose tier push host is missing now
fails with a named error instead of being mistaken for one with no tier
accumulator.

This touches every facet that moves funds, so it reaches a chain only by a
fresh deploy or the all-facets in-place refresh; the curated refresh scripts
refuse a Diamond from before it. Closes #1820 and #2849.

_Committed 2026-10-26 04:27 UTC (82ac09188)._
<!-- assembled-fragment: 1820-tier-record-seam.md sha256=433ad880194a106c8e70ce6e224c35577c1bae14132be4f5f992b6ed8b592394 -->

## Thread — One reward broadcast wire (PR #2879)

Base now sends each finalized reward day to its mirrors on one wire only: the
per-destination broadcast that carries the day's frozen clock and the identity
of the Base deployment that finalized it (message kind 10). The two older forms
are retired and their message kinds are never reused: the flat broadcast
(kind 2) and the per-destination broadcast without a clock (kind 5). A packet
carrying either is refused as an unknown kind and applies nothing. The reward
messenger's wire generation moves from 7 to 8.

Everything that existed only to keep those older wires working is removed with
them: Base's fallback from the newer send to the older ones, the refusals that
went with it (a messenger too old for the newer wire, a day with no clock), the
mirror's clock backfill onto a day an older wire had applied, the repair flags
for days applied by older receivers, the era-rotation flag that switched the
older wires off, and the parked-message lane (with its retry and tombstone
calls) that held older-wire packets arriving after a rotation. Because the one
remaining wire names its deployment, a retired deployment's late or manually
re-executed broadcast is simply refused by name and stays a failed,
re-executable message. Base's late inclusion backfill is removed too, so
finalization is now the only writer of a day's inclusion. All three stated
leftovers of the per-day delivery gate (#1944) close with this: a day applied
only by the flat broadcast, a late inclusion backfill on a day the mirror had
stamped as excluded, and days before the gate's first day.

The gate also loses its arming step (owner decision 2026-10-26). It used to be
a one-shot switch an administrator set on each mirror, naming the first day it
held. It now applies on every mirror by its reward role, from the mirror's
first day, and never on the canonical chain or on a chain with no reward role.
There is nothing to arm and nothing that can leave a mirror ungated. The one
thing a mirror needs is the keeper's delivery-proof pass running there, which
proves each delivery's days so a delivered day is paid without a manual step;
without it, a funded day waits for someone to prove its delivery. The delivery
state readback now reports whether the gate binds on the chain rather than
whether it was armed.

The arming switch had one more job, which moves to the point where a broadcast
arrives. It stopped a chain from taking broadcasts and settling days while it
had no reward role, then becoming a mirror and holding those days again. A
broadcast is now applied only where the gate binds or where nothing can be
paid from it: a mirror, or a chain detached from rewards. A chain with no
reward role, or the canonical chain, refuses it by name, and the refusal stays
a failed, re-executable message.

Only a day whose funding arrived by a broadcast can be held. A chain that was
canonical and is later made a mirror funded its own days while canonical;
nothing was ever sent to it for them, so those days are never held, and a
broadcast that later arrives for one of them is refused by name instead of
overwriting the chain's own record of the day.

The retired storage fields are renamed in place and recorded in the storage
layout's rename list, so the layout stays append-only. Like the rest of this
build, it reaches a chain only by fresh deploy (owner decision O1 = A); no live
testnet is changed by this PR. The keeper now recognises only the one
broadcast-sent event and no longer treats the two retired refusals as a reason
to resend to every destination. Refs #1944.

_Committed 2026-10-26 13:59 UTC (1f88662e1)._
<!-- assembled-fragment: 1944-retire-legacy-broadcast.md sha256=98f07b8a4518bab6145f9dd60c43ace0979ebd18e46725c325f72c68e0adb038 -->

## Thread — A price read through two feeds keeps the finer feed's precision (PR #2905)

Part of the #2419 scale change. When no direct feed prices an asset in the
active numeraire, the protocol combines two feeds: the asset's price in ETH
with ETH's price in the numeraire, or, on the PAD route, the asset's price in
the PAD with the PAD-to-numeraire rate. The combined price is now reported at
the finer of the two feeds' precisions, with one rounding down at the end, so
it carries every digit both feeds supply. Every caller already reads a price
together with its decimals, so values, loan-to-value and health-factor figures
come out the same whatever precision the feeds use.

Converting an amount of one asset into another at the oracle, as a settlement
split, a forced sale's size and floor and a swap's expected output all do,
now goes through one rate for every path, including the swap-to-repay sizing,
which used to build its own. The rate cancels the scale the two sides share
and is applied at full width, so the conversion is exact at any feed
precision, including both loan assets priced through the ETH route at 18
decimals.

Funds: no transfer, fee or settlement rule changes. The change is to how a
composed price is expressed; valuations through it are exact to the finer
feed's precision.

Part of #2419.

_Committed 2026-10-26 15:06 UTC (882d8c772)._
<!-- assembled-fragment: 2419-composed-price-precision.md sha256=3685c48d16d7e113879b4ff249ea2a9865c93b6ac887fef2a36cef5a5a48f880 -->

## Keeper: split liquidations pick legs that each clear their own floor (#2724) (PR #2881)

Since #2871 the protocol holds every leg of a split liquidation to its own
share of the sale's floor, not only the two legs together: a leg that would
deliver less than the floor rate on what it sells now reverts the whole split.

The keeper's split picker used to take the two best quotes from different
aggregators and check only their sum. A pair whose total cleared but whose
weaker leg fell short would now be sent and refused, costing a transaction
before the keeper fell back to a full liquidation.

The picker now works out each leg's share of the floor from the split's own
sizing preview, rounded up as the protocol rounds it, and only considers pairs
where each leg's quote clears its share. Among those it takes the best combined
output, then applies the existing "is splitting worth it" check unchanged. When
no pair qualifies it goes straight to the single-route liquidation. The check
runs before sending and is not the final word: prices move between the quote and
the transaction, the protocol measures what each leg actually delivers, and a
refused split still falls back to the full liquidation as before.

_Committed 2026-10-26 06:08 UTC (a80719e3b)._
<!-- assembled-fragment: 2724-keeper-split-leg-floors.md sha256=7e6ac5a6fbed4e3bb257c280b4910ccd4887216a505cdcab742eb75ddcd66900 -->

## Thread — every split-liquidation leg carries its own floor (PR #2871)

A split liquidation sells a loan's collateral over two or more routes the
caller chooses, in one transaction. Until now only the combined output was
held to the oracle-derived floor; each leg ran with no floor of its own. The
caller writes each leg's route, so one leg could pay its output to an
address of the caller's choosing while an honest leg delivered enough to
cover the whole floor by itself. The diverted proceeds were never booked,
and the lender, the borrower and the treasury lost them.

Every leg is now floored at its own share of the floor: the floor scaled to
the collateral that leg sells, rounded up, and measured at the Diamond, the
same way a single-route sale is measured. A leg below its share reverts the
whole split, so no leg can deliver less than the floor rate on what it sells,
and a split pays the loan at least what one route at the floor would have.
The combined floor is still checked. This is in the one shared split routine,
so it covers every caller of it. It means a keeper that splits a sale must
pick legs that each clear the floor rate, not just legs that clear it
together.

Closes #2724.

_Committed 2026-10-26 06:25 UTC (752abd3e7)._
<!-- assembled-fragment: 2724-split-leg-floors.md sha256=4e248c66ed6b4bee854f44021935b81ff7510cab5337140444adb38b83ee7176 -->

## Thread — One offer-shape rule for create and edit; backstop opt-in cleared by edits (PR #2883)

Offer creation and offer editing each carried their own copy of the rules for a
well-formed offer, and the edit copy had fallen behind. It never checked the
fill mode, so an all-or-nothing offer could be edited from, say, 1,000 / 1,000
into a range of 1 / 1,000. A match for one unit then passed the all-or-nothing
check, and the rest of the lender's vaulted principal was stuck until they
cancelled. Both surfaces now check through one shared definition, so an edit
can never produce an offer that creation would have refused (#2749).

That shared definition also closes a zero-collateral gap (#2729). An ERC-20
loan against ERC-20 collateral could be posted with no collateral at all,
because the exception meant for the protocol's lender-sale vehicle was keyed
on the offer's shape (both collateral fields zero) rather than on who was
creating it. Against illiquid collateral, which is valued at zero and admitted
on mutual consent, nothing else refused such an offer, so a lender could fund a
loan backed by nothing. Only the sale vehicle may now carry zero collateral,
and no edit can strip collateral from an offer.

An offer opted into the treasury backstop is now withdrawn from it by any edit
to its amount, rate or collateral (#2737, first half). Before, a borrower could
opt in a small offer, wait out the mandatory delay, edit it to the terms they
wanted and have the backstop fund those terms in the same block, so the funded
terms had never sat in the market. The edit now emits the same eligibility
event with a zero deadline, and the borrower opts in again and waits the delay
out on the new terms. The second half of #2737, the oracle-coverage count, is
handled with the other oracle fixes.

The offer-shape errors moved from the create facet into the shared library
under the same names, so every revert keeps its selector. Fresh deploy only, as
for the rest of this pre-live work.

Closes #2729, closes #2749. Part of #2737.

_Committed 2026-10-26 06:44 UTC (a9adbd72b)._
<!-- assembled-fragment: 2729-2749-2737-offer-shape.md sha256=c8352ba7b275fa7b8c9f062e5ed3443aeb9305d678c175583b54840384fcb3b1 -->

## Thread — every interest payment counts toward the current period, and a periodic settlement can always run (PR #2885)

On a loan with a periodic-interest schedule, the borrower owes each period's
interest by a deadline, and a settlement sells collateral for any part left
unpaid after the grace window.

**Interest a partial liquidation pays now counts toward the period.** A
partial repayment and a partial swap-to-repay already credited the interest
they paid to the current period. A partial liquidation paid interest to the
lender too, but did not credit it, so the next settlement could read the
period as unpaid and sell the borrower's collateral for interest the lender
already had. All three now go through one shared rule, so a new path that
pays interest mid-period cannot leave the credit out.

Two related corrections to the partial liquidation. Interest the borrower had
already paid ahead of the accrual, through an earlier settlement, is now
carried forward against the restarted interest clock instead of being
discarded. And a slice must now pay the interest accrued since the clock last
started in full: the clock restarts at a partial, so interest a short slice
left unpaid would have been written off at the lender's expense. Such a slice
is refused by name, and the keeper sells a larger one or liquidates in full.

**A pending swap-to-repay auction no longer blocks a periodic settlement.**
Before a forced close-out sells collateral it cancels any swap-to-repay
auction the borrower has open. The periodic settlement used the
health-factor check for that cancel, which refuses while the loan is
healthy, so a healthy borrower who missed a periodic payment could keep an
auction open and the settlement would always fail. The cancel now takes the
trigger the close-out acts on and checks that trigger itself: the health
factor for a liquidation, the grace end for a time-based default, and the
unpaid period for a periodic settlement. A close-out whose own trigger does
not hold still leaves the auction its window.

Closes #2731. Closes #2732.

_Committed 2026-10-26 09:18 UTC (7155604c2)._
<!-- assembled-fragment: 2731-2732-periodic-interest-paths.md sha256=15a265f855f334bd9f185777108a3f91adccd1f03564eb913b157cf778a3cd19 -->

## Keeper: a partial liquidation refused for not covering interest is resized, not dropped (#2731, #2886) (PR #2889)

A partial liquidation now has to pay at least the interest the loan has
accrued since its interest clock last started. A slice that falls short is
refused by name, because the clock restarts at a partial and the shortfall
would otherwise be written off at the lender's expense.

The keeper treats that refusal like its other "slice too small" answers. The
refusal states what the slice repaid and how much interest is due, so the
keeper sizes the next slice straight to cover it, at the rate the refused slice
paid, still inside the band the other refusals leave it. If that is still
short, the protocol refuses again and the keeper keeps growing the slice. Only
when no partial size can both cover the interest and stay under the
over-liquidation ceiling and the close-factor cap does it move on to the split
or full liquidation. Before this, the keeper did not recognise the refusal, so
it skipped the loan and recomputed the same slice on the next run.

_Committed 2026-10-26 09:23 UTC (5b4469f77)._
<!-- assembled-fragment: 2731-keeper-partial-covers-interest.md sha256=6e307253dd033840d55ffbe1c42260d8574af1649b12cb04bd208e6366a88969 -->

## Thread — Discounted liquidation respects the internal-match window and sells only through governed venues (PR #2898)

The liquidator-buys-at-discount route now waits for an internal match the
same way the other external liquidation routes do. While the internal-match
switch is on and a loan's loan-to-value sits inside the priority band just
above its liquidation threshold, the full, partial and split liquidations
already declined to sell collateral outside the protocol; the discount route
did not check at all. All four routes now ask one shared rule, so they cannot
disagree on where the band starts or ends, and the discount route's preview
reports "inside the internal-match window" as its reason, so a keeper never
plans a run the platform would refuse. The preview's new reason is added
after the existing ones, so the existing reason numbers do not change.

The flash-loan liquidator contract the keeper uses for that route no longer
approves or calls whatever addresses an off-chain quote names. It sells the
seized collateral through one of the swap adapters the platform itself has
registered and not disabled, the same governed venues the platform's own
liquidations sell through. It approves only that adapter, for exactly the
amount sold, and clears the approval afterwards. The adapter applies its own
rule to the quote (for an aggregator, a fixed approval recipient and an
allow-listed call target), so a bad or hostile quote can no longer take the
contract's tokens. The adapter is asked for at least the flash loan, its fee
and the run's least profit, and the contract still checks its own balance
after the run. The completion event now reports the collateral the adapter
actually took, since an adapter returns any part it did not sell.

Funds: the lender was always paid by the platform first, so the exposure this
closes was the keeper's own profit and standing balance, never a borrower's
or lender's funds. The discount route is off on every chain today and the
flash-loan liquidator is not deployed anywhere, so nothing live changes. The
liquidator's entry points now take an adapter and that adapter's quote bytes
instead of a call target, an allowance target and calldata, so the keeper's
caller changes with it before the route is ever switched on; that keeper
change, and the keeper's sizing fix, are tracked under #2697.

Part of #2734 (its two contract items; the third is the keeper's #2697).

_Committed 2026-10-26 12:48 UTC (15192564a)._
<!-- assembled-fragment: 2734-discount-path-window-and-adapters.md sha256=6062525aa6a8e6149ce6747619d91d3c914a44b96593f79687a36bc526db7718 -->

## #2734 — the keeper's flash-loan liquidations sell through the Diamond's own swap adapters (PR #2896)

The flash-loan liquidator now sells the collateral it seizes only through a
swap adapter the Diamond has registered and not disabled (the contract half of
#2734). The keeper's flash-loan branch is changed to match.

- **One quote path.** The keeper used to keep a second quote service just for
  this branch, which asked 0x and 1inch for calldata the liquidator would call
  itself. That service is gone. The branch now asks the same route builder
  every other forced close uses, each aggregator quoted with its adapter as
  the taker, and hands the liquidator the chosen adapter and its quote.
- **The testnet mock is checked for the right caller.** Where a chain's mock
  adapter only pays one caller, the route builder now checks it would pay the
  liquidator, which is the contract that sells through it on this branch.
- **The internal-match window is a "not yet".** When the Diamond's preview
  says the loan is inside the internal-match priority window, the keeper logs
  that reason and leaves the loan to its normal liquidation branch, which is
  the one that dispatches the match.

Nothing is armed by this change: the branch still runs only on chains named in
`DISCOUNT_PATH_CHAIN_IDS`, which ships empty, and only where a liquidator is
deployed.

_Committed 2026-10-26 13:22 UTC (677b4cbd2)._
<!-- assembled-fragment: 2734-keeper-flash-loan-adapter-sale.md sha256=f9f01b7905dab942e89023c0beaa29cff6b9af88bc7835d0ceb387f92ea4050e -->

## Thread — Oracle gates: tier box binds at read, overrides only tighten, backstop counts agreement only (PR #2887)

The peer-derived tier LTV cache now has to sit inside its tier's current
safety box to be used (#2736). The refresh already rejected a reading outside
the box, but governance can move the box afterwards, and a still-fresh entry
above a tightened ceiling kept admitting new loans at the old figure for up to
14 days. The box is now re-checked where loan initiation reads the cache, and
an entry outside it is treated like a stale one: the governance tier cap
applies until a refresh lands inside the new box. It is never clipped into
range, matching the refresh's own rule. The comment in loan initiation that
called the governance tier caps dead was also wrong and is corrected: they
decide the cap whenever the cache is not trusted.

A per-feed oracle override can no longer loosen a feed (#2742). SECURITY.md
always said overrides only make a feed stricter, but the price read let an
override replace the two-tier staleness defaults outright, skipping the
stable-peg check too, so a 6-hour override let a 4-hour-old volatile price
through. Meanwhile the liquidity check ignored overrides entirely. Both reads
now share one freshness rule: the defaults always apply and an override only
adds a shorter budget and an answer floor on top. The setter refuses a budget
above the 25-hour outer default, since it could never bind. Slow-heartbeat
fiat and commodity feeds lose nothing, because the stable branch already
accepts a 25-hour-old answer that sits at its registered reference.

The treasury backstop's oracle-coverage gate now counts only secondary feeds
that agree with Chainlink, and refuses outright if any live secondary
disagrees (#2737, second half). Before, a minimum coverage of 2 passed with one
secondary agreeing and one disagreeing, so the evidence that a price was wrong
counted toward trusting it. The coverage view keeps its name and selector and
now reports agreeing and disagreeing feeds separately. The general price read
is unchanged; this is the backstop's own, stricter bar. Fresh deploy only, as
for the rest of this pre-live work.

Closes #2736, closes #2742. Completes #2737 together with the offer-shape PR.

_Committed 2026-10-26 07:51 UTC (72cbf21cf)._
<!-- assembled-fragment: 2736-2742-2737-oracle-gates.md sha256=9db5f92a8725bbde1b5549bd90f1a87290ff94e2592e242905662de9519f64df -->

## Thread — An in-place extension happens only near maturity and never shortens grace

An in-place loan extension re-terms a loan: it settles the interest so far,
restarts the loan's clock and moves its rate within both parties' limits. The
contract accepted one as soon as a day had passed since the loan started, so
the keeper could re-term a loan with both parties' limits set as early as day
two (#2738). It also checked only that the new end was later than the old
one, so a short new term that earns a smaller grace period could make the loan
defaultable sooner than before, taking grace time from the borrower.

The contract now states both rules once. An extension is accepted only inside
the loan's extension window, which opens three days before its effective
maturity (never within its first day) and closes at its grace end; a pause
moves the window with the loan's other deadlines. And an extension must leave
the loan defaultable no sooner than it is now: the new end plus the grace the
new term earns must not fall before the current grace end. The window binds
every caller, not just the keeper, and a new read gives each active loan's
window so the keeper reads it instead of computing its own. Fresh deploy only,
as for the rest of this pre-live work.

Closes #2738.

_Committed 2026-10-26 21:26 UTC (c81585268)._
<!-- assembled-fragment: 2738-auto-extend-window.md sha256=0e2e85d8fa3ac6b2e617c7678c5ce9f6de9bd900350ca805d10f686f7037faf8 -->

## Keeper: auto-extend only near maturity, and never shortens the grace deadline (#2738, keeper half) (PR #2895)

The keeper's auto-extend pass used to re-term any loan whose borrower and lender had both switched auto-extend on, as early as a day after it started. Each extension settles the interest so far, restarts the loan's clock and moves its rate to the lender's floor, so a loan could be re-termed long before anyone needed it extended.

The keeper now extends a loan only inside a window that opens three days before its effective due date and closes at the end of its grace period. The due date is read on the loan clock, so a protocol pause that moved it later moves the window too. The keeper also refuses a new term that would make the loan defaultable sooner. A shorter term can carry a shorter grace period, so a new due date that is later than the old one is not enough: the new due date plus its grace must not come before the old due date plus the old grace.

When the keeper cannot read the pause record or the grace schedule, it extends nothing on that chain for the run, rather than judging against a date the chain may not hold the loan to.

The contract does not check either rule yet. The contract half of #2738 will enforce the same window and the same grace rule on-chain, and publish the window, which the keeper will then read instead of holding its own copy.

_Committed 2026-10-26 11:05 UTC (7dccdc3d0)._
<!-- assembled-fragment: 2738-keeper-extend-window.md sha256=7681ccc049fd36dfc0e732da4bde4af0630e099ee0edfd5cdc73e9b85689fd92 -->

## Keeper reads the auto-extend window from the contract (#2738, #2921)

The contract now states each loan's auto-extend window itself and refuses an
extension outside it, or one whose new term would make the loan defaultable
sooner. The keeper's auto-extend pass now asks the contract for that window
instead of working it out on its own, and leaves the term rules to the
contract, which refuses a bad term before anything is sent.

The live testnet Diamonds were deployed before that contract change, so they
neither state the window nor enforce it. On those chains the keeper keeps
applying its own copy of the same rules, so a loan there is still only
extended close to its due date. The keeper checks which kind of Diamond it is
talking to once per chain per run. Its own copy is removed at the all-waves
fresh deploy (#2921).

_Committed 2026-10-26 22:21 UTC (7b251a0f7)._
<!-- assembled-fragment: 2738-keeper-reads-extend-window.md sha256=3cbc848d9e5571032ec9b48ab155203e4fd1c97b45f1b04df5d6c0d3774bd60f -->

## Thread — Terminal reward closes can no longer be skipped (PR #2924)

Every way a loan ends closes its interaction-reward entries, and that close
decides whether the borrower keeps the reward or forfeits it. Five facets ran
their reward calls through a private best-effort hook that ignored any
failure: direct preclose and offset completion, the periodic-interest
settlement, both prepay-sale finalisations, the claim-time default of a
fallback-pending loan, and the three internal-match liquidation legs. The
reward-window split at an obligation transfer (not a terminal, but the same
hook) went through it too. A caller
could arrange for the close to run out of gas (the 63/64 rule), let the hook
swallow it, and finish a late preclose with the borrower's reward entry still
open. An open entry on a repaid loan reads as claimable, so the reward the
close should have forfeited stayed payable.

The hooks are gone. Each of those calls now goes through the same bubbling
cross-facet call every other terminal path already used, so a failed reward
close reverts the whole transaction, carrying the close's own revert reason
(or `RewardHookCallFailed` when it gave none). A loan can no longer reach a
closed status with its reward entries open. The early-withdrawal facets
already bubbled and are unchanged. The cost is a few bytes per facet;
PrecloseFacet keeps 533 bytes of EIP-170 headroom.

Closes #2739.

_Committed 2026-10-26 23:27 UTC (df3dc47fe)._
<!-- assembled-fragment: 2739-reward-close-bubbles.md sha256=433a8b36bbf40ede0807e2f6f301af3ec512f4451d72907fe42bba9c68aa424a -->

## Thread — A collateral sale settles as a repayment does (PR #2891)

A loan closed by selling its collateral (a prepay or parallel marketplace
listing, or a swap-to-repay intent fill) now owes exactly what a full
repayment at the same moment would owe, and splits it the same way. The
lender receives principal plus interest net of the treasury's cut, and the
treasury receives its cut of that interest. Before this change the sale legs
paid the lender its whole interest and charged the treasury's cut on top, out
of the borrower's remainder, so selling cost the borrower more than repaying.
Every listing floor, fill-time check and payout now reads one split, the one
repayment settles with, so a floor and the payout it protects cannot disagree.

A sale that lands after the due date but inside grace is a late repayment and
now owes the late fee, which the treasury takes its usual cut of. Before, a
borrower could sell inside grace and skip it. A listing whose legs are fixed
for a later moment (a Dutch listing fixes them at the auction's end) prices
interest and the late fee at that moment. A borrow-or-sell listing posted
before a lender accepts hedges the most the debt can reach before the grace
boundary: worst-case interest over the term and grace, plus the late fee at
the boundary. It no longer adds a treasury charge on top. The swap-to-repay
intent fill also stops checking the same floor twice, since its payout refuses
any delivery below that floor.

Two consequences are stated rather than implied. The lender now bears the
yield fee on the two marketplace sale routes, as on a repayment, so the
lender's yield-fee discount should apply there and does not yet: the
loan-keyed listing pays its treasury leg to the treasury inside the
marketplace fill, before the platform can shift any of it. That is dark until
a lender has discount consent or a Full stamp, and it is now a named item on
the fee-entitlement cut-over blocker (#2876). And fixed-price listings signed
before maturity go stale at maturity because the late fee starts then; the
borrower re-signs with the live amounts, as they already must when a day's
interest accrues.

Closes #2740.

_Committed 2026-10-26 10:19 UTC (1791b598f)._
<!-- assembled-fragment: 2740-collateral-sale-shared-split.md sha256=9ed64b1086c3015d169fa1f9bb618b31c40648972b49c935b28dd22972669078 -->

## Thread — Rent is counted in whole days, with a one-day minimum (PR #2893)

A rental that is closed early now pays for every day it has started, not
only for the days that have fully passed. Before this change the rent
owed on a pay-for-time-used rental, and the catch-up rent settled when a
rental obligation is handed to a new borrower, counted only completed
days. A renter who returned an NFT inside its first day paid no rent at
all, and one who returned it a few hours into a later day paid nothing
for those hours.

The rule is now the same on every rental close. Time since the rental
began rounds up to whole days, at least one day is always charged, the
count never goes past the agreed term, and days already paid through the
daily deduction are never charged again. A rental closed exactly on a day
boundary is not charged an extra unused day. The rent comes out of the
prepayment the renter already funded, so the lender receives it and the
renter's refund shrinks by the same amount; nothing else moves.

The rule is stated in the functional specification, and the offer form
now shows it under the pay-for-time-used option whenever the offer is a
rental, in every supported language.

Closes #2741.

_Committed 2026-10-26 11:03 UTC (c87f735d3)._
<!-- assembled-fragment: 2741-rental-whole-days.md sha256=89f3cca9b853fc207fb098fe786672ad6988d4a08ffc7fa5ad9b7a558864e664 -->

## Thread — WETH always has a liquidity-tier quote route (PR #2890)

The liquidity-tier search never quotes an asset against itself, so WETH can
only be tiered through a quote asset other than WETH. A fresh Diamond's quote
list is unset and stands for WETH alone, and no deploy step set it outside
Anvil, so WETH resolved to tier 0 whatever its market depth (#2747). That
matters even with depth-tiered LTV off: the tier sets every liquid loan's
liquidation threshold for its whole life and decides the discounted
liquidation's discount, which refuses tier 0. With depth-tiered LTV on, every
new WETH-collateral loan would have been refused.

The quote list now has one rule: once set, it always names an asset besides
WETH. Governance cannot set a list without one (an empty list included), cannot
re-point WETH at the list's only other quote, and cannot switch depth-tiered
LTV on while the list is still unset. The launch step gains a seventh
readiness requirement that refuses a chain whose list names no quote besides
WETH that the Diamond can price at that moment, so no chain opens with WETH at
tier 0. The tier search skips a quote it cannot price before it looks at any
pool, so the requirement asks the Diamond that same question through a new
read, rather than keeping its own copy of the rule: a listed stablecoin with a
peg reference but no asset price feed is not a route. The configure step writes the
list: the testnet mock rig's stable stand-in where the rig is recorded, and
the chain's canonical stablecoin from a new per-chain setting elsewhere.
Whether that quote's pools are deep enough for a higher tier is still measured
per loan and is not a launch requirement. Fresh deploy only, as for the rest
of this pre-live work.

Closes #2747.

_Committed 2026-10-26 11:22 UTC (6e05372cc)._
<!-- assembled-fragment: 2747-weth-tier-quote-route.md sha256=e5c18ecd7cb3b2c5ed436b0a4b0a056fcd0f7d231c595b6b4543434af9d5b3fa -->

## Alerts — every settings change signed, every signed request used once (PR #2859)

Saving alert settings used to need no proof of ownership. The alert service took the wallet named in the request at its word for everything except switching the due-date reminder off, so any caller that skipped the browser could rewrite another wallet's risk thresholds or switch on its Push alerts. Now every save carries the wallet's signature over a plain message that names what the save changes: the three risk levels, the payment-reminder choice and a Push opt-in, each given its new value or marked unchanged. The service rebuilds that message from the request it received, so a signature covers that save and nothing else. Signing is free and is not a transaction. The old message that covered only the reminder switch is retired; the app now signs on every save, which means one wallet prompt per save.

A signature also used to be reusable for as long as its timestamp stayed fresh (about ten minutes), so a captured link request could mint link codes again and again. The service now records each signed request it accepts, by a fingerprint of the exact message, and refuses a second presentation; the app tells the user to sign again. The record keeps no wallet, chain or settings, and each entry is dropped once its request has aged out. Where the record's table is not yet in place the request is refused with a "try again shortly", never accepted unrecorded. The four signed alert actions now also share a per-caller limit of twenty requests a minute, checked before any signature work. A save for a network the service does not watch is refused, and a Push value other than the opt-in is a bad request.

Telegram linking is harder to hijack. The link code was a six-digit random number, which a caller could guess against a webhook that anyone could post to, attaching the victim wallet's alerts to their own chat. The code is now 24 characters from an unambiguous alphabet, drawn from a cryptographic generator (120 bits), and the bot's webhook refuses any update that does not carry the secret Telegram returns when the webhook is registered with one. That secret is derived from the bot token, so there is nothing new to store; a new script registers the webhook with it and keeps the token out of shell history.

Rollout, in order: the shared database gains one table (migration 0076), which the indexer's deploy applies before the agent ships. Once the agent ships, an app bundle from before this change can no longer save alert settings (its saves are unsigned) until the app is deployed with it, and the bot is silent until an operator re-registers the webhook with the script. Both steps are stated in the PR. Closes #2754 and #2753.

_Committed 2026-10-26 02:49 UTC (ed68f0af1)._
<!-- assembled-fragment: 2754-2753-signed-alert-writes.md sha256=d7b4ef61fa834a6900f32faa57c215872a0a96626b36f2c8816490681e8af7a7 -->

## Agent — key-spending routes answer only the platform, and one limiter rule (PR #2868)

The agent Worker spends operator-held API keys on several routes: the 1inch quote and Fusion order post, and the OpenSea collection, offers, signed-offer and listing proxies. Each route used to carry its own copy of the rate-limit check, and the copies disagreed: some let a request through when the limiter binding was missing, some when it failed, and a few of these routes sat in front of the Origin gate, so any script could spend the keys. Now every key-spending route is answered only after the same Origin gate the rest of the agent uses, and one rate-limit rule applies everywhere: a request proceeds only when the limiter exists and said yes. A missing limiter and a failing one each refuse with their own name, so the answer says which it was, and neither is confused with a venue the deployment holds no key for.

Two kinds of budget now use that rule. Each caller has a per-address budget, taken once at the router before the route does any work. Each API key has its own budget, shared by every route that uses it and charged once per upstream call, immediately before the call is made, so a request is charged for what it actually spends. The OpenSea offers walk, which can make several upstream calls, now stops when the key's budget runs out or its limiter cannot count, marks its answer as truncated and names which it was, rather than reserving its worst case up front or overrunning. The 1inch caller budget is lowered to twenty per minute. The limits are stated for what they are: Cloudflare counts each budget per location and catches up eventually, so a key's budget bounds what callers reaching one location can spend, not an exact network-wide meter.

The OpenSea listing proxy now publishes only a live Vaipakam listing: the chain must name a collateral-listing executor, the order's zone must be that executor, the protocol address must be the Seaport it is bound to, and Seaport's own hash of the submitted order must be one the executor reports live. The hash is computed from the parsed order, never taken from the caller, only the parsed fields are forwarded, and an order the agent could not check is refused rather than published. The unused 0x quote route is removed along with the agent's 0x key binding; the app never asks the agent for a 0x quote (the keeper keeps its own 0x key). The older website spec line that names a 0x proxy route on the agent is superseded by the connected-app spec and is left for a recorded decision. Closes #2755.

_Committed 2026-10-26 04:50 UTC (bde5cb2d3)._
<!-- assembled-fragment: 2755-agent-key-spending-routes.md sha256=bd4203128532b76c97fc3f3e4831edd3efd119812fe3ccd37910950982bcfabe -->

## Thread — public endpoints do bounded work before expensive work (PR #2877)

Every request body the agent and the indexer accept is now read only up to a size stated for its route, through one shared reader. A body declared or streamed past that size is refused as too large before the service holds the rest of it, and a body that is not valid JSON is refused under one shared name on every route. Until now each handler buffered whatever arrived before looking at it, so a single large post cost the Worker its memory and CPU whatever the route would later decide.

The indexer's signed-offer limiter now follows the same fail-closed rule the agent adopted in #2755: a limiter that is missing from a deployment, or fails when asked, refuses the post rather than letting it through unmetered. That rule now lives in the shared package and is pinned, for every Worker in the tree, by one test that refuses any source file that calls a limiter binding, names a limiter failure, or reads a request body itself. The indexer's OpenSea match-source route is the one exemption, because the deletion already planned in #2757 removes it; the exemption fails as stale once the route is gone.

The live update channel that tells the app when chain data changed is bounded for the first time. It admits only the app's own origins, takes a per-IP slot from a new limiter before reaching the chain's ingest object, and that object caps how many sockets it holds for the chain (1,000) and for one client IP (8). A refused subscribe leaves the app on its ordinary polling, so a full channel delays an update and never hides one. The trade-off is stated: many users behind one shared address (a carrier or office NAT) can exhaust the per-IP allowance together, and those users poll instead of receiving pushes. The 1inch order-book post also now gives its two zero-cost answers (a chain 1inch does not serve, a key the operator has not set) before its on-chain preflight, so neither spends an RPC call.

Operators: the indexer gains a `WS_SUBSCRIBE_RATELIMIT` binding and a `FRONTEND_ORIGIN` variable, both declared in its configuration, and the origin list must match the agent's. Closes #2756.

_Committed 2026-10-26 05:55 UTC (2b3c45586)._
<!-- assembled-fragment: 2756-bound-public-endpoint-work.md sha256=586416baa0c81047227ff902b5cf52c609242d1caf21264d5ce9913e689951f6 -->

## Thread — Indexer data integrity (PR #2913)

The indexer no longer invents a block time. When it could not read a block's time it used to stamp its own clock in its place, and the loan record then stored that guess as the loan's start and last-settled time, on a row nothing later corrected. Now a block whose time cannot be read is not processed at all: the scan stops just before it, keeps its reading position there, and reports an RPC error so it retries shortly, and the next pass that can read the block processes it with the chain's real time. Every handler that stores a time about an event now takes it from the chain; a block handed in without its time is refused rather than dated by the clock.

The unauthenticated `POST /loans/:id/prepay-listing/match-source` endpoint is retired, with its rate-limit binding. It recorded which OpenSea offer a listing match came from, but no client still sends it, it checked neither that the transaction existed nor that it belonged to the loan, and anyone could overwrite what it stored. The match record now comes only from the on-chain match event. Because nothing in that record is created off chain any more, the nightly off-chain backup no longer archives it and a restore no longer imports it: the recovery replay rebuilds every match record from its event, like the rest of the chain-derived tables. Signed offers remain the one table a restore imports in part and leaves in part to the replay.

`/offers/by-current-holder` now returns only a wallet's open offers, the same set as the contract's own view of a holder's offer positions. It used to return every status, including an accepted offer whose position token now belongs to a loan, and left each caller to filter. Closes #2757.

_Committed 2026-10-26 18:47 UTC (99d358cc3)._
<!-- assembled-fragment: 2757-indexer-data-integrity.md sha256=699cc5605d8030f522a90837e28946361f7f8163b15faf36dbf86c6b64fde50f -->

## Diagnostics — a legal hold now outlasts the retention prune (PR #2861)

Server-side diagnostics records under a legal hold were deleted anyway once they passed the 90-day retention age. Only the user's signed erasure honoured holds; the scheduled prune checked nothing but the record's age. A hold that a scheduled job can delete is not a hold. Both delete paths now go through one condition, a record is deletable only if no hold names its wallet, written into the delete itself, so the hold is read in the same statement that deletes and a hold placed a moment earlier is still honoured. The erasure path's separate hold lookup is gone for the same reason; its uniform response is unchanged.

The Privacy page now states the retention period with its exception: records are pruned after 90 days unless the law requires one to be kept, and then neither the prune nor an erasure request removes it until that requirement ends. The support runbook no longer tells support that a matching diagnostics record proves a report came from a real session. It does not: any caller can submit a record under an identifier it picks, so a record is context for a report, never evidence of who sent it. Closes #2758.

_Committed 2026-10-26 02:55 UTC (2c0e03e5f)._
<!-- assembled-fragment: 2758-legal-hold-retention.md sha256=404a3a5d250fe36e01a5eb4a9cb5f1722261c360ca7d6e91f1c0bb9b263f71d7 -->

## Thread — failures are reported without the credentials they touched (PR #2882)

The agent and the indexer wrote raw errors into their logs in more than eighty places, and the chain library they use puts the full provider address, API key included, in its error messages. Anyone who could read a Worker's log could read the key. Shortening the message did not help, because the address sits near its start.

There is now one redaction rule in the shared package, used by every error formatter: it removes every web address whole, any provider host name with a label in front of the provider's domain (a lookup failure names the host alone, and some providers put the key in that label), and any key-, token- or password-shaped value through its closing quote, while keeping hashes, identifiers, database messages and stack positions. A new formatter keeps what an operator needs (the error's kind, its message, its chain of causes and the first stack frames) with those values removed, and the agent, the indexer and the shared Push rail now log through it. The same applies to error text that left a service by other routes: the OpenSea publish result, the Telegram send failure and the Push send failure.

The rule is enforced by a check that reads the code's syntax tree rather than its text. It refuses any place a caught error is turned into text other than through the formatters, whether that text was headed for a log, a response, an alert or a stored row, and it walks every server-side package in the workspace. Three areas are listed as pending and must be cleared by their owners: the keeper (this issue's keeper half), one indexer route file whose rewrite is already in flight (#2757), and the two recycling and reward route files, which echo database error text in a response. Each pending entry fails the check once its sites are gone, so the list cannot outlive the work. The two operator Workers under ops/ sit outside the workspace and are not covered; neither holds a provider address in the paths that failed this way. Refs #2759.

_Committed 2026-10-26 06:42 UTC (b72bc4412)._
<!-- assembled-fragment: 2759-failures-reported-without-credentials.md sha256=ffd1ffdf1ba8e7bb6105d15acffa3953a526aebc5f0dc21aad20ec0b5bf5637e -->

## Keeper: caught errors become text only through the shared redacting formatter (#2759) (PR #2888)

The keeper used to turn caught errors into log lines, alert text and stored
reasons with the raw error text. viem puts the full RPC URL, API key
included, into its error messages, so those lines could carry a provider key
into logs that more people can read than the secret store.

Every one of the keeper's 70 such places now goes through the shared
formatter the agent, indexer and Push rail already use. A log line keeps the
message, the cause chain and the first stack frames; text stored in a field
keeps the message and the cause chain. Either way every URL and credential is
removed and the length is bounded. The keeper's own decisions that read an
error's text (a refusal name such as `PartialLeavesDust` or
`KeeperAccessRequired`) read the same redacted text, which keeps revert names
and selectors intact.

The repository check that refuses raw error text in server-side code now covers
the keeper as well, so a new site fails CI instead of reaching a log.

_Committed 2026-10-26 08:03 UTC (bda1d61e4)._
<!-- assembled-fragment: 2759-keeper-redacted-errors.md sha256=1de53ba61a885260bc4019daf8b03ffd81940e423d40e2ee661904933325550e -->

## Indexer — the recycling and reward routes stop echoing error text

When the recycling series or the reward loop-closure query failed, the
indexer's public answer carried the raw error text alongside the failure. That
text can hold an RPC address with its key. Both answers now say only that the
query failed; the cause goes to the indexer's own log, with addresses, keys and
tokens removed by the shared formatter. The recycling backing read's warning is
redacted the same way. The shared redaction check no longer lists these two
files as pending, so it now covers them; the one file it still exempts is
waiting on #2757. Refs #2759.

_Committed 2026-10-26 14:32 UTC (cfb16527a)._
<!-- assembled-fragment: 2759-recycle-reward-route-redaction.md sha256=339a5510cf909a93c584814fdea3beb1371cf2018001e80eb0b07e2943142bdc -->

## Pre-grace warning: no offer in the book silences it any more (#2761) (PR #2884)

The keeper warns a borrower who has auto-refinance turned on when their loan
is within a day of its due date and has not been refinanced. It used to skip
that warning whenever any lender offer in the book matched the loan's asset
pair and could cover its principal. That check ignored the offer's expiry,
duration, remaining capacity, rate and collateral terms, so an offer that would
never fill still silenced the warning, and anyone could post such an offer to
switch a borrower's warning off.

The keeper no longer reads the offer book for this pass. Every opted-in loan
inside the warning window gets the warning, throttled as before. A borrower
whose loan is about to be refinanced anyway may get a warning they did not
need; that costs them little, while a warning missed can cost them their
collateral. The pass also makes fewer reads per run.

_Committed 2026-10-26 07:35 UTC (b891581d1)._
<!-- assembled-fragment: 2761-pregrace-warning-not-suppressed.md sha256=9782e95a2731ddf1948ef05cc6b6246ef029deff4681b921f6e823c323e91b53 -->

## Thread — CI workflow hardening (PR #2878)

Five CI workflow fixes from the 2026-10-24 security scan. The release workflow passes the dispatched tag to its shell as an environment value instead of pasting it into the script text. The Claude workflow now starts only for a comment, review or issue by the repository's owner, members or collaborators; the action's own write-access check stays in place behind it. The OpenID Connect grant stays, because the action exchanges that token for its GitHub App token. The main CI workflow no longer grants code-scanning write access to every job: only the two jobs that upload scan results (CodeQL and Slither) hold it, in their own permission blocks.

Change detection is tightened in two places. A pull request touching only a file outside `contracts/` that the contracts job reads (the committed facet ABIs, the deployments bundle and its type, or the Diamond facet manifest) now runs that job, which is the one that checks those files. And every change-detection diff counts a renamed file at both its old and new path, as the main CI workflow already did, so moving a file out of a watched path still wakes the checks that watch it. Closes #2762.

_Committed 2026-10-26 05:40 UTC (65df75c00)._
<!-- assembled-fragment: 2762-ci-workflow-hardening.md sha256=b45d1005427f71843a1fb3d90febba0358e38ae380667df2ad9d387aee4eb3f8 -->

## Thread — Deploy and ops script correctness (PR #2870)

The deploy scripts' check that each Cloudflare Worker can read a chain's RPC secret could never fail. When the secret was missing its count came out as two lines of "0", so the refusal never matched, and it looked in the Worker's own secrets while every Worker reads its RPC URLs from the account's Secrets Store. The check now lives once, in a shared helper all three deploy scripts use: it reads where the Worker's own config binds the secret, looks in that store, and refuses with its own message when a listing cannot be read. Because every Worker binds every RPC it reads from the store, a chain its config does not bind is a chain it does not serve: the indexer and the agent refuse that, while the keeper, whose chain set is whatever its config binds, reports it and moves on. A chain with no known RPC binding now refuses instead of skipping the check. (Closes #1492.)

Every script that points a Diamond at mocks it deploys now runs one shared chain guard first: always allowed on Anvil, never on a production chain, and on a testnet only when `REHEARSAL_ALLOW_CHAIN_ID` names that chain. This replaces the positive-flow suite's own guard (whose variable was renamed from `POSITIVE_FLOWS_ALLOW_CHAIN_ID`) and adds the guard to the partial, negative and Sepolia fixture scripts, which had none. The testnet deploy scripts no longer seed the indexer's cursor after a fresh deploy: the indexer owns a new Diamond as a new epoch and restarts from its deploy block, while the old seed jumped to the chain head and could skip the events in between.

`ConfigureV2Factories` now signs with the admin key, reads the three factory slots first and writes only those that differ, including writes of zero, so a chain's stale factories can be cleared. Where the admin no longer holds the admin role (after the governance handover) it sends nothing and refuses with the calldata to propose through the Timelock. The Tenderly alert export fills the chain id and Timelock placeholders it used to leave as literal text, refuses the run if the template uses any placeholder it does not fill, skips by name a chain with no recorded Timelock, and the alert template is now valid YAML with quoted addresses. The slippage census encodes its free-text CSV columns, so a token's symbol cannot add a column, a row or a spreadsheet formula. Closes #2763.

_Committed 2026-10-26 05:16 UTC (dab4016de)._
<!-- assembled-fragment: 2763-deploy-script-correctness.md sha256=bdbda973f11cd4364d27f26b649baed0f4949a13e65cf922d4590c5f0a82bdfb -->

## Thread — Test wallet answers only the site under test (PR #2917)

The live-review drivers inject a test wallet into the browser so a drive can
connect, sign and send transactions with the funded testnet wallets. Until now
that wallet answered any page or frame in the browser, so a redirect, a
third-party iframe or a compromised preview could have obtained signatures and
transactions from the test keys. Both drivers (the live driver under the app's
end-to-end tree and the harness-seed copy) now behave like a real wallet: they
answer only frames on the origin of the site the drive was pointed at. A frame
on any other origin is offered no wallet at all, and a direct call from one is
refused with the standard "not authorized" wallet error. The live driver also
records each refused attempt among the drive's blocked requests, so the report
shows that a foreign frame tried.

The Telegram link drive no longer prints the one-time link code. That code is a
live credential (whoever sends it to the bot first links their chat to the
wallet's alerts) and drive output is pasted into pull-request threads, so the
drive now prints only that a code rendered and its length.

The CI wallet fixture keeps its current behaviour: it serves Anvil's publicly
known development keys to a local preview server, so there is nothing to
protect there.

Closes #2765.

_Committed 2026-10-26 19:15 UTC (081c5e5d1)._
<!-- assembled-fragment: 2765-test-wallet-origin-scope.md sha256=12c8e3d21486e208631e1b762a5e54283c4823a7762345b079c4e662380aff0f -->

## Thread — the live read report covers the app's indexer reads (PR #2897)

The live position drive asks the deployed app which of its reads went unserved. Until now the app answered for its chain reads and its query cache, but not for its reads from the indexer. Those go through one fetch helper that turns any failure into "unavailable", and the query cache counts that as a success. A live run could therefore pass while part of a page had been built without indexer data, with an empty-looking panel read as a healthy one.

The indexer fetch now reports each read once to an installed driver. The report names the read by its route only: path words and query names, never an address, an id or any other value. When a read is not served, it also says why: no indexer configured, a timeout, a network failure, a non-2xx status, or a body that was not JSON. In normal use nothing is installed and nothing is reported. The drive judges an indexer read that was not served as unserved and blocks the run, as it already does for an unserved chain read. It also waits for indexer reads still in flight before judging. The report's version moved to 2. A build carrying the older report is named as older than the drive, so the remedy reads as a deploy rather than a change to the drive. Closes #2784.

_Committed 2026-10-26 11:24 UTC (bd24cb1a9)._
<!-- assembled-fragment: 2784-indexer-reads-in-read-report.md sha256=908ecb45ef865e53e14e16dc946032d6392ca69601daa6ef35168e8f93ec1100 -->

## Keeper — mirror day closes resume on chains still sending the B4 report (PR #2867)

The day-report change in PR #2790 (#2620, #2621) moved fresh deploys to one report shape, and the keeper's day-close pass started quoting only that shape. The live testnets still run messengers and Diamonds deployed before that change, which send the older B4 report. From the release that shipped it, every mirror close on BNB Testnet and Arbitrum Sepolia was refused with "the messenger has no quote for the report closeDay sends", starting with reward day 4. Day 4 was closed by hand from the keeper wallet at 03:52 UTC on 2026-10-26, paying the B4 quote.

The keeper now reads which report shape a mirror's messenger carries from the messenger's own code, either the one report shape or B4, and quotes that shape. The report channel checks that sit in front of every close gain three links:
- Base's reward messenger, also read from its code, must take the same shape. Base refuses a report of the wrong size on delivery, after the fee has been paid and the day stamped sent.
- The messenger must carry one of the two shapes.
- On a B4 chain, the Diamond's reporter must send B4: `closeDay` and `getInterestFrontiers` routed to one facet. B4 is the one older shape Base applies after it has finalized a day.

Any of these that fails or cannot be read holds every close on that chain, and the channel alert says which. On a B4 chain the route to Base is the messenger's own configuration, not a rule the contract enforces, and the rotated-messenger alert now says so.

This is keeper-only compatibility for chains deployed before #2790. The contracts still carry one report shape. The path is removed at the all-waves fresh deploy, when no served chain runs a pre-#2790 messenger (#2866).

_Committed 2026-10-26 05:27 UTC (ee0976312)._
<!-- assembled-fragment: 2790-keeper-b4-testnet-closes.md sha256=416220ebc84d15dab3df1fcaf9fbde95d7a4a87d6aade288734748f100bac97a -->

## Thread — Lender intents may lend VPFI (PR #2914)

A lender's standing intent now accepts the platform's own VPFI as its lending
asset. Registering, funding, filling, previewing and withdrawing a VPFI intent
all work like any other priced ERC-20. The refusal existed because the vault
paths an intent uses did not refresh the lender's fee-discount tier when VPFI
moved; since the tier record is refreshed inside every vault balance write
(#1820), VPFI an intent holds counts toward the lender's tier while it sits in
their vault and leaves it when a fill lends it out or the lender withdraws it,
exactly as an offer's escrowed VPFI already did. The owner decided to lift the
refusal on 2026-10-26.

Auto-roll still refuses a loan whose lending asset is VPFI, now with its own
named refusal. A VPFI repayment's proceeds are reserved for the lender
position's holder until claimed, and a roll cannot release that reservation,
so such a loan settles through the normal claim. The fill preview's error list
keeps its numbering: the code that used to mean "VPFI lending unsupported" is
retired and never returned, so solvers that key on the numbers need no change.
The treasury-funded backstop still refuses VPFI as backstop capital; that is a
separate treasury decision this change does not take.

Closes #2860.

_Committed 2026-10-26 17:37 UTC (7e00471e9)._
<!-- assembled-fragment: 2860-vpfi-lender-intents.md sha256=5f6a0ee2b644354797901e3a53650bbb4732d5e95a1dd183e094c2a98a3bec31 -->

## Thread — Zeroed-day compensation loses its upgrade-in-place shims (PR #2911)

The zeroed-day compensation machinery carried a migration for Diamonds upgraded in place across its w4 slice: an admin stamp that bound an old untagged receipt to a zeroed day as its compensation, an admin seed that wrote a day's per-side funded record by hand, a Base-side inventory of old manual reservations, a permissionless armer for compensated days that predated the deadline clocks, and a one-shot admin arm that kept both lapse terminals switched off until that migration was attested. Base also refused to dispatch a compensation for a finalized day with no frozen lapse clock. Every chain reaches this build by fresh deploy (owner decision O1 = A), and on a fresh Diamond none of those states can exist: finalization writes the day's clock in the same step, every manual compensation stamps its funded record, and every settled credit starts the deadline clock. All of it is removed. Two storage fields are kept in place under retired names, so the layout is unchanged.

The visible change is that the two permissionless lapse terminals now work from deploy. Before, no deploy script armed them, so on every chain an unpaid zeroed day could never close and a short-compensated day could never settle at what was funded. Now each day closes on its own frozen clock. A day is still lapse-eligible only if a lapse schedule was in force when it finalized; schedule version 0 never lapses.

Refs #2875.

_Committed 2026-10-26 16:36 UTC (6afe44027)._
<!-- assembled-fragment: 2875-retire-legacy-compensation-shims.md sha256=c7766cece68f60319eb5be3f18a26c0f4e0913509f95dba49b352e50a28aedda -->

## Thread — Recycled-credit counters lose their upgrade-in-place seeding (PR #2915)

Each chain's recycling ledger carried machinery for a Diamond refreshed in place over state older than its counters. The lifetime absorption figure a chain reports to Base was published as the larger of the stored counter and a floor derived from the bucket and the payout total, so an upgraded chain whose counter was still zero would report its historical absorption. Several ledger writes copied that floor into the stored counter first. A flag recorded whether recycled accounting had ever run, so the watcher could treat a zero counter on an upgraded chain as unverifiable. An admin ceremony, resumable across transactions and guarded against races, rebuilt the released-remittance stranded total and the lifetime release count from the reservation history. Every chain reaches this build by fresh deploy (owner decision O1 = A), so every counter starts at zero with the Diamond and is exact from the first credit. All of this is removed. Nine storage slots stay in place under retired names, so the layout is unchanged.

What changes for a reader:

- The cumulative a chain reports to Base is now exactly the stored absorption counter. The floor could only add wei-scale rounding dust from a claim that consumed slightly more than the bucket held; the reported figure no longer picks that dust up.
- The composition view no longer returns the "accounting seeded" flag. Its outputs are now: credited, released-remit stranded, canonical role, released-remit resolved.
- The stranded-seed functions, their state view, their errors and events, and the lifetime release counter that only the ceremony read are gone. The in-place redeploy script no longer prints the ceremony, and its runbook section is removed.
- The mesh watcher's bucket-composition check is always critical now; the "unverifiable, unseeded" advisory is gone. The `reported-derivation` check is retired: with no floor it would compare one stored number with itself. The relocation exclusion is still caught by bucket composition.

Refs #2875.

_Committed 2026-10-26 20:20 UTC (e7f3d143c)._
<!-- assembled-fragment: 2875-retire-recycle-cumulative-seeding.md sha256=3ce6df4eacf39a39269f691e928bae7227dc2eba78350100373b16536cb99dfd -->

## Thread — Every chain prices through its own Chainlink feed registry (#2880)

Outside Ethereum mainnet, the oracle could price WETH and nothing else. It finds every other asset's Chainlink feed through a feed registry, and Chainlink runs its registry on Ethereum mainnet only. So on Base, Arbitrum, Optimism and Polygon every other asset would have read as unpriced, and therefore illiquid. Testnets hid this because their mock rig deployed a mock registry. Every chain, Ethereum included, now deploys Vaipakam's own registry in the contracts phase. The Diamond prices through it with no oracle-code change, because the registry answers the same lookup Chainlink's does.

The registry holds only official Chainlink feeds. On every add or replace it checks what the chain can prove: the token answers its decimals, and the feed answers the declared decimals and pair name. The pair's quote must also be the one the entry is filed under, so an ETH-quoted feed cannot become a USD price, and the feed's latest answer must be positive and within its heartbeat plus a one-hour grace, so a short-heartbeat feed whose round lands a few seconds late is not refused by chance. What the chain cannot prove, which token a pair name means, is left to a reviewed per-chain record. Every change also carries the hash and date of the Chainlink directory file it was checked against.

Every change waits a delay the Pauser Safe can veto: adds, replacements and removals alike. The delay is three days by default on a production chain (one to fourteen allowed) and zero on a test network. A proposer key may propose low- and medium-risk feeds only. Higher-risk feeds need the owner, which becomes the Timelock at the handover, and only the owner may replace or remove them once registered. The handover also moves the registry's veto to the Pauser Safe, and the handover gate refuses any other holder.

Configure now points the Diamond at the recorded registry on every chain and takes the USD and ETH denominators from it. The old denominator and registry environment settings are retired. The testnet and Anvil mock rigs and the end-to-end fixture now register their mock feeds in the real registry, so the shape the testnets run is the shape a mainnet runs. Fresh deploy only.

A drafting tool now writes each chain's bindings file from Chainlink's directory. It keeps only standard low- and medium-risk price feeds quoted in USD or ETH, with no shutdown date. It drafts a binding only when CoinGecko, CoinMarketCap and the chain's official token list all name the same single token address. It then reads the feed and the token on chain the way the registry will. Anything else goes to a review list with every source's answer, and nothing is drafted for it. Every feed it leaves out is listed with the reason. The owner can add entries by hand, each naming where its address came from. The API keys stay on the machine that runs the tool and are never printed.

The launch step gains an eighth readiness check: the Diamond must price through the registry the deployment records, and that registry must file a quote under both keys the oracle asks it under, so no lookup misses a feed for want of a key. The production launch proposal names the registry for the Safe to review. How many feeds it holds is reported, not required, since WETH prices without it.

Still to come under #2880: the service that proposes and executes the merged bindings. #2745 (secondary oracle keys from the registered pair name) builds on this.

Part of #2880.

_Committed 2026-10-26 19:06 UTC (1c75a3a80)._
<!-- assembled-fragment: 2880-feed-registry.md sha256=d3ba3ce2074178e3afb09957a4e2f698dbc4af32910523c2006e9927ed45acbd -->

## Delisting timelock: a removed bot key's proposals stay void (#2902)

Removing a delister bot key from the sanctions delisting timelock was meant to void every delisting it had pending. It did, but only while the key stayed removed: if the owner appointed the same address again, every proposal it had made before the removal, and that nobody had cleared away, became executable again, including ones whose waiting window ran out while the key was removed.

Each proposal now records the authority it was made under, and a removal ends that authority for good. Reappointing the address lets it propose again, with a fresh waiting window and a fresh chance for the Safe to veto, but never brings back what it proposed before. The old proposals can only be cleared away, which anyone may do. The delister bot reads the same rule from the contract, so it clears them away too, rather than treating them as its own.

The other safeguards were already holding: a delisting still needs the publication unchanged, no veto, and a current RedStone reading that clears the address. Prelive: fresh deploy only.

_Committed 2026-10-26 22:31 UTC (75d923998)._
<!-- assembled-fragment: 2902-delisting-proposer-generation.md sha256=631a77857cb2efa83836eae8cabb48563acfbc437289f12c34b7ec97cecf36a8 -->

## Thread — Keeper reads a Diamond's forced-sale surface in one request (PR #2912)

The keeper now finds out which forced-sale calls a Diamond routes (added in #2908) with one loupe read per attempt. Before, it made ten: five at the start and five again at the final gate. The grace-default pass runs under a hard budget of 40 requests per visit, and on BNB Testnet the extra reads used it up, so the two past-grace test loans there were skipped on every visit with "subrequest-budget-spent".

The single read asks whether the Diamond routes the sale plan. If it does, the keeper uses the sized calls; if not, it uses the older whole-collateral ones. Nothing is lost by dropping the other reads. The keeper still previews or estimates the exact call it is about to send, and a call the Diamond does not route reverts there, before anything is broadcast. So a Diamond part-way between the two surfaces, or one cut while an attempt was being judged, still gets nothing sent. The log now shows that as a preview failure rather than a named "mixed surface" reason.

The whole-collateral bridge is still removed at the all-waves fresh deploy (#2907).

_Committed 2026-10-26 16:45 UTC (9374c432d)._
<!-- assembled-fragment: 2907-keeper-surface-one-read.md sha256=e5cb0696b035b25e7b0a0d3a24b051d3c2f2b5e337464cc3bbf26798ac3840fd -->

## Thread — Keeper sends the forced-sale form each Diamond routes (PR #2908)

The live testnet Diamonds were deployed before the sell-to-need change (#2796). They route only the older default and liquidation calls, which sell the whole collateral and return the surplus to the borrower, and they have no sale plan. After the keeper moved to the newer sized calls (#2834), every grace default and health-factor liquidation it tried on those chains failed with "function does not exist". The past-grace test loans on Base Sepolia, Arbitrum Sepolia and BNB Testnet then sat undefaulted. Collateral stayed where it was; nothing moved.

The keeper now reads from each Diamond's own routing which form it carries, before every default, liquidation, internal-match close and periodic settlement attempt. A grace default reads it again at its final gate. On a sized Diamond nothing changes. On a pre-#2796 Diamond the keeper prices a sale of the whole collateral and sends the older call. It still requires a simulated preview of that exact call to show a sale or a terminal in-kind close, and it does not try a split liquidation, whose legs need the missing plan. The periodic settlement pass, which ships disarmed, declines such a Diamond outright. A Diamond that routes part of each form, or whose routing cannot be read, gets nothing sent, and the log names the reason.

This is a bridge for the live testnets only. Every fresh deploy carries the sized surface, and the whole-collateral branch is deleted at the all-waves fresh deploy (#2907), the same treatment as the B4 report path (#2866).

_Committed 2026-10-26 15:03 UTC (e184e30d0)._
<!-- assembled-fragment: 2907-keeper-whole-collateral-surface.md sha256=37ef557c1efaa1f2cde02e296e914a0dc5770dc4ac18ee9c084fab7189b7e738 -->

## Rewards — the deploy now sets the zeroed-day lapse schedule (PR #2919)

A fresh canonical reward chain used to launch with no lapse schedule at all.
That is the schedule's version 0, under which a zeroed day never lapses and
compensation for it has no dispatch cutoff, so the lapse terminals that #2911
made live from deploy had nothing to act on until an admin remembered to call
the setter by hand. No deploy or configure script did.

The reward-mesh configure step now sets it on the canonical chain, right after
it wires the mirrors: a day lapses seven days after it is finalized, and manual
compensation for it must be dispatched at least 24 hours before that. Both
values can be overridden per run, inside the contract's own bounds. Re-running
the step with the values already in force creates no new version, so the
append-only version history only grows when the schedule actually changes. A
mirror chain is unaffected; it never reads a schedule.

Launch readiness, the single list of launch requirements that the launch
script, the post-deploy verify phases and the on-chain launch gate all read,
gains a check for it. On the canonical chain a missing schedule is NOT MET and
blocks launch, and the readout names the version and both values when one is
set. On any other reward role the check says it does not apply and why.

Closes #2909.

_Committed 2026-10-26 21:26 UTC (6650d2be8)._
<!-- assembled-fragment: 2909-lapse-schedule-configure.md sha256=9322214eff53b564f3f86882136c9c3a8dcb760d303ff94819eebbf4d010b726 -->

## Thread — the connected app's connection list, published as a report first (#43)

The connected app's content policy still allows network requests to any secure host, so a script that got onto the page could send what it reads anywhere. The narrow list is now built and sent beside it as a report-only policy: the app's own address, the indexer and its live channel and the alert service this build is configured with, the chain endpoint of each supported network (and its live socket where one is configured), the name-lookup endpoints, the two token-screening services, and the hosts the WalletConnect and Coinbase Wallet connectors need. A request outside the list is reported by the browser and still made, so nothing can break yet. It moves into the enforced policy once a deployed build has been driven clean under it, because a wallet host missed from an enforced list would silently break that wallet. That staging was an owner decision.

Every address the app connects to is now resolved in one place, from the build's settings, and the build writes the list from that same place, so the policy cannot describe a different deployment from the one it ships with. The five copies of the alert-service address rule became one. A configured address that is not a plain secure origin stops the build.

The live review drives now fail on any content-policy report or refusal the page raises, whatever else they check, which is how a missing host is found before the list is enforced. No report is sent to any server: it would carry the page a visitor was on.

Part of #43.

_Committed 2026-10-26 03:41 UTC (e7f6a5fb1)._
<!-- assembled-fragment: 43-app-connect-policy-report-only.md sha256=a2f461bdc07a61b398d29c3477778af5a0db1e1b759a10d0688d4c04b336adca -->

## Thread — A tier push never blocks staking, unstaking or a loan start (PR #2853)

On Base, every action that changes a user's VPFI standing also sends their new discount tier to the mirror chains. That includes stake, unstake, loan start, the fee paths at settlement, consolidation and the tier poke. Until now that send was all or nothing, and it ran inside the user's own transaction. So the action failed whenever the send could not go out: the protocol's broadcast budget was empty, one destination lane was down or paused, or no destination was configured. Anyone could drain the budget cheaply by switching their discount consent off and on and poking their tier. Once it was empty, every unstake that lowered a tier failed until an operator topped it up. A single dead lane froze tier-changing actions for everyone.

A tier push now never makes the user's action fail. Base's own tier is current at once. Each mirror lane is delivered on its own and is owed the new tier until it gets it. A lane that cannot be reached right now stays owed and is announced on-chain with the reason. Reasons include an empty budget, a lane that cannot be quoted or sent, and a paused messenger. The user's next tier-pushing action retries it, and so does anyone who calls the new delivery entry point.

The protocol budget pays at once for a lowered tier and for a lane's first push. It pays for any other change, such as a raised tier, at most once per lane per spacing window: one day by default, settable by the admin between one hour and seven days. That limit bounds what the consent-toggle loop can drain. Anyone who wants an owed push delivered sooner can pay its fee themselves. Caller-paid delivery has no spacing limit, and any unspent value goes back to the caller.

A transaction cannot skip a push by withholding gas. Base gives each call to a lane a fixed amount of gas, well above what the delivery needs, makes the call only with that amount in hand, and reverts the whole action otherwise. A lane that fails has therefore failed on its own, and because no call gets more than its amount, a lane that uses up its gas leaves the next lane's share untouched.

Each user's per-lane delivery state is publicly readable. A budget-paid send debits only what actually left the contract. The messenger's tier send is now one lane at a time, and it refuses a chain that is not on its destination list.

The trade-off is stated in the design: a mirror can lag Base. A lowered tier reaches a mirror as soon as its lane works and the budget can pay, or sooner if someone pays. A lane that never recovers is still bounded by the mirror's 60-day maximum age. Fresh deploy only, like the rest of the pre-live work.

Closes #898. Closes #911. Part of #1277: its reward-batch finding belongs to the reward remittance work. Follow-up #2849 retires the separate broadcast-free restamp, which this change makes unnecessary.

_Committed 2026-10-26 02:50 UTC (a96921fa3)._
<!-- assembled-fragment: 898-911-tier-push-never-blocks.md sha256=447c39d179c14d26ee92e9698b203c80be1dd39950bdb4d609c3b0ac3a17e7f6 -->
