# Keeper matcher: each pair considered once, a dust refusal no longer ends the fill search, and dust rolls are left to their owners (#2760, PR #TBD)

The keeper's offer matcher now reads each live offer once per run. The order book is read page by page and can change while it is read, so an offer could appear twice; it is now dropped the second time. That lets the matcher visit each lender and borrower pair at most once without keeping a list of every pair it tried, which grew with the size of the book.

A party holding offers on both sides of a market can never be matched against themselves. The matcher used to compare every such pair one by one, for free, which let one party make it do work in proportion to the product of their offers. It now groups each market's borrower offers by who created them and passes over the lender's own group in one step.

When the keeper sizes an auto-lend fill and the borrower's collateral cannot cover it, it searches for a smaller fill. It used to give up if the smallest legal fill was refused for any reason. A refusal on collateral at the smallest fill does prove nothing smaller can pass, and the keeper still stops there. A refusal for another reason does not: a dust fill can fail on rounding where a larger one passes. The search now continues above it, within the same small number of previews.

Anyone can delegate auto-roll to the keeper, and the keeper pays each roll's gas with nothing back. It now rolls a repaid intent loan only when the amount re-lent is worth at least 100 times the roll's gas, both valued by the Diamond's own pricing rule, with gas valued through the chain's wrapped native token. Smaller loans are left for their owners to roll or claim themselves, and each run logs how many were declined. Where the keeper cannot value the gas, it rolls nothing on that chain and says why. That is the case today on BNB Testnet, whose deployment carries a mock WETH, not wrapped BNB. (Owner decision 2026-10-25.)

No contract change. The admission rule for lender intents (#2760 item 2) is a contract change and ships separately.
