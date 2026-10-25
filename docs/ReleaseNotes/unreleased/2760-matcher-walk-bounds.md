# Keeper matcher: each pair considered once, and a dust refusal no longer ends the fill search (#2760, PR #TBD)

The keeper's offer matcher now reads each live offer once per run. The order book is read page by page and can change while it is read, so an offer could appear twice; it is now dropped the second time. That lets the matcher visit each lender and borrower pair at most once without keeping a list of every pair it tried, which grew with the size of the book.

A party holding offers on both sides of a market can never be matched against themselves. The matcher used to compare every such pair one by one, for free, which let one party make it do work in proportion to the product of their offers. It now groups each market's borrower offers by who created them and passes over the lender's own group in one step.

When the keeper sizes an auto-lend fill and the borrower's collateral cannot cover it, it searches for a smaller fill. It used to give up if the smallest legal fill was refused for any reason. A refusal on collateral at the smallest fill does prove nothing smaller can pass, and the keeper still stops there. A refusal for another reason does not: a dust fill can fail on rounding where a larger one passes. The search now continues above it, within the same small number of previews.

No contract change. The other two items in #2760 (an admission rule for lender intents, and a minimum value for keeper-paid auto-rolls) need decisions and are not in this change.
