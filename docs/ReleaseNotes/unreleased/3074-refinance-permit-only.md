## App — refinance pays its payoff by permit only

The connected app no longer carries the old way of paying a refinance payoff,
a standing approval of the protocol for the whole payoff. Every testnet now
runs the fresh deploy that takes the borrower's single-use payoff permit, so
the bridge kept for older deployments had nothing left to serve.

The refinance form, the request card and "Refinance all" now always ask the
wallet to approve the permit service, which moves nothing without a
signature, and to sign a permit for the wallet's share of the payoff. Every
figure the borrower reviews and signs for comes from the contract's own
payoff view; the app's own copy of the payoff and late-fee rules for the old
route is gone, together with the copy that described a standing approval and
the steps that tried to undo one after a failure.

The live refinance drive and the coverage notes say the same: a deployment
without the permit route is refused, because the app cannot refinance on it.

Closes #3074.

> Caveat: the contract's payoff view sizes a request that is not yet posted at
> the loan's own term. When the new request asks for a longer term, the
> initiation fee is higher, so the signed permit can come out short; the
> request card then says so and offers to sign again. A contract fix is
> proposed separately.
