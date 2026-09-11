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
