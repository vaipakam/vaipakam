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

Every public page now says what actually happens, and says it in the same place
the old promise stood: the discount is a direct reduction, no VPFI leaves the
vault to pay the fee, and there is nothing to claim afterwards.

**The old mechanism is scoped, not deleted.** Loans opened while it was live
still settle exactly that way, and a rebate on one of them is claimable **when it
closes properly** — repayment, early close, or refinance. If such a loan instead
defaults or is liquidated, the held VPFI is forfeited and there is no rebate at
all, which the pages now say wherever they describe those outcomes. Deleting the
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
The pages now state, wherever they set expectations, the five conditions that
actually govern it: the VPFI must sit in the vault on the canonical chain; it
must have been held for a minimum period before it counts, and a mid-loan
withdrawal reprices the whole average down to the lowest balance held; a tier
earned on the canonical chain does not appear on another chain until it is
pushed there; the fee-discount consent must be enabled **on the chain the loan
settles on** — it is a per-chain setting, not one global switch — **and also on
the canonical chain**, because the message that carries a tier outward is forced
to zero while the canonical consent is off, so a reader who settles only on a
mirror needs both; and the lender leg needs free VPFI on that same chain when the
discount is applied, or it is simply not delivered.

**A sixth condition is that the push is not a one-time step.** A mirror stops
honouring a pushed tier sixty days after the most recent push and falls back to
treating that wallet as tier 0 until a new one arrives. The cards had presented
the push as an activation you perform once, so a reader could follow every
instruction on the page, act on that mirror months later, and be charged the
full fee with nothing on the page to explain it — the same shape of failure as
the five above, except that this one arrives *after* the reader has done
everything right. Both cards now say the tier has a shelf life.

**And what renews it is narrower than the first attempt at this said.** That
attempt named two renewals — pushing again, or a canonical-chain deposit or
withdrawal — and both were wrong, in the direction that matters most: they told
a reader they could restore something they cannot. A push is only sent when the
tier, its rate, its projected expiry or the tier table itself has changed. An
identical one is deliberately skipped, so the protocol's cross-chain budget is
not spent re-sending a message the mirror already holds. For the reader this
paragraph is about — a steady holding, no tier movement, sixty days — every
action available hits that gate and sends nothing. Pressing the button again
does nothing. A deposit or withdrawal that leaves the tier where it is does
nothing. The window expires and the discount on that mirror is gone.

**And the second attempt was wrong too, in the same direction.** It said only a
change that moves your tier could bring the discount back, which would have sent
a reader to shuffle VPFI they had no reason to shuffle — and crossing a tier
boundary and climbing back costs them the discount for the whole minimum-history
window, so the advice was not merely useless but expensive. There is a way back
that touches nothing: switch the fee-discount consent off on the canonical chain
and push, which sends tier 0 and therefore differs from what was last sent, then
switch the consent on and push again, which sends the real tier and restarts the
sixty days. The pages now spell that out, because it is not something a reader
would ever guess.

Twice in a row, then, this note named the wrong remedy — first one that does
nothing, then one that costs the reader. The pattern in both is the same: a
sentence written from what the mechanism seemed to imply rather than from what
the mechanism does.

**Three times, as it turned out.** The consent round-trip is real, but the
first description of it said it costs nothing but gas, and that is not true
either. The fee path reads the consent flag at the moment a fee is charged, so
for as long as the consent is off — three transactions' worth of time — any
offer of yours that somebody accepts, and any loan of yours that settles, is
charged at the full rate. Nobody needs your permission to accept a standing
offer, and a loan can settle without you. So the pages now say to cancel
standing offers and pick a quiet moment before starting, rather than presenting
the sequence as free.

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
no supported way to refresh an unchanged tier, that the discount returns by
itself the next time the tier moves, and that this is the one condition here
that can cost someone their discount through no fault of their own.

The through-line in all three is the same and worth naming once: each wrong
sentence was written from what the mechanism seemed to imply, and each was
corrected by someone reading what the mechanism does.

**A separate correction, and the most consequential one here.** The Claim
Center guidance told a borrower that an HF-liquidation or a default returns
**nothing**. That is false whenever the position was overcollateralised: only
enough collateral is taken to cover the liquidator, the lender and the treasury,
and the remainder is recorded as the borrower's claim and stays in their vault
until they withdraw it. A borrower who believed the page would simply never go
and collect it. The guidance now tells them to check, explains that an illiquid
default usually does take the whole basket — an outcome, not a rule — and keeps
the one thing that is always lost, which is the rebate.

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
