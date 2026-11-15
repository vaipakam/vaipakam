## Thread — Midpoint states move onto the staged runner (branch, no PR yet)

The scripts that leave a rehearsal chain in UI-testable midpoint states are now one staged module, PositiveFlowsMidpoints, on the same fixture and runner as the positive flows. The three scripts it replaces posted an offer and filled it in one broadcast, so since the offer-age rule they stopped before sending anything. Now each state that fills an offer posts it in one stage and fills it in the next, once its terms have stood the minimum age.

The module leaves 13 states: an open lender offer and an open borrower offer, an active liquid loan, a repaid loan neither side has claimed, an active loan on NFT collateral, an active NFT rental, a fully filled offer beside a partly filled range offer, a loan with one partial repayment, a loan whose collateral was doubled, a loan with a keeper approved to start a preclose, a loan with a refinance request posted and no lender, a loan whose lender listed the position with no buyer, and a stray token sitting in a vault. The listing state was only logged before, because posting a listing used to fail; it now posts the listing.

The states are left on purpose, so none is recorded as a setting to put back, and the module changes no protocol setting. Each state sits on the run's own mock tokens, so other modules neither see nor disturb it. The one exception is the keeper approval, which belongs to the wallet; the keeper module already clears an approval it finds before granting its own.

All 13 states were set up by a staged run on a local Anvil chain. The runbook, the test matrix and the coverage list now point at the module. Advances #3574.

> Caveat: a defaulted loan, a loan in the health-factor warning band, overdue periodic interest and a borrower offset offer are still not among the midpoint states; unit tests and the timed module cover those flows.
