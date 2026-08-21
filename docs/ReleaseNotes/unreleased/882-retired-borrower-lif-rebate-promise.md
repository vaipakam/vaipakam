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
