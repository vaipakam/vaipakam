## The guides no longer tell borrowers who repaid in full that their rebate is gone (#882)

On loans still using the retired VPFI fee path, a loan that ends properly
**settles** the time-weighted rebate on the VPFI held against the Loan
Initiation Fee. A default or a liquidation forfeits the whole amount outright.

Ending properly covers more routes than the three the guides used to name: a
full repayment, an early close, a refinance, **and also the sale-based closes** —
selling the collateral to settle the loan, and the swap-to-repay routes. Six
distinct paths settle the rebate, and copy that lists only three tells the
borrower using a fourth that theirs is not a proper close.

The sale routes are listed separately rather than folded in with the others,
because what they return is different: the collateral goes to the buyer, and
what reaches the borrower's vault is the remainder of the sale proceeds after
the lender and the treasury are paid. Grouping them under "your collateral
back" would trade one wrong expectation for another.

Settling is not the same as paying out. The rebate is sized by the discount the
borrower averaged over the loan's life, so a borrower who held no VPFI, or
dropped to no discount, can settle properly and still receive nothing — the
whole held amount goes to treasury. What is wrong is telling every borrower it
never comes back; what would be equally wrong is telling them it always does.

Both user guides said otherwise. The Claim Center section of every Basic guide
stated flatly that the fee rebate is what never comes back, two sentences after
telling a borrower who repaid in full what their claim returns. The Advanced
guides went further and contradicted themselves inside a single sentence: the
rebate is "always lost", followed immediately by the clause saying it comes back
on a proper close.

**Why it matters more than a wording slip.** It is on the page a reader visits
to find out what they can collect, and the error points the wrong way — it tells
them the answer is always nothing, when the answer depends on how their loan
ended. A borrower who believed it would simply never look.

**Corrected in all twenty editions** — both guides, ten languages — so no reader
is told one thing in their language and another in English. The sentence now
says plainly that whether the rebate comes back depends on how the loan ended,
and names which endings settle it — while saying that what is settled can itself
be nothing, because the amount is sized by the discount the borrower averaged.

**How it was missed.** An earlier pass in the same effort corrected this exact
claim in the guides' action summaries and did not carry it into the Claim Center
sections those summaries point at — so the summary and the section it referred
readers to disagreed. The Advanced editions had their tail clause corrected
while the opening clause kept the old assertion, which is how one sentence came
to state both. Fixing where an error is reported rather than everywhere the
claim appears is what leaves this shape behind.

**A second overclaim in the same section, corrected with it.** The guidance said
the borrower is left the collateral *itself* only when a liquidator takes it
directly at a discount instead of selling it. There is a second route: when the
sale cannot be completed, the collateral is distributed as it stands and the
borrower's share is recorded in collateral units the same way. A borrower on
that path would have read a page telling them their claim must be in the loan's
own asset, and gone looking for the wrong thing.
