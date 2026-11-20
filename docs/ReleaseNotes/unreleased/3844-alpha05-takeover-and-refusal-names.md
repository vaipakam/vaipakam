## alpha05 — takeover requests left out of the books; refusal words keyed by name

The alpha05 offer book and rate desk now check two chain records for every offer the index lists. One record says the offer is bound to a loan (a loan sale or an early-close offset). The other says it is a request to take over a named loan (#3844). The two are read separately. If either names a loan, the offer is left out of the book, and the page counts and states it. If the records cannot be read, the offer stays listed, because its own page reads the chain again before it offers anything. The index queries also ask the indexer to leave takeover requests out.

The refusal words for matching and for Auto-lend are now keyed by the refusal's name, not by its position number. A test reads each refusal list from the contract source and checks that the app's list matches it in order. A refusal added to the contract can no longer shift the words onto the wrong reason. Before this change, the match refusal list was missing four entries, so a collection-offer refusal was worded as the Terms refusal. The takeover refusal now has its own words in the accept, match and Auto-lend explanations.

Advances #3844.
