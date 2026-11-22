### NFT collection offers (#3328)

A lender can now post one offer against many tokens of an NFT collection, instead of one offer per token. The offer names the set it accepts (the whole collection, a range of token ids, or a published list such as the tokens that share a trait) and how many loans it funds. The lender's wallet funds every loan when the offer is posted, and that principal stays reserved to it until each loan is filled, the offer is cancelled or it expires.

Each fill is its own ordinary loan against the one token the borrower locks. A borrower fills directly by naming their token and signing the usual acceptance for that exact token; a matcher can also pair the offer with a borrower offer already on the book whose token is in the set. Every check an ordinary accept or match makes still applies to each fill. For a listed set the contract checks only that the token is in the lender's list; the label is the lender's description, and the platform says so.

Collection offers carry a mandatory expiry (at most 30 days to start) and at most 50 loans to start, both governed. A lender can lower the number of loans left, and the released principal goes straight back to their wallet. The ordinary accept, match, edit and buy routes refuse a collection offer by name, so it is only ever filled one token at a time through its own entries.

Two supporting moves keep the contracts under the size limit: the match core that pairs a collection offer runs through the one copy on the offer-match facet, and the loan-initiation risk bounds the match core reads moved from the offer-preview facet to the risk-preview facet. Nothing changes for callers.

Advances #3328. Keeper matching of collection offers is #3688.
