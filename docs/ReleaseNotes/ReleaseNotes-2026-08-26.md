# Release Notes — 2026-08-26

A day about a promise the protocol kept selectively. A lender who had paid for a
fee reduction received it on every route a loan could end well and lost it on
every route a loan could end badly — same lender, same purchase, different
outcome according to how the borrower happened to finish. That is now closed
across the recovery routes as well as the repayment ones, with the shared helper
moved somewhere both can reach it. Alongside it, two operational corrections
that share a theme: what an operator types on the command line now beats what a
configuration file says (#1932), and the M7 activation runbook gained three
preflight checks it had been missing while its review backlog went unread. The
day ends on an honest downgrade — the activation ceremony's ordering rule is
documented as the convention it is, rather than the guarantee it was described
as, with five procedures refuted and replaced by what the document can actually
promise.

# The lender's paid reduction now survives a loan that ends badly

A lender who paid for a fee reduction was getting it on every route a loan could
end *well* — repaid, closed early, refinanced, swapped — and losing it on every
route a loan could end *badly*. If the borrower defaulted, or the position was
liquidated, the full fee was taken from the interest recovered on their behalf.
Same lender, same purchase, different outcome depending on how the loan happened
to finish.

That is now fixed on all five of those routes: an ordinary default, a liquidation,
a discounted liquidation, a split liquidation, and a partial liquidation. Each of
them now applies the reduction to the fee taken from recovered interest, and
every wei the treasury gives up reaches the lender.

## A larger problem on one of those routes

Partial liquidation is the one route that recovers money without ending the loan,
and it was paying the recovered money to whoever the records still named as the
lender — not to whoever holds the position today.

On the routes that end a loan this is caught downstream: they record a claim, and
collecting against that claim checks who holds the position. Partial liquidation
deliberately records no claim, because the loan is still running. So there was
nothing behind it to correct the address, and if the position had changed hands
the previous lender simply kept the principal and the interest, with no way for
the new holder to ask for it.

This was never about the reduction. It was money going to the wrong person, and
it is fixed independently of any decision about the reduction itself.

Fixing it also changed **where** that money lands, for every partial
liquidation and not only for positions that changed hands: it now goes to the
lender's own wallet rather than into their vault. That is how the equivalent
step already worked when a missed periodic payment forces a sale, and it is the
route that handles a sanctioned recipient properly — it sets the payment aside
under restriction instead of failing the whole liquidation, which paying into a
vault could not do, because the platform will not open a vault for a restricted
wallet at all.

## And one route was reducing the right fee for the wrong person

Refinancing did apply the reduction, but resolved it against the stored lender.
It attempts to refresh that record first, but that refresh is allowed to decline
quietly — it is designed never to block a close-out — so on a position that had
changed hands the previous lender's holdings could set the size of a reduction
the buyer received, and once the token peg is configured, could be charged for it.
It now resolves against the current holder, like every other route.

## Why the same helper now lives in one place

The step that applies the reduction had been copied by hand into five separate
components and one shared module. This change would have made it nine. It is now
written once. That is not a size saving — the compiler inlines it either way —
but the early exit inside it is the part that decides whether a settlement
consults the reduction machinery at all, and six hand-maintained copies of that
decision is how they quietly stop agreeing.

## What this does not change

Nothing here is visible until the fee-entitlement switch is turned on, because no
loan carries the paid stamp before then. Turning that switch on remains gated, and
the checks for it stay manual — see the operator runbook.
<!-- assembled-fragment: 1383-recovery-paths-honor-lender-stamp.md sha256=2c86f261f2117a6fdefc3b34f9a702b8ab18ec7c1c3bb4bed10227e24fe94f4c -->

# The lender's paid discount reaches every repayment route — and none of the recovery ones

A lender who paid the optional up-front tariff on a loan earns a further
reduction of the fee taken from their interest. When that arrangement was
specified, several of the ways a loan can be settled did not yet apply it, and
the specification recorded all of them as outstanding — and as something that
must be resolved before the tariff can be switched on at all.

Most of them have since been implemented, and the specification had not caught
up. Closing early by handing the obligation to someone else, closing by
offsetting against a new position, repaying part of the amount, paying interest
periodically, and the automatic lifecycle path where the position has changed
hands all now apply the reduction, and all of them key it on the party actually
being paid rather than on whoever the loan first recorded as lender.

One entry on the old list turns out never to have belonged there. A rental loan
cannot carry the paid arrangement at all — the tariff is only ever charged when a
loan is originated in an ordinary token, and a rental pays no origination fee to
be tariffed alongside. There is no rental lender who paid and could be owed
anything, so that route is dropped rather than fixed.

What the review turned up instead is a set nobody had listed: the ways a loan
ends **without being repaid**. When a loan defaults, or is liquidated, whatever
interest is recovered still has the ordinary cut taken from it — and none of
those routes consults the lender's arrangement, so a lender who paid for the
reduction does not receive it. The original enumeration named only the repayment
and early-close routes, so the recovery routes were absent from that
IMPLEMENTATION list — not from the entitlement itself, which the frozen rule
already extends to every settlement of a lender's interest.

One of those routes does not even end the loan: a partial liquidation leaves it
running and still takes a cut from the interest it recovers on the way. It also
carries a larger problem than the missing reduction. Because the loan stays
open, that route pays the recovered money straight to whoever the records name
as lender and deliberately records no claim for anyone to collect against —
every route that does end a loan records one. So if the position has changed
hands and the tidy-up step declined to run, the previous lender keeps the money
itself, and the new holder has no way to ask for it. Putting that right is part
of the same work.

A second pair of routes was added to this list during review and then taken
back off it, and the reason is worth recording. When an NFT collateral position
is sold through the prepayment route, the settlement does pay its fee the plain
way without consulting the arrangement — but on that route the lender is not the
one paying it. The sale pays the lender the principal and the whole of the
interest, and the fee is a separate charge taken out of the sale price, which
comes off what returns to the borrower. Reducing it would hand the borrower
more, not the lender. Whether the arrangement should ever reach a charge the
borrower bears is a question for the owner, not a defect to fix.

One further route honours the arrangement but pays for it out of the wrong
pocket: refinancing resolves it against whoever the records still name as
lender. Where the position has been sold and the tidy-up step declined to run —
it declines rather than failing, by design — the previous lender funds a
reduction the buyer receives.

One route that earlier drafts of this note counted among the recovery
routes turns out not to belong there at all. When a periodic-interest
payment is missed and collateral is sold to cover it, the charge taken is a
handling fee on the sale proceeds, not a share of the interest — so there is
no yield fee on that route for the arrangement to reduce, and asking for one
would either discount an unrelated service charge or introduce a fee the
route does not levy. The count of affected recovery routes is five, not six.
The mistake is recorded rather than quietly amended: it had reached six
separate documents.

Two things follow that the documents had not said. The condition for declaring
this settled now spells out that a decision to leave recovered interest out of
scope would settle only the recovery routes' missing reduction. Two things
outlive it. The refinance defect is that the wrong party is billed, which such a
decision does not reach. And the misrouted payment on the partial route is not
about the reduction at all — it is money going to the wrong person — so it
remains to be fixed even though the route it sits on would be the one excused. And nothing automatic is checking any of it: the one
deploy-time check on the master switch confirms only that it ships turned off,
and the switch itself asks only which chain it is on. Confirming the settlement
work is live is a manual step, and a clean automated run is not evidence for
it.

The specification now says that plainly, and says what kind of thing it is. The
frozen rule is that the reduction applies at *every* moment a lender's interest
is settled; the four routes named beside it are the ones that were built, not a
definition of where the promise reaches. Recovered interest is lender interest —
the ordinary cut is taken from it — so the recovery routes are inside the rule
and simply do not honour it yet. That is a gap between the code and a decision
already made, not a question still open, and only the owner can narrow the
decision instead of closing the gap.

Two other documents said the opposite and are corrected with it: an internal
audit recorded this work as complete across *every* settlement path, and the
operator's switch reference told whoever throws the switch that this was "a
check, not a blocker". Either would have led someone to enable the arrangement
while a lender who paid for the reduction could still lose it, depending only on
how their loan happened to end.

Separately, tightening the milestone conditions turned up a slice of work
with no tracker: the ability for a maker to opt into the full arrangement on
a pre-signed offer was never delivered, but the card covering it was closed
when its other half shipped. The source still points readers at that closed
card. It now has an open one, so the milestone cannot close over it.
<!-- assembled-fragment: 1383-secondary-settlement-paths.md sha256=865e6253cf4891c605f8d689fb2598fc73631f7dca4b36edb72d987814eea7cd -->

## What an operator types on the command line now beats what a config file says (#1932)

The deployment scripts read the operator's command-line options first and then
load a shared settings file. Anything that file mentioned quietly replaced what
had just been typed. That worked in both directions: an option nobody passed
could arrive switched on because the file said so, and an option that was
explicitly passed could be thrown away because the file said otherwise.

Most of the affected switches are the ones that exist precisely because somebody
has to make a deliberate decision — which stage of a deployment to run, whether
to wipe an existing deployment and start over, whether the operator has reviewed
the live state a destructive step is about to abandon, whether the signing device
is the hardware wallet the process requires. Several of those are written into
the deployment record afterwards as evidence that the confirmation was given. A
stored setting supplying one of them would produce a record of a confirmation
nobody made.

An earlier change fixed exactly one of these switches. This one covers the rest,
and does it in a single place rather than switch by switch, so there is one rule
instead of eight copies of it.

Because that fix is a list of names, the list can fall behind the options it
protects — which is how the first fix left seven of them exposed. A check now
compares the two and refuses a deployment if they have drifted apart, in both
directions: an option missing from the list is the original problem returning,
and a name in the list that no option sets is protection for something that no
longer exists, which makes the list look more complete than it is.

Review then took the whole approach apart, three times over, and the answer
turned out to be much simpler than any of the attempts.

The settings file was never being read — it was being run. Everything in it
executes as instructions inside the deployment itself. So each attempt to let the
operator's choices win after loading it failed for a new reason: the file could
switch off the safeguards, make a value permanently unwritable so restoring it
failed, replace the command used to restore, or — the one that ended the argument
— simply supply a different command line, replacing what the operator typed
before it was ever read. Ordering could not fix that, because the file gets to
speak first either way.

The settings file is now read as data. Each line is taken as a name and a value
and nothing else; nothing in it can run. A line that is not a plain setting stops
the deployment rather than being skipped, because a skipped line is a setting the
operator believes is in effect and is not. Every attack found during review is
now either refused outright or stored harmlessly as text — including one that
tried to create a file, which no longer happens. A side benefit: values containing
a dollar sign, which is common in URLs carrying access keys, now survive exactly
as written instead of being partially expanded.

All four operator scripts that read the file were switched over, including one
nobody had raised and the local development playground, which had briefly been
made to require production settings it does not need.

Reading it as data turned out to be half the answer, and review caught me
treating it as the whole one. Not running the file stops it from rewriting the
command line, but it does nothing about an ordinary setting quietly replacing a
choice the operator made — which is the problem this started as. Having removed
the ordering on the grounds that it no longer mattered, I put it back: settings
are read first, choices are read second, so what was typed is applied last.

Then a stricter idea — allow only settings the platform documents, refuse
everything else — was built and withdrawn, which is worth recording because it
was withdrawn on evidence rather than taste. Checking mechanically what the
deployment actually configures turned up sixty settings it would have refused:
the artwork for position tokens, the test-token faucet, vesting, governance
roles, liquidation routing, and the wrapped-ether address on every chain. Each
one stops a documented step. Review had found two of those sixty by reading, over
two rounds, so shipping the rest would have meant finding them one failed
deployment at a time.

What remains refused is a small set of settings that another program would act on
rather than merely read. There are two kinds, and they fail differently. The
first is a name some program treats as an instruction to run something when it
starts — the deployment runs a shell, several language interpreters, the version
control tool and the package manager, and each of those has its own such names.
Some do it at one remove: rather than naming a program to run, they move the
directory a tool reads its own settings from, and the settings found there name
the program. Those are refused on the same footing, because the outcome is the
same.
The second does not run anything: it changes where an authenticated request is
sent, so a stale file can have the deployment deliver its own credentials to a
host of the file's choosing, or route every request it makes through one. Both
sets are open-ended and the change does not pretend otherwise; the wider work of closing it everywhere,
including in the written operator procedures that still execute the file, is
tracked separately. The reasoning for the split is the threat it defends against:
the file already holds the deployment's private key, so anyone able to edit it
has no need of a start-up trick. The problem this change was filed for is a stale
or shared file, and that is closed.

The check that keeps this honest asks one question — does any script execute the
file — and nothing else. Earlier versions of it tried to reason about where each
script reads its options, and every one of them certified something it was written
to prevent: one looked at a single style of option, one looked at only two of the
scripts, one could be walked around by writing the option parsing differently, and
one fired on nineteen ordinary lines because a full stop inside a printed sentence
looks exactly like the shell's own load command. A question with no moving parts
has nowhere to be wrong in either direction.

An earlier draft of this note, and of the specification, described a different
check — one that compared a list of protected options against the options each
script accepts. That check was removed when the approach changed, and both
documents kept describing it. They now describe what is actually there, which
matters more than usual here: this work exists because documentation that had
quietly stopped matching the code cost real time.

A last correction came from the repository's own guard rather than from review.
Two settings are documented as harmless to leave lying around — the deployment
forces them off itself — and the stricter reading would have turned that
documented harmlessness into a refused deployment. They are recognised, and the
forcing is what keeps them from deciding anything. A hardening change is not
allowed to break a behaviour the documentation guarantees.

A separate rule governs the settings the deployment scripts work out for
themselves — where the repository is, which directories each phase builds from,
which commit is being deployed. A settings file has no business replacing any of
those, and an earlier version of this change protected three of them by name. It
turned out there were a dozen more, and one of them is a directory a later
publishing step runs a build from. The scripts now record their own variable
names before they read anything, and the file is refused any name they created —
so the protected set is worked out from the scripts themselves rather than
remembered, and cannot fall behind as they grow. A script that skips that step
gets no settings at all, rather than the rule silently switched off.

One operator-visible behaviour did change, and in the safe direction. The
emergency pause tool and the testnet unpause drill both read a switch that says
whether ownership of the unpause has already moved to the timelock. They only
ever recognised the value one; anything else — the word true, the word yes — was
not rejected, it was quietly read as "ownership has not moved", and the operator
was then handed instructions that could not run on a chain where it had. Both
tools now check that switch once, as soon as the settings are read and before
anything decides on it, and stop with an explanation if it says something they do
not recognise. A declaration that is read as yes-or-no is now required to say one
or the other.

Nothing changes for an operator who was not relying on the settings file to
supply these switches, which is everyone following the documented process.
<!-- assembled-fragment: 1932-cli-flags-survive-env.md sha256=562d30c96f140146a7a650c5cbbf536e2207ea8e77180ab73a0b554e534370a2 -->

# M7 activation runbook — three preflight checks that were missing, and a review backlog that was never read

The written procedure for switching on the recycling programme gained a section
in August describing, step by step, what an operator must confirm before the
one-shot switch is thrown. That switch cannot be moved once it lands, so every
check that happens after it is a check that happens too late.

The review of that procedure raised a large number of points and almost all of
them were answered while the change was still being written. A little over a
hundred of the review's own conversation threads, though, were never replied to,
and nobody had gone back to establish which of them still described something
missing. That is the work this change begins.

Reading the procedure against each point, most turn out to have been addressed
already — the objection was raised, the paragraph was rewritten, and only the
unanswered thread was left behind. Three were not addressed, and all three share
a shape: a component reads back perfectly on its own inspection while the thing
the protocol actually consults points somewhere else.

The first is the canonical chain's own record of which reward messenger to use.
It is a different address from the cross-chain messenger the procedure already
told the operator to check, so checking that one and stopping leaves a stale
value in place — and both the daily reports and the broadcast that carries the
cutover day to the other chains go through it.

The second is the local binding between a channel and the contract allowed to
use it. Rotating any of the three participating contracts without finishing the
registration leaves every outward-facing check passing — addresses agree, peers
agree, nothing is paused — while each chain's own messenger still points the
channel at the contract that was replaced. The first send after the switch then
fails.

The third is the gas allowance each messenger attaches to its cross-chain
deliveries. Nothing validates it when it is set, so an upgrade can leave it at
zero, and every other check in the procedure passes while each delivery runs out
of gas on arrival.

Review of that change then made the same point about the fix itself, four more
times: the pass reads what the central contract believes, and each thing it
points at is separately settable from its own side. A rotation that updated one
side leaves the other naming what was replaced, and every check still passes. One
of the four is not stored state at all — the address a messenger routes through
is fixed into the implementation when it is built, so replacing the
implementation changes it while every stored value the procedure reads is
untouched.

Rather than add four more remembered items to a list that had already missed
three, the procedure now enumerates each participating contract's settable state
as a table and requires all of it to be read back — marking which entries earlier
steps already cover. The list of things to check is now derived from what the
contracts can actually be told to point at, rather than from what someone
remembered to write down.

Review then made three further points about that table, and the first is the one
that would have hurt an operator soonest: the procedure explicitly permits a
simpler variant of this ceremony in which the other chains carry none of this
machinery, and the new block did not say it was for the fuller variant only. An
operator following the simpler path would have been asked to inspect contracts
that were never deployed, and would have had no way to finish. It is now marked
for the branch it belongs to, with an instruction to skip rather than attempt it.

The second is that matching readings are not sufficient when something has just
been replaced. Deliveries already in flight are directed at their destination
when they arrive rather than when they were sent, so one sent to the old
contract, and anything it carries, is handed to the replacement instead — and
every reading still agrees. The contract itself says this is a procedure to be
written down here rather than something it can enforce, so the procedure is now
written down here: quiet the channel, let what is in flight arrive, then change
the binding, and settle anything that already failed before trusting the new
readings.

The third corrects a claim in our own new text, which said the table enumerated
everything settable. It enumerates the settings — not the people who can change
them afterwards. Each of these contracts has an owner who can rewrite every one
of those fields and authorise a replacement of the contract itself, and a
guardian who can halt the transport, and both can act after the check has passed
and after the switch is thrown. The earlier ownership check in the procedure
covers the main contracts as they were handed over, and says nothing about one
replaced since — which is exactly the situation this section is about. Those are
now read back too.

Two more followed from those additions. The first is that "check who owns it"
was not precise enough to be safe: ownership transfers here happen in two steps,
and only the second one clears the name of whoever was about to take over. A
contract can therefore be owned by governance and still have another key waiting
to claim it — at any moment, including after the switch, at which point that key
holds every setting and the power to replace the contract. The procedure now
names both expected values rather than one, and the same omission in the earlier
ownership check elsewhere in the document is fixed with it.

The second concerns a lookup the transport keeps in both directions. The reverse
direction was added later, so a contract upgraded from the earlier version
carries it empty until a migration is run over a list of pairs the operator has
to reconstruct from the event history — the contract cannot enumerate its own
configuration. While it is empty, the rule that one counterpart belongs to one
channel is not enforced, and a replacement performed during this very ceremony
can quietly attach a live counterpart to a second channel and leave one route
rejecting everything. Three existing deployments are in that state today, so this
is a migration to confirm rather than a hypothetical.

A further round found that the table's own right-hand column — the one marking
which entries earlier steps already cover — had not itself been checked. Two of
those "already covered" marks were wrong. The pair of lookups that translate
between a chain's ordinary identifier and the one the transport uses are read
nowhere in the procedure, in either direction, and every other check passes with
a stale one; and the entry authorising the chain that sends the funds arrives on
a different channel from the one carrying the announcements, so a single line
about "the peers" covered one and read as covering both. Both are now their own
requirements. The lesson is the obvious one: a table that records what is already
covered has to have each of those claims verified, or it becomes a more confident
version of the list it replaced.

Two smaller corrections came with it. The ownership assertions were scoped to the
contracts that carry a pause guardian, which quietly exempted the one that sets
every lane's rate limits and can authorise its own replacement — they now apply
to every contract the handover transfers, with the guardian check kept only where
there is a guardian. And the instruction to let in-flight deliveries finish
before changing a binding was not something an operator can observe: it is now a
reconciliation of every message sent since the last known-good point, each of
which must have arrived or been explicitly dealt with. A message still pending is
a blocker rather than a delay, because the transport will deliver it eventually
and eventually is after the change.

Three corrections then landed on those corrections, and each is the kind that
only shows up when someone tries to actually perform the step.

The ownership check had become an instruction that cannot be carried out on one
of its nine targets. Eight of them are built on one widely used ownership
library, which lets anyone read who is waiting to take over; the ninth uses the
transport vendor's own version, which keeps that value hidden and offers no way
to read it. The blanket instruction would simply fail there — and an operator who
hits that either stops, or quietly drops the check on the one contract that
controls the token's transfer pools. It now has its own path, established from
that contract's published history of ownership handovers instead.

A second transfer had been missed entirely. Alongside the ordinary ownership
handovers there is a separate two-step handover of the right to designate which
pool the transport uses for the token. None of the ownership readings touch it,
so skipping its second step leaves the original deployer able to swap that pool —
after every check has passed, and after the switch. Both of its values are now
read back.

And the drain instruction had grown an escape hatch that does not close anything.
It allowed a stuck delivery to be "abandoned with the reason recorded". A failed
delivery here stays re-executable indefinitely and there is no way to cancel one,
so an abandoned message can arrive after the rebinding and be handed, with
whatever it carries, to the replacement — the exact outcome the drain exists to
prevent. The only terminal state is a delivery that succeeded, and the procedure
now says so.

Three more followed, and one of them moved this work out of documentation for
the first time.

The procedure had grown a check with no step able to satisfy it. The separate
handover of the right to designate the token's transfer pool has a second leg,
on a different contract and with a different name from all the others, and the
step that walks an operator through completing handovers only ever mentioned the
common one. So the new verification would correctly report the problem and leave
the operator with nothing in the document to do about it. That second leg is now
written out where the others are.

The instruction for reading the one contract whose pending owner cannot be read
directly needed an exception. Cancelling an outstanding handover there is done by
requesting a transfer to nobody — which is recorded like any other request, and
can never be followed by a completion, because nobody cannot accept. Read
literally, the rule would have failed a contract whose handover had been safely
cancelled. That case is now named as a settled one.

And the test that the procedure names as its pre-release gate did not test any of
this. Its stand-ins were two contracts of one shape; it never checked whether
anyone was still waiting to take ownership, never included a contract without a
pause guardian, never covered the one whose pending owner is unreadable, and did
not know about the pool-designation handover at all. It now carries all four
shapes and asserts each of the readbacks this work added — and, deliberately, the
before-state as well, so a passing run is known to mean the checks can fail.
Removing either newly added completion step from the simulated handover was
confirmed to turn the relevant assertions red.

A further round found four more, and the sharpest was against the new test rather
than the procedure. Checking that a value cannot be read is not the same as
checking the thing that value was for: the substitute check confirmed the missing
reading and never exercised the history-based rule meant to replace it, so the
gate stayed green for precisely the dangling-takeover state the rule exists to
catch. The rule is now exercised over its completed, still-outstanding and
cancelled cases — and, after a deliberate attempt to break it survived, over one
more: a contract whose ownership genuinely completed to an address once, came
back, and was later offered to that same address again. Without that case, a
version of the rule that ignored the order of events passed everything.

Three procedural corrections came with it. The newly added acceptance step is
conditional — the handover script skips that transfer entirely when the signing
key is not the current administrator, which is a supported situation, and
scheduling the acceptance anyway simply fails; the procedure now says to confirm
the transfer is actually pending, and what to do when it is not. The rule that a
switched-off transfer limit means "no limit" needed a precondition: a limit that
was never configured for a route reads identically to one deliberately switched
off, and the transfer then fails for an unrelated reason the limits know nothing
about — so the route's existence is confirmed first. And the contract that holds
the token has a second authority besides its owner: a separate address permitted
to rewrite those transfer limits directly, which is deliberately set to the
bounds-checking governor and was never read back. A stale one there could rewrite
both limits, immediately before or after the switch, with none of the intended
bounds applied.

All of this is read back before the switch, in the same pass that already
verifies the wiring rather than the components, and the design record carries the
same additions so the two documents do not drift apart.

A further pass added six more readbacks in the same spirit — each a pointer or a
principal that every other check can pass while it alone is wrong. The transfer
route now confirms that each pool actually lists the live peer pool at the far
end, so a redeployed peer cannot slip through a healthy-looking lane that then
rejects its first delivery; that the pool's own message router — separate from,
and independently changeable from, the adapter's — is the live one; and that the
rate-limit governor and the live pool name each other, not merely that the pool
names the governor, so the limits stay tunable after the switch. The mirror token
is now checked for the same controlling principals as the other cross-chain
contracts — its owner can hand the sole mint authority elsewhere and its guardian
can freeze it — rather than only for which pool it mints through. The unpaused
check now covers the participating settlement contracts on each chain, not only
the transport contracts, because the remittance itself refuses to move while
either end is paused. And the conditional-acceptance caution, previously stated
only for the token-administrator transfer, now applies to every ownership
transfer the same script can skip, so an operator does not schedule an acceptance
that will simply fail and leave a contract outside governance.

The remaining review threads are being worked through the same way — each one
checked against the procedure as it now stands, and answered with what was
found. The count of genuinely outstanding points is an outcome of that pass, not
something to be asserted ahead of it.
<!-- assembled-fragment: 1940-m7-runbook-triage.md sha256=9c773809ebbe8f798944e099226763f81d7cc4fc85bae3dd07c038ffd73107ed -->

# The activation ceremony's ordering rule is a convention, not a guarantee

Part of the ongoing review of the activation procedure for the recycling
programme (see the M7 runbook triage).

The procedure tells an operator to send each chain its funding, wait for each to
confirm arrival, and only then announce the cutover day — because the
announcement is what opens the door for users to claim, and the funding is what
makes claims succeed. Doing it the other way round opens claims against funding
that has not arrived — and while the outstanding fund-safety item is undeployed
on a chain, that is not a harmless failed claim but a payout measured against a
balance that includes collateral belonging to borrowers.

The step that announces the day, though, can be triggered by anyone. It is
restricted to the main chain, not to the operator — the check is about which
chain the call arrives on, not who made it. So between the moment a day is
finalized and the moment the last chain confirms its funding, any account willing
to pay the messaging fee can announce it, and every claim gate opens early. No
amount of care on the operator's part prevents that, because the ordering was
never theirs to enforce.

The first attempt at a remedy was to remove the window by re-ordering the
ceremony — doing the funding and its confirmations before the irreversible step,
so the announcement afterwards had nothing left to open early. Review showed that
does not work, and would have made things worse.

It does not work because the only thing an announcement needs is for the day to
have been closed off for accounting; whether the cutover has happened is
irrelevant to it. So the announcement remains available to anyone from the moment
the day closes, on either side of the re-ordering.

It would have made things worse because a chain that receives the announcement
*before* the cutover records that it has already handled that day, and later
handling of the same day stops early — before the part that would have told it
the cutover date. The announcement the procedure relied on would therefore be
silently ineffective for that day. An ordering meant as a fix would have given
anyone a way to interfere with an irreversible step.

Two further corrections landed on that correction, and both matter to an operator
in the room.

**A spent day is not a lost chain.** An earlier draft said a chain in that state
could not be brought in at all. It can: every freshly assembled day carries the
current cutover date, so announcing a different untouched day works normally.
Only running out of eligible days is unrecoverable. Saying otherwise would have
had someone treat a fixable situation as ruined.

**And there is an enforceable gate after all — but it is narrower than it first
looked.** The messenger that carries these announcements can be paused by its
guardian, and pausing it does not stop the funding transfers, which travel a
different path. So the funding and its confirmations can be completed while
announcements are impossible, and the pause lifted immediately before announcing.

That closes the gap for the day being prepared, and only for that day. An
announcement may name any day that has been closed off for accounting, so the
moment the pause lifts, someone can announce a different one that is neither
funded nor yet handled on that chain — reaching the same exposure by another
route. The procedure therefore says to leave the messenger paused until the
property that matters holds — that a claim against a day whose funding has not
arrived cannot consume value belonging to anything else, which deploying the
outstanding fund-safety item does not by itself guarantee — for the whole mesh,
not one chain, because the
pause is global and the single-destination form of the announcement can name a
chain that was removed from the list. Reconciling every announceable day first
was considered and does not work; the reasons are below with the rest of the
dead ends.

There is one further trap in the mechanics. Lifting the pause is an owner action,
which after governance handover means a scheduled action with a delay — and the
timelock as deployed by default lets *anyone* execute a scheduled action once its
delay expires. Queuing the unpause in advance therefore hands away control of
when it happens: if the funding is still in flight at that moment, someone else
can execute the unpause and announce against an unfunded chain. The procedure now
does not offer this route at all on a chain that is still unfixed. Restricting
who may lift the pause controls only the lifting: closing a day off for
accounting is itself something anyone can do, so a fresh day can appear after any
check, including in the moment the lifting happens. Both the restricted-executor
version and the queue-late-and-watch version are in the dead-end list below, with
that reason.

Two smaller things were wrong in the same direction. Pausing does not reach an
announcement already on its way: one dispatched moments earlier still arrives and
takes effect, so the outstanding ones have to be accounted for individually
before the pause counts as a gate. And a day that has already been announced
without funding is not "handled" — its door is already open, and pausing the
sending side does not close it; only funding it, or containing the receiving
chain's claim path, does.

**The severity was also understated.** While the outstanding fund-safety item is
open, a claim arriving at a gate opened ahead of its funding does not simply
fail: the figure the payout is measured against is computed from the contract's
whole balance minus a few known reservations, and the balance has other owners —
including collateral belonging to borrowers. So an early announcement can result
in someone being paid out of that collateral, and it can happen before the
ceremony's own check for the fix is ever performed. This is treated as something
to contain now rather than a hazard scheduled for the activation day.


## A second gate that only bound one step

The same review pass found that the switch which turns on the expiry-and-sweep
behaviour carries its own list of things to confirm first, and that list was
missing one of them. The condition in question — an open fund-safety item about
how reward payouts are bounded — is written down as a blocker on the irreversible
activation step, and correctly so. But the sweep switch is deliberately separate
and may be thrown later, on its own; a condition attached only to the earlier
step does not reach it.

That matters because turning the sweep on moves more value through a balance the
programme shares with other claimants, two of which are user collateral. Until
payouts are bounded by what was actually delivered for rewards rather than by
whatever the balance happens to hold, enabling the sweep widens exactly the
exposure the activation gate exists to hold shut. The condition is now listed in
both places, with a note that deferring the step does not defer the condition.


## Five procedures, all refuted — and what the document says instead

Successive review rounds refuted every operational procedure built on the pause,
and each refutation was correct. Re-ordering the ceremony does not help, because
announcing a day depends only on the day having been closed off. Pausing, funding
the day in hand, and unpausing does not help, because the announcement may name
any closed day and unpausing frees all of them at once. Reconciling every such day
first does not help, because a day already announced without funding is already
open and closing a day off is something anyone can do at any time. Containing the
receiving chain's claims meanwhile does not help, because the same single switch
that stops claims also stops the funding arriving — so the condition being waited
for can never be met. And restricting who may lift the pause does not help,
because that controls only the lifting, not what someone else may have created in
the meantime.

The procedure therefore stops offering alternatives and states the one branch
that survives, and it is **mesh-wide, not per chain**: while any chain the
announcements can reach lacks the property that matters — that a claim against a
day whose funding has not arrived cannot consume value belonging to anything
else — the whole sender stays paused and nothing is propagated anywhere. It
cannot be narrowed to the unsafe chain, because the pause is a single switch and
lifting it for the others also re-enables the single-destination form, which can
name the unsafe chain directly. The outstanding fund-safety item does not by itself
guarantee that; some of its permitted remedies protect borrowers' collateral
while still letting such a claim take another day's reward funding.

Two chains are exempt from that block rather than caught by it, and saying so
matters as much as the block itself: one whose route has been fully dismantled
cannot be reached at all, and one that was removed from the lists and whose
qualifying history has already been used up cannot be reopened. Without those
exemptions an operator would stop all reward messaging indefinitely over a
retired chain. That is
expensive — it stops other reward messaging and leaves the chain out of the
cutover — and it is the only option in the list that has not been argued away.
The five that were is kept in the document as a dead-end list, with the reason
each fails, so nobody re-derives them under time pressure.
<!-- assembled-fragment: 1940-permissionless-broadcast-race.md sha256=9b1370e4409bf645f2ad37c06632ddcca299c018718ebf1365c9346ab0882cd6 -->
