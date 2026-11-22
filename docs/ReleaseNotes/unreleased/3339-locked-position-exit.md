## Protected mode: selling or handing over a locked position

Protected mode keeps an account's position tokens under the holder lock, and until now that lock also stopped every early exit: a protected lender could not sell a loan, and a protected borrower could not hand the obligation to a new borrower, without first unlocking and waiting the delay. Now a protected account that is not locked and not retired may sell or hand over while its positions stay locked. Everything that comes back, the sale proceeds or the returned collateral, lands in the account's own vault, where every payout to a wallet still waits the delay and the owner or any signer can cancel it.

A lender sale by such an account has a floor taken from the loan's own terms: it may not pay the buyer a rate shortfall out of the seller's principal. The seller therefore receives the whole principal into the vault and keeps the interest earned and not yet paid as the seller claim, whatever the collateral is. A listing above the loan's rate is refused when it is posted, and a sale that would carry a shortfall is refused when it fills. A borrower handover needs no floor, because the collateral returns to the borrower's own vault.

Nothing moves while the protected vault itself is locked, after the account was retired by a replacement, or when an account locked its positions without protected mode, because no payout delay would cover the proceeds. Unlocking still always waits the delay, and plain token transfers and outside-marketplace sales stay blocked while the lock is on. The pre-authorised sale the issue proposed was dropped by owner decision. Design: `docs/DesignsAndPlans/ProtectedAccountExitDesign.md`. Ships by fresh deploy.

Closes #3339
