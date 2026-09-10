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
