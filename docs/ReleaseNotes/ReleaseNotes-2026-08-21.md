# Release Notes — 2026-08-21

A day about telling users the truth about their own money.

The largest piece retires a promise the public pages had been making to
borrowers — a VPFI rebate that, under the current fee model, cannot arrive. The
correction runs through the documentation and site copy — whitepaper, overview,
both user guides, the FAQ and the localized interface strings — in all ten
languages, and it scopes the retired mechanism rather than deleting it, because
the loans opened while it was live are still settled on that basis when they
close. Several surfaces inside the connected app are deliberately not part of it
and are listed below, so this is not yet a complete sweep of everything a user
can read.

Alongside it, the same review kept finding a second and sharper class of
problem: pages a reader could follow to the letter and still be charged the full
fee, and pages that told a borrower their collateral was gone when it was
sitting claimable in their own vault. Correcting those turned out to be harder
than removing the original promise, because the first few corrections were
themselves wrong — each one enumerated the routes a loan can close through, and
each was overtaken by a route it had not heard of. What finally worked was to
stop enumerating and state what the answer turns on.

The rest of the day is verification work on the lender's exit options: a card
that shows what selling early would cost and treats waiting as a real choice,
now able to say whether it has finished deciding, plus three fixes that stop the
wallet-analytics checks from passing without having looked at what shipped.


## Lenders can now see what their options are — including doing nothing

If you have lent on a loan, the position page now opens with a card called
"Your options as the lender", listing every way out of the position along with
what each one costs.

Until now, a lender in the simple view saw **nothing at all** about this. The
sale tools existed, but they lived behind the Advanced view, so unless you had
already switched over you would not learn that selling your position early was
possible, what it would cost, or that waiting is itself a choice. The card is
informational only — it never submits anything, and each row points at the tool
that does the actual work.

**Waiting is listed first, on purpose.** For a borrower, the useful thing to
surface is the ways out of a debt. For a lender the situation is reversed: the
position is already the thing that pays you, so the option that costs nothing in
forfeited interest is to leave it alone. The card says so before it says
anything about selling.

With one exception the card now states: **while a listing of yours is standing,
waiting is not the free default.** Doing nothing does not keep the position —
a buyer can complete your listing at any moment, at the costs the sale rows name
two lines below. So the wait row says that, and says cancelling the listing is
what makes waiting free again. It does not read as unavailable, because waiting
is not refused — cancelling is the way back to it. Before this the card managed
to say "a buyer can still complete this and here is what it takes from you" and
"costs nothing — this is the default" about a single live listing, on one
screen.

That row is careful about two things. It never promises you will be repaid — it
says what happens *if* the borrower repays, and what happens if they do not.
And it describes **when** you get paid based on the loan's own schedule rather
than assuming: on a loan that settles interest periodically you are paid during
the term, not only at the end, so the card says that instead. The same applies
on a loan with no periodic schedule that nonetheless allows the borrower to
repay in parts — each part reaches you when it is paid, so the row says money
can arrive before maturity rather than claiming you are paid only at the close.
While it is still reading the schedule it says so rather than guessing, because
guessing would tell you something about your own money that is not yet known.
And if that read *fails* rather than merely being slow, it says so instead of
leaving a "still checking" line up indefinitely — an answer that is not coming
should not be dressed as one that is. It says plainly that the failure does not
change what you are owed, only when it arrives, and it offers reloading, which
is a recovery that can actually work because the read is a live one. An earlier
version pointed at the loan's own terms instead; that was worse than saying
nothing, because the terms shown on the page carry the rate, the duration and
the due date and have never carried the interest schedule — so it sent the
reader somewhere that could not answer, and they only found out after the trip.

**Each sale row states its cost before you open anything**, and states all of
it: selling early costs the larger of the interest built up so far or the
buyer's rate top-up — never both — and on top of that, any balance already being
held for you on the loan transfers to the buyer and your pending reward entry
for the position is given up. A cost line that mentioned only the interest would
read as complete while omitting an amount that can be larger than it.

The row is careful about **which** of those you can actually see a number for.
The interest-or-top-up figure is shown by the sale tool, and the row says so.
The other two are not shown as amounts anywhere yet — not on this card, and not
in either sale tool, which display only the payout and the settlement cost — so
the row says that plainly and suggests checking your held balance and rewards
before selling. An earlier version sent you to the tool "for the actual
figures", which was worse than saying nothing: the tool does show a cost figure,
a narrower one, and it would have read as the complete cost precisely because
the card sent you there to find it. Putting numbers on those two is separate
work; promising a page that already had them was the mistake.

One position type pays a fourth thing, and the card now says so. If your
position is on the Full fee plan — paid for in VPFI when the loan opened — that
plan is recorded against the loan rather than against whoever holds it, and
nothing about a sale cancels it. So it goes to the buyer along with the
position, and the part of it covering the rest of the term is value that is not
refunded to the seller. The card names it on both sale rows and, like the other
two, does not attempt to price it.

Note the wording avoids saying **you** paid it, and that is deliberate rather
than fussy. Because the plan is keyed to the loan and not to a holder, a lender
who acquired this position by transfer or by buying it from an earlier lender
inherits the plan without ever having paid its tariff. Telling every current
holder they paid for it would hand exactly those lenders a false idea of what
the position cost them, at the moment they are deciding whether to sell it on.

Those cost lines stay visible **while a listing of yours is standing**, even
though the rows themselves then read as unavailable. A live listing is not an
option you declined — it is a sale in flight that a buyer can complete at any
moment, so the held balance transferring and the reward entry being given up are
pending consequences rather than hypothetical prices. Nothing else on the page
states them, so the card keeps saying them while the listing stands.

One limit on that, worth stating because it is the direction the card currently
errs in: a listing that **expired without selling** still holds the position
until you cancel it or someone runs the cleanup, and during that window no
buyer can complete — so the losses are no longer pending, but the card carries
on naming them. It is telling you about a cost you can no longer incur, on a
row that already reads as unavailable. Saying too much rather than too little,
and being fixed with the other listing-state work rather than guessed at here.

The listing row goes further and says something sellers routinely do not expect:
while your listing stands it also freezes two of the *borrower's* options on
that loan — the protocol refuses their collateral withdrawal and their offset
exit, both to protect the terms the buyer signs. Their repayments stay open.
And the freeze does not lift on its own when a listing expires: it lasts until a
buyer completes, you cancel, or someone runs the cleanup that clears an expired
listing.

**Rows that are unavailable explain why, rather than disappearing.** A vanished
row reads as "no such option". So the card names the reason instead: the listing
tools are not deployed on this network, the collateral is an NFT and listing
currently supports ERC-20 collateral only, or the position is already listed
(with a pointer to the card that can cancel it — and where this device cannot
recover the listing's record, the row says the listing stands without promising
a cancel it cannot deliver — and where the reason is that we simply could not
confirm you still hold the position, it says *that*, rather than telling you the
listing was made somewhere it may well not have been). A loan settling through
its fallback path also blocks both sales, since a sale can only start on a loan
running normally; the card stays, because waiting still applies. Two more
reasons are operational rather than
positional: while the details a sale needs before it can start are still being
read, both sale rows say so, because the tools themselves do not appear until
those reads land — and if one of them fails outright, the row says that instead,
so the wait does not run forever. It deliberately does **not** say which detail
was missing. Naming it went wrong three times in review, each time blaming a
read that had actually worked, and a lender can do exactly one thing about any
of them — reload — so the name was detail they could not use attached to a claim
that could be wrong. And if the operator has
paused new listings on a deployment while looking into an issue, the listing
row says that too, and says your position is unaffected. And if the loan's due
date cannot be confirmed at all, both rows say **that**, rather than quietly
treating an unanswered check as "not due yet" — a sale cannot be started past
the due date, so a card that guessed there would be guessing about the one fact
that closes both exits. Past the due date both sale rows say plainly that
the loan is now resolved by repayment or the default process — no new sale can
be started — so you are not sent looking for a narrower fix that could not help
anyway.

Two limits worth stating plainly. The "sell now" row does not yet tell you
whether a matching buyer exists right now; finding that out requires a sweep of
every open offer, and doing it for every lender who merely opens a page would be
a poor trade. Rather than guess, the row makes no claim and the tool it points
to does the real check. In the advanced view that sweep has in fact already run
— the sale tool does it — so there the row is holding back an answer that
exists rather than one nobody has; reusing it is follow-up work, and the cost
meanwhile is a scroll to a tool that immediately tells you the market is empty. Separately, two further reasons a
listing can be refused — a position carrying an unresolved VPFI balance, and a
borrower whose own offset exit is already pending — are **not** yet shown on the
card: neither has a cheap client-side read today, so both still surface when you
try rather than up front. Wiring them is tracked as follow-up work; the card is
built to take them without restructuring.

Two things about **when the card appears at all**, both of which err towards
saying nothing rather than saying something wrong. It is shown to whoever holds
the lender position, which is not always the person the page thinks of as "the
lender" — someone holding both sides of a loan gets it too. And if the check of
who holds the position **fails**, the card and the sale tools go away until the
next successful check, rather than staying up for whoever held it last time we
looked. A position can change hands between two page loads; a card that outlives
the check offers exits to a wallet the protocol will refuse.

Finally, the simple view no longer sends you to the advanced one to discover bad
news. If the figure both sale tools need to price an exit cannot be read on this
deployment, the simple view now says so directly — previously it showed both
rows as available, offered the switch to the advanced view, and only then turned
them to "couldn't be read". The switch was an invitation to find a dead end.

The card is available in all nine translated languages.

## The review sweep stops filing a configuration defect under "environmental noise"

The automated review sweep sorts what it sees into problems with the app and
things that are merely background. A refused analytics script had been filed
under background, which was a mistake — and one this project had just finished
arguing against in the surrounding work.

That script is inserted into every page by the hosting configuration, and the
site's security policy refuses it. The refusal is the correct behaviour: the
collector is added after the page leaves the application, so it cannot be held
back until a visitor consents to analytics, and the rule the project settled on
is that such a collector must be switched off where it is injected rather than
allowed through. Filing the resulting message as background noise treated a
configuration defect as weather — and, worse, would have quietly swallowed the
same message if the injection were ever switched back on after someone turned
it off.

The sweep now names it. Once per run, not once per page, it reports that the
injection is on, how many pages are affected, that the refusal is correct while
the injection is not, and where the fix belongs. Loud enough to act on, quiet
enough not to drown the rest of the report.

It also fails the sweep, which was the harder half of the decision. The first
version only warned, reasoning that the remedy is a hosting setting rather than
a change to any file in the project, so a failure would block work nobody
reading it could unblock. Review pushed back and was right. This sweep runs
after a deployment, not before a merge, so it blocks nothing — and the person
reading its verdict is the one who can change the hosting setting. Meanwhile
the batch that collects these runs reads a clean exit as a pass, so warning
only would have placed a confirmed privacy defect inside a green summary. Where
the fix lives decides who does it, not whether a run that found the problem may
call itself clean.

### Watching for the refusal was not enough

The first version noticed the problem by watching for the browser's complaint
that it had refused the script. Review pointed out that this goes quiet in the
one case that matters most: if the site's own security policy were ever
missing, out of date, or widened to let this collector through, there would be
no complaint to notice — and the collector would be running for real. The check
would have turned green at the exact moment the problem got worse.

It now watches for both, by two separate means: the browser's refusal, and a
reply actually coming back from the collector. Either one fails the run, and
they are reported differently, because the remedies differ — a refused script
means one thing to switch off, while a collector that answered means the
security policy is not doing what the project believes it is doing, and both
need attention.

Which signal to watch was measured rather than guessed, and the obvious choice
was wrong. A refused script still counts as an attempt, so watching for
attempts would have accused today's correctly-behaving deployment of running a
collector it in fact blocked — a false report of the worse problem, inside the
check whose whole purpose is to report this one honestly. Watching for the
*reply* separates the two cleanly. Confirmed against the deployed site in both
states: as it stands today, and again with the security policy deliberately
disabled to produce the case under discussion.

### A detail worth keeping

The problem is a property of the deployment rather than of any particular page
— every page sees it — so the report counts the affected pages and mentions the
total once, instead of repeating itself for each one. Reporting per occurrence
would have produced a number that says more about how many pages the sweep
happened to visit than about the problem.

## The wallet-analytics fix is now checked against the deployed apps, and the check can prove itself

Switching off the wallet kits' built-in reporting was verified, when it shipped,
only by the compiler accepting the settings. That confirms the settings exist;
it says nothing about whether the reporting actually stopped. A committed check
now answers the second question against the deployed sites.

It loads each connected app with no wallet installed, never touches the connect
dialog, and watches for any request to the vendors' reporting addresses. That is
the right moment to look: the reporting does not wait for someone to open the
wallet dialog. The apps try to restore a previous wallet session as soon as they
load, and doing so builds a connector before asking whether it has a session to
restore — which is where that kit's reporting begins. In practice one of the two
kits is built this way and the other is not, which is why the check speaks about
them separately rather than as a pair.

All three connected apps come back silent.

### Why the silence is believable

A check that watches for something and finds nothing is worthless if it could
not have seen that thing in the first place — a failure this project has been
bitten by before, and the reason the checks here are built to be calibrated
rather than trusted.

So this one was calibrated against the broken configuration. With the setting
removed, on a local copy, a single page load produced two reports to the wallet
vendor before any wallet was involved. Restoring the setting on the same copy
produced none. That before-and-after is recorded in the check itself, along with
instructions to repeat it if the check ever goes quiet for a reason that seems
too convenient.

It also confirmed, rather than assumed, the claim that prompted the change: the
reporting really did cover every visitor, not only those who reached for a
wallet.

### It refuses to report a pass it cannot justify

Review pointed out that the check could still have passed without testing
anything: asking a browser to open a page succeeds even when the server returns
an error page, and waiting a fixed time proves nothing about whether the app
ever started. A broken deployment would have looked identical to a clean one.

It now requires evidence that the thing under test actually ran before it will
report anything: the page must load successfully, the app must have rendered,
and the wallet kit must have left its own fingerprint in browser storage —
which only happens if the kit was constructed, which is the moment the
reporting would begin. Anything less is reported as "not verifiably exercised"
rather than as a pass. Confirmed by pointing it at a page with no wallet
support, which it correctly refuses to bless.

That refusal is also counted separately from a real failure. An earlier version
lumped the two together and announced that a page had sent tracking data when it
had done nothing of the sort — a false accusation inside a check about honest
reporting.

### One thing it deliberately does not claim

The second kit is not tested at all. It turns out not even to be started when
the page loads, and it would stay quiet on a first visit in any case, since it
only forwards activity an earlier session left behind. So the check now reports
each kit separately and says plainly that this one was not exercised, instead of
printing one line that would let a reader assume both were covered. Closing that
gap properly needs a real returning-visitor session, and is recorded as its own
piece of work rather than approximated with invented data.

Still outstanding, and not claimed anywhere: nobody has yet completed a real
wallet connection on these apps since the change. The settings could be correct
and the connect flow still broken, and only a person with a wallet can tell.

## The wallet-analytics check now also reads what actually shipped

The check that watches for wallet kits phoning home could only ever speak for
one of the two kits. The other is never started when the app loads, and even
when it is, it stays quiet on a first visit — it forwards only what an earlier
session left behind. Its setting could therefore have been switched back on and
every observation would still have come back clean. The check said so plainly
rather than implying coverage it did not have, and the gap was recorded as work
of its own.

That gap is now closed from the other side. Alongside watching the traffic, the
check reads the JavaScript the deployed app actually serves and confirms both
kits' settings are present in it. No wallet and no returning visitor required.

The two kinds of evidence are reported separately, on purpose. Watching traffic
shows behaviour. Reading the shipped code shows configuration — it proves the
setting was published, not that the vendor honours it. Presenting either as the
other would overstate what was established, which is the mistake this whole
line of work exists to avoid.

### Why it refuses to excuse a missing setting

The tempting version of this check would let a deployment off when it has no
second kit to configure — that kit is only included when the app is built with
an identifier for it, and a build without one has the whole block removed before
it ships. An earlier draft tried exactly that, and the attempt could not be made
sound: the wallet library generates its own near-identical configuration, so any
signal claiming "our settings block is present" can be produced by library code
instead.

So the check does not guess. It confirms a setting is there, and when one is
missing it says so plainly, naming both possible reasons and leaving the
judgement to a person. That direction is the safe one: a deployment that
legitimately omits the kit costs someone one look, whereas excusing absence
automatically would have excused a genuine regression on exactly the same
evidence.

### Scope

The connected app being promoted is the target that matters, and it passes on
both kinds of evidence. The check still takes any address, so a sibling
deployment can be examined when there is a reason to.

Still outstanding, and not claimed: nobody has completed a real wallet
connection since the settings changed. Configuration and quiet page loads are
both consistent with a connect flow that is broken, and only a person with a
wallet can rule that out.

## The lender's options card now says whether it has finished deciding

The card that lists a lender's ways out of a position has always had to answer a
question before it can render: is any of these options actually available right
now? While it is working that out, the shortcut into the detailed tools is not
shown — and when the answer turns out to be no, it is not shown either.

From inside the app those two situations are obviously different. From outside —
to anything checking that the card behaves correctly on a real position — they
look identical, because the only evidence either way was the absence of a
control. That left post-deploy review with two bad options: wait a fixed length
of time and then assume the answer had arrived, or treat every quiet card as a
possible fault.

The card now states its own answer: whether the decision has settled, and what
it settled to. Nothing about the page looks different — no wording changes, no
new controls, nothing moves. The card simply stops keeping to itself something
it already knew.

**A failed check is reported as its own answer, not as either of the others.**
If one of the reads the sale options depend on fails outright, the card has
finished deciding — a reader should not be left waiting — but "finished" is not
the same as "the answer is no". A review that treated those alike would report a
position as having no exits available when the truth is that we could not tell.

Two things deliberately do not count towards the decision being settled. One is
the loan's interest schedule: it changes how the waiting option is worded and
nothing else, so waiting on it would hold up an answer it cannot affect — and on
a position whose schedule never loads, the answer would never come at all. The
other is a check that will never run: on a position where the app does not sweep
the market for buyers, and on one where the listing record cannot be read at all,
there is nothing to wait for. Treating a permanently-unanswerable check as
"still coming" would leave the card looking undecided forever.

The reason this was worth doing is that the alternative had already been tried.
Reviewing this card against a live position currently costs forty-five seconds
per page of waiting for an answer that may already have arrived, and three
separate classes of mistake in that review have traced back to guessing at an
absence rather than reading a fact.

## The public pages no longer promise borrowers a rebate that cannot arrive (#882)

The whitepaper and the user guides told borrowers that their Loan Initiation Fee
discount arrives as a **VPFI rebate paid when they claim** — that the full fee is
taken in VPFI up front, held for the life of the loan, and partly returned at
settlement.

That stopped being true when the fee model changed. A loan opened today has the
discount applied **directly to the fee it pays in the lending asset**, at the
moment the loan is accepted. No VPFI is taken to pay it, nothing is held, and
there is no rebate. A borrower reading the old pages would have been waiting for
money that could never arrive — and would have had no way to discover that from
the pages themselves.

The documentation and site copy now say what actually happens, and say it in the same place
the old promise stood: the discount is a direct reduction, no VPFI leaves the
vault to pay the fee, and there is nothing to claim afterwards.

**The old mechanism is scoped, not deleted.** Loans opened while it was live
are still settled on that basis when they close properly — repayment, early
close, or refinance — and what is settled is sized by the borrower's discount
standing **at the moment of settlement**, not by an average over the loan's life,
so a holder who has since dropped their balance receives correspondingly less. If
such a loan instead ends in a default or a close-out liquidation, the held VPFI
is forfeited and there is no rebate at all, which the pages now say wherever they
describe those outcomes. A PARTIAL liquidation is not one of those endings: it
leaves the loan open, forfeits nothing, and a later repayment settles the rebate
as normal. Deleting the
description outright would have stranded the people it still applies to.

**One thing deliberately not over-corrected.** Where the optional per-party
tariff is enabled, VPFI genuinely does leave the borrower's vault at origination.
The correction says so rather than flattening everything into "no VPFI ever
moves", and states the three things that make the tariff different from the
retired path: it is an *additional* fee rather than a substitute, it is not
refundable and is not a rebate, and it is opt-in with a cap the borrower
authorises up front.

**All ten languages moved together**, which was the point rather than a detail. A
partial sweep would leave some readers told the rebate is gone while others are
still promised it — worse than a uniformly stale set, because it makes the
correct pages look like the mistaken ones. Finding every instance meant searching
for the *idea* in each language rather than the English word: three locales carry
the promise as `ردّ VPFI`, `reembolso de VPFI` and `rabais VPFI`, and one of them
also spells it a second way in the same file. An English-only search finds none of
those.

**The correction reaches the places a borrower actually looks.** Beyond the page
that introduces the fee discount, four surfaces mattered more than the rest and
each is now corrected — including the site's **public FAQ**, which answered "how
does the VPFI discount work?" by describing the retired mechanism outright, on
the homepage and in the structured data search engines read: the **Claim Center** list a borrower reads to find out what a
claim will pay them; the **illiquid-default** passage that tells them what is left
after losing their collateral; and the **public marketing bullet** on the buy-VPFI
page, which advertised the rebate as a reason to hold VPFI; and the FAQ answer
just described. The introductory
walkthrough also stopped offering the retired "pay the fee in VPFI and receive the
full amount" route as a live choice.

**A second class of correction, found while making the first.** Removing the
rebate promise meant reading every passage that describes how the discount is
earned — and those passages were incomplete in a way that costs a reader money.
The pages that set expectations now state the conditions that actually govern
it — not as a closed list, since assembling one is what kept going wrong: the
VPFI must sit in the vault on the canonical chain; it must have been held for a
minimum period before it counts; a tier earned on the canonical chain does not
appear on another chain until it is pushed there; the fee-discount consent must
be enabled **on the chain the loan settles on** — it is a per-chain setting, not
one global switch — **and also on the canonical chain**, because the message that
carries a tier outward is forced to zero while the canonical consent is off, so a
reader who settles only on a mirror needs both; and for a borrower the lending
asset must be liquid, or the full fee is charged whatever they hold.

Two of those need scoping rather than stating flatly. A mid-loan withdrawal
repricing what you earn applies to the lender's yield-fee discount and to loans
still on the retired path — a borrower on the current model has their initiation
fee resolved once, at acceptance, so a later withdrawal cannot reach it. And the
lender needing free VPFI applies where the protocol has a VPFI price reference
configured; without one the discount is delivered as a reduction of the fee in
the loan's own asset and no balance is spent.

**Not every surface was reached.** The Basic guide's own introduction to the
discount still says a balance on any chain is enough and presents the consent as
a one-time switch, so a reader who follows that section alone can still end up
with no discount. That gap is real and is not closed here.

**A further condition is that the push is not a one-time step.** A mirror stops
honouring a pushed tier once it passes a maximum age — sixty days by default,
though governance can set it anywhere in a bounded range, so it is a deadline to
read rather than one to memorise — and falls back to treating that wallet as
tier 0 until a new push arrives. The cards had presented
the push as an activation you perform once, so a reader could follow every
instruction on the page, act on that mirror months later, and be charged the
full fee with nothing on the page to explain it — the same shape of failure as
the conditions above, except that this one arrives *after* the reader has done
everything right. Both cards now say the tier has a shelf life.

**And what renews it is narrower than the first attempt at this said.** That
attempt named two renewals — pushing again, or a canonical-chain deposit or
withdrawal — and both were wrong, in the direction that matters most: they told
a reader they could restore something they cannot. A push is only sent when the
tier, its rate, its projected expiry or the tier table itself has changed. An
identical one is deliberately skipped, so the protocol's cross-chain budget is
not spent re-sending a message the mirror already holds. For the reader this
paragraph is about — a steady holding, no tier movement, the window running out
— every action available hits that gate and sends nothing. Pressing the button again
does nothing. A deposit or withdrawal that leaves the tier where it is does
nothing. The window expires and the discount on that mirror is gone.

**And the second attempt was wrong too, in the same direction.** It said only a
change that moves your tier could bring the discount back, which would have sent
a reader to shuffle VPFI they had no reason to shuffle — and crossing a tier
boundary and climbing back costs them the discount for the whole minimum-history
window, so the advice was not merely useless but expensive. A way back does exist that
touches no balances, and it is deliberately NOT printed: it works by forcing two
broadcasts whose payloads differ, and the contract names exactly that repetition
as a way to drain the protocol-funded cross-chain budget — which, once
exhausted, makes legitimate broadcasts fail for everyone. Harmless once and
harmful at scale is not something to publish on a page read by everyone, so the
pages say instead that there is no supported way to refresh a tier that has not
changed.

Three times in a row, then, this note named the wrong remedy — first one that
does nothing, then one that costs the reader, then one that costs everyone
else. The pattern in all three is the same: a
sentence written from what the mechanism seemed to imply rather than from what
the mechanism does.

**And again, on what the round-trip itself costs.** The consent round-trip is real, but the
first description of it said it costs nothing but gas, and that is not true
either. The fee path reads the consent flag at the moment a fee is charged, so
for as long as the consent is off — three transactions' worth of time — any
offer of yours that somebody accepts, and any loan of yours that settles, is
charged at the full rate. Nobody needs your permission to accept a standing
offer, and a loan can settle without you. At the time, the pages answered that
by telling readers to cancel standing offers and pick a quiet moment first,
rather than presenting the sequence as free. That advice is superseded: the
procedure it qualifies was withdrawn outright a round later, for the reason given
below, so there is no longer a sequence to time carefully.

That warning, as first written, then overshot in the other direction: it said
such a charge lands **at the full rate**. Not quite. A Full tariff already paid
keeps its own reduction whatever the consent says — which is the very fact
established two rounds earlier in this same note. What is exposed during the
window is the hold-tier discount, not every discount, and the pages now say so.
A warning that overstates a risk still has to be corrected, and this one
contradicted a correction made two rounds above it.

That warning also arrived wearing formatting that nothing renders. The answer it
sits in is shown through a translation component with no support for emphasis,
so a bolded phrase reaches the reader as literal asterisks around the words. The
emphasis is gone from all ten languages, along with one older instance in the
Chinese answer that had the same problem and was not mine.

**And the false "a default returns nothing" turned out to be in a third and a
fourth place.** Each guide also carries a short list of what every action does,
and the Claim entry in both said it. Correcting only the two places a reader
pointed at would have left the same sentence standing in eighteen other files,
so this time every claim entry in every edition of both guides was found first
and then corrected together — twenty in all. The entries about collateral we
cannot price were left exactly as they were, because there the whole basket
really does go and they were never wrong.

Three rounds running, that sentence was found somewhere new. The lesson is not
to look harder next time. It is that correcting published copy should start by
finding every place the sentence appears, which is what happened here and not in
the two rounds before it.

**Sweeping it introduced two new errors of its own, which is worth admitting
rather than quietly fixing.** The first: a sentence saying the VPFI held under
the retired fee path is forfeited "either way" read as covering a proper close
too, when a full repayment, preclose or refinance all still pay the rebate. So a
borrower who refinanced could have been told to give up a claim that was waiting
for them — the same shape of harm the whole correction was meant to undo, caused
by the correction.

The second: the surplus was described as the wrong asset. Telling a borrower to
look for the wrong thing is a quieter failure than telling them there is
nothing, but it is the same kind — they go looking, do not find what the page
named, and conclude the page is wrong about everything else too.

It took two attempts to get right, and the first attempt is worth recording
because it was confidently wrong in a new way. It said the collateral waits in
your vault after a partial liquidation, and that the whole basket is sold on a
time-based default. The second half was true. The first named the wrong route
twice over: a partial liquidation is not a close-out at all — the loan stays
open and no claim is created — and the ordinary liquidation, which is the common
one, sells the collateral exactly as a default does and hands back the loan's
own asset. Only a close-out where a liquidator takes the collateral directly at
a discount, rather than selling it, leaves the collateral itself waiting. So the
correction pointed most borrowers at the wrong thing while sounding more precise
than the sentence it replaced.

It took several attempts, and each wrong one was wrong in a way the first had
made likely: it enumerated ROUTES, so the route it had not heard of was simply
absent. An ordinary liquidation does not always go to an exchange — where
another position can absorb it, the protocol matches it internally and the
borrower's residue is the collateral, not the loan's asset. Naming three routes
left that one out. Naming four left out the failed swap, which also ends in the
collateral being handed over. And a correction that removed the enumeration
from one side of the sentence promptly grew a fresh one on the other.

So the guides no longer enumerate routes at all. They state the one thing the
answer actually turns on: whether the collateral was SOLD or HANDED OVER. Sold
returns the loan's own asset, handed over returns the collateral, and the ways
of handing it over are named as open examples rather than as a closed list —
with no count attached, since the count is the thing that kept going stale.

**And the position NFT is not proof that anything is waiting.** Where a
liquidation left nothing over, the claim is recorded as already settled — and
the NFT is not burned on that path, so it can sit there afterwards looking
exactly like an unclaimed one. The pages had gone further than that and pointed
at the surviving NFT as the reason to expect a surplus, which sends a borrower
to sign a transaction that is refused. Both guides now say to read the claim
and not the NFT.

**A zero-surplus liquidation is not always recorded the same way.** The pages
said the claim is filed as already settled. That is true of the ordinary and
discounted routes and not of an exactly-matched internal one, which records no
claim at all — so the refusal a borrower meets differs by route, while what
they can do about it does not. The pages now say only what is true of all of
them: there is nothing to collect, the attempt is refused, and the NFT can be
sitting there regardless. Stating the mechanism bought nothing a reader could
use and was another internal detail to keep in sync.

**The renewal warning needed one exception.** After it was narrowed, the pages
said a push is sent only when your tier changes. A push carries the tier's rate
and the tier-table version too, and mirrors stop honouring a cached older
version — so after a governance retune the button does work, and pressing it is
the difference between your discount and no discount at all. The warning stays;
the case where the button is worth pressing is now named — and named
accurately, which took a second attempt. The first version said a mirror stops
honouring the cached version after a retune and that you would otherwise be
charged with no discount at all. It does not, and you would not: no
cross-chain message carries the new version, so the mirror goes on applying
the rate it already has until a per-user push arrives. This document says so
itself, in a section 1,400 lines further down, which the correction
contradicted. That second attempt was also wrong, in the
opposite direction, and the third is the one to read. The version a mirror
holds is mirror-WIDE, and its receiver raises it from ANY user's message — so
the first push by anybody after a retune flips the version for everyone on
that mirror, and every cache still carrying the old one reads as tier 0 from
that moment until its own push arrives. The old-BPS grace is real, is
per-mirror rather than per-user, and ends on a stranger's message. So the
push is worth making promptly, whether or not the new rate suits you.

The passage that misled me is in this same document, and it has been corrected
too: it described the grace without saying what ends it.

**And the renewal procedure has been withdrawn rather than qualified.** Two
rounds ago these pages started describing how to refresh a lapsed mirror
discount by switching the fee-discount consent off and on. It works, and it is
the wrong thing to publish: each half of it spends cross-chain budget the
protocol funds, and the code says in as many words that repeated toggling drains
that budget. A procedure that is harmless once and harmful at scale should not
be printed on a page read by everyone. The pages now say plainly that there is
no supported way to refresh an unchanged tier, and that the discount returns
only when a later broadcast carries an eligible non-zero tier. Movement alone is
not enough: a withdrawal below the first tier floor also counts as a change and
broadcasts tier 0, which a mirror reads as no discount at all — and climbing back
then runs the minimum-holding delay again. This is the one condition here that
can cost someone their discount through no fault of their own.

The through-line in all three is the same and worth naming once: each wrong
sentence was written from what the mechanism seemed to imply, and each was
corrected by someone reading what the mechanism does.

**A separate correction, and the most consequential one here.** The Claim
Center guidance told a borrower that an HF-liquidation or a default returns
**nothing**. That is not something a page can promise either way: only enough
value is taken to cover the liquidator, the lender and the treasury, and any
remainder is recorded as the borrower's claim, waiting in their vault until they
withdraw it. Whether a remainder exists depends on what the collateral actually
realised — the liquidator's incentive and the realised slippage come out first —
so an overcollateralised position often leaves one and is not guaranteed to. What
the remainder consists of depends on how the position was closed: where the
collateral was sold, what waits is the proceeds in the loan's own asset; where it
was handed over instead, the collateral itself waits. Telling a borrower to look
for the wrong token is the same error, one level down, as telling them there is
nothing to look for. A borrower who believed the page would simply never go
and collect it. The guidance now tells them to check, explains that an illiquid
default usually does take the whole basket — an outcome, not a rule — and states
what happens to the retired-path rebate: forfeited outright on a default or
liquidation, and settled on a proper close.

The same passage also said the borrower position NFT is burned when the loan
resolves. It is burned when the borrower *claims*, which is exactly the
distinction that makes a surplus collectable afterwards; stating it the other
way round reinforced the false conclusion. Corrected in all ten editions of the
guide.

Worth noting where the correct account already lived. The Advanced guide's own
refresh paragraph states the deduplication rule explicitly, and why it exists,
fifteen lines below the expiry bullet the first attempt drew on. The card was
written from the review finding rather than from the guide that already
documented the mechanism, which is exactly how it came to contradict it.

**One correction runs the other way.** The pages had been saying that opting
into the optional tariff counted as the fee-discount consent, so a borrower who
paid the tariff need not enable the setting. It does not. The tariff authorises
its own separate reduction, added on top; the hold-tier reduction still requires
the consent. A tiered borrower who paid the tariff with the consent left off
would receive the tariff's slice alone and not their tier — having paid for the
privilege. The specification had this right and stated it precisely; the public
copy took its heading and dropped the qualifying clause underneath.

Fixing that heading left a second, quieter inaccuracy standing one sentence
earlier: the answer still said that without the consent *the full fee* is
charged, and then explained two lines later that a borrower on the Full tariff
receives its slice regardless. Both cannot be true, and it was the first that
was wrong — a Full-tariff borrower on a liquid asset does get that reduction
with no consent at all. The claim is now scoped to what actually fails, the
hold-tier reduction, and still tells a reader with no tariff in play that they
pay the full fee. Worth noting where the error came from: correcting a
paragraph about the tariff introduced a contradiction with the sentence
immediately above it, which had been accurate about the ordinary case and was
never re-read against the new one.

Each of these was already true and already enforced. None of them was on the
page. Together they describe a reader who does everything the site tells them to
and is still charged full price, with nothing to indicate why — which is a worse
failure than a stale promise, because a stale promise is at least visible once
it fails to arrive.

**Known limitation, stated rather than left to be discovered.** Settlement
passages deeper in the guides — the refinance and preclose mechanics — are covered
by their section's scope but remain individually unqualified. A reader arriving
directly at one of them via an anchor link may read it without that scope. They
are not false (they describe what happens to a rebate that exists), but they are
not self-contained, and closing that is follow-up work.

**Several connected-app surfaces are deliberately untouched and need a decision.**
The offer-creation screen still advertises the retired rebate to a borrower at the
moment they are choosing terms; the Dashboard's consent control still tells them,
at the moment they enable the setting, that doing so may take VPFI from their
vault to pay the initiation fee; the Claim Center's own borrower help text
still says that a default or liquidation leaves an unused rebate to collect; and
the signed-out vault page still pitches the retired lifetime-weighted rebate to
anyone who visits it. All are app copy rather than documentation and sat outside
this change's agreed scope, so they are recorded rather than edited here — and
the list is written as "several" rather than a count, because every attempt to
enumerate these surfaces has found one more. Four rounds, four additions.

The claim display itself needed no change: it reads each loan's actual held amount
and shows a rebate only where one exists, which was already correct for both old
and new loans. The wording around it was the only thing making a promise.
