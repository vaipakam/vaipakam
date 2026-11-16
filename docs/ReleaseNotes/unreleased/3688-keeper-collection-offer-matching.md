## NFT collection offers: keeper matching, published lists and the book filter (#3688)

A lender can now post one NFT collection offer (#3328) that funds several loans, one for each token in a set: a whole collection, a range of ids, or a listed set proven against a root. Anyone can pair such an offer with a posted borrower offer whose token is in the set, and the caller earns the usual match share. Until now the keeper's matcher did not know these offers existed. It previewed them like any lender offer and got a refusal every time.

The match pass now reads which lender offers are collection offers. It keeps them out of the ordinary walk and gives them a step of their own, after the walk and before the Auto-lend fills, using what is left of the pass's limits. A borrower offer qualifies when it names the same assets and token quantity, comes from another wallet, admits the offer's term and rate, and wants exactly one loan of the offer's amount. Its token must also be in the set, and an excluded token never qualifies. Each pair is simulated from the keeper's account before it is sent. Offers take turns, one borrower each, with at most eight simulations per offer per run, so one offer with many candidates cannot use up the budget the others need.

For a listed set, the keeper builds the proof from the offer's list. A list of up to 256 ids comes from the offer's creation event, which it reads from the shared event ledger. A longer list is a file the indexer serves by its hash, read from `INDEXER_ORIGIN`. The keeper does not trust either source. It first checks the list against the offer: the canonical file form and its hash, no id twice, the number of ids the offer states, and the offer's root. An offer whose list it cannot read, or that does not check out, is left alone, and the run log says why.

The indexer now keeps a table of collection offers, with each offer's set and the state of its list. A longer list is posted to the indexer as a file after the creation transaction. Anyone may post one, with no sign-in. It is kept only when a known offer carries its hash and the file matches that offer's count and root, and then anyone can read it by its hash. A listed offer whose list is not yet published, or does not match, stays out of the default offer book. The book's offers now state their set, the loans it funds and, for a list, its state and where to read it.

The walk's buckets now also separate NFT legs by token id and quantity, because the match core refuses two offers that name different tokens. Such pairs no longer use up previews.

The step ships disarmed behind its own flag, `COLLECTION_MATCH_ENABLED`. Arming it is an owner decision. The permissionless-step ledger now records `matchCollectionOffer` as keeper-backed.

Closes #3688. Before deploying, the operator creates the `vaipakam-collection-lists` storage bucket the indexer binds; the indexer deploy fails without it.

> Caveat: the nightly backup does not yet include the posted list files; that step is waiting on a design answer. The market summary's depth counts still include listed offers whose list is not published.
