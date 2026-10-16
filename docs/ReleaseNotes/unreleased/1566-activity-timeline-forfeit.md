## Thread — a loan's activity timeline shows when its rewards were forfeited (#1566)

**Problem.** The sanctions forfeit added an event that belongs to a specific loan: the settlement of a forfeited reward entry. The indexer recorded it but did not attach it to its loan, so a loan's activity timeline could never show it. Its own coverage test, which requires every loan-referencing event to be attached or deliberately left out with a reason, had been failing since the forfeit landed.

**Fix.** The settlement now attaches to its loan and appears on its timeline, with its own label in English and in the nine translated languages. The sanctions stamp on a reward entry is deliberately kept off every user-facing surface, in line with the rule that user-facing copy never mentions sanctions; the forfeit itself still shows, through its settlement. Refs #1566.
