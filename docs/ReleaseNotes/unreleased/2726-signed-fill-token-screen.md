## Thread — Every accept runs the token screen, signed-offer fills included (PR #<n>)

The independent token-security screen (honeypots, sell restrictions,
fee-on-transfer tokens and similar) is meant to stand between a user and any
deal carrying a token outside the curated list. The direct accept and the NFT
rental ran it, each with its own copy of the check, but the Rate Desk's fill
of a gasless signed offer did not run it at all. Signed offers are admitted
for any ERC-20 pair, so a maker could post one on a hostile token and a taker
could fill it with no warning.

The screen now lives in one place and is enforced where every acceptance is
signed. Both accept signers (the one behind the direct accept and the rental,
and the one behind signed-offer fills) re-screen every ERC-20 leg of the terms
they are about to sign and take the verdicts the review showed as a required
input. A blocked token refuses, a check that cannot run refuses, and a warning
passes only when the review showed that exact warning. A new accept surface
cannot reach a wallet prompt without the screen, because it cannot reach
either signer without it.

The reviews share the same screen too. The signed-fill card now shows the same
block, warning or not-screened notice as the other reviews, holds its accept
button while a verdict is pending, failed or blocking, and clears the consent
tick when a verdict arrives or changes. The rental now screens a collateral
token as well as the prepayment token when a listing carries one. Posting an
offer re-checks at signing time through the same shared check.

The indexer still admits signed offers on any ERC-20 pair; screening at
admission would need the indexer to call the screening service and is not part
of this change. The browsing badges and the fill-time screen cover it.

Closes #2726.
