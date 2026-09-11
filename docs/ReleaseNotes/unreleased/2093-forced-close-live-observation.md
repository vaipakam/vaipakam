## Thread — the lender's forced close-out is now watched on the deployed build

The forced close-out card shipped without a committed post-deploy check.
The live driver that visits a lender's position page did exist, but it
asserts a *different* card on the same page — the exit chooser — so the
card that lets a lender wind down an overdue loan was going out with
preview builds, unit tests and CI behind it and nothing looking at the
deployed thing. This closes that.

The card is now scraped on the same watch-only visit and judged
separately. Separately is the point rather than an implementation
detail: folding two cards' verdicts together lets one card's missing row
hide a positively observed defect on the other, and the two cards do not
even agree about who should see them — the chooser is correctly withheld
from a sanctions-flagged holder, while the forced-close card
deliberately stays available to one, because winding down an already
defaulted loan is a close-out the protocol keeps open to everyone.

Two things are checked, and they pull in opposite directions on purpose.
The card must state **no amount it cannot substantiate**, which is the
standing rule for any surface touching funds. And an **absent** card on a
position the lender genuinely holds is a failure, while a card that
renders and explains why it is offering no button is not — absence is
the strongest claim the surface can make, since it says the capability
does not apply here.

The amount check is deliberately calibrated against every shipped string
of the card's copy, in every language the app ships, rather than against
English alone. A check that fires on correct copy gets switched off, and
switching it off loses the true positives with it — so the grace window
the card is explicitly allowed to show must stay clean while a bare
figure with no unit does not.

What the drive refuses to do is as load-bearing as what it asserts. It
never reports a pass it did not earn: a card still saying a check is
running has not settled, so it is recorded as unobserved rather than
clean; a position that turned out to carry an accepted sale is outside
the card's scope and reported that way; and a probe that could not
classify what it saw says exactly that, which fails the run's coverage
rather than passing quietly beside a position that did pass. The
distinction between "nothing is wrong here" and "nothing was learned
here" is the one this drive spends most of its logic on, because
collapsing the two is how a missing card gets explained away by a reason
nobody established.

One limitation is intrinsic rather than a gap in coverage, and it is
worth stating because it bounds what a failure from this drive means.
The check that a missing card is a real defect rests on proving the
observer was not simply behind the page — a page whose provider has
seen a loan go terminal is *correctly* showing nothing. That proof
cannot be completed from outside the app: the read that removes the card
is issued against the latest block and carries no block number, so the
page's position can only be inferred from what it happens to announce,
which is a lower bound. The drive narrows the window — it watches the
page's own announcements on the deployment's endpoint only, and requires
its own view to pass that bound rather than merely match it — and it
reports an absence it cannot judge as unverified rather than as a
defect. What remains is that a page running several blocks ahead of its
last announcement, with a loan going terminal inside that window, can
still be accused of omitting a card it was right to omit. Closing that
needs the card to publish the block its readiness resolved at, which is
a change to the product rather than to this drive.

Two gaps are stated rather than left implied. The candidate pool is
inherited from the chooser's, so it excludes NFT rentals and excludes a
sanctions-flagged holder — which means the card's rental route and the
flagged-lender case, the one the spec deliberately requires the card to
survive, are both uncovered. The run prints a note naming whichever gap
the chain actually exhibits on the day, and a follow-up tracks widening
the pool.

A late round of review found five ways the drive could reach a confident
verdict about something other than what it had looked at, and the theme
running through four of them is the same: it judged one thing and then
acted on another.

The clearest was the amount rule, which is the one absolute claim this
check makes — nothing on that surface states a figure it cannot
substantiate. That rule was only being applied to cards that were still
on screen when the drive stopped watching. A card that named a figure
while its readiness checks were still running, on a position that then
went terminal, changed hands, or picked up an accepted sale, had the
observation thrown away on the way out; and if the sale explained the
card's disappearance, the run went on to report that there had been
nothing to see. A figure a lender was shown is a finding whether or not
the card outlived it, so the evidence is now kept and reported on both
paths. Relatedly, a card that vanished mid-check used to be recorded as
still present, which sent an ordinary lifecycle race out as a reported
defect and skipped the re-read that exists to tell the two apart.

The drive also read one card and clicked another. It picks the card a
lender can actually see — which includes rejecting a card rendered fully
transparent — but the click, the confirmation wait and the receipt scan
were addressed through a different rule that does not consider
transparency at all. A transparent card sitting ahead of the real one
therefore had its copy judged from one element and its behaviour driven
from another, and a healthy card came back as unreadable. Both halves now
resolve the same card.

Two checks were being satisfied by the first thing that matched. The
card's explanatory body is meant to be in exactly one state, and the
drive accepted any one match, so a body carrying two states at once —
telling a lender both that they recover the collateral and that they
recover the asset they lent — would have passed. It is now a failure,
which is only safe because no shipped sentence contains another in any
translation, and that is checked directly rather than assumed. And a
chain read that failed because the drive itself had asked wrongly was
being filed as the chain being unavailable, since the two arrive wearing
the same label; a self-inflicted error now says so instead of leaving the
position quietly ranked as fine.

Finally, the safeguard that stops a missing card being blamed on the
product depends on watching what block the page says it is on. The page
usually announces this by asking for the latest block rather than for its
number, and only the second form was being read — so on the pages that
matter the safeguard was not merely weaker, it was inert. Both forms now
count, and only the current block does: an older one is not the page's
position and a not-yet-mined one would overstate it, which is the
direction that produces false accusations.

A further round found three more, and two of them were introduced by the
previous round's own repairs — which is worth recording, because it is
the argument for running the loop to convergence rather than stopping at
the first quiet round.

Carrying every render the check had read, so a figure shown briefly could
not be lost, created a second problem: the renders were being joined
together before being examined. Every rule that decides whether a number
is an amount or a harmless identifier depends on the words around it, so
joining let one render lend its context to another. A screen ending with
the word "Loan" followed by a screen beginning with a figure read as a
loan number, and the figure was excused — an adjacency that never existed
for any reader. Each render is now judged on its own text.

The check for currency figures recognised five signs, chosen by hand. A
sign outside that list did not merely go unflagged; it left the figure to
be treated as an identifier instead, so an amount written in roubles or
won — won being the currency of a language the app ships — passed as
clean. It now recognises every currency sign Unicode defines, which is a
set nobody has to maintain.

Finally, a second copy of the card appearing briefly and disappearing
before the card settled was counted and then forgotten. The check only
ever reads the first card, so that second surface was never examined at
all, and the run reported the page clean having seen something it could
not vouch for. A duplicate at any moment is now a failure, and it says
whether the duplicate is still on screen or has gone, so nobody goes
looking for something that is no longer there.

One gap is stated rather than implied: the part of the drive that decides
which network traffic to read for the page's position has no test of its
own, because it cannot be reached without restructuring the file, and a
live run cannot distinguish it working from the older path having been
sufficient on that page. That restructuring is tracked separately.

The check that the pre-signature receipt was actually visible had one
more gap. It rejected a container collapsed to nothing, but a container
one pixel tall passed: the rows inside keep their full size, the browser
reports them as displayed, and their text can still be read
programmatically — so the run recorded that a lender had been shown the
fees and the losses when a sliver of a single line was on screen. A
container that cannot be scrolled must now actually show at least half of
a row for that row to count. Half, rather than any part of it, because a
one-pixel window does show a part; and half rather than all of it,
because a row whose descender is trimmed by a pixel is still perfectly
readable and failing on that would be the kind of false alarm that gets a
check switched off. Content merely scrolled out of a scrollable area
remains fine, as before.

One reported concern was investigated and found not to apply: that the
card might briefly offer a usable action while still saying its safety
check was running. The card decides what it says and whether it offers an
action from the same single value in the same render, so on a state that
withholds the action the button is not merely disabled — it is not there
at all. Rather than leave that as an argument, it is now something the
suite checks, because the two halves of it are maintained in separate
places and a future disagreement between them would otherwise surface as
a surprise on a live run rather than as a failing test.

A third way of hiding content turned out to be unchecked: text can be
made invisible by its own colour. A receipt row set to a transparent
colour keeps its size, is reported as displayed, and its words can still
be read programmatically — so the run could record that a lender had been
shown the fees and losses while nothing was painted. Visibility now
requires the text to be painted as well as the element to be there.
Only elements carrying their own text are judged, because colour is
inherited and judging containers would condemn a whole card whose rows
set their own colour. Nothing attempts to decide whether text is too
faint to read against its background; that needs more than this check can
see, and getting it wrong would reject readable copy.

Two existing checks were also looking at too little. The scan for
currency figures now reaches its sign across a dash or a comma, so a
figure written that way is no longer mistaken for a reference number —
while still stopping at the first real word, so a sentence that merely
mentions a currency later on is untouched. And the rule that a card must
never say both "a check is still running" and "this is not available" is
now applied to every screen the check saw rather than only the last one,
which is the state the rule is actually about: a card that contradicted
itself while its checks ran and then settled cleanly used to have the
contradiction overwritten before anything looked at it. Two claims made
on two different screens are still not treated as a contradiction — that
is simply a card resolving.

One documentation correction belongs here too, because it was misleading
rather than merely incomplete. The coverage notes both stated that the
websocket capture is inert today and, a few lines later, credited it with
narrowing the timing window the missing-card check depends on. Only the
first is true. An operator reading the second would have believed in a
protection that is not currently in force.

A further round produced five more, and one guard written for them failed
in a way worth keeping.

The check that receipt text is actually painted was looking for one way
of writing a colour. Modern colour syntaxes survive into the computed
value unchanged, and the check treated anything it could not read as
painted — the wrong way round for a check whose purpose is to catch
invisible disclosures. It now reads the transparency by shape rather than
by recognising particular colour functions, so a syntax added to the web
platform later needs no change. Anything still unreadable is treated as
visible, deliberately: the cost of that is a missed defect, whereas the
opposite would reject copy a lender can see.

Three checks were reaching the wrong element or looking at too little.
The click on the close-out button was selected by a different rule from
the one that judged the button, so a transparent, disabled button placed
ahead of the real one could be clicked instead — the same mismatch fixed
for the card itself a few rounds earlier, in the control beside it. An
amount written with an asset glyph rather than a ticker or a currency
sign, which is how an ether figure is usually written, was being read as
a reference number. And the rule that the card must be in exactly one
state at a time is now applied to every screen the check saw, not only
the last, since a card showing two contradictory outcomes and then
settling on one had already shown them.

The last of the five is about how the run reports itself. A card observed
stating an amount it cannot know is the most serious thing this check can
find, and it was being announced only after several infrastructure
problems had each had a chance to declare the run inconclusive — so an
unrelated network failure could turn a confirmed defect into "nothing was
learned". An observed defect is now reported ahead of them. The ordering
principle is the one the rest of the check already follows: something
seen outranks something uncertain.

The guard that failed concerns languages rather than layout. The scanner
recognises the words that make a number harmless — days, hours, percent —
and it only recognises them in the Latin alphabet. So a grace-window
sentence in Japanese or Hindi is reported as an invented amount, which is
exactly the false alarm the check is otherwise careful to avoid, on
wording the specification explicitly permits. Nothing is failing today
because no translated string happens to write a duration with a number in
it, which is luck rather than protection. It is recorded as a known
defect with its own issue, and the test pins what the code actually does
rather than what it should do, so that fixing it properly is what breaks
the test.

A later round returned to the confirmation panel and to the same
principle. The check was only willing to judge the button that sends the
transaction when it had also succeeded in reading the whole receipt above
it — so a button that could not be used, alongside a single line of the
receipt the check could not parse, was reported as an inconclusive run
rather than as the defect it was. Those are two different kinds of thing:
an unreadable receipt line is a gap in what the check managed to see, and
an unusable button is something it saw clearly. The second is no longer
hidden by the first.

The same round found that the check looked at only the first action
beside Back. A confirmation offering more than one way to pay is a
finding in its own right — the receipt explains one decision — and the
second control was going unexamined. It is now counted, and a second
action is reported ahead of any question about whether the first one
works.

It also now asks whether that button can actually receive a click.
Visible, enabled and labelled are all true of a button sitting under
something else, or one configured not to accept pointer input; the lender
cannot use either, and every signal the check had said the route was
fine. The question is asked in the form that runs the browser's own
usability checks and stops short of pressing anything, because this check
watches and must never spend a lender's money.

Finally, a number written after a word like "loan" or "position" was
treated as a reference rather than as an amount. Those identifiers are
whole numbers, so a fractional value in that position is not naming
anything — it is stating a quantity, which is the invented figure the
rule exists to catch. The exemption now applies only to whole numbers.

Reviewing that last change afterwards turned up a way it could have made
things worse rather than better. The check finds the confirmation button
by its position among the buttons on the card, and then goes back to the
page to try it. If the page had redrawn in between, that position could
have been the Back button instead — which can always be clicked — so a
confirmation button that did not work would have been reported as fine.
That is the precise kind of false reassurance the whole check exists to
prevent, on the one control that spends money. The check now remembers
the button's wording and confirms it is looking at the same control
before trying it, and where it cannot confirm that, it says the button
was not tested rather than guessing either way.

The run also now states, in its own output, whether that test actually
ran. "Not tested" is a legitimate result, and from the outside it looks
exactly like a check that has quietly stopped working — so it is said out
loud instead of left to be assumed.

A second pass over the same area found that an earlier fix had only ever
reached half of what it should have. The check had already learned that
text can be hidden by its own colour — laid out, present in the page's
text, and invisible on screen — and it was taught to look for that on the
receipt's rows. The button beside those rows was never given the same
treatment, and because of how the colour test is deliberately scoped, a
button whose label sits inside a wrapper was exempt from it entirely.
That is the usual way a button is written, so a confirmation control
reading as blank would have been reported as present, visible, labelled
and usable. It is now checked, with the leniency that matters in
practice: a label that is partly hidden on purpose — the longer wording
some interfaces provide for screen readers — is still a correctly
labelled button, and the check says so rather than condemning it.

The review then caught something the previous fix had introduced. When
the check declines to test the confirmation button — because it can no
longer be sure it is looking at the same control — it had been saying
nothing at all, and "nothing" was indistinguishable from an older
recording made before the test existed. The run therefore finished
successfully without ever having established that the button works,
which is the one thing that test is for. The check now records all three
outcomes separately, and a run that did not manage to test the button
reports itself as incomplete — re-run this, nothing was established —
rather than as a success.

The next review round found three more, all of them the same underlying
theme: something that hides what the lender is meant to read, while every
signal the check consults says the page is fine.

A page can clip an element's painted area away entirely without changing
anything else about it — the box stays full size, the colour stays
opaque, and the text is still there to be read programmatically. It is
the standard way to hide something from sight while leaving it available
to screen readers, and the check had no defence against it, so a receipt
whose fee and loss lines were clipped to nothing would have been recorded
as read. The check now rejects a clipping region it can prove is empty,
and deliberately does not guess about the shapes it cannot measure — a
check that condemns readable content is worse than one that misses a
rare case.

The rule that lets a number after the word "loan" or "position" be
treated as a reference rather than an amount was still too generous: it
accepted "Loan 1k", because it only looked at the digit. Identifiers do
not carry magnitude suffixes, so the rule now requires the number to end
where the digits end, tested as a boundary rather than as a list of
suffixes to recognise — lists like that go stale in exactly the way this
one would.

And the check's record of how far the page had caught up with the chain
could be sampled while a reply was still being parsed. That made it
possible to read a chain position the page had already passed, which in
the worse direction would have reported a correctly absent card as a
regression — a false alarm produced by timing rather than by anything on
the page. The readings already in progress are now allowed to finish
before that record is read.

Two more from the following round. The rule that stops a number being
read as an amount when it follows a word like "loan" had been closed
against "Loan 1k" and was still open against "Loan 1 million" — the same
mistake with a space in it. Closing the spaced form needs the check to
know which words are magnitudes, which is a vocabulary, and vocabularies
in this check have a known weakness: a word in a language nobody listed
walks through. That limitation is now written down next to the list and
tracked alongside the existing one, rather than left to be discovered.

The other is about what the check throws away. It re-reads the loan's
state from the chain after looking at the page, and if the loan has
since ended, the token has moved, or a sale has been accepted, it treats
the whole visit as no longer applicable. That is right for a clean
reading — a page observed in a state that has already passed proves
nothing — but it was also discarding faults that had genuinely been seen:
a confirmation that opened with no button beside Back, or with two, or
with one that cannot be seen or read. None of those can be explained by
the loan changing a moment later, and they are now reported regardless.

The line is drawn deliberately and narrowly. A button that is disabled,
or that briefly cannot be clicked, is exactly what a loan ending
mid-observation looks like, so those two stay where a state change can
still account for them. Reporting them would mean accusing the product
of something that was really a matter of timing, which this check is
built specifically not to do.

Four more from the next round, and three of them are versions of the same
mistake: something the check genuinely saw was being thrown away because
something else nearby could not be read.

A confirmation receipt has six lines, and the check only kept the text at
all when all six of them rendered legibly. So a single missing line
discarded the other five — including, in the worst case, one stating an
amount the platform cannot know. That is the headline thing this check
exists to catch, reported as "I couldn't read it" rather than "this is
wrong". The readable lines are now kept and scanned in their own right,
and the all-six question goes back to being only what it is: whether the
receipt was completely covered.

The same shape again on the card's own button. When the button is
visible and enabled but sits under something else, the check's click
simply fails, and that failure was discarded — leaving the run to report
an unread confirmation instead of a lender who cannot reach the
confirmation at all. It is now tested the same way the confirmation's own
button is, and reported as what it is.

The third concerns a moment rather than a page. The card can pass through
an intermediate state where the safety check is still running and the
button is already live — a state the lender can click, and pay for. The
check recorded the wording of every such moment and the button counts of
every such moment, but never the two together, so any unsafe moment was
forgiven as soon as the card settled into a clean one. It now keeps them
paired. The deliberate exception is unchanged: a button that is briefly
disabled costs nobody anything and is still treated as a normal
intermediate state.

The fourth is smaller and about trusting a provider less. Block numbers
arrive from the network as hexadecimal by specification, and the check
was converting them with something that also happily accepts an ordinary
decimal or a negative number. A provider answering in the wrong format
would have supplied a chain position far lower than the real one, which
in the worse direction turns a correctly absent card into a reported
regression. The format is now checked, in all three places the check
reads a number of that kind.

The round after that brought four more, and one of them uncovered
something larger than itself.

A page can erase an element with a CSS filter, leaving its size, its
colour and every other signal intact while the browser paints nothing —
the same trick as the clipping one found earlier, by a different
property. Adding that check revealed that the check's two copies of its
own visibility rule had drifted apart: one of them returned early, so
everything written after that point had only ever run on browsers that
lack a feature every modern browser has. It had cost nothing until now,
because the only thing below the early return was something the browser
feature already covered. The new check would have gone straight into dead
code in one of the two copies. Both copies now have the same shape.

The check also waited for the wrong thing when a hidden copy of the card
sits before the real one: it watched the first one for a full thirty
seconds before considering any other. The page is live, so a card can say
something wrong and then settle or disappear inside that window, with
nothing recorded. It now watches for any visible card from the start.

An endpoint that had once reported the wrong chain could be trusted
again if it later answered correctly — which is precisely the endpoint
the rule was written to distrust, since one that gives two different
answers cannot be relied on for either. It now stays excluded.

And the moment-by-moment safety check from the previous round was still
being thrown away when the loan ended, transferred, or was sold. What the
lender could have clicked, they could have clicked; what the chain says
afterwards does not undo it.

A fifth finding in the same round pointed the other way, and that
direction matters more. The new rule about a confirmation offering more
than one way to pay counted every button it found, including ones hidden
by styling — which is how a page ordinarily carries two variants of the
same control for different screen widths. A perfectly correct card would
have been reported as offering the lender two ways to spend money. It now
counts only what is actually shown, which is the rule the card's own
duplicate check has always used. A check that condemns a correct page is
worse than one that misses a rare bad one, because it is the kind of
result that gets the whole check switched off.

Three more, and the first is about what the check is entitled to claim.
If every position it looks at happens to be in a state where the card is
shown but not yet actionable, the check would finish successfully —
having never opened the confirmation panel, and so having never looked at
the receipt, the amounts, or the button that spends money. It reported
clean over a surface nobody had seen. It now says plainly that the
confirmation was never opened and that the run establishes nothing about
it. That is a gap rather than a fault: nothing was wrong, the chain
simply did not offer one to look at, and saying so is the honest answer.

An endpoint that answers the same question twice with two different
chains in a single reply was being believed on whichever answer came
first. One that contradicts itself cannot be relied on for either, which
is exactly the case the existing distrust rule was written for. It is now
excluded outright, and a contradiction is recorded as a different thing
from having no answer at all — because "no answer" lets the endpoint be
accepted on other evidence, and a contradiction must not.

The last is about blame. One early step deliberately re-raises failures
it cannot attribute to the chain, so that a fault in the check itself is
loud rather than quietly degrading the run. But it did so outside the
part of the run that knows such failures happened before anything was
observed, so the run ended by reporting a product regression for
something no page had yet been looked at. It is still loud; it now ends
by saying nothing could be checked, which is what actually happened.

Five more, and two of them are about the confirmation receipt being the
right one.

The check counted six rows and, finding six, concluded the whole receipt
had been read. Six copies of the same row would have satisfied that — with
the fee and loss disclosures simply absent — and the run would have
reported the full receipt as scanned. It now checks that the six rows are
the six rows, and that they are the ones belonging to the route the card
is actually offering: a collateral close-out showing the rental receipt,
or the reverse, is a confirmation describing a different transaction from
the one it confirms.

The line between reporting that as a fault and reporting it as a gap is
drawn deliberately. Duplicated rows are a fault: no wording is involved,
so nothing about the check's own vocabulary can explain them. Rows that
match the other route's receipt exactly are also a fault, because the
check recognised them — it is simply the wrong receipt. Rows matching
neither are reported as a gap instead, because the check's copy comes
from this repository and the page's from whatever is deployed, and a
difference between them is as likely to be the check being out of date.

The other three: text elsewhere on the confirmation — a banner, a note,
the button's own label — is now read as well, having been discarded
whenever any row failed to render; a button that could not be tried but
then could be clicked is treated as reachable, since a click that worked
outranks a probe that did not; and a grace window written as "3-day"
rather than "3 days" is no longer read as an invented amount, which had
made correct copy the specification explicitly permits fail the check.

The next round found the largest single gap in the whole check, and it is
not about how the page looks.

The check confirmed that the position was still active and still held by
the lender, and never asked the protocol whether the close-out could
actually run. So a page that wrongly said "ready" and offered the button
would have been certified as correct — certifying an action the protocol
is guaranteed to refuse, after the lender has paid the network fee for
it. The page's own wording was being accepted as proof of itself.

The check now asks the protocol directly, at the same moment it reads the
loan's status, and never works the answer out for itself: the grace
period is configurable on-chain, and any client that recreates the
default ladder is correct only until someone changes it. If the protocol
says the loan is not yet closeable while the page offers the action, that
is a fault. If the question cannot be asked at all, the run says so
rather than passing — a route this check vouches for is not something to
vouch for on no evidence.

Two smaller ones alongside it. The receipt's six lines are now checked
against their own headings rather than merely being present, so a receipt
where every line is true and every line sits under the wrong question —
the loss disclosure filed under "Fees" — is caught; nothing on such a
panel is false, which is what makes it the most misleading shape it can
take. And the card's own button must carry a label the lender can read,
which the confirmation's button has been required to do for some rounds
while the one that opens it was not.

The following round found two problems with that fix, both of them about
what the protocol's answer actually covers.

The question the check was asking turned out to be narrower than the
action it was vouching for. Whether a loan is past its deadline is only
one of the conditions the close-out requires: it can still be refused
because the protocol is paused or because the network's sequencer is
unhealthy, and the answer the check relied on says nothing about either.
It now asks all three — the same three the page itself asks — and asks
them of the chain rather than working them out from the contract's rules,
because a copy of those rules is right only until they change.

And the answer was being taken after the page had been watched, which can
take up to half a minute. A deadline passing inside that window meant a
card that had offered an invalid action was validated by an answer from
after the fact — the very moment worth catching, erased by the delay. The
question is now asked before as well. Where the answer changes during the
window, the run reports that it could not match the two rather than
guessing: the card may legitimately have become ready mid-observation,
and the check cannot tell that from the fault without asking the chain
once per redraw, which it does not do.

The next round caught two faults in those same fixes, and both were of
the worst kind: the check condemning a page that was behaving correctly.

The requirement that the card's button carry a readable label was applied
even to cards that deliberately show no button at all. A position that is
simply not yet closeable shows an explanation and withholds the action —
which is exactly right — and the check would have reported every one of
them as offering a blank control. The single position the live run
exercises does offer the button, so the one case the check runs against
end to end was the one case the fault could not appear in. The rule now
applies only where an action is actually being offered.

The second: the check had been taught that a loan becoming closeable
while the page was being watched makes the reading ambiguous, and had not
been taught the reverse. If the protocol pauses during that window, the
action the page offered was valid when it was offered — and the check
would have called the page faulty on the strength of something that
happened afterwards. Both directions are now reported as an
unmatchable reading. A window in which the protocol refuses throughout is
still a fault, because there is nothing ambiguous about it.

The round after that overturned the reasoning in the one before it, which
is worth recording as plainly as the fix.

Asking the protocol three specific questions — is the loan past its
deadline, is the protocol paused, is the sequencer healthy — is not the
same as asking whether the transaction would work. There are conditions
none of those three cover, and a page could render "ready" on a loan
where all three answer favourably and the transaction would still be
rejected. The product's own code already says how to do this properly: it
simulates the exact transaction before submitting it, precisely because
that covers the conditions no list of checks models. The check now does
the same, asking the question the lender's click would ask rather than a
stand-in for it.

The other half is about whose view of the chain the answer comes from.
The check reads the chain through its own connection, which can be a
block ahead of the one the page is using. Around the moment a loan
becomes closeable, that difference is exactly the difference between
"the page was right" and "the page was wrong" — and the check was
comparing against its own clock rather than the page's position. It now
asks the question at the chain position the page itself had reached when
it drew what was being judged.

One more, and it is the previous fix keeping the problem it was for. The
check had been taught to ask the protocol its question at the chain
position the page had reached — but it read that position after it had
finished examining the card, and examining the card includes opening the
confirmation and waiting on it. A page that moves forward during that
examination would supply a position it had not reached when it drew the
thing being judged, which is the same error one step along. The position
is now read before anything is looked at. The later reading is kept,
because a different question — has the page caught up at all — genuinely
wants the newest answer.

Three more corrections of the same kind, all about what the check throws
away when a loan changes hands or ends while it is looking. A card whose
button carries no readable label, a receipt with one disclosure printed
twice in place of another, and a receipt describing a different
settlement route than the one being confirmed are all things the lender
has already been shown — and the check was discarding them whenever the
position stopped being applicable a moment later. Nothing that happens
afterwards can unshow them, so they are now reported regardless. The one
case that still yields is a receipt the check simply does not recognise:
that may be the check's own wording being out of date rather than a
fault, and a position that no longer applies is a perfectly good reason
not to have judged it.

And the fallback used when the page never reveals its chain position was
still being taken after the page had been examined rather than before,
so on that path the timing fix from the previous round had not actually
taken effect.

Five more. The most consequential concerns how the check waits for the
card to appear. It was using the browser automation library's idea of
"visible", which is a box with size and a visibility setting — while the
check's own idea, built up over many rounds, also rejects transparency,
clipping and erasing filters. A decorative or leftover node that looks
visible to the weaker test but not the stricter one could satisfy the
wait immediately, after which the check would look, find nothing it
considered visible, and report the card missing — on a page where the
real card was about to appear well within the time allowed. The wait now
asks the same question the rest of the check asks.

A related correction: when the check disagrees with the page about
whether a close-out would be accepted, that disagreement is now treated
as something inferred rather than something seen. The commonest cause is
the deployment talking to a different chain than the check is, and the
run should report that as a configuration problem rather than blaming the
page for it.

The others: a receipt line whose label is hidden but whose value is on
screen is now read, where previously the whole line was discarded and an
amount stated in plain sight reached no check at all; a reply from the
chain that reuses one identifier for two different questions is refused
rather than guessed at; and amounts written with the denomination spelled
out — "100 ether" rather than "100 ETH" — are now recognised after words
like "loan", where they had been read as reference numbers.
