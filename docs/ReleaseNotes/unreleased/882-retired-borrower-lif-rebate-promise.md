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
settles on** — it is a per-chain setting, not one global switch; and the lender
leg needs free VPFI on that same chain when the discount is applied, or it is
simply not delivered.

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
