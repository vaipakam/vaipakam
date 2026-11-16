## Keeper matches NFT collection offers with posted borrower offers (#3688)

A lender can now post one NFT collection offer (#3328) that funds several loans, one for each token in a set: a whole collection, a range of ids, or a listed set proven against a root. Anyone can pair such an offer with a posted borrower offer whose token is in the set, and the caller earns the usual match share. Until now the keeper's matcher did not know these offers existed. It previewed them like any lender offer and got a refusal every time.

The match pass now reads which lender offers are collection offers. It keeps them out of the ordinary walk and gives them a step of their own, after the walk and before the Auto-lend fills, using what is left of the pass's limits. A borrower offer qualifies when it names the same assets and token quantity, comes from another wallet, admits the offer's term and rate, and wants exactly one loan of the offer's amount. Its token must also be in the set, and an excluded token never qualifies. Each pair is simulated from the keeper's account before it is sent. Offers take turns, one borrower each, with at most eight simulations per offer per run, so one offer with many candidates cannot use up the budget the others need.

For a listed set, the keeper builds the proof from the ids the offer's creation event published, which it reads from the shared event ledger. It first checks the list against the offer: no id twice, the number of ids the offer states, and the offer's root. An offer whose list is kept as a file (more than 256 ids), or whose list does not check out, is left alone, and the run log says why.

The walk's buckets now also separate NFT legs by token id and quantity, because the match core refuses two offers that name different tokens. Such pairs no longer use up previews.

The step ships disarmed behind its own flag, `COLLECTION_MATCH_ENABLED`. Arming it is an owner decision. The permissionless-step ledger now records `matchCollectionOffer` as keeper-backed.

Advances #3688. Still to come: the indexer's typed table of collection offers, the store for list files, and the default-book filter that the design's section 5 describes.

> Caveat: listed sets published as a file are not matched until the indexer keeps list files.
