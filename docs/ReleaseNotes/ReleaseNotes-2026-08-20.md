# Release Notes — 2026-08-20

Ten entries, and they fall into three groups.

**Settlement, unified.** The first two are two halves of one piece of work: the
completion of the VPFI recycling programme's settlement layer. Rewards can end
three different ways — a holder claims them, an unclaimed one reaches the end of
its claim horizon and is recycled, or a defaulted position forfeits them. Each of
those three used to work out on its own what the reward was worth, applying the
same limits in slightly different ways. That is the kind of duplication that does
not announce itself: every copy looks correct in isolation, and the disagreements
only surface at the edges — a reward that could never be finalized, an estimate
that contradicted what a claim would actually pay, a limit applied twice or not at
all. All three now ask the same settlement engine for the answer. The second entry
is what that unification was for: a receiving chain can now pay out its own
coordinated-mode days, bounded by what it has actually been funded, instead of
being held back entirely. A third entry finishes the same theme from the position
side — a sold position now always carries its reward migration with it.

**Saying the right thing.** Three entries change no behaviour at all and are
still worth reading, because each corrects a description that was quietly wrong
in a way a reader would act on: the 69,000,000 VPFI reward figure described as a
pre-funded pool when it is a spending ceiling and no such balance is ever
created; the commitment rule stated four different ways in four places when only
one of them was the rule the code implements; and a specification section whose
own rule had been pushed beneath a subsection about an operator flag, so the
table of contents advertised the wrong thing entirely.

A fourth belongs with them by subject and not by kind, which is worth separating
rather than blurring: a lender-position listing was filling in every number
faithfully while leaving three of the terms blank — the ones that decide whether
the buyer may be repaid in parts, and on what schedule. That is not a wording
fix. The listing genuinely said the wrong thing, a buyer's signature genuinely
agreed to it, and the position they received could permit what the listing
denied. The fix is in the contracts.

**Things a live check found.** The last three came from looking at what is
deployed rather than at what is written. The marketing site was logging a content-
policy refusal on every page load — an analytics beacon the hosting provider
injects after the page leaves the application, which the site neither asks for nor
can control; it stays refused, and now that is recorded as intended rather than
read as a bug. Two of the three wallet-connecting apps were still reporting
visitors to their wallet vendors, against a project rule that already required
otherwise. And the internal size-limit report, which warned usefully when one
component was tight, had stopped being useful now that seven are: it listed the
one with 32 bytes of room identically to the one with a thousand.

## Reward expiry now settles the same way a claim does (#1434)

When a reward entry reaches the end of its claim horizon without being
claimed, the protocol reaps it and returns its value to the recycling
bucket. Working out *how much* an entry is owed at that moment is the same
question a normal claim answers — but until now the expiry path worked it
out separately, with its own arithmetic.

That separation was the problem. Three consecutive review rounds each
corrected the expiry calculation, and each correction was wrong in a new
way: it measured the raw amount owed rather than the amount actually
funded; then an amount that looked capped but was not, on precisely the
chains where it mattered; then a figure borrowed from the claim path that
covered the wrong span of days and the wrong set of limits. The arithmetic
differed every time; the shape of the mistake did not.

Expiry now asks the settlement engine for the answer instead of computing
one. The practical consequences:

- **Entries that share a daily ceiling no longer interfere.** Previously
  two expiring entries could each be measured against the whole shared
  allowance — leaving one of them permanently stuck, or letting both
  together exceed the ceiling. Each now takes its own allocated share, and
  what it consumes is recorded so the next one sees the reduced remainder.

- **Long entries no longer lose value when reaped.** An entry spanning more
  days than a single pass can price used to be closed out in full while
  only part of it was credited; the rest was simply lost to the claimant.
  An expiry now settles only the days it actually priced and carries the
  remainder forward, so a long entry is reaped across several passes with
  nothing dropped.

- **Expiry is no longer limited by a cap that does not apply to it.** An
  expired reward returns to the bucket rather than being paid out to a
  participant, so the per-loan payout ceiling was never meant to bind it —
  the same exemption forfeited rewards already have. Where that ceiling was
  exhausted, an entry could previously be closed out while none of its
  value was returned.

- **A reap never partially credits while the owner can still claim.** Where
  the overall emissions budget is nearly exhausted, an expiry waits rather
  than taking what fits and discarding the rest. A claimant asking to be paid
  is right to take what is available; someone being reaped without asking is
  not, and while their own claim is still open to them, waiting costs nothing
  but time.

- **Once a reap has actually moved value, that changes — deliberately.** The
  first pass that credits anything removes the reward: it is announced, and
  the owner's claim to it closes from that moment. From then on the reward
  must finish rather than wait, because the emissions budget only ever
  shrinks — a wait that began after removal could never end, and the reward
  would be left permanently unfinished with its owner already unable to
  claim. So a later shortfall settles for what the budget allows and
  completes, and any remainder it could not fund is discarded rather than
  held.

  This is a real trade, stated plainly: tail value CAN be discarded, but only
  after the owner has been removed and told, and only to guarantee the reward
  terminates. The alternative — waiting forever on a budget that cannot grow
  — loses the same value AND leaves the reward stuck, with no signal that
  anything happened.

- **Only a genuinely permanent shortfall triggers that trade.** The
  emissions budget is not the only thing that can come up short at
  settlement: the platform also refuses to credit more than its own
  balance currently backs, and that constraint is temporary — it clears
  with the next inflow. A removed reward that hits a momentary backing
  dip now waits for it to pass, rather than settling short and discarding
  the difference. Discarding is reserved for the one budget that can
  never refill.

- **Removal happens when value first moves, not merely when the sweep
  first advances.** A sweep pass can step past days that turn out to be
  worth nothing — for example a day whose shared allowance an earlier
  claim already used up. Such a pass now leaves the reward exactly as
  claimable as before; the owner's claim closes only on the first pass
  that actually credits value, which is what the platform's announcements
  have always described.

- **Detaching a chain from the cross-chain mesh is now a full role change.**
  A chain's delivered-funding position was already retired when its
  canonical/mirror role flag flipped; the same retirement now also applies
  when the chain is detached or re-attached by clearing or setting its
  home-chain reference — the second way its effective role can change.
  Previously a detach-and-reattach round trip could re-offer funding
  headroom whose backing had already been spent.

- **Previews and readiness checks now model the lifetime budget the same
  way payment does.** Near the end of the emissions schedule, the
  platform's forward-looking figures — the pending preview and the
  "could this claim be paid?" check that drives the expiry clock — used
  to treat the remaining schedule as unlimited while applying the
  cross-chain funding bound, so they could disagree with the live claim
  about which limit actually applies. A claim that would succeed (paying
  exactly the schedule's remainder) could preview as zero, and the
  readiness check could wait on cross-chain funding for value the
  schedule will never emit — stalling expiry clocks permanently. Both now
  apply the schedule's remaining headroom exactly as the claim does,
  which is also what the specification always said. Two refinements
  complete this: the simulated budget is spent down day by day exactly
  as a real claim spends it (previously each day of a multi-day estimate
  was measured against the full remaining headroom), and it accounts for
  the parts of the same claim that are paid before the daily walk — the
  legacy window and each reward's pre-cutover slice — so an estimate can
  never promise the same headroom to two legs of one claim. That
  accounting reserves by what a leg SPENDS, not by who receives it: a
  forfeited reward's pre-cutover slice goes to the treasury channel
  rather than the claimant, but it draws on the same schedule, so it
  reserves headroom too — while remaining excluded from the pending
  figure shown to the user, who receives nothing from it.

- **Forfeited rewards now settle through the same engine as everything
  else.** The last path that still worked out its own settlement — the
  sweep that finalizes forfeited rewards — now prices each armed day
  through the shared settlement engine: the same daily ceilings, the
  same split between newly-emitted and recycled value, the same
  cross-chain funding bound, and a bounded amount of work per call with
  progress saved between calls (a very long reward settles across
  several sweeps instead of needing one impossibly large transaction).
  Two visible consequences: a sweep that cannot yet be funded
  cross-chain simply makes no progress and succeeds later (previously
  the whole call failed), and a forfeited reward whose value rounds to
  nothing still closes out cleanly when the emissions schedule is
  exhausted. Operators also get a safer maintenance path: re-running the
  full facet refresh on an already-migrated deployment no longer stops
  mid-way asking for migration inputs that only ever applied to the
  first run. The same budget discipline covers the parts of a forfeited
  reward that predate the daily engine: their settlement never pushes
  the emissions ledger past the lifetime cap, and a temporary backing
  shortage makes them wait rather than silently forfeiting the
  recoverable remainder.

- **A forfeited reward is settled against what the cross-chain funding
  actually owes.** The permissionless sweep that finalizes forfeited
  rewards used to require cross-chain funding to cover the reward's raw
  value, but the funding schedule only ever remits the capped figure —
  so a capped forfeited reward could never be finalized at all. The
  sweep now settles exactly the capped amount (the same figure the
  funding schedule states), writes off the capped-away remainder just as
  the schedule already did, and still retires the full obligation.

- **Routine sweeps no longer pay for questions whose answers cannot
  matter.** The eligibility probe — an expensive simulation of the
  owner's whole claim — now runs only where its answer can change the
  outcome: before a reward's removal point, and its cross-chain half
  only on chains where that bound applies. Previously it ran
  unconditionally, letting a large enough reward history make an
  otherwise valid sweep run out of gas.

- **A removed reward shows no countdown either.** The Claim Center's
  removal countdown is a deadline for the owner to act on; once removal
  has begun that deadline has passed, and continuing to show it — possibly
  for a long settlement tail — would invite a claim that can no longer
  succeed. The countdown now clears at the removal announcement, exactly
  as it does for a claimed or fully expired reward.

- **A removed reward no longer counts toward what its owner could claim.**
  The internal check that asks "could this user's whole claim be paid
  right now?" excludes removed rewards — the claim itself already skips
  them. Previously a removed reward still mid-settlement inflated that
  figure, which could stall the expiry clocks of the same user's other
  rewards indefinitely. (The user-facing pending preview was measured to
  be unaffected — it already read zero for such rewards through a
  different mechanism — and now states the exclusion explicitly as well.)

The claim-horizon sweep also moves onto its own internal component. It now
shares the settlement engine, and no existing component had room for it
within the per-component size limit that the platform's upgrade mechanism
imposes. Nothing changes for anyone calling it: the address and the call
itself are unchanged.

## Receiving chains can now pay out their own coordinated-mode days (#1434 P1-b)

Until now, a receiving chain never priced the days that run under the
platform's coordinated reward mode. Those days were stopped outright — not
because anything was wrong with them, but because the platform had no way to
tell how much funding a receiving chain had actually been sent, and paying
without that knowledge could have drawn on tokens held for other obligations.
The stop was a placeholder for the missing measurement.

That measurement now exists, so the stop is gone. A receiving chain prices its
coordinated-mode days exactly as the coordinating chain does, and what keeps it
honest is a simple rule: **it may pay out no more of that funding than it has
actually been sent.**

**A shortfall makes a day wait; it never shrinks it.** This is the part that
matters most for anyone whose rewards are affected. Two different limits can
hold a payout back, and they settle in opposite ways:

- The platform's lifetime emission ceiling only ever shrinks. What it cannot
  cover can never be covered later, so a day held back by that ceiling is paid
  down to what fits and then closed for good.
- Delivered funding is the opposite — it grows with every delivery. A day short
  of it is simply not funded *yet*, so it waits, and the next delivery pays it
  in full.

Trimming a day for the second reason would permanently underpay someone whose
funding was merely still in transit. The two limits are therefore tracked
separately, so the platform can always say which one actually applied. Where
both apply equally the day closes, because no future delivery could complete it
and waiting would mean waiting for something that cannot arrive.

**The wait can always end.** A day that is waiting on funding is not stuck: it
becomes payable the moment that funding lands. The rule is keyed on the amount
present rather than on the arrival of any particular message — which matters,
because some days are deliberately never funded from the coordinating chain
(the receiving chain covers them locally, or the amount rounds to nothing). A
rule keyed on messages would leave those days waiting forever and block every
later day behind them.

**What is unchanged.** The coordinating chain is unaffected — it funds its own
days directly and receives no deliveries, so the new limit does not apply to
it. Rewards earned before coordinated mode was switched on are also unaffected:
no delivery ever funded them, so they are not measured against delivered
funding and continue to pay as they always have.

**What you will see.** A reward estimate on a receiving chain no longer quotes
an amount that a claim will decline to pay **for want of delivered funding**.
Previously an estimate could promise a full day's reward while the claim paid
nothing at all, because the estimate did not know what had been delivered.

One limit used to sit outside that guarantee: near the platform's lifetime
emission ceiling an estimate could read higher than the claim would pay, because
estimates did not model that ceiling. The other entry in these notes closes that
gap — the pending preview and the readiness check now apply the schedule's
remaining headroom exactly as a claim spends it — so the two figures agree at
that boundary as well. The agreement described here is the separate one about
delivered funding, where the gap was never a bound but a wrong answer.

## The reward allocation is described as what it is: a spending limit, not a balance (#1459)

The platform reserves 69,000,000 VPFI for interaction rewards. Across the design
set that figure was repeatedly described as a *pre-funded pool* — a balance set
aside at launch and drawn down over time.

It is not, and the difference matters operationally. Deploying the token creates
a smaller initial amount for one recipient; nothing anywhere creates a 69,000,000
balance. The figure is a ceiling on how much may be *spent*, and the balance it
is spent from has to be funded into the platform as a separate, deliberate act.
The consequence the old wording concealed is the one an operator most needs to
know: the platform can report ample remaining headroom while holding nothing to
pay it with. Headroom is permission to spend, not evidence of funds.

The statements found saying otherwise now say so — including the one inside a
**ratified principle**, whose substance is unchanged and whose reword is recorded
in place alongside it. Several of the corrected statements are in the
machine-readable documentation that integrators inherit, so a downstream reader
no longer picks up the wrong model of where reward value comes from. No claim is
made that none remain: a wording sweep can only reach the phrasings someone
thought to look for, and the correction below is what happens when that limit
bites.

Wording that uses "pre-funded" in its ordinary and correct sense — a loan's
prepaid buffer, a test account funded in advance, surplus already delivered to a
chain that genuinely does pay later claims there — is untouched. The correction
is specifically about the 69,000,000 allocation.

Dated release notes already published are left as they stand. They are a record
of what was said at the time, and the specification is what governs.

## The commitment rule reads the same way everywhere it is stated (#1577)

Chains report how much recycled value they hold, and the platform instructs them
to spend against it. The rule bounding that has a subtlety: value committed and
then released un-spent stays where it was and may legitimately be committed
again, so the amount instructed over a lifetime is deliberately *not* bounded by
the amount reported. What is bounded is the instructed amount **net of releases**.

The working code has said this correctly for some time. Several places
*describing* it had not caught up, and one of them was a live test asserting the
older, simpler rule — passing only because that particular scenario never
releases anything. A test that is true by fixture rather than by rule will reject
a perfectly healthy state the day the fixture grows, and until then it teaches
every reader the wrong rule. Both assertions now state the real bound; they pass
identically today, which is the point.

An invariant elsewhere had the opposite problem: its **name** stated a form its
own body deliberately avoids, with a comment underneath explaining why that form
would break. The two forms agree in ordinary arithmetic and differ in the
arithmetic that actually runs, where the rejected one can overflow on a hostile
report. The name now matches the body — a name is read far more often than the
comment correcting it.

The descriptions in the contracts were corrected too, and there were more of them
than the record of outstanding work listed — repeatedly. A first pass corrected
several and said the code was done; a review found more; a further review found
more still, in test files the checking search had never looked at. Each pass
wrote a narrower claim than the last, and each was wrong within a round.

So the claim was replaced with a check. A small script now reads every comment in
the contracts and the tests and fails if any of them states one of the retired
forms, with an explicit, reasoned exemption for the places that name a wrong form
deliberately — to reject it, or to describe what an older version did. It runs as
part of the pre-deployment gate, and it was tested by reintroducing each mistake
it exists to catch, including one case where the check itself turned out to
accept an unexplained exemption. That hole was found by attacking the check
rather than by reading it, and closed.

The reason for the change of instrument is worth stating plainly: this is not a
fact that can be kept true by careful writing. Every attempt to assert it went
stale almost immediately, because the assertion and the thing asserted live in
different places and only one of them is re-read.

## The treasury recycling rule is no longer filed inside one of its own footnotes (#1570)

The specification's treasury-recycling section had gained a subsection about a
per-chain surplus signal, and that subsection was placed directly beneath the
section heading — ahead of the section's own rule. Everything the section
actually says about recycling treasury value, the bug-bounty bucket, buyback
dormancy and the keeper budget therefore appeared, to any reader and to the table
of contents, to be part of a subsection titled "per-chain recycled-surplus flag
(operator signal only)".

The rule now comes first and its two refinements follow it. Moving it turned one
cross-reference inside the subsection — which said "the rule below", and was
correct while the rule was below — into a statement pointing the wrong way, so it
was corrected as part of the same move. A note deferring the disposal of a
flagged surplus to a section "tracked separately" now points at the section that
specifies it, which has since been written.

No statement of intended behaviour changed in any of this — the section says what
it said, in an order that lets it be found.

## A sold position now always carries its reward migration, and the sale's internal bookkeeping loan stops showing up in your history (PR #1825)

Two independent defects on the lender position-sale routes, both about a sale
leaving traces it shouldn't — or failing to leave one it promised.

### The reward migration is now part of the sale, not a side effect

Every sale quote tells the seller, as a priced cost line, that they forfeit
the platform-interaction rewards accrued on the position, and tells the buyer
they receive a fresh entry covering the rest of the loan's window. Underneath,
that migration was performed on a best-effort basis: if it failed, the sale
settled anyway. The seller kept a reward entry on a position they no longer
own, the buyer received none, and nobody was told — the transaction succeeded
and reported nothing wrong.

A disclosure the protocol does not keep is worse than one it never made, and
this one is quoted at the moment of decision. Both sale routes — selling
instantly into a standing bid, and the completion of a posted listing — now
treat the reward migration as part of the settlement. If it cannot be
performed, the whole sale is refused and the reason is reported, rather than
settling on terms different from the ones quoted.

In normal operation nothing changes: the migration is simple bookkeeping that
cannot fail, and it does nothing at all before the rewards programme launches.
The failure this makes visible is a misconfigured deployment where the reward
component isn't reachable — precisely the case that must not be allowed to
settle sales quietly on the wrong terms.

### The sale's internal bookkeeping loan is no longer visible anywhere

Completing a listed sale forges a short-lived internal loan record to carry the
lender relationship from the moment a buyer accepts to the moment the sale
settles — usually the same transaction. It is not a real position: no
collateral, no borrower obligation, and it ends within the flow that created
it. The product has always described it as invisible.

It was not. That record was counted into the platform's active-loan and
lifetime-loan statistics, added to the interest-rate averages, appended to both
parties' permanent loan history, placed in the list keepers walk, and announced
to interfaces as a newly created loan. Users saw a loan appear in their history
that they never took out; the protocol's own totals counted positions that were
never real, permanently.

The internal record is now excluded at every one of those points, and — as the
matching half — its close-out no longer removes what it never added, nor
announces the end of something no interface was told about. Never counted,
never uncounted: every entry balances exactly, so no total can drift in either
direction.

Exclusion had to reach further than the writes made when the record appears.
The record itself stays in storage, and its identifier came from the same
sequence real positions draw from — so anything that walks that sequence kept
finding it: the count of loans ever created, the full loan list, the
by-status pages, and the lifetime volume and interest totals, where a sale
would have priced the very same money a second time and invented interest
nobody ever owed. The record now carries a durable mark saying what it is, and
those surfaces skip it. The mark records which real loan the sale was for, so
the acceptance notification can name that loan instead of publishing an
identifier no list will acknowledge.

The same mark answers a question the first cut of this work got wrong. Whether
a record was *announced* when it was created and whether it was *counted* are
separate facts, and a record from before this change can be the first without
being the second. Deciding both from the counters would have closed such a
sale in silence — the exact stuck-forever symptom this work exists to remove,
re-entered through the older records' door. Announcement is now decided by the
mark and counting by the counters, independently.

What the record is *not* excluded from is the bookkeeping that is about records
and people rather than about positions. Someone buying their first position is
still counted as a participant in the protocol's user total, and the listing's
own position token still stops presenting as an open listing the moment it is
consumed. Those were never part of what "invisible" meant, and separating them
explicitly is what keeps a future addition to the position bookkeeping from
silently going missing on this path.

Records created before this change were announced, so their close-outs are
still announced — and they still adjust whichever totals they had actually
joined, which need not be all of them. The two regimes are distinguished
automatically; no migration or operator action is needed, and the statistics
self-heal as those older sales complete.

Part of #1503 (items 12 and 26).

## A lender-position listing now describes the position it is selling

When you buy someone's lender position from a listing, you sign the terms you
are agreeing to, and the platform refuses the purchase if what you signed does
not match what is on offer.

The listing you sign against is not written by the seller. The platform
assembles it from the live position at the moment the seller lists. It filled in
the numbers — the outstanding amount, the term, the collateral — and one of the
behavioural terms, and then simply left the rest blank. Three fields never got
copied across: whether the borrower may repay early in parts, whether they may
list their prepayment, and whether interest settles on a periodic schedule. A
blank in those fields does not read as "unknown"; it reads as "no".

So a buyer was shown, and signed, a statement that the position permitted none
of the three. The check compared that against the listing, found agreement, and
let the purchase through — because the listing genuinely did say so. The
position they received could permit all three.

Nothing was mispriced and no money moved wrongly. What was wrong is what the
buyer had agreed to: the confirmation they signed described a position that did
not exist, and it was precisely the fields that govern what the borrower can do
to them afterwards. A buyer who cared that the borrower cannot repay in pieces
had that recorded as agreed, and could still be handed a position where they
can.

The listing now carries all three, copied from the position when the seller
lists. That is enough, and it is permanent: these three terms are fixed when the
loan is first taken and never change for as long as it runs, so a value copied
at listing time cannot go stale. Every screen that shows you a listing's terms,
and every app that prepares your confirmation, reads the listing — so all of
them became correct at once, with no change needed on their side and no window
where one half of the platform disagreed with the other.

Two consequences worth stating, because each is a thing you could otherwise
run into:

**Listings made before this change are not yet covered.** Such a listing still
carries the blanks while its position carries the truth, and no amount of
re-signing fixes that — the buyer is signing the listing faithfully; it is the
listing that is wrong. The right answer is to refuse the purchase so the seller
relists, and that refusal is written and tested but is **not part of this
release**: the contract it belongs in is within a hundred-odd bytes of the
hard size limit Ethereum places on a single contract, and adding it would leave
no room for any later correction to that same contract. It is tracked
in #1835 and lands once that contract has been split. Until then, buy from a
listing created after this release; a seller with an older listing can simply
cancel and relist to produce a correct one.

**Listing a position that settles interest periodically keeps working.** Copying
the schedule across meant the listing was, for a moment, being checked against
the rules for setting up a brand-new loan — rules like "the payment interval has
to be shorter than the term". A running position routinely fails those, not
because anything is wrong with it but because it has aged: a loan that pays
annually has less than a year left the day after it starts. Applying them would
have quietly removed the seller's exit from ordinary healthy positions. A sale
hands over an existing position rather than creating a new one, so those
set-up-time rules no longer apply to it — the schedule is recorded as-is.

Worth recording how the original gap went unnoticed for as long as it did. Every
existing test of this purchase path used positions that did not permit early
partial repayment — which is exactly the value the listing left blank — so the
listing and the position always agreed and the disagreement was never
constructed. The tests passed identically before and after the fix until a case
was written where the two genuinely differ.

## An analytics collector nobody asked for was being refused on every page, and it stays refused

A live check of the deployed marketing site turned up an error in the browser
console on every single page load: the site's content policy was refusing a
script. The script was an analytics beacon the hosting provider inserts into
responses automatically, as a zone-level setting — nothing in the site asks for
it, and nothing in the site can control it, because it is added after the page
leaves the application.

The obvious fix — permit that one address in the policy and the error goes away
— is the wrong one, and the reason is worth stating because the error is
annoying enough to invite it.

The site's rule is that no analytics runs until the visitor has agreed to
analytics. That is enforced in the application, around the analytics the
application loads. A collector inserted after the fact sits outside that
enforcement entirely: it cannot be held back until consent, because the code
that would hold it back never sees it. Permitting it would therefore have
traded a visible console message for an unconsented collector running on every
page — a worse state that happens to look tidier. The project's rules already
extend this reasoning beyond its own analytics: the connected app's wallet
connectors are required to have their built-in telemetry switched off, so that
merely opening the connect dialog does not report usage the visitor never
agreed to. Checking that requirement while writing this turned up that neither
of the two connectors it names actually switches its telemetry off, and that
the resulting exposure is not the one the rule describes. It is not gated on
opening the connect dialog: the app restores any previous wallet session when
it starts, and building each connector to check is what sets its reporting
going. For one of the two that means every visitor to the connected app is
reported on, whether or not they ever reach for a wallet. The other has its
reporting switched on but sends nothing on a first visit — it only forwards
activity that an earlier wallet session left stored. Both are recorded
separately as their own gap.

So the policy is unchanged, and it was doing its job — it caught a collector
that had never been declared anywhere in the project. The policy file and the
site's specification now both record why that address is deliberately missing,
so the next person to meet the error does not resolve it the quick way.

The console error itself is **not yet gone**, and nothing in this change makes
it go: the beacon is added by the hosting configuration, not by anything in the
project, so it stops only when an operator turns that setting off for the site.
Until then the browser console keeps showing the refusal — which is the safe
state, since the refusal is what prevents the unconsented collector from
running.

If the product later wants this kind of performance data, it can have it: the
route is through the same consent flow every other category uses, added as a
deliberate choice rather than as a way to quiet a warning.

## Two wallet apps stop reporting visitors to their wallet vendors

Wallet connection kits ship with their own analytics built in, reporting back to
the vendor unless an application explicitly turns them off. The project's rules
already require that they be turned off, so a visitor is not reported on for
usage they never agreed to, and so that people on restricted networks are not
subjected to a stream of failed background requests.

One of the three wallet-connecting apps had done this. The other two had not —
the requirement had simply never been applied to them, and nothing checked. Both
now switch the reporting off, using exactly the settings the working app already
uses.

### It was not only about the connect dialog

The rule was written as though the exposure begins when someone opens the wallet
dialog. It does not. These apps try to restore a previous wallet session as soon
as they load, and doing that means constructing every configured connector to
ask whether it has one — which is the moment each kit's reporting starts. So the
reporting covered every visitor to those two apps, including people who never
went near a wallet.

The two kits also behaved differently once switched on, which is worth recording
because it made the problem easy to misjudge from the outside. One reports on
each page load. The other reports nothing on a first visit and only forwards
activity that an earlier session had left stored — quieter, but on, and one
routine dependency update away from becoming as loud as the first.

### Why leaving the setting out was not the same as switching it off

For one of the two kits, omitting the setting and setting it to "off" look
identical in the source and are opposite in effect: the library treats an absent
setting as a request for its default, and its default is on. That behaviour also
changed between two adjacent patch versions of the same library, so reading a
copy that happened to be lying around gave the opposite answer to reading the
one the app actually uses. The settings are now written out explicitly in both
apps rather than left to a default nobody controls.

## The facet-size report now ranks, not just lists

An internal check that watches how close each part of the contract is to
Ethereum's hard size limit already warned when one got tight. It listed every
tight component in one flat group, which was fine when that meant one or two —
and stopped being useful once it meant seven, because the one with 32 bytes of
room left read exactly like the one with a thousand.

The report now separates the genuinely-out-of-room from the merely-close, and
puts the former first. Nothing about the pass/fail rule changed: a component
over the limit still fails the check outright, and one that is simply close
still only reports. The difference is that someone glancing at the output can
now tell, without doing arithmetic, which components are one ordinary change
away from blocking work — a situation that has already forced one component to
be split, and is currently holding up a fix on another.
