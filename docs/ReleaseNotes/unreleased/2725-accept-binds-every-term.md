## Thread — An accept signs only what its review showed (PR #<n>)

Accepting an offer means signing a typed statement of the deal, and the
contract refuses the accept if any signed term differs from the stored offer.
That protects against a cloned interface, but only for the terms the user
actually saw. The app's reviews showed the amounts, rate, duration and
interest mode, and compared those few before opening the wallet. The rest of
what the signature binds was signed without being shown: the interest-payment
schedule, whether the borrower may repay in parts, whether the collateral may
be listed for sale during the loan or before acceptance, a collateral listing
already live, a refinance target and a linked loan.

Every accept review now lists those lifecycle terms, read live from the offer
and stated even when they are the defaults: the direct accept, the NFT rental
and the signed-offer fill. All three signers now share one model of the signed
terms. Each signed field is classified as a term of the deal, the acceptor's
own choice, or bookkeeping. Every term of the deal is compared with what the
review showed, and the wallet is not asked to sign if any differs. A field
added to the signed terms later fails the typecheck until someone classifies
it, so it cannot slip past the comparison. A change to the listed terms while
the review is open clears the consent tick.

The illiquid acknowledgements are narrowed the same way (#2728). The direct
accept and the rental used to name both legs in every signature, relying on
the review having warned about whichever leg was illiquid. Now a leg is named
only when the review showed that leg as illiquid. A leg that turns illiquid after
the review is refused before signing (and by the contract, if it turns during
the transaction), so the user is shown the warning and asked again. The rental
names only the rented NFT, whose own model the rental review discloses; a
signed-offer fill names neither, and refuses an illiquid pair outright as
before.

Closes #2725. Closes #2728.
