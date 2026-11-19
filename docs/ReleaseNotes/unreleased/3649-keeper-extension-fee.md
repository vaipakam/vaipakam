## Keeper — auto-extension stays within the borrower's fee limit

An extension adds initiation fee for the term it adds, and the borrower's auto-extend settings name the most one extension may add. The contract refuses an extension above that limit. The keeper's auto-extend now quotes the added fee before it sends. If the usual 30-day term would cost more than the limit, the keeper shortens the term to the longest one the limit allows, and the run's line says so. If even a one-day extension costs more than the limit, the loan is skipped with both figures named. Each extension's line also states the fee it adds.

The funding check before this already counted the fee, because the contract's funding view includes it. This change stops the keeper from sending an extension the contract would refuse.

This is stage 2 of #3649.
