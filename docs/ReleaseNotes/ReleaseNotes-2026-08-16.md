# Release Notes — 2026-08-16

Six entries, and they fall into three pairs.

**Two settlement paths would still accept an offer past its deadline.** One is
the direct sale of a lender's position; the other is handing a borrower's
obligation to a replacement borrower. Both consult an offer whose expiry had
gone unchecked on that particular route, so a deadline a counterparty relied on
was enforced everywhere except where it mattered most. Both now refuse.

**Two places where what is published and what the system does were kept in
step** — one already out of step, the other arranged to go that way on a
schedule nobody controls.

The one that had already gone wrong: a design document promised that, on top of
the sender authentication the cross-chain messenger performs, the receiving
contract would check the sender's identity a second time against its own stored
copy. That second check was never built — the storage field reserved for it was
never read or written. The field is now removed outright rather than completed:
the messenger's own check covers what it was for, and a second copy would have
compared a deployment against itself rather than checking anything about the
message.

The other has not gone wrong yet, and the work is to stop it rather than to
correct it. The Overview's worked example printed its money amounts as fixed
numbers beside two fee rates read live from the published configuration. Those
agree today. They stop agreeing the first time either fee is retuned — and in a
way arranged to mislead: the rate updates and stays right, the unmarked
arithmetic beside it goes stale, and the freshness marker on the rate lends the
whole passage a currency the stale half does not have. That is what makes it
worth doing early rather than after. The amounts are now computed from the same
configuration, and the site search was fixed alongside them, because it had
been building its index from bundled defaults before the live values arrived.

**Two are residue from the securities excisions**, on user-facing surfaces
rather than in contract code. The tokenomics "Learn more" links had been serving
a 404 from a base URL that never followed the specification to its new home,
with two anchors underneath pointing at sections describing removed programmes —
separate excision tracks, the fixed-rate VPFI sale in #687-A and the `5% APR`
staking yield in #687-B. And the retired buy widget's strings finally leave the
marketing site's translation bundles, where seven languages still carried a
"Buy VPFI" label for a surface that no longer exists. Nothing rendered those
strings; they shipped in the bundle regardless.

## Thread — the tokenomics help links point at a document that exists (PR #1765)

Every "Learn more" link on a card that cited the tokenomics specification was
serving a 404. The base URL still addressed the spec at its old top-level
path; the document now lives under the functional-specs directory, and the
constant had not followed it. Ten links were affected.

Two anchors were stale on top of that. The VPFI vault overview card pointed
at a section named for a VPFI issuance and buy flow — a surface the #687-A
securities excision removed — where the acquisition and vault material is now
section 8. The dashboard rewards summary pointed at a rewards section that
does not exist; section 7 is the *removed* staking-yield program, so once the
base URL was corrected that link would have taken a reader to a retired
programme. It now points at platform interaction rewards, which is what the
card describes.

Every remaining anchor was checked against the specification's actual
headings and resolves.

The card help file also carries seven links to numbered README sections that
no longer exist — the README was shortened and those sections went with it.
Those are left alone here: unlike the tokenomics links there is no
corresponding heading to repoint them at, so each needs a decision about
where it should lead. That is filed separately.

The first of these was found while scoping #1742, which asks for the retired `buy-vpfi`
route spelling to be added to the excision ratchet. It is the same shape as
the PWA manifest shortcut that opened that issue: a clickable target whose
label or address asserts a removed surface is the assertion, regardless of
where it happens to land. The rest of #1742 stays open — adding the ratchet
token flags 27 files, most of them stale identifiers whose user-facing copy
is already correct, and choosing between pinning those and renaming them is
a decision recorded on the issue rather than made here.

## Marketing site — the retired VPFI buy widget's strings leave the translation bundles

The public marketing site's VPFI page once carried the interactive
deposit/withdraw widget. That widget moved to the connected app, but its
strings stayed behind in the marketing site's translation bundles: connect
prompts, unsupported-network notices, the three numbered step headings, and
the button labels and failure messages for every action it used to offer.

Twenty-five keys in all, none of them read by anything the marketing site
renders — the page uses only its title and the pre-connect explainer. They
shipped to every visitor regardless, in the English bundle that loads on
first paint and again in each translated bundle.

Four of them named a purchase — a button reading "Buy VPFI", its in-flight
and failure counterparts, and a timeout notice about returned funds. The
English copy on this page had already been reworded away from purchase
language by the securities excision, but these particular strings were part
of the widget rather than the page, so the rewording never reached them, and
seven of the translated bundles still carried the purchased-verb phrasing
their translators had been given. Nothing rendered them; they were
nonetheless the removed surface, asserted in the shipped bundle.

All twenty-five are gone from all ten language bundles. Nothing the page
displays changes.

While confirming which keys were dead, a larger version of the same drift
came into view: the marketing site's bundles carry fifty-four further
namespaces that belong entirely to the connected app — well over a thousand
strings the marketing site never renders. That is filed separately; this
change stays inside the one namespace the page actually uses.

## A lender offer past its deadline can no longer be consumed by a direct position sale

An offer to lend carries a deadline. Past it, the offer is dead everywhere it
can be filled or matched — the row survives in storage because nothing sweeps
it away, so every path that could bind it to a loan is expected to refuse it
on sight.

One path did not. A lender selling their position directly into a standing
offer to buy went through checks on what kind of offer it was and whether it
had already been taken, but never on whether its deadline had passed. So an
offer whose window had closed, and which nobody had yet got around to
cancelling, stayed consumable: the seller could take the principal the offer's
author had set aside and mark it as filled, after the period that author
agreed to had ended.

Nothing here was mispriced. The author got exactly the loan they described, at
their stated terms. What they did not get was the right to stop offering — the
deadline they set was the whole of their consent to the timing, and it was
being read by every other route and ignored by this one.

The sale now refuses an offer past its deadline, before anything moves. The
caller is told which offer expired and when, so the refusal can be explained
rather than just reported.

Two details worth stating, because both are places a fix like this commonly
goes wrong:

**An offer with no deadline is not an expired offer.** Offers may be authored
to stand until cancelled, recorded as the absence of a deadline. A check
written as "now is at or past the deadline" reads that absence as the earliest
possible instant and rejects every such offer. The sale routes through the
shared helper that already handles this, rather than re-deriving the rule.

**The deadline second is already closed.** An offer good until a given moment
is not fillable *at* that moment. This matches every other fill path, and is
now pinned by its own test so a later simplification cannot quietly reopen a
one-second window.

This is one of the contract-side gaps recorded against the lender
early-withdrawal work. It was the one that moved another party's funds outside
the window they consented to, and the guard it needed already existed and was
already in use elsewhere — it had simply never been called here.

## The worked example's arithmetic, and the site search, now move with the rates they are computed from

The Overview walks a reader through a specific loan — a thousand dollars, eight
percent, thirty days — and prints what each party ends up with. The two fee
rates in that passage were already read from the published protocol
configuration. The amounts computed from them were not: they were written into
the page as fixed numbers.

They agree today. They stop agreeing the first time either fee is retuned, and
the way they stop is the problem. The rate moves, the arithmetic beneath it
does not, and the rate carries a marker saying it came from the live published
configuration — so a reader comparing the two has every reason to trust the
half that is now wrong. This is the same contradiction a previous sweep had to
clear by hand ("the rate says one thing and the sum below says another"), set
up to happen again on a schedule nobody controls.

Those amounts are now computed from the same configuration the rates come
from, at the moment the page is read. There is no longer a version of the page
where the rate and the sum disagree, because the sum is derived from the rate
rather than remembered alongside it.

### What a reader sees differently

Almost nothing today, which is the intended outcome. Three small changes:

- The money amounts now always show cents. One figure previously read as a
  whole number and now shows two decimal places, so that a future change of a
  fraction of a cent cannot hide behind a rounded display.
- Nothing else. In particular the six-decimal figure is unchanged, and an
  earlier draft of this change altered it in error — see below.
- On non-English pages the amounts now follow that language's own number
  conventions automatically, rather than depending on each translation having
  been written with the right separators.

### Why the arithmetic is done in whole units of the smallest denomination

The computation deliberately mirrors how the protocol itself calculates,
working in the currency's smallest unit and discarding fractions at each step,
rather than in ordinary decimals.

This is not fussiness. An earlier draft of this change used ordinary decimal
arithmetic and produced a figure one unit different in the last place from what
the protocol actually pays — and then presented it on a page that calls the
figure exact and says settlement uses it. The number written on the page
originally was right; the more "precise" computed one was wrong. A page that
disagrees with the contract about what a settlement pays is worse than a page
whose figure is merely old, so the arithmetic follows the chain's rules rather
than approximating them.

### On the marker that says where a figure came from

A computed figure only claims to come from the published configuration when
**every** input it was computed from was read live. If any input falls back to
the value bundled with the site, the result is marked as bundled too.

This matters because a computed figure could otherwise inherit a confidence
none of its parts had — one live rate and one fallback could produce a number
presented as fully published. The marker exists to be precise about provenance,
so it defers to the least certain input rather than the most.

### The site search was reading the same figures from the wrong place

The help search builds its index by substituting these figures into the text
it searches, so the index carries whatever the numbers were when it was built.
It was built once, from the values shipped with the site, before the published
configuration had been fetched — and never rebuilt.

After a retune that produces a specific failure: searching for a figure
**printed on a page** could miss that page's own section, and a result summary
could contradict the page it links to. That is the exact problem substituting
figures into the index was introduced to prevent, reintroduced by building the
index too early.

The index is now tied to the configuration snapshot it was built from, so a
newer snapshot naturally produces a fresh index rather than relying on anyone
remembering to discard the old one.

Alongside this, the description of which configuration field backs which figure
now lives in one place instead of two. The page renderer and the search index
each had their own copy, which is the same kind of duplication that caused the
problem being fixed here.

### Scope

This covers the worked example and the site search. The remaining threads on
this topic are unchanged and still tracked: the machine-readable exports, which
cannot follow a retune without introducing a network dependency at build time
and so need a deliberate decision either way; naming which network the figures
describe; passages that quote a fee fixed at a loan's creation rather than the
current one; and re-checking a long-lived snapshot for freshness.

## A cross-chain check that was specified but never built is now retired rather than left pending

A storage field on each mirror deployment was set aside for a check on
incoming tier updates: the address of the contract on the canonical network
whose messages the mirror would accept. It was allocated, shipped, and written
up in the design as something the mirror validates on arrival. Nothing ever
read or wrote it. A previous change corrected the field's own description to
say so and deliberately left one question open — whether to finish building the
check or to abandon it.

This settles that question: the check is abandoned, and **the field is deleted**
rather than kept and explained. Deleting it moves nothing else — it shared a
storage slot with its neighbour, and the field after it is of a kind that always
begins a new one, so every other field stays exactly where it was.

Nothing about how the protocol behaves changes. The check was never running, so
there is none to remove.

### Why abandoning it is the safer of the two

Separate work has since put the sender's identity on the wire and made the
shared cross-chain adapter reject any message whose sender is not the partner
configured for that conversation. So by the time a tier update reaches the
mirror's own logic, who sent it has already been established against
configuration once.

Doing it again one layer up would not check the message a second time. It would
compare one stored copy of an address against another stored copy of the same
address — a check on whether a deployment agrees with itself, wearing the
appearance of a check on the message. That distinction matters because the two
copies have nothing keeping them in step. If they ever disagreed, a working
lane would stop delivering, and the reason would be invisible from the message:
both records look equally authoritative and neither says which one is stale.

This is the same failure the recent run of corrections kept turning up — a
second description of a fact drifting away from the first — except with funds
behind it rather than a comment.

A misdirected partner setting cannot be caught this way either, which is the
other reason the second copy earns nothing. Pointing a network's partner
setting at the wrong contract makes the lane refuse the *right* sender rather
than accept a wrong one: a message carries the name of the conversation it
belongs to, and that name is stamped from whoever sent it, so only the
conversation's registered contract can send on it at all. The failure is a
lane that stops, not a lane that lets something through — and a second stored
copy of the address adds only a further way for two records to disagree, with
neither of them saying which is stale.

### A neighbouring check that looks similar and is not

The mirror also checks that a tier update came from the canonical network, and
that check stays. It is defence in depth rather than the only thing standing
in the way: the messenger already refuses a message from a network it has no
partner configured for on that conversation, and a correctly configured mirror
has exactly one partner. What the network check adds is what still holds if a
partner is ever configured for a network that should not be sending tier
updates at all.

That is still a different thing from the abandoned check. It constrains a fact
recovered from the message more tightly than configuration alone does; the
abandoned one would have compared configuration against configuration and
constrained nothing further.

The full set of checks a tier update passes today — the transport's own sender
check, the sender-identity check in the adapter, the paired-messenger check,
the source-network check, and ordering — is now recorded where the field used
to be, so the next reader can see what protects the path without having to
reconstruct it.

### The field is removed outright

An earlier draft of this change kept it, on the stated grounds that removing it
would move every field declared after it. That was wrong, and checking rather
than reasoning is what settled it: the field shared a slot with its neighbour,
and the next field along is of a kind that always begins a new slot. A
before-and-after comparison of the entire structure's layout shows one field
gone and **not a single other field moved**.

So it is deleted rather than kept and explained. Keeping a permanently unused
field alive on a justification that turned out not to hold would have been the
same kind of residue this change exists to clear.

## Handing over an obligation can no longer consume an offer past its deadline

A borrower leaving a loan early may hand the obligation to someone else, by
consuming a standing offer that person had already published saying what they
were willing to borrow and on what terms. That offer can carry a deadline.

The handover never looked at it. It checked that the offer was the right kind,
that nobody had taken it already, that it was not reserved for a different
purpose, that it had not been partly filled, and that its assets matched the
loan — and then bound it. So an offer whose window had closed, and which nobody
had yet cleaned up, could still be used: the departing borrower could hand a
live debt to someone whose stated willingness had already lapsed.

The person on the receiving end is not present when this happens. They
published terms, the window they set passed, and the obligation arrived anyway.
Their deadline was the whole of their consent to *when*, and it was the one
condition the handover did not read.

This is the same gap that was just closed on the lender side, where a lender
selling a position could draw on an offer past its deadline. Both paths reach a
standing offer without going through the ordinary acceptance route, so neither
inherited the deadline check that route performs. Both now refuse, before
anything moves.

Two details, both places a fix of this shape commonly goes wrong:

**An offer with no deadline has not expired.** Offers may be published to stand
until withdrawn, recorded as the absence of a deadline. A check written as "now
is at or past the deadline" reads that absence as the earliest possible moment
and rejects every such offer. Both paths route through the shared helper that
already knows the difference.

**The deadline moment is already closed.** An offer good until a given instant
cannot be taken *at* that instant. Consistent with every other route, and now
pinned by its own test.

A third route was checked at the same time and deliberately left alone: a
borrower refinancing their own loan consumes an offer they authored themselves,
so ignoring the deadline there overrides nobody's wishes but their own.
