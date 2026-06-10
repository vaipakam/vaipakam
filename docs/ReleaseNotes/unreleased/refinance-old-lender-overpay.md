## Thread — Refinance old-lender overpay fix (PR #TBD)

Refinance now repays the original lender with principal plus the old loan's full-term interest, then applies the existing treasury split to that interest. It no longer stacks a lower-rate-offer shortfall on top of full-term interest. That additive shortfall pattern is still valid for transfer/offset paths where the original lender remains economically exposed to the remaining term, but refinance closes the old loan entirely, so there is no remaining earning slice to top up.

The contract comments, English borrower copy, functional spec warning, and code-vs-docs audit were updated to match the corrected economics. A focused refinance test covers the lower-rate borrower-offer fixture and asserts the borrower pays `principal + oldInterest`, not `principal + oldInterest + legacyShortfall`. Closes #411.
