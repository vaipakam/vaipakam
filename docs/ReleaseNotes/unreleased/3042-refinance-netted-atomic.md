## Thread — Every refinance is atomic, and the new principal pays the old lender directly (PR #<n>)

A refinance used to move money in a round trip through the borrower's wallet: the accept delivered the new lender's principal, less the initiation fee, to the borrower, and the refinance then pulled the whole payoff back out of that wallet. It could also be finished later, in a second transaction, by the borrower or a delegated keeper. Both are gone. A refinance now completes only inside the transaction that accepts, or matches, the borrower's refinance-tagged request, and inside it the new lender's net principal goes straight from the new lender's vault to the old lender's vault.

The borrower's wallet now pays only the difference: the rest of the old lender's due and the treasury's cut of the old loan's interest. For a request asking for the old principal, that is the old loan's interest (and any late fee) plus the new loan's initiation fee. The new principal can never exceed what the old lender is owed, because a request may not ask for more than the old loan's outstanding principal, so there is no surplus to return; a refinance in which there would be one is refused rather than leave the excess anywhere.

Each refinance now publishes one settlement statement naming its three legs: what the new lender's net principal paid the old lender, what the borrower's wallet paid the old lender, and what the borrower's wallet paid the treasury. The refinance event itself drops a field that had been a constant zero since the earlier removal of the rate-shortfall top-up.

The standalone refinance step and the keeper permission bit for it are retired. Granting that bit is now refused as an undefined action, and the app no longer offers it in the keeper settings. The auto-refinance switch still governs only the matcher; a lender accepting a request directly is never blocked by it.

In the app, the standing approval a refinance request asks for is now sized to the wallet's share of the payoff instead of the whole payoff, and the copy says that the new loan's money pays the current lender directly. The approval is an upper bound: it uses the live initiation-fee rate with no discount, so a fee discount only lowers what is actually taken.

This ships by fresh deploy only. The curated refresh scripts refuse a Diamond that still routes the retired refinance step, because the accept and the payoff now hand off within one transaction and must be on the same code. Design: `docs/DesignsAndPlans/Refinance3042NettedAtomicDesign.md`. Closes #3042.

> Caveat: a governance raise of the initiation-fee rate after a request is posted raises what the wallet must pay above the approval granted for it; the request's card recomputes the figure with the live rate and asks for a fresh approval.
