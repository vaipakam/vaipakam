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

Asking whether the transaction would succeed also turned out not to be
the same as asking what the lender would receive. The protocol can settle
an overdue loan two ways — by handing over the collateral, or by matching
it against another position and repaying the lent asset — and the
close-out call succeeds either way, because the match is attempted first
and works. A card that had regressed to promising the collateral on a
loan the protocol would match instead therefore satisfied every check:
the transaction simulated cleanly, and the receipt's wording deliberately
covers both outcomes. The check now reads which settlement the protocol
would actually perform and compares it against the one the card is
displaying, so being told you will receive one thing and receiving
another is caught.

The comparison runs in both directions. A card that withholds the action
and blames the protocol — saying the deadline has not passed, or that the
protocol is paused — while the protocol would in fact accept the
close-out is now reported too. That reading was previously one-way, so a
lender could be denied a close-out they were entitled to and shown a
reason that was not true, and the run would still pass. The check is
careful about which wordings it judges: only the ones that assert the
protocol refuses, never the ones that say the app does not yet know or
cannot arrange a settlement, because those can be perfectly true at the
same moment.

The confirmation's Back button is checked as well. It is the one control
on a pre-signature panel whose whole purpose is to let the lender decide
not to spend money, and a Back button that cannot be activated leaves
leaving the page as the only way out.

### Timing, and what the check keeps

The card passes through intermediate states on the way to its settled
one. A figure shown briefly, a control offered and withdrawn, a duplicate
that appears and vanishes — each is something the lender was shown, so
the check carries every render it read rather than judging only the last
one. Conversely, a reading taken before the page has caught up with the
chain is not evidence of anything, so heights announced by the page are
waited for, scoped to the deployment's own endpoint, and refused when a
provider's answers cannot be told apart.

One consequence of that rule is worth stating, because it is where it
was got wrong twice: deciding that a piece of text is readable and
carrying that text into the verdict are two different steps, and the
readable-text result has to be the one carried. A receipt line with some
readable filler beside an erased label is legitimately a readable line —
but if what gets recorded is the underlying text rather than the visible
text, the erased label still satisfies the disclosure the line was
supposed to make, and the lender reads filler where the figures should
be.

The same rule about *where* an answer comes from applies to the chain
data. A provider that answers two different questions under one
identifier has not told the check which question it answered, so an
answer to one can be read as an answer to the other — and being wrong
about which chain a provider speaks for is worse than being wrong about a
single height, because it buys trust in everything that provider says
afterwards. Those exchanges are refused rather than guessed at.

Amounts written as fractions — "½ ETH" rather than "0.5 ETH" — are now
recognised. They are a different kind of character from ordinary digits,
so the scanner had been finding no number at all and reporting such a
card as clean: the worst way for a check on funds copy to be green,
because it looks exactly like coverage. The recognised set is listed
explicitly rather than taken as "anything numeric-ish", since the wider
category also contains superscript footnote markers, and treating those
as amounts would invent findings on correct copy.

### Stated limits

Three, and the first two are gaps in coverage rather than in the
checking.

The pool of positions is inherited from the existing driver, so NFT
rental loans are outside it and the card's rental route is not exercised
by a live run. That same pool also drops any position whose holder is
sanctions-flagged — which is correct for the card the existing driver
checks, and wrong for this one: the specification deliberately keeps the
forced close-out available to a flagged lender, because winding down an
already defaulted loan is a close-out the protocol keeps open to
everyone. So the one behaviour that most distinguishes this card is the
one a live run cannot confirm. The run prints both gaps in its own output
when they apply, rather than letting a clean tally imply otherwise.

The third is intrinsic: a check that watches a live page can never rule
out that the page changed between two of its own observations, so where
that race is unavoidable the check reports what it saw and names the
uncertainty instead of resolving it by assumption.

Closes #2093. The round-by-round record of how each of these rules was
arrived at — including several cases where a fix left its own new state
unhandled, or was applied to one of several parallel sites — lives in the
pull request's review threads, the commit messages, and the coverage
matrix entry, which is where that detail belongs.
