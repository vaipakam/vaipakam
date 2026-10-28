## Thread — The NFT verifier tells a retired token from a never-minted one (PR #3029)

When a position NFT id does not exist, the verifier used to say only that it
was either retired or never minted, because the chain gave the same answer for
both. The contracts now publish the highest position-NFT id they have ever
allocated (PR #2994), and ids are never reused, so the verifier can tell the two
apart. An absent id at or below that number was retired by the protocol and is
shown as a warning; an id above it was never minted on this network, and the
page suggests switching to the network where the position was opened.

Both answers come from the same block, so a position opened a moment after the
check is never reported as retired. On a network whose contracts predate the
new view the page keeps the old two-way wording, and if the second read fails
it says it could not check which and that reloading retries; the absence itself
is never in doubt in either case.

The page still does not name why a token was retired, and it does not yet show
the loan a retired token belonged to; that history panel needs an indexer
lookup by token id and is tracked in #3021.

Closes #2529.
