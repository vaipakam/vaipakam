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

### What is checked, and in which direction it is allowed to be wrong

Two things, and they pull against each other on purpose. The card must
state **no amount it cannot substantiate**, which is the standing rule
for any surface touching funds. And an **absent** card on a position the
lender genuinely holds is a failure, while a card that renders and
explains why it is offering no button is not — absence is the strongest
claim the surface can make, since it says the capability does not apply
here.

Every rule in the check is built to fail in one direction: it may miss a
fault, never invent one. A check that fires on correct copy gets switched
off, and switching it off loses the true positives with it. So the amount
rule is calibrated against every shipped string of the card's copy in
every language the app ships — the grace window the card is explicitly
allowed to show must stay clean, while a bare figure with no unit does
not. Where a rule cannot decide, it says so instead of guessing, and the
residual is recorded in the code rather than left for a reader to
discover.

### What the check refuses to claim

As load-bearing as what it asserts. It never reports a pass it did not
earn: a card still saying a check is running has not settled, so it is
recorded as unobserved rather than clean; a position that turned out to
carry an accepted sale is outside the card's scope and reported that way;
a probe that could not classify what it saw says exactly that, which
fails the run's coverage rather than passing quietly beside a position
that did pass; and a reading that could not be taken at all — the page
navigating away mid-check, a browser-side rule that could not be
evaluated — is reported as an incomplete observation rather than as a
missing card.

That last distinction is the one the check turns on most often. A wait
that times out has genuinely looked and kept finding nothing, and
reporting an absence is right. A wait that never got to ask has
established nothing, and reporting an absence would invent a missing card
out of an infrastructure problem.

### "Visible" means painted, not merely present

The largest single theme of this work. A page can leave text in its
markup and still show the lender nothing: transparent colour, zero
opacity, a filter that erases, a clipping region collapsed to nothing, a
box with no height. Each of those leaves the underlying text readable to
an automated check while the lender sees blank space — so a card could be
certified as having explained itself, or a receipt as having disclosed
its fees, with none of it on screen.

The check therefore has one rule for what counts as readable, applied
everywhere it makes that judgement: gather the text whose every enclosing
element is painted, and treat that — not the page's underlying text — as
what the card says. The card's explanation, the receipt's labels and
values, the button's own label, and the sentence the check recognises the
card's state from all go through it.

Two boundaries are deliberate. Text placed off-screen for screen-reader
users is correct, accessible markup, so requiring that *everything* be
visible would fail a card for being accessible; and accepting *any*
visible text would let an erased explanation pass beside an unrelated
readable note. Binding the judgement to the text actually relied on
avoids both. Where a way of hiding content cannot be judged reliably — an
arbitrary filter chain, a contrast judgement needing the background — the
check treats it as painted, because condemning legible copy is the error
that gets a check switched off.

### Asking the protocol rather than re-deriving it

A card can be perfectly rendered and still be offering an action that
would be refused. Rather than re-deriving the eligibility rules from a
second copy of them — which would go stale the moment the contract's
grace periods were retuned, and which ignores that those periods are
governance-configurable — the check simulates the exact transaction the
card would send, from the same account, against the same state, and asks
whether it would succeed.

Where that answer and the page disagree, the check reports it as
something inferred rather than something seen, because the commonest
cause is a deployment pointed at a different chain — a configuration
problem, not a defect in the card. And where the two sides of the
comparison come from different views of the chain, or from a provider
that has contradicted itself about which chain it is on, the check
declines to conclude at all rather than blaming the page for a disagreement
between two data sources.

### Timing, and what the check keeps

The card passes through intermediate states on the way to its settled
one. A figure shown briefly, a control offered and withdrawn, a duplicate
that appears and vanishes — each is something the lender was shown, so
the check carries every render it read rather than judging only the last
one. Conversely, a reading taken before the page has caught up with the
chain is not evidence of anything, so heights announced by the page are
waited for, scoped to the deployment's own endpoint, and refused when a
provider's answers cannot be told apart.

### Stated limits

Two, and they are gaps in coverage rather than in the checking. The pool
of positions is inherited from the existing driver, so NFT rental loans
are outside it and the card's rental route is not exercised by a live
run — the run says so in its own output rather than leaving the reader to
assume otherwise. And one limitation is intrinsic: a check that watches a
live page can never rule out that the page changed between two of its own
observations, so where that race is unavoidable the check reports what it
saw and names the uncertainty instead of resolving it by assumption.

Closes #2093. The round-by-round record of how each of these rules was
arrived at — including several cases where a fix left its own new state
unhandled, or was applied to one of several parallel sites — lives in the
pull request's review threads, the commit messages, and the coverage
matrix entry, which is where that detail belongs.
