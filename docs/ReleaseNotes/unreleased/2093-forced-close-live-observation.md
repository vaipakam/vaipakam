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

The same rule governs the one control on the confirmation whose job is to
let the lender walk away. The check trials that control rather than
clicking it, and the card is allowed to withdraw the whole confirmation
the moment the position's readiness changes — so a trial can fail because
the panel went away rather than because the control was unusable. That is
correctly not treated as a defect, and it is now also not treated as a
pass: the run says it never established whether the lender could leave,
and asks to be re-run. A tested control and an untested one must not
report the same thing.

Two separate questions are asked about that control, and both follow the
same rule. Whether it can be activated is one; whether the lender can
*see* it is the other, and it needs asking separately because the
activation test is indifferent to a control that has been made
transparent. Either question going unanswered — not answered *badly*,
but not reached at all — now leaves the run saying so.

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

One refinement of that rule came from reviewing it rather than from the
page. Deciding that text is readable involves two separate questions —
whether the box is on screen at all, and whether a particular element's
own words are painted — and an earlier version of the rule collapsed
them. Because text colour is inherited, a container is deliberately not
judged by its own colour; but the collapsed rule discarded a whole
subtree whenever the container's own stray text happened to be invisible,
including a child that explicitly repaints itself. The result would have
been a reported failure on a card whose explanation is plainly on screen.
The two questions are now asked separately.

Gathering the readable text also has to preserve where the lines fall,
and the first version did not. Two sentences on separate rows are two
separate statements, and the amount rule relies on that: a waiting period
on one line and a currency named on the next are unrelated, where the
same words side by side would be an amount. Collecting every readable run
into one string erased those boundaries, so correct copy on two rows
could be reported as stating an amount it never stated — a false failure
about funds, introduced by the very change that made the reading honest.
Line breaks are now kept, while words split across styling inside a
single line are still joined without one, since a bolded word must not
become two.

Deciding that text is invisible has a matching limit. Transparent letters
are not always unreadable — a shadow or an outline can draw the glyphs
the fill leaves blank — so the check no longer concludes "erased" from
the fill alone. It declines rather than adjudicating: it does not try to
work out whether such a shadow is itself visible, or the same colour as
what is behind it, because that is the contrast judgement this check has
always refused to make. The cost is a defect it may miss; the alternative
is condemning copy the lender can read, which is what gets a check
switched off.

The oldest way of hiding text is simply to park it off the page, and
catching it took three attempts because the first two asked about the
wrong thing. Measuring the element's own rectangle catches text moved by
positioning it off-screen, but not text moved out from under a box that
stays exactly where it belongs — the standard image-replacement trick —
and a rule sized on the element's width let a short label in a wide
container through. The check now measures where the letters themselves
landed. Text that sits entirely before the top-left corner of the page,
which no amount of scrolling reaches, is not readable; text merely below
the fold is, and stays admitted. The residual is stated rather than
implied: the judgement is made for a block of text as a whole, so a
wrapped run whose first line alone is pushed off the page still counts in
full, on the grounds that the rest of it is plainly on screen.

### Asking the protocol rather than re-deriving it

A card can be perfectly rendered and still be offering an action that
would be refused. Rather than re-deriving the eligibility rules from a
second copy of them — which would go stale the moment the contract's
grace periods were retuned, and which ignores that those periods are
governance-configurable — the check simulates the exact transaction the
card would send, from the same account, against the same state, and asks
whether it would succeed.

That simulation is only allowed to stand for the protocol's answer when
the protocol actually ran it. A provider replying that the request itself
was malformed has not executed anything, and reading such a reply as a
refusal would let a defect in the checking tool be reported as a defect
in the card — an accusation that the card offers an action that cannot
succeed, built out of a question that was never asked. Those replies now
fail loudly as a fault in the tool instead.

Which block that question is asked at turned out to matter as much as the
question. A page announces new blocks far more often than a card refetches
its own data, so "the latest block the page has seen" is routinely newer
than the state the card is showing — and around the moment a grace period
expires, that difference is the whole subject. A card still displaying the
earlier state would have been reported as withholding an action the
protocol had only just started accepting. The check cannot tell which
block a rendered card read, so it no longer pretends to: it asks the
protocol at a block the card's data cannot predate as well as at one it
cannot postdate, and only treats a disagreement as real when the answer
was the same across that whole span. Otherwise the observation is
incomplete. The run prints the span it used.

"The same across the span" is then read rather than assumed. Asking at
the two ends and finding the same answer proves nothing about what
happened between them — and one of the things being asked can come and go
inside a single observation, because another position can be matched
against this one and then settled. A card that told the lender the truth
at the moment it was drawn could therefore be reported as promising an
outcome the protocol "would not take", on the strength of two readings
that never looked at the moment in question. The check now asks at every
block of the window it watched, which is a handful of readings, and says
so plainly when it could not cover the window instead of treating two
matching ends as proof.

Both of those rest on the earlier end of the window genuinely sitting at
or below the state the card displayed, and that took four attempts to
stop guessing at. A page's own data source can answer a read from a block
behind the one this check has already seen, so no estimate of "early
enough" is a guarantee, and neither is any inference from the order
things arrived in — a single network request can carry several questions
whose answers need not come from the same moment. What settles it is
asking the page's own data source for its current block *before the page
is loaded at all*. Blocks only advance, so anything that source serves
the page afterwards is at or above that point, whatever it is asked and
in whatever order.

That reading is not always available — the first page visited has not yet
revealed which data source it uses, and a source can decline to answer.
The check then falls back to the weaker evidence it can still gather:
whether that source reported its position before it served the page's
first read, which bounds the read where it holds. Only when neither is
available does the check say the comparison was not established rather
than making it anyway. The run reports which of those happened, so a
window that could not be covered is visible rather than looking like a
clean result.

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
another is caught. Only where the card actually commits to one of the two
outcomes: a card that describes neither is not making the promise this
comparison exists to check, and reporting it as unchecked would claim a
gap that was never there.

Every version of the card the check saw is judged, not only the one it
settled on, and whether or not the lender could act on it at that moment.
A wrong outcome shown while a button is still disabled has still been
shown; and it is not a loading placeholder, because a card whose readings
have not arrived says so in those words rather than naming an outcome.
The same now goes for a card that blames the protocol: an explanation
that was untrue when it was displayed is not made true by a later correct
one.

The comparison runs in both directions. A card that withholds the action
and blames the protocol — saying the deadline has not passed, or that the
protocol is paused — while the protocol would in fact accept the
close-out is now reported too. That reading was previously one-way, so a
lender could be denied a close-out they were entitled to and shown a
reason that was not true, and the run would still pass. The check is
careful about which wordings it judges: only the ones that assert the
protocol refuses, never the ones that say the app does not yet know or
cannot arrange a settlement, because those can be perfectly true at the
same moment. Both of those readings require the protocol's answer to have
held still: the check asks before and after it reads the page, and where
the two answers differ it reports that the window was not quiet rather
than judging the card on an answer taken at a different moment. That rule
applied only to cards offering the action until now; it applies to
withheld ones as well.

The confirmation's Back button is checked as well. It is the one control
on a pre-signature panel whose whole purpose is to let the lender decide
not to spend money, and a Back button that cannot be activated leaves
leaving the page as the only way out.

Telling those two buttons apart used to mean reading their labels — the
fee-paying one was "the button not labelled Back". That ties the check to
the wording, which breaks in any of the nine translated bundles and can
misfire in English on a confirm label that happens to contain the word.
The confirmation panel now marks both controls in its markup, so the
check identifies them by what they are rather than by what they say. This
is the one change here that touches the product rather than the checking,
and it changes nothing a user sees.

Two statements about the same fact are compared where the card makes
them. The heading and the explanation are chosen independently, so a card
could be headed "this loan is overdue" above a body saying the borrower
still has time — both on screen, disagreeing. That pair is now checked,
but only where the explanation actually settles the question: a paused
protocol or an unreachable price feed is perfectly compatible with an
overdue loan, and reading either as a contradiction would accuse a card
that is telling the truth.

The limits of what a simulation can prove are now stated too. Asking the
protocol whether a close-out would succeed establishes that it would be
refused; it does not establish which rule refused it. So a card that
names the wrong reason — saying the protocol is paused when the deadline
simply has not passed — is reported as unverified rather than passed,
because the check did not establish the reason either way. Verifying each
reason against its own rule is tracked separately.

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

The check also keeps a ledger of the requests the page itself made, so
that a surface missing because its data never arrived is reported as the
provider failing rather than as the product failing. One kind of error is
deliberately exempt from that ledger — a contract call that reverts is an
ordinary answer the app is built to handle, and recording it would make
every healthy run look broken. That exemption now applies only to the
requests that actually run contract code. A revert is a statement about
execution, so the same error shape coming back to a request for a block
number or a receipt is not an answer at all; treating it as one left the
ledger reporting a clean fetch while the page held an error, and the
later checks would then blame the product for a surface the provider had
failed to fill.

Amounts written as fractions — "½ ETH" rather than "0.5 ETH" — are now
recognised. They are a different kind of character from ordinary digits,
so the scanner had been finding no number at all and reporting such a
card as clean: the worst way for a check on funds copy to be green,
because it looks exactly like coverage. The recognised set is listed
explicitly rather than taken as "anything numeric-ish", since the wider
category also contains superscript footnote markers, and treating those
as amounts would invent findings on correct copy.

Several refinements concern the difference between a fault and a moment.
The card legitimately withdraws its whole confirmation panel when
readiness changes while the panel is open, and the check had been reading
that as a panel rendered without its action — a failure invented out of a
change that happened between two looks. It now records whether the panel
was still there in the same look, so the fault and its explanation come
from one observation rather than two.

The check also now refuses to pass what it could not establish. Where a
reading of the protocol fails — an unavailable endpoint, an unreadable
answer — the visit is reported as incomplete rather than clean, both for
the settlement route and for the reason a withheld card gives. A run that
exits clean should mean the checks ran, not that they were skipped.

And two surfaces gained checks they had been missing. The confirmation's
Back button is now required to be visible as well as usable — the
automation's own idea of "usable" does not consider transparency, so a
button nobody can see was passing — and a receipt is rejected if it
carries the terms of both settlement routes at once, which the previous
rule could not notice because it only checked that the right terms were
present, not that the wrong ones were absent.

Where the check's own restrictions could be the cause of what it sees, it
says so before blaming the page. The driver refuses to serve requests it
does not recognise, and that refusal can itself make a card fail to
appear; a conclusion drawn from something missing now ranks behind that
explanation, while anything the check actually read still ranks ahead of
everything.

One more on the confirmation panel. The check had been recognising that
panel by its Back button, which meant a panel rendered without one was
not examined at all — reported as something the check failed to read
rather than as what it is: a lender shown a fee-paying action with no way
to decline short of leaving the page. The panel is now recognised by
either its Back control or its receipt lines, which fail independently,
and a missing Back on a panel that did render is reported in its own
right.

### Which positions get looked at

The check visits a bounded number of positions, so on a lender holding
many of them the order decides which questions can be asked at all. It
had been ranking candidates by whether the card would appear, and that is
not the same as whether the card would offer anything — the confirmation
can only be read on one that does. A lender whose first few positions
were not yet closable could therefore use up the allowance on cards with
nothing to confirm, and the run would report the confirmation unchecked
while a usable position sat discovered and unvisited.

Positions the protocol would accept a close-out on are now tried first,
and that is settled before the check picks **which** lender to watch
rather than afterwards — otherwise a lender with several positions that
cannot be closed still outranks one holding a position that can, and the
allowance runs out before the better candidate is reached. It improves
which positions are looked at and changes nothing about the conclusions
drawn from them: the protocol accepting is not the same as the card
offering, so the run still says plainly when nothing it visited could
exercise the confirmation.

### Stated limits

Five, and the first two are gaps in coverage rather than in the
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

The third is in the amount rule itself, and it matters most because that
rule is about funds. The check reads rendered text rather than parsing
it, so it can only judge what a number sits next to: an amount written
out in words — "you receive one ETH", "half an ETH" — contains no number
to find, and a card saying that passes the check clean. Fractions written
as symbols are recognised, and spelled-out figures are not. So a green
amount verdict means no unsubstantiated amount was found in the forms the
check can see, which is a narrower statement than no amount was stated,
and it should not be read as the wider one.

The fourth is intrinsic: a check that watches a live page can never rule
out that the page changed between two of its own observations, so where
that race is unavoidable the check reports what it saw and names the
uncertainty instead of resolving it by assumption.

The fifth is of the same kind and worth stating separately, because it is
what every comparison with the protocol now rests on. Establishing which
state the page could have been showing means asking its data source where
the chain is before the page loads — and that assumes the source does not
go backwards, which a pool of machines serving one request from a machine
that has fallen behind would break. Nothing observable from outside the
page distinguishes that case. It is a far narrower assumption than the
estimates it replaced, and it is still an assumption rather than a
measurement.

Closes #2093. The round-by-round record of how each of these rules was
arrived at — including several cases where a fix left its own new state
unhandled, or was applied to one of several parallel sites — lives in the
pull request's review threads, the commit messages, and the coverage
matrix entry, which is where that detail belongs.
