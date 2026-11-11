## alpha05 — signed orders held for a re-check after a reorganisation (PR #3583)

When the chain replaces some recent blocks, the indexer re-reads the fills and cancels of the signed orders it holds (#3411). Until it has, it leaves those orders out of the shared book and counts them, and it still lists them to their maker, flagged. The new app now shows both.

On a market's desk, the signed-order section says how many orders the book is holding back. A shorter list is therefore never read as the whole book, and an empty market with held orders does not say the book lists none. If the book's count cannot be read, the section says the list may be incomplete instead of assuming nothing is held.

In Your signed orders, a held order is marked on its row. The row says the shared book leaves it out until the re-check ends. Its standing is still read from the chain. Only while a fresh standing shows it can still be filled does the row add that anyone holding the signature can fill it and that you can still cancel it. The rate desk's user-guide sections in both editions and all ten languages describe this.

The rule for a risk refusal during a signed fill is also written into the rulebook. The step to clear a refusal is offered only when the refusal, decoded from its own bytes, names the taker's wallet. This shipped with the fill itself (#3578).

Advances #3180 (the new app) and follows the indexer's reorganisation guard (#3411, #3528).
