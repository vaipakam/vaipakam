## Thread — a loan backed by illiquid collateral can now be refinanced, with both parties' consent (PR #2401)

Refinancing a loan whose collateral is illiquid used to fail every time. The new lender's acceptance opened the replacement loan and paid off the old one. Then the refinance's final risk check asked for a loan-to-value ratio and a health factor, figures the platform never computes for an illiquid asset because it values that asset at zero. The whole transaction reverted. This surfaced on a copy of the live Base Sepolia deployment in #2355's verification, as #2380.

The owner decided on 4 October that such a refinance is allowed when both parties to the new loan consent to the illiquid terms. The borrower consents in the refinance request, and the new lender consents when accepting it. The exiting lender's consent is not needed, because they are paid out in full. The final check now makes the same decision the new loan was opened under: a consented illiquid loan passes, as it does at opening. The check reads the facts recorded on the new loan when it was accepted, so a change in an asset's liquidity in between cannot strand a borrower already admitted. A fully liquid replacement is checked exactly as before.

Contract change: the refinance facet only. Base Sepolia gets it at its next in-place refresh.
