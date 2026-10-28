## Thread — Forced close-out card names the lender-KYC refusal (PR #<n>)

The lender's close-out card now asks the protocol whether a time-based default would pass its lender-KYC check, using the view the contract side added for exactly this question. Before, the card left that check out on the reasoning that KYC is off on the retail deploy, so on a deployment that turns KYC on it could show a ready close-out the chain would refuse, with only a failed simulation to say so.

The verdict is one more read in the batch the card already makes, so it is dated by the same block as every other fact the card shows. It sits in the protocol's own order: after the pause check and before the repayment window. Where it refuses, the card offers no action and says that this deployment has identity verification switched on, that it is the lender recorded on the loan who must meet the tier, that nobody can close the loan out until then, and that the answer can change as the loan's value moves. Where KYC is off, which is every current deployment, the verdict always passes and the card is unchanged.

The app asks the contract rather than valuing the loan itself, so there is no second copy of the oracle-priced rule to drift. The live review driver's mirror of the card's rule carries the same gate, and its test checks the mirror against the app over every combination of facts.

Closes #2083.

> Caveat: the view exists only on Diamonds built from current source, so on the testnets it arrives with the all-waves fresh deploy. Until then the card reads that fact as unread and shows its still-checking state rather than a verdict, and this app change ships with that deploy.
