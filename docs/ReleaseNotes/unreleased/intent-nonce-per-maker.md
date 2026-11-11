## Thread — Repayment-auction nonces are unique per vault, not across the platform (PR #3530)

A swap-to-repay auction order carries a nonce, and the 1inch order protocol tracks used nonces per seller. Since the borrower's own vault became each order's seller, the protocol still kept one platform-wide list of used nonces, so a nonce one borrower used refused every other borrower's order with that nonce. Anyone could make another borrower's commit fail by using the nonce first. No funds were at risk; the borrower had to retry with a new nonce.

Used nonces are now recorded per seller vault, matching 1inch. A vault still can never reuse a nonce (its two orders would void each other on the first fill); different borrowers may use the same one. The old platform-wide record stays in storage, retired and unused. No funds move differently.

Found by the 2026-11-11 external security review.
