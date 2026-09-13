# Release Notes — 2026-09-13

Four entries. Three are about the drive that reviews the deployed build
on a testnet, and each fixes a rule that could have blamed the product
for something the product did not do. One rule was too quick to reject
text sitting above the page's top edge, not knowing that a scrolling
region inside the page could bring it back. Another refused any figure it
could not account for, but knew the words for durations only in English,
so a grace-window sentence written with a figure in one of five shipped
non-Latin languages would have read as an invented amount. The third let
one page's network outage vanish into a later page's success, which
erased the very evidence that would have explained that page's missing
card. All three now measure what they rely on rather than assuming it and
say plainly what they cannot decide. The fourth entry is about the
protocol's own books: the ledger that records delivered funding now
measures what actually moves. No product surface changed, and the drive
still reads the live card as readable.

## Thread — Live-drive visibility rule credits an inner scroll container (PR #2157)

The check that watches the lender's forced close-out card on the deployed
build reads only copy a sighted lender can actually see. One of its rules
rejects text parked before the document's top-left corner, the older
screen-reader trick, on the grounds that no scrolling reaches it. That
reasoning is right for the page's own scroll and was wrong for a scrolling
region inside the page: a row inside such a region, scrolled above the
region's own visible slit, sits above the viewport while the page itself
has not scrolled, so the rule condemned copy the lender can scroll straight
back to. Nothing the check reads sits inside such a region today, so the
gap was latent rather than live, and the failure direction is the one the
check is built to avoid: dropped text reads as absent copy, and absent copy
can be reported as a card failure.

The rule now asks the reachability question once, for both places it is
used, the element's box and the text's own glyph rectangles, and credits a
scrolling ancestor's offset before condemning. The credit is measured, not
granted, and review sharpened what "measured" means: only a scrolling
region that actually carries the element counts, which is decided by the
same containing-block walk the clipping rule already uses, so a
viewport-fixed element gets no credit and an absolutely positioned one is
credited only from its containing block upward; an element's own scroll
counts for its text and not for its box; the distance a region can move
its content back runs to that region's minimum, which is negative for a
reversed layout; the distance is mapped through any ancestor transforms
before it is compared with on-screen positions, so a doubled region is
credited double; and only the page's own scrolling element is left out,
since the page scroll is already accounted for, so a body element that
scrolls independently is credited. Where the engine cannot supply the
transform mapping the rule admits rather than guesses. Text parked far
above inside a scrolled region is still rejected. The fixtures reproduce
the exact measurements, a negative row position with the page unscrolled,
and assert them to the pixel so no case can pass without reaching the
state it claims to test.

Writing those fixtures found the same gap one level up, in the clipping
rule. A non-scrolling wrapper around a scrolling region, the usual
rounded-corner card around a scrolling list, judged content scrolled out
of the region's slit by where it currently sits and condemned it, even
though the region can scroll it back inside the wrapper. A second review
round then showed that a blanket exemption for such wrappers overshoots in
the other direction, admitting a region whose slit the wrapper never shows
and content a region can only carry further away. So the clipping rule
and the origin rule now share one measure of what a scrolling region can
do, a range of movement in both directions rather than only back toward
its resting position, which is also what rescues content in a region
turned upside down. At a scrolling region the rule asks only whether the
content can reach the slit at all, since asking whether most of it can be
seen at once is the wrong question of something read by scrolling; at a
non-scrolling wrapper above it, the rule asks whether the slit itself is
mostly shown. A wrapper with no extent at all is still condemned whatever
scrolls inside it. A third round added two refinements to the same idea:
when one scrolling region sits inside another, the inner region's slit is
itself carried by the outer region's scroll, so it is placed where that
scroll can best bring it into view before the content is judged against
it; and a region styled to scroll but with nothing to scroll is treated as
the plain wrapper it behaves as, decided per axis. A fourth round tightened
the same model further: whether a region scrolls is read in on-screen axes
after any rotation, one scroll position has to serve every wrapper above
a region rather than each wrapper choosing its own, a wrapper that clips
only one axis leaves the other alone, and the two ways a horizontal
direction can be reversed cancel each other when combined, as measured in
the check's browser. One case from that round, a sticky row pinned to its
region, is deferred to its own issue with the reasoning recorded there.
The root element's overflow was also found to have been read as clipping
at the root's own box when it clips at the viewport, and is now judged as
the viewport. A fifth round added that a reversed flex direction only
reverses an actual flex container, and that the newer stand-alone rotate
and scale properties count as transforms the way the combined property
does; the exact treatment of a region rotated off the page's axes, where
the per-axis bounds admit more than a single scroll position can reach,
is deferred to its own issue with the reasoning recorded there. A sixth
round drew two boundaries and closed one gap: a region inside a
three-dimensional scene or written vertically is declared beyond what the
rule quantifies and is admitted rather than mis-measured, and a row that
is off-screen and admitted only because a region can scroll it back is now
checked for cover at the place it would come back to, so an opaque overlay
parked over the whole region rejects it. A seventh round refined those
edges: the cover check applies only where the page's own scrolling could
not bring the row back and looks inside the region's frame rather than at
its border, a row fixed to the viewport is never credited with the page's
scroll, page zoom is declared beyond the rule, the position chosen for a
nested region is the one that brings the row's reachable part into view
rather than the region's middle, and a stack of wrappers is measured
against the region's original size so that halving twice cannot pass as
half. One refinement, checking cover only over the exact band a scrolled-
out row can return to, is deferred to its own issue. An eighth round
added, each confirmed by measurement or pinned by a fixture: a container
that skips rendering its off-screen content also anchors absolutely
positioned descendants; a nested region resets the half-shown measure to
what it actually shows; and the cover check reads the region's frame as
drawn on screen and only through the wrappers that show it. Two further
refinements, knowing which region's scroll supplied the credit and holding
one scroll position across the origin and clipping checks, were folded
into the two issues already open for those themes. A ninth round closed
four more gaps inside the rule's scope, including that a row inside a
card fixed to the viewport does not ride the page any more than the card
does, and declared two more boundaries; it also wrote the scope down. The
rule now states exactly which layouts it quantifies, admits everything
outside that scope rather than guessing at it, and an umbrella issue
collects further precision findings beyond the scope so that the review
loop is bounded, while any finding inside the scope that would wrongly
reject readable copy is still fixed in place. The list of properties that make an element the
reference for absolutely positioned descendants gained two more, each
confirmed by measurement in the check's own browser, and one candidate the
review raised, container queries, was measured not to be one and left out
on that evidence. A tenth round fixed four more cases inside that scope,
each of which would have rejected readable copy: an opaque block that
sits inside the scrolling region and fills its slit is carried away by
the very scroll being credited, so it is no longer read as a cover; two
lines of one value that a shallow inner region can only bring to separate
parts of its slit are each brought into view on their own by the outer
region rather than judged at the gap between them; the question of
whether the page's own scroll moves a row at all is now asked in one
place for both the origin rule and the cover check, so a covered row
inside a card fixed to the viewport is checked and rejected however far
the page has scrolled; and the clipping rule measures a scrolling region
by its opening rather than its border, so a wrapper showing the whole
opening of a heavily bordered region is no longer read as showing a
sliver of it. One more boundary was declared: a mirrored region, like a
rotated one, is admitted rather than measured. An eleventh round made
the question of which ancestors carry a row one shared answer for the
clipping rule, the origin rule and the page-scroll test, asked at every
step of the way up rather than once of the row itself: a row inside an
absolutely positioned wrapper is no longer credited with the movement of
a scrolling region that does not carry the wrapper, and a card fixed to
the viewport inside another fixed card is still recognised as not moving
with the page. The clipping rule also honours the margin a clipping
region may extend past its edge, measured in the check's own browser so
that copy painted in that margin is read as shown, and the half-shown
rule for a nested region is now asked at the position chosen for each
line, so a line reachable only through a mostly hidden region is
rejected as it should be. A twelfth round tightened the scrolling
region's own test from "can any of it be reached" to "can enough of it
be read": the best position a region can reach must show at least half
of the line, or the whole opening where half the line would not fit in
it, so a row leaving a sliver in a region that can only carry it further
away is rejected. An ancestor that draws no box of its own is no longer
mistaken for the reference of an absolutely positioned row, and two more
declarations of intent to change an element's containing-block
properties, measured in the check's own browser, are recognised as
establishing that reference in advance. A thirteenth round found that the
shipped bound for that readable-overlap rule was looser than the
sentence above, half the opening rather than the whole of it, and
corrected the rule to the stated intent rather than the sentence to the
rule. It also reads such declarations of intent as whole property names,
so a declaration about a related property is not mistaken for one about
the property itself; makes the cover check look through only the
ancestors that actually carry the scrolling region, so a box the region
is not clipped by cannot narrow the check to itself; and treats a page
body that clips at its own edge, rather than standing in for the
viewport, as the real clipper it is. A fourteenth round measured that a
plain inline span cannot be transformed or contained, so declaring a
transform on one does not make it the reference for an absolutely
positioned row inside it; of the properties the rule reads, only the two
filter properties, a filter on the element or a backdrop filter behind
it, and a declared intent to change either, do. The rule now reads inline
wrappers accordingly, so a scrolling region between such a wrapper and
the row's real reference is neither credited nor blamed for the row.

Also carried: the wording of the previous entry's call-site ordering, in
the test header and the coverage row, now states the two sites separately
as the release-notes fold already does.

Closes #2138. No product surface changes.
<!-- assembled-fragment: 2138-inner-scroll-origin.md sha256=4a275dd14ce3fde9b3e6b5d563606fd3c940f5646e4268883e52fedaf7280ed4 -->

## #1566 closure 2 — the delivered-funding ledger measures what moves (PR #2151)

The reward-funding ledger on a mirror chain used to count by vintage: the paid
side was charged only for coordinated-mode days, inside the claim walk, and the
received side counted only deliveries whose every day was at or after the
chain's switch into coordinated mode. The balance that ledger protects is not
vintage-aware — a legacy payout and a coordinated payout spend the same VPFI —
so an ordinary-schedule claim could draw on delivered backing the bound had
already counted as available, and the bound reported itself satisfied. The
#1566 design calls this closure 2, "the ledger measures the wrong noun".

This change moves the charge to the two places reward value actually leaves,
and makes each of them a bound rather than a record. A claim hands its
genuinely-new component to the delivery step, which refuses the whole claim
before any transfer if that component exceeds what has been delivered and not
yet paid, and otherwise charges the ledger by exactly that amount. Within one
claim the coordinated-mode days are priced against what is left after the
ordinary-schedule slice, so a funding shortfall still defers those days rather
than refusing the whole claim, and the read-only preview quotes what the claim
will actually pay under the same order. The test that decides whether an
unclaimed reward's expiry clock runs measures the same total, so a claimant
whose claim would be refused for want of delivered funding is never counted as
able to claim, and a forfeiture or expiry that the delivered funding cannot yet
cover is deferred rather than failing the whole batch. Forfeited
and expired reward value enters the recycle bucket only through a reward
operation that refuses, charges and credits in one act. The generic
"credit the bucket with this label" entry is gone: each of the three proven
non-reward inflows (the notification tariff, the Full tariff, a spend-gated
perk purchase) has its own operation that verifies the tokens arrived before
crediting, and any other source has no door. On the received side the
authenticated new portion of a delivery is counted whatever days it funds;
compensation credits count at ingress and confirmation promotes nothing, so a
later demotion reverses exactly what the credit added. The two administrative
writers (the role-transition retirement and the one-shot paid seed) are kept.

The charge is taken only where the ledger is live, the mirror role; the
canonical column arrives with slice 4. No deployed chain has an armed mirror or
a non-zero ledger, so no live figure changes. The cutover apparatus the design
specifies for a chain that does — a migration mode, an open legacy
reconciliation epoch with ingress-stamped packet identities, the bounded
reclassification and restitution rules — is the second closure-2 PR and is
deliberately not approximated here. Refs #1566, #1956, #1349.
<!-- assembled-fragment: 1566-closure-2-chokepoints.md sha256=d92d59d1c71aa7887968a7805886d8833cde310ebe652cb658ddb43ff2dce0f3 -->

## Thread — Forced-close amount scanner learns each language's duration words (PR #2164)

The check that watches the lender's forced close-out card on the deployed
build refuses any figure the card cannot substantiate, and exempts the few
kinds of number the card is allowed to show: a duration such as the grace
window, a proportion, an identifier. Those exemptions knew only English
words. A grace-window sentence written with a figure in Japanese, Hindi,
Tamil, Korean or Chinese, five of the shipped languages, would therefore
have been reported as an invented amount on copy the specification
explicitly permits. Nothing was failing, because no shipped translation
currently writes the window with a figure, but that was luck rather than a
guard, and the first translator to add one would have turned the live
check red on correct copy.

The scanner now has to be told which language the text is rendered in,
and takes that language's duration words from the same standard locale
data the browser itself formats with, in every grammatical number and in
long, short and abbreviated forms, so the list cannot drift from what a
reader is shown and a language added later needs no edit. The live drive
passes the language it pins its browser to; the test that puts every
shipped translation through the scanner passes each bundle's own. Two
edges are stated rather than guessed at. In languages that write no space
between a number's counter and the word after it, the unit is recognised
only where the text continues in a different script, so a counter
followed by a particle is a duration while the word for yen is still an
amount. And a one-letter unit in an alphabetic script is treated as an
abbreviation that might mean a magnitude, in every language, so it is
reported unless something around it establishes a wait; a single Chinese,
Japanese or Korean character is a whole word and is not. A caller that
does not name the language gets the English words alone, and a
non-Latin duration is then reported, which is the loud direction rather
than the silent one. Asset glyphs and tickers are unaffected: the sourced
words are duration words, never a licence for any non-Latin token.

Review tightened the derivation in five places: a language that writes
the unit before the number is read from the word in front; abbreviations
the locale data writes with punctuation are stored in the same shape the
scanner reads; the sample numbers used to collect every grammatical form
are taken from each language's own plural rules rather than a fixed list;
a counter followed directly by a ticker or asset glyph is not a duration;
and a one-letter symbol classifies the same whether its accent is stored
composed or decomposed. A second round kept a multi-word unit as one
phrase, so a linking word inside it is never a unit on its own; judged the
first word after a counter even when a particle follows it, so a
denomination there is still an amount; matched units regardless of
sentence capitalisation, in the language's own casing rules; and made the
per-language cache immune to a malformed language tag masquerading as a
list of tags. A third round taught the scanner the forms a unit takes in
a sentence rather than standing alone, such as the German dative after
"in", by reading the same locale data's relative-time phrases; narrowed
the unspaced-script rule so that only Japanese grammatical script after a
counter reads as a particle, since the script used for loanwords is also
where asset names are written; and let a duration written before the
number stand when an asset is merely mentioned later in the sentence, as
one written after the number already did. A fourth round read which side
of the number a unit sits on from each phrase rather than assuming it,
treated a money sign glued to a counter as the amount it is, applied the
existing quantity guards to a unit written before the number, let a
language's own words for "in" and "ago" establish that a one-letter unit
means time, and counted a letter written with a combining mark as the
single letter it is. A fifth round moved the language vocabulary and its
matching rules into their own module, leaving the scanner as their
consumer; read the words on either side of a whole number, so a decimal
could not misfile a context word as a unit; preferred a language's own
longest phrase to an English abbreviation; learned both "in" and "ago"
forms for languages with a single grammatical number; kept a malformed
language tag in a fallback list from raising an error at match time; and
matched phrases whose words carry abbreviation marks. A sixth round let
phrase words be separated by any punctuation short of a line break,
remembered on which side of a number each word was seen so a word only
ever seen after a figure is not accepted in front of one, and treated a
unit word written entirely in capitals as the ticker it might be rather
than the duration it might be, in every language including English. A
seventh round allowed only punctuation, never a symbol such as a currency
sign, between the words of a phrase, and applied the capitals rule to each
part of a hyphenated unit. An eighth round extended that rule to
single-letter parts of such a unit and stopped a unit on the next rendered
line from being attached to a number on this one.

Closes #2125. No product surface changes.
<!-- assembled-fragment: 2125-non-latin-durations.md sha256=fd76b744c1215dd88270d865092d38b157010856aa7e929680210f7e8017e1a7 -->

## Thread — One page's network outage no longer disappears into another page's success (PR #2167)

The drive that reviews the deployed build on a testnet watches every
network call the page makes, so that when a card fails to appear it can
say whether the app was at fault or the network was. A failed call is not
by itself a fault: the app retries a failed read and falls back to a
second provider, so a failure followed by its own retry succeeding is one
healthy read. The rule that recognises that was matching calls by name
and arguments alone, which is the same for the same read on every page
the drive visits. So a genuine outage that spoiled one page was wiped
from the record the moment a later page made the same read successfully,
which it always eventually does.

The consequence runs in the worse of the two directions. The run could
pass while hiding that one page had been observed through a broken
connection; and worse, that page's missing card would then be reported as
the product's fault, because the evidence explaining it had been erased.
The whole point of this drive's two failure verdicts is that "the app did
something wrong" and "we could not look properly" stay distinct, and this
could turn the second into the first.

The rule now reconciles a failure only against successes from the same
page. Three earlier refinements had each narrowed when a success may
clear a failure — how soon after, whether both came back in the same
response, whether the success was even requested after the failure was
known — and none of them could express which page the calls belonged to,
which is why the same gap kept reappearing at a new edge. Scope is stated
once, at the source, rather than by narrowing time a fourth time. A
page's own retries and provider fallbacks all happen within that page, so
the rule keeps doing exactly what it was written for. Where the browser
cannot tell the drive which page a request came from, the current page
stands in, which errs toward reporting a recovered failure rather than
hiding a real one — the direction this drive takes everywhere. Records
written before pages were tracked are judged exactly as they were.

The situation has not been reproduced against a real partial outage,
since arranging one across pages is beyond the test environment; this is
a correction to the scope of an identity, argued from what that identity
can and cannot distinguish.

Closes #2100. No product surface changes.
<!-- assembled-fragment: 2100-rpc-ledger-cohort.md sha256=523a9b5317213afda024b55141c0e829c66d65588049bc37eae49a28945fb5ef -->
