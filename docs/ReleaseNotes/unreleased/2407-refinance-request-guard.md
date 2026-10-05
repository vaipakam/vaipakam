## Thread — the protocol holds a loan still under a standing refinance request (PR #TBD)

A refinance request is priced against the loan as it stands. Its amount has to cover the outstanding principal, and a carry-over request has to match the loan's collateral exactly. A partial repayment, an early close, an obligation handover, an offset or a collateral withdrawal made while the request stands leaves it impossible for any lender to fill. The connected app already checks for a request just before the wallet opens, but no check made before signing can close the gap between that read and the transaction being mined. The protocol now closes it. While a live refinance request targets a loan, those five actions are refused, and so is partial repayment by swapping collateral. Each refusal names the loan and the request. The borrower cancels the request first. Full repayment is deliberately not held, because it settles the loan and ends the request with it. Neither is any enforcement action — default, liquidation in full or in part, or the periodic-interest auto-liquidation — because a borrower's own request must never be able to shield a loan from enforcement. A partial liquidation can leave the request unfillable, and that is accepted. Adding collateral is not held either: it is a safety action that has to stay available under price pressure, even though it makes a carry-over request unfillable.

The protocol now keeps a record of each loan's refinance request and allows one live request per loan. Posting a second request while one is live is refused, so two devices can no longer both post one and leave each other's request unfillable. A request counts as live only while it could still be accepted:

- it exists and has not been taken or cancelled;
- it still targets the loan;
- it has not expired;
- the loan is still active;
- its creator still holds the borrower position.

Liveness is worked out when it is read, not stored, so a request that lapses for any of these reasons stops holding the loan back without any further transaction. A new public read reports the request recorded for a loan and whether it is still live. A lapsed request stays reported, so an expired request that was never cancelled can still be found and cleaned up.

Requests posted before this upgrade are not in the record. Until they are added, they do not hold the loan back. A new permissionless call adds them, scanning offers in slices. It records only a request the chain itself shows to be live, and never displaces a live request already recorded, so no caller can invent a request or block a loan. Operators should run it once over the existing offer range after refreshing the Diamond. The app still finds a request by its bounded on-chain search; switching it to the new record is a follow-up. Closes #2407.
