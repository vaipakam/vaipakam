# Release Notes — 2026-09-13

Six entries. Four are about the drive that reviews the deployed build
on a testnet, and each fixes a rule that could have blamed the product
for something the product did not do. One rule was too quick to reject
text sitting above the page's top edge, not knowing that a scrolling
region inside the page could bring it back. Another refused any figure it
could not account for, but knew the words for durations only in English,
so a grace-window sentence written with a figure in one of five shipped
non-Latin languages would have read as an invented amount. The third let
one page's network outage vanish into a later page's success, which
erased the very evidence that would have explained that page's missing
card. The fourth had several of those rules reading a stretch of the
drive's own source measured as a fixed number of characters, which is
wrong in both directions: too short and a rule goes blind to the end of
what it checks while still looking exact, too long and it starts matching
its neighbours. All four now measure what they rely on rather than
assuming it, and say plainly what they cannot decide.

The fifth is about the protocol's own books: the ledger that records
delivered funding now measures what actually moves.

The sixth removes a guard rather than repairing it. A check that read the
whole repository looking for a deployment command missing its
value-preserving flag had accumulated fourteen open reports, each a
different way of misreading text, four of them wrong about a correct
tree — and deciding whether a piece of text will run a command, and
against which configuration, needs the execution model of every system
that might run it. In its place, every deployment configuration in the
tree now declares that a deploy preserves those values, which is a
question about a file rather than about a command. Two things the old
check covered are not covered by the new one, and both are named where
that defence lives rather than left to be discovered.

No product surface changed by any of the six, and the drive still reads
the live card as readable.

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

## Thread — the deploy guard stops guessing what text will run

Cloudflare Workers lose their dashboard-managed environment values on an
ordinary deploy: wrangler treats the checked-in configuration as the source of
truth and deletes anything not in it. For the keeper that is the liquidation
tuning; for the agent, recipient-token validation and marketplace pagination.
Two defences were built for this. The first asks each Worker's configuration to
declare that a deploy preserves those values, which wrangler honours on both
the publish and the staged-version paths — so every way of spelling a deploy
becomes safe at once, including ways nobody has written yet. The second walked
the whole repository looking for a deploy command that did not carry the
preserving flag.

The second is now retired. Asking whether a piece of text will run a command,
and against which configuration, means holding the execution model of every
system that might run it — a workflow file's, a package manifest's, a
Makefile's variable language, a shell's quoting rules, a command interpreter's
name resolution — and the attempt did not converge. It accumulated fourteen
open issues, each a different parsing edge: a folded workflow scalar whose
character offsets do not line up with the file's, a Makefile whose recipe
marker is settable, a PowerShell here-string read as live code, a variable
spelled in a different case, a helper saved with an upper-case extension, a
semicolon after an assignment. Four of those were false reports — they redden a
tree that is correct — and none of the fourteen named a real file in this
repository. The check, its fixtures and its CI job come to about 23,800 lines,
and deleting them costs **three** guarantees, of which **one is kept and two
are not**. All three are named here rather than only in the detail below,
because this paragraph is what an approver reads — and two successive review
rounds found this summary understating the cost, first by claiming none and
then by claiming one.

*Kept:* a deployment pointed at a different checked-in configuration file whose
name follows the tool's own convention. The canonical file's declaration is not
what gets loaded in that case, and the requirement now applies to every such
configuration, so the coverage survives.

*Lost — first:* a configuration **generated or rewritten at deploy time**. The
retired check refused those, not by reading them, but by falling back to
judging the command when it could not trust the file it named. A check that
looks only at files has no such fallback.

*Lost — second:* a checked-in configuration named **outside the tool's
convention**. The retired check read whatever path the command selected,
whatever it was called; the replacement finds configurations by that
convention, so a file named anything else is invisible to it. An earlier draft
of this note called that "the price of not classifying files by their
contents", which is true of why it cannot be recovered cheaply but wrong about
what it is: the old check did cover it, so it is a removal and not a limitation
the change inherited.

Both losses are real reductions and both want a deliberate acceptance. The
second is narrower — it needs someone to check in a deployable configuration
under a name that does not begin the way every configuration in this repository
begins — but narrower is not the same as absent, and an approver should be told
the count rather than the adjective.

Keeping it took two attempts, and the second is the more useful lesson. The
first kept it by deciding which configurations mattered — those naming a
Worker with values to lose, carrying a compatibility date, in one of two
directories. The next review round returned six findings against that, each a
different way a deployment reaches such a Worker through a configuration the
rule had excluded: the name can be overridden on the command line, the missing
date supplied there, a named environment selected, an arbitrary path chosen, a
newly added Worker absent from any list. Answering those needs the deployment
tool's own merge semantics — the same open-ended inference this change exists
to retire, moved from shell text into configuration files.

So the classification is gone. **Every deployment configuration in the tree
declares preservation**, whatever it names and wherever it sits, identified by
the tool's own filename convention rather than by anything about its contents.

Two exceptions qualify that, and both come from the deployment tool's own rules
rather than from any judgement the check makes about a file. A **static-site
project** — a different product mode of the same tool, recognised by that
mode's own marker — is exempt, because the tool *refuses* the declaration
there: requiring it would leave no version of such a file that satisfies both
the tool and the check. And a named environment is deliberately NOT required to
declare it separately —
an intermediate draft did require that, reasoning that inheritance could not be
established from here, and review pointed out the setting is top-level-only:
the tool rejects it inside an environment and reads the top-level value after
the environment is selected. Demanding it there would have forced an
unsupported field and a validation warning on every deployment. Not being able
to establish something is a reason to go and find out, not a licence to require
the cautious-looking thing. Two
Workers that hold no operator-managed values today declare it as well: that is
the point rather than an oversight — classifying them was the thing that kept
going wrong, and one that later gains a value is already safe. What it costs
them is the trade the others already accept: a deployment can no longer remove
such a value, so deleting one becomes a deliberate dashboard action.

The functional specification had already reached this conclusion and said so —
where a check would need another system's execution model, the answer is a
declaration from the deployment itself rather than a better approximation in
the check. So this closes the divergence in the direction the specification
pointed, by changing the code.

It does **not** withdraw the specification's separate, permissive allowance
that a secondary command-level check *may* exist. A first draft did, rewriting
that into "an implementation should not carry one", and review was right to
call it a reversal of ratified intent rather than a code-to-spec fix. The
allowance stands; the platform simply does not exercise it, which the allowance
permits. The constraints the specification already placed on any such future
check are kept in condensed form rather than deleted along with the
implementation, so a later attempt inherits what was learned instead of
rediscovering it.

What the remaining defence does *not* cover is written down where that defence
lives, rather than left to be inferred — a deployment that explicitly
overrides the declaration on the command line, a configuration that does not
exist in the tree when the check runs because it is generated, and a
configuration checked in under a name that does not follow the tool's
convention.

Only the first of those is inherited. The other two are removals, and each was
established by review naming the retired check's own deleted fixtures rather
than by argument: for the generated case, three of them; for the
non-conventionally-named case, one that seeded exactly such a file and asserted
the old check refused the deployment that selected it.

Why the second cannot simply be recovered: finding configurations by anything
other than their name means classifying files by their contents, and that is
what produced four false reports on a correct tree earlier in this very change.
The convention is therefore stated as a contributor rule — a deployment
configuration is named the way the tool names them — and the residual exposure
is one accepted miss, named, in place of six edges. That is a reasonable trade
and it is still a reduction; both things are true and the note now says both.

This is the third and fourth instance of one pattern, and it is recorded as
such in the contributor handbook alongside the others: when successive review
rounds keep finding edges of the same rule, the move is to remove the rule,
not to add the next edge. It happened twice inside this one change — once for
the command scanner, and once for the classification written to replace part
of it — which is the clearest evidence available that the pattern is about the
shape of the question being asked, not about any particular implementation of
it.

Closes #2085, #2110, #2112, #2113, #2114, #2115, #2116, #2117, #2118, #2119,
#2121, #2122, #2123, #2124, #2126.
<!-- assembled-fragment: 2085-retire-deploy-command-scanner.md sha256=10a025034b6147245f81c8c710c8fda15c92886c0224699427ecb4c872a98b91 -->

## Thread — The drive's source guards are bounded by meaning, not by character count (PR #2170)

Parts of the drive that reviews the deployed build cannot be run from a
unit test, because importing the file runs the whole drive. Those parts
are checked by reading the drive's own source instead, and each such
check needs a region of that source to reason about. Several still took
their region as a fixed number of characters from a starting point, which
is wrong in both directions and moves with edits that have nothing to do
with the rule being checked. Too short, and the check is blind to the end
of the region while looking exact: one such check counted the assignments
recording an outcome, found two where there are three, and asserted that
count as exact, so deleting the very line it exists to protect would have
left it passing. Too long, and a rule about one region silently starts
matching its neighbours.

Every such region is now bounded by something that means the region has
ended — the statement it belongs to, the block it opens, or a named
landmark in the code that follows it. The helpers refuse to return
anything when a landmark is missing, or when the closing one does not
follow the opening one; that last case would otherwise hand back an empty
region, and a rule asserted over nothing passes by checking nothing,
which is the failure this whole family exists to refuse.

Review caught the same mistake three times, and the third time is what
changed the approach. Each attempt established that the conversion was
complete using something that read the file as plain text, and each
reader was narrower than what it was looking for. The first missed
several windows because it insisted they start a particular way. The
second could not see a window written across four lines, because it
stopped at the first closing bracket it met. The third, a hand-written
reader of its own, missed a bound hidden behind a comment, a bound
written as text rather than as a number, and a bound given a name — and
quietly skipped any call whose brackets it could not pair up, so ordinary
formatting was enough to slip past it.

Each fix was correct and the next gap was already waiting, because
"where does this piece of code end" is a question the language's own
grammar answers, and a reader assembled by hand is a worse answer to it
every time. So the boundaries are no longer found by reading characters.
The file is parsed, the way the language itself does, and a region that
is a piece of the grammar — a statement, a block, a call — is taken as
that piece. Quotes, comments, patterns and the punctuation that means two
different things stop being special cases to remember.

One kind of region is deliberately still located by text, and saying
otherwise would have been the overclaim this note is about. Some regions
are not a piece of the grammar at all — a declaration and the few lines
that belong with it — so there is no piece to ask for, and they are
bounded by naming a landmark in the code instead. Those landmarks are
matched against the file's text, with one protection: a landmark is
never matched inside a comment, because these files quote code in prose
constantly and a mention in a comment was moving a boundary. A landmark
that appears inside a string is still matched, and that is on purpose —
a string in the code under test is code, and one of these landmarks is a
message the program actually prints.

That also fixed a fault the hand-written reader had been shipping: a
declaration containing a search pattern was cut in half, and one
containing an unbalanced bracket was reported as having no end at all —
the same silent truncation this whole effort exists to remove, produced
by the tool meant to remove it.

The completeness claim is now made by the suite rather than in prose, and
it is made the safe way round: rather than working out which values hold
source code and checking only those — a question with no bounded answer,
and every gap in it a hiding place — it checks every such bound in the
family, and the handful that legitimately count characters say so in a
short note at their own declaration, naming what they count. Nine of
those became three notes, because saying it once per reason is also how
a fourth gets noticed. A note covers the one declaration it sits above
and nothing else; an earlier version covered whatever happened to follow
within a few lines, which would have let a fixed window inherit a pass by
being written next to a legitimate count.

Deciding whether a bound is a count, rather than a landmark, is also
asked of the value a name is given, and of the value that name is given
in turn. Review found those being answered by two separate pieces of
code, of which the weaker looked only at the surface of a definition — so
a length that had been given a name, or worked out by arithmetic, or
handed on through a second name, read as a landmark. There is one answer
to it now, used in both places, because it was always one question.

A further round found the rule drawn slightly wrong in both directions at
once, which is the useful kind of finding. It was too narrow in four
places — it recognised one of the three standard ways to shorten a piece
of text and not the other two, it did not see a length supplied as a
default value or declared inside a branch of a multi-way choice, and the
note excusing a legitimate count could be faked by an ordinary piece of
text that merely contained the words. And it was too wide in one: a
landmark that happened to mention a number was being read as a length,
which would have forced apologetic notes onto perfectly correct code.
That last one matters most. A check that complains about correct work
does not get obeyed, it gets switched off.

The same round found a region in the existing checks bounded by a
sentence rather than by code. These files quote code in prose constantly
— naming the thing a rule is about, the call a fix replaced — and one
check had been ending its region at a mention inside a comment rather
than at the code it meant to stop before. A landmark is now required to
be code, and that check is re-anchored. Notes in the margin that mention
a landmark no longer move it.

A sixth round settled how the check should be phrased, and that is the
part worth recording. Every round so far had answered the same question —
"could this length be a fixed number?" — and every round had found
another way of writing one that the check did not know about: spelled as
text, given a name, handed on through a second name, worked out by
arithmetic, supplied as a default, declared inside a branch, produced by
a function defined and called on the spot, assigned after the fact, or
buried in a pattern that unpacks an argument. There is no end to that
list. Every way of writing a number is an open-ended thing, and a check
whose correctness depends on having listed all of them is wrong without
knowing it.

So the question is asked the other way round now. Rather than trying to
recognise a length, the check recognises a LANDMARK — a search for text,
a small helper that performs one, a name holding the result, the measured
length of the thing searched for, and simple combinations of those. That
list is short and closed, because it is what these checks actually write.
Anything else is treated as a length and has to say what it counts.
Unrecognised is refused, so no new way of SPELLING a number gets in by
being one the check had not met.

That is a real result and it is narrower than it first reads, which is
worth stating plainly rather than leaving to be discovered. Closing the
set of spellings does not close the set of ways a shape the check DOES
recognise can turn out not to be a landmark after all. A search reads as
a landmark, but the check does not yet establish that it searches the
same text being narrowed — so a search through some unrelated string can
carry a fixed count through in good standing. A name holding a search
reads as a landmark even where the thing it names was never set, because
control left the block before the line that sets it. And a stand-in
object that only looks like a searchable thing is caught when it is
written out plainly and not when it is chosen between two of them.

None of these is a way of writing a number; each is a way for a
recognised landmark to be hollow. They are recorded as open work rather
than described as closed, because a check that overstates what it
guarantees is the same failure as a window that overstates what it
bounds.

Measured before adopting it: phrased this way the check objects to
exactly the three places that genuinely do count characters, and to
nothing else. Its remaining cost is written down rather than glossed — a
landmark handed into a helper as an argument is unknown to it, and the
answer to a case like that is to teach it the shape, never to attach an
apologetic note to correct code. A note asserts that something really
does count characters, and putting one on correct work is a falsehood the
next reader inherits.

A seventh round is worth recording because the findings changed
character. They stopped being "here is another way to write a number the
check has not met" and became "the things you call landmarks include
several that are not" — which is a question about a short list I control
rather than about an open-ended one I cannot finish. That is the evidence
the change of phrasing did what it was meant to.

The substantial one is that a place and a distance had been treated as
the same thing. The gap BETWEEN two landmarks is a width, and using a
width to say where a region ends is the fixed length again, arrived at by
subtraction instead of typed out. So the check now keeps places and
distances apart, and knows which combinations mean anything: a place plus
or minus a distance is a place, one place minus another is a distance,
and two places do not add. A measured width on its own measures something
and points at nothing, so it can no longer end a region.

The rest were things that merely looked like landmarks: an object with a
search-shaped method that returns a fixed number, an object with a
length-shaped field that does the same, a name that holds a landmark when
it is declared and is overwritten afterwards, a helper that returns a
landmark on one path and nothing on the other, and a collection of
landmarks handed over where one was expected.

Two of these were live rather than hypothetical. One check bounded a
region with no end at all, so its rule about the order of two things could
have been satisfied by matching text anywhere further down the file; it is
re-bounded on the block it is actually about. And a check whose region
legitimately runs to the end of an already-bounded piece of text is
recognised as such, rather than being asked to invent an ending it does
not need.

The notes that excuse a genuine count were tightened twice more. One note
above a line declaring two names was excusing both, though it can only be
about one, so a line declaring more than one name is no longer excusable.
And a note now has to be a stated reason rather than a mention: the words
alone, or a sentence saying never to use them, no longer count.

An eighth round kept narrowing the same short list, and two of its
findings were the more valuable kind: places where the check objected to
correct work. A region that starts at the very beginning of the text was
being told to apologise for counting characters, when the beginning of a
text is a place like any other. And a name used as a landmark was being
rejected because somewhere else entirely, in an unrelated piece of code,
a different thing of the same name was changed. Both are now right. A
check that complains about correct work does not get obeyed; it gets
switched off, and then it protects nothing.

The rest were the remaining ways to look like a landmark without being
one: a name overwritten by unpacking rather than by a plain assignment, a
collection's count of landmarks mistaken for one of them, a landmark set
up inside a branch that may not have run, and a value that looks fixed
until a caller supplies a different one. Two were ways of writing the
same truncation that the check simply was not looking at, and one was a
helper trusted by its name where a locally defined thing of the same name
could have returned anything.

The oldest habit in this work surfaced once more: a region whose starting
landmark was matched inside a comment rather than in the code. That had
been fixed for one kind of boundary three rounds earlier and not for the
others, and parsing had made it worse rather than better — the earlier
hand-written version would usually have run off the end and complained,
where the parser hands back a plausible, complete, wrong region.

A ninth round found three, down from fourteen, and all three concerned
the one place the check reads a landmark out of a list. A position in
that list has to be a whole number counting from the front, since
anything else picks out nothing at all and the region then runs to the
end of the text. And a list that is changed after it is built no longer
says what it said, whether by replacing an entry or adding one — though
merely reading it changes nothing, and an early version of this treated
every use as a change and rejected regions the checks legitimately take.

The third was an old kind of name that can be declared twice, where the
second declaration quietly replaces the first rather than making a new
one. Resolving it where it is written rather than where it belongs had
made those look like two separate things.

A tenth round found six more, and two were again the check objecting to
correct work: a landmark stored in an old-style name declared plainly at
the top of a function, which always runs before it is used; and a list
changed *after* the region was already taken, which cannot affect
something that has already happened. Both are accepted now, and the
cases that genuinely are unsafe — a landmark set up inside a branch, or
one set up after the fact, or a list changed before the region is taken —
still are not.

The other four were the list rule again and a receiver taken on trust: a
position past the end of the list, a position written in a way that looks
like a number without being one, an entry stepped up in place, and a
thing that merely has a search-shaped method. The check now resolves the
list and confirms the entry is really there, and confirms a receiver is
not something written out in the file with a method of the right name.

One process note, because it is the more useful lesson. I read that round
as clean and began merging. It was not: the findings were on the second
page of a paginated list and my check read only the first. Nothing
merged, but only because a rule about resolving conversations stopped it,
not because my own check caught the mistake.

An eleventh round produced the decision this note should end on: one
capability was **removed** rather than fixed again.

The check had learned, early on, to recognise a landmark picked out of a
list. That was added to avoid complaining about a shape review raised in
passing — and that shape appears nowhere in this work. Keeping it honest
then took three rounds: the position in the list had to be proved real,
the list proved unchanged, a change proved able to reach the use, the
ways of spelling a change all recognised, and the list followed through
second names for it. What was still open after all that needed the kind
of whole-program reasoning this work has four times declined to attempt,
on the grounds that a half-version of it states confident conclusions it
has not earned.

A capability with no user, whose correctness bill has no ceiling, is not
worth the surface it presents. So it is gone, and a bound of that shape
is simply reported like anything else the check does not recognise. If a
real one ever appears, it can be recognised then, deliberately, with its
own reasoning written down. Removing it also retired a second rule that
existed only to serve it, and that the same round showed could not be
made sound either.

That is the opposite of the reflex this whole effort has been fighting.
The easy move was a sixth patch to a feature nobody uses; the honest one
was to stop carrying it.

Putting a removed window back, in any of the disguises review has
demonstrated, turns the suite red — each one written down as its own
case, and each rule that ACCEPTS something written down beside it, so
neither half can quietly rot into the other.

No count is given for that list, on purpose. An earlier draft of this
note asserted one, and a careful recount could not reproduce it: the
obvious way to tally the cases mixes the ones that must be refused with
the ones that must be allowed. Twice already in this work a number has
been stated on the strength of a check narrower than the thing it
counted. The honest version is the list itself, which anyone can read.

Four further rounds narrowed the same short list, and the last of them
ended the way the parsing round did — by replacing something written by
hand with the thing that already exists to do it properly.

The remaining findings had almost all stopped being about lengths and
become about NAMES: what a name means at the place it is used. Answering
that had quietly grown its own hand-written machinery — which shapes
introduce a new scope, which spellings declare a name, which declarations
are hoisted to the top of the piece of code they sit in, what counts as
changing a name. Nine rounds each added one more shape to that list: a
name taken apart from a larger value, a name declared inside one branch
of a multi-way choice, a name given a fallback value, an older kind of
name that floats to the top, a name introduced by a class, a name a
function or a class gives only to itself, the same name declared twice, a
name declared and published in one breath, and a name brought in from
another file.

That is the open set again, wearing different clothes. "What does this
name mean here" is written down in the specification of the language and
implemented by a well-used component that does nothing else. So the
question is asked of that component now, and about a hundred and eighty
lines of language rules re-implemented by hand are gone. Only the two
questions it does not answer stay local — whether a definition definitely
runs on the way to the use, and whether a change to a name could reach
it — and both refuse when the order cannot be known rather than assume
the convenient answer.

Two other fixes in the same stretch are worth recording because they are
the kind that keeps the check honest rather than merely stricter. Order
means something only when both ends of the comparison sit in
straight-line code: a region taken inside a function runs whenever that
function is called, so a change written below it may still happen first.
And a value set up inside a class's own fields runs when an object is
made rather than where it is written — unless it belongs to the class
itself, which does run in place, so that case is accepted rather than
refused. A check that objects to correct work gets switched off.

One boundary was still located by reading text where the grammar could
have answered: a piece of text borrowed from another and then measured
was slipping past the collector, and so was a header written inside the
gap of a piece of assembled text, which is code and was being skipped as
though it were quotation.

A further round is the one that shows the effort has turned a corner, and
it is worth recording for that rather than for its fixes. Four of its
five findings were the check REFUSING CORRECT WORK — the direction that
matters most, because a check which complains about correct code does not
get obeyed, it gets switched off. The refusing side has become tight
enough that the remaining work is loosening it where it is too tight.

Three of those four were the same mistake wearing different syntax, and
naming it is the fix. A rule was being stated about a whole piece of
code, when only PART of that piece is uncertain. The body of a loop that
always runs at least once is not uncertain, though the loop repeats. The
name of a value stored on an object is worked out when the object's
shape is written down, though the value itself waits until the object is
made. The test of a loop runs at least once, though its body may not. In
each case the rule was right about one part and wrong about the other,
and wrong in the direction that refuses.

So the rules no longer name a piece of code. They name the PART of it
that is uncertain, and everything not named is ordinary code in ordinary
order. What is left out of those lists carries as much weight as what is
in them, and is written down beside them: the setting-up step of a loop
always runs, the clean-up step after a guarded attempt always runs, and
the kind of loop that checks its condition afterwards appears in neither
list, because it is guaranteed a first pass.

This is the same correction as the earlier one about assembled text, one
level up. A piece of assembled text is not quotation or code — its fixed
parts are quotation and its gaps are code. A piece of code is not
skipped or run — its parts are.

The fifth finding went the other way and was the cheapest kind of evasion
to fix: the check confirmed a helper came from this very file by looking
at the END of the file name it was imported from, so a file whose name
merely ENDED that way was trusted. A test could write one, have it hand
back the whole unbounded text, and pass. The name now has to be the whole
final part of the path.

Two smaller ones round it out, both again the refusing direction: bounds
handed to a borrowed operation inside a list were being read as one
unreadable thing rather than as the two bounds they are, and text brought
in from another file was being refused outright on the grounds that
imports cannot hold text — which is untrue, and contradicted a limit this
same file states two screens further down.

The next round confirmed the shift and sharpened the same idea. Naming
the uncertain part rather than the whole construct was right, but the
question asked about that part was still being asked about the whole: it
checked whether the use sat anywhere inside the construct, when what
matters is whether it sits on the SAME uncertain path. Something set up
in one branch and used in the other passed that test, and the value would
not have been set at all. The question is now asked of the part, which is
also what makes a value set earlier in the same branch, or earlier in the
same arm of a multi-way choice, correctly accepted.

That round also found the one case where a value stored on the thing
itself, rather than on each copy of it, is NOT in ordinary order. All the
names worked out when a shape is written down are worked out before any
of those stored values are, so a name computed further down can supply
something a stored value further up reads. Text order and running order
genuinely differ there, and the check now knows it.

The oldest habit in this work reappeared once more, and it is the one
worth ending on: two readers of the same question. A reader of "which
property is this" existed twice — one that could decode a name written
indirectly and one that refused to look at any — so a truncation spelled
with an indirect name was invisible to one and misread by the other, and
slipped past both. That is precisely the fault of the round that had two
answers to "is this a length", and of the round that had two answers to
"what does this name mean". There is one reader now.

Two smaller ones, both again the refusing direction: a truncation takes
at most two bounds and anything after is ignored by the language, but the
check was reading the ignored one as a length; and a note excusing a
genuine count, written above a small helper, was excusing every
truncation in that helper rather than the one it describes — the same
one-reason-many-bounds fault found earlier on a line declaring several
names, a scope wider. A note above a helper now excuses it only when
there is exactly one thing in it to be about.

A later round is worth recording for what it says about fixing things one
shape at a time. Half its findings were holes in the two rounds before
it — each of those a fix that was right about the case in front of it and
silent about the case beside it. A note excusing a genuine count, written
above a name, was made to cover only one truncation when the name held a
function; it still covered two when the name held anything else. That
same rule has now been stated four times, at four scopes, and only the
fourth states it plainly: one reason excuses one bound, wherever the two
sit.

The others follow the same pattern. A borrowed truncation whose method
name cannot be read was dropped, where the ordinary path has inspected
such a call for many rounds on the principle that a call nobody can name
is not a reason to stop looking. A truncation borrowed through the
language's own reflection helper was invisible because the thing it
borrows sits in an argument rather than on the call. And a region taken
from a named landmark would quietly take the NEXT block in the file when
the named one opened no block at all — which is the silent-wrong-region
failure this whole effort exists to refuse, produced by the helper meant
to refuse it. It now says so instead.

Two more were the check objecting to correct work: a value set inside a
branch went on poisoning a name that a later, unconditional setting
provably replaces; and a region chosen between two already-bounded
regions was called unbounded, when either choice has a meaningful end.

Three of the windows survived the earlier passes for a reason worth
naming: they bounded a declaration spread over several lines, which is
neither a block nor a call, so there was nothing to convert them to. That
missing bound now exists — a region may be taken as the statement it
belongs to, ending where that statement ends.

The last round is the one that names the shape of the whole effort. Two
of its findings were, again, the check objecting to correct work — a
choice between two already-bounded regions was accepted when written one
way and refused when written another, and an ordinary local function
handed to the language's reflection helper was reported as a truncation
it plainly is not. That second one had two readers answering the same
question about the same call, and the one that did not own the shape gave
the worse answer; whoever owns a shape now owns its answer.

One finding was the check trusting something it should not have. A
wrapper around a piece of text uses the built-in search, so it had been
exempted — but a wrapper is an ordinary object whose search can simply be
replaced, and replacing it is a change to a property, which no check on
the NAME can see. The exemption now depends on how the wrapper is used
rather than on how it was made: read through it and nothing else, or it
is not trusted.

The last one was a defect this effort introduced one round earlier. A
search had been widened to consider every occurrence of what it is
looking for, which was right; on an EMPTY thing to look for, every
position is an occurrence and the search never moves past the end, so
the call did not fail — it hung. The helper it grew out of has rejected
an empty landmark since it was written. This one now does too. It is a
fair record of the loop: most of what the review found in the late
rounds was over-strictness, but not all of it, and the one that was not
would have been a test suite that stops rather than a test that reports.

Two corrections after that are worth recording because both were holes
the round before them had opened, and both were in the direction that
matters. A list of values whose identity can be read off the page
included things built with `new`, on the reasoning that a thing written
out plainly is plainly what it is. That is true of a piece of text or an
object written out and false of a construction, because a constructor is
allowed to hand back something else entirely — so a narrowing borrowed
through one was not merely misjudged, it was invisible. And the rule that
a wrapper is trusted only if nobody has touched it was implemented by
looking at the first thing done to the name rather than the whole of it,
so reaching one property further along replaced the finder without the
check noticing.

The second of those is the more instructive. The rule was stated as
"list what may be done with this and refuse the rest", which is the shape
that has held up everywhere else here — and then it was implemented
against a prefix of what was being done rather than the whole of it. The
principle was right and the reading was short. A guard that misses a real
window is worse than one that objects to a good one, so both were fixed
even though the review loop had reached its agreed limit; a limit on how
long to keep polishing is not permission to ship a hole opened on the way
there.

The round after that is the one where an allowance was withdrawn instead
of mended, and it is the clearest example in the whole effort of when to
stop patching. A wrapper around a piece of text had been allowed through
on the grounds that it uses the built-in search. Three consecutive rounds
then found three ways to change which search it uses: writing over the
search on the wrapper, writing over it one step further along, and
replacing the built-in search for every piece of text before the wrapper
is even made. Each fix was correct and each revealed the next, and the
third is not reachable by examining the wrapper at all — it asks whether
anything anywhere has changed how searching works, which is not a
question with a bounded answer.

So the allowance is gone. A wrapper is now treated like any other
constructed thing, which is to say not trusted, and the cost is one
shape nothing in these suites writes. Three rounds needing three fixes
to one rule is the rule telling you which side of it is wrong.

The same round closed a narrowing that had been leaving entirely: a
search function fixed to a piece of text in one statement and called in
the next. The fixing was passed over because fixing is not narrowing,
and the call was passed over because its name says nothing about what it
holds, so the window fell through the space between the two.

Two last narrowings had been leaving unexamined, and the second is the
one that says something about the rest.

The first is a narrowing written as a label attached to a piece of quoted
text rather than as an ordinary call. It is still a call, and what it
hands the narrowing is coerced into a number, so it is a fixed offset
running to the end of the text — in a form nothing had thought to look
at. It is now looked at, and its bounds are reported as unreadable rather
than interpreted, since a coercion is not a landmark.

The second is a name taken apart from something rather than set to it.
Where a name is introduced by unpacking, it holds a piece of whatever was
unpacked — and unpacking a number yields nothing at all, so the name is
empty and the region runs to the end of the text. What the check saw
instead was the search on the other side of the declaration, and read it
as the name's value.

That rule already existed. One part of the system had known since several
rounds earlier that unpacking is not the same as naming, and every other
part that asks what a name holds did not. So it is fixed where the
question is answered rather than where it was asked, which is the
direction the remaining work in this area points: one place that answers
what a name holds and whether that answer can be trusted here, instead of
several that each answer a little differently.

A late sweep of the review's own backlog turned up nineteen comments that
had never been answered. Nine of them described things later rounds had
already fixed for other reasons. Ten were still true, and five of those
were letting a window through.

One is worth naming above the others, because it is this family's own
failure mode committed by the part written to prevent it. A region can be
asked for by naming the header that introduces it, and a check exists to
refuse a header that opens no block — the thing that would otherwise hand
back a plausible, complete, wrong region. A branching statement has two
arms, and that check only ever looked at the first. So naming the second
arm, where that arm opens no block, produced exactly the plausible wrong
region the check is for.

The others: a helper written to run asynchronously does not return a
place, it returns a promise of one, and the region it bounds is empty
rather than anchored. A landmark whose value is arithmetic has no width,
so stepping past it produces nothing at all — and the answer there was to
stop listing what a landmark may not be and start listing what it may:
text written out, a name holding some, or a region taken from the source,
which is what the single composite measurement in these suites actually
measures. A narrowing fixed to a piece of text and then used as a label
fell between two forms exactly as one fixed and then called had a round
earlier. And a narrowing held under an innocuous name was dropped on the
strength of the name, when a name says nothing about what it holds.

The sweep is the lesson as much as the fixes are. Answering every comment
is not bookkeeping — half of these had been raised hours earlier and
described live defects, and the reason they sat unanswered is that the
tool reading them had been looking at one page of a list with several.

The round after the sweep corrected three of the sweep's own fixes, and
that is worth recording plainly rather than folding in quietly.

The first is the sharpest thing this review produced. Deciding which arm
of a branching statement a name refers to had been done by counting the
characters between them — inside the fix for a check whose entire purpose
is to stop regions being decided by character counts. A comment between
the word and the arm was enough to pick the wrong one. It is settled from
the structure now, which is what should have been done the first time and
what the rest of this work exists to argue for.

The second and third are the same shape twice: a shortcut that trusted a
word instead of checking a thing. A reader was told to trust an object
whose property was spelled like a built-in's, and any object may have a
property spelled that way; and the reader that knows how to look past a
misleading name was not used on one of the two places a narrowing can
appear. Both now check what is actually there.

One earlier decision is reversed outright. Stepping BACK from a landmark
by its own width had been accepted for several rounds. It is not safe:
when the landmark is at the very start of the text the result is
negative, and a negative end is measured from the end of the source, so
the region becomes nearly the whole thing while reading as properly
anchored. Whether it underflows depends on where the landmark is, which
is only known when the code runs. Stepping PAST a landmark is the shape
these checks actually write, and nothing in them steps back, so refusing
it costs nothing.

The last round is the one that stopped a rule from trying.

A reader had been working out what a property holds by looking at the
object it was written in. Three consecutive rounds found three ways that
is wrong: the property written over after the object was created, the
property defined so that reading it runs code rather than fetching a
value, and the property brought in from somewhere else entirely. Each fix
was correct about the case in front of it and revealed the next. That is
the signature this work has learned to recognise — a rule that depends on
having listed every way something can happen is wrong without knowing it,
and the list here is "everything the program can do to an object", which
has no end.

So the reader stopped asking. A built-in settles the question; anything
else is unreadable and therefore refused. What is lost is a name — a
narrowing borrowed through an ordinary object is now reported as an
unreadable one rather than identified by its method — and what is kept is
that it is reported at all, which is the only part that protects
anything.

The same round widened a different rule in the opposite direction, and
the pairing is the point. A name can be given its value by assignment
rather than at its declaration, and the resolver refuses a reassigned
name because it cannot say which value stands. But "which one" was not
the question: if any value the name is ever given is a narrowing, the
call may be one, and a may-be is refused. Enumerating a name's own
assignments is bounded, where choosing between them is not. Where there
is more than one candidate, the bounds are reported as unknown rather
than guessed at.

The effect is that these checks now fail when the thing they describe
changes, and not when the file grows. A check that fails because a file
got longer teaches nothing, and trains the next reader to widen the
number rather than ask what it was supposed to bound.

Closes #2144. No product surface changes.
<!-- assembled-fragment: 2144-anchor-bounded-source-guards.md sha256=0eab062bbefd0423dd6ad94c05590f8b22a8005bca30f517711fdbcede4bab52 -->
