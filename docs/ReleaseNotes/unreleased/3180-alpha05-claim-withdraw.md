## alpha05 — claim and withdraw as one action, and "ready to claim" totals

A loan claim pays the position holder's own vault, and only a withdrawal takes the money on to the wallet. That second step is the one a protected account's delay applies to. The new app now offers both steps together, without hiding that there are two. Every claim entry point gives a choice up front: "Claim and withdraw" (the lead) or "Claim to my vault", for a holder who wants to lend the money again or post it as collateral. This applies to a payout's card on Claims, the loan page, and Claim everything. The review says which was chosen. For a withdrawal, it explains the two steps and says the wallet will ask a second time.

Once the claim confirms, the app opens the ordinary vault withdrawal for exactly what the transaction's logs show the claim credited to the vault. It never uses the amount the review promised. Each asset gets its own withdrawal, with its own review and protocol dry run. A protected account's withdrawal is queued for the account's delay, as on the Vault page. If a withdrawal is refused, fails or is closed, the claim still stands and the money stays in the vault. The app says so and offers the withdrawal again. The claim's finish card cannot be closed while a withdrawal it opened is still out. In Claim everything, only the loan payouts are withdrawn: rewards and the batch's other parts stay in the vault, and the review says so.

Claims and Home now lead with "Ready to claim". This is the per-asset total of every loan payout whose claim can run now, decided by the same rule each payout's button follows. Payouts that are still waiting, or could not be read, are counted separately and named rather than added in. A claim pays the vault, so the total is never described as received.

Advances #3631. The payouts made while a loan is still open wait for the contract change in #3629, which routes them through a claim as well. Letting a wallet send both steps as one batch is a later step; the issue keeps that open.

> Caveat: the wallet asks twice (once for the claim, once per withdrawn asset). Combining both steps into one wallet confirmation is not built yet.
