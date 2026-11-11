## alpha05: the rate desk lists every maker's signed orders (OFF-60, first slice)

The new app's rate desk now shows the gasless signed orders makers have placed on a market. They appear in their own section, apart from the ladder of offers posted on the chain. Lenders' orders run from the lowest rate and borrowers' from the highest. Each order names its maker and when it lapses, and shows where the chain stands on it: open, partly filled with what is left, filled or cancelled, stopped by its nonce, or lapsed. The offer book can lag the chain, so an order the chain has already cancelled is never shown as open.

A signed order sets nothing aside, so a fill draws the maker's side from the maker's own vault at that moment. For each order that can still be filled, the desk says what the maker's vault holds free now against what a fill would draw. That is either enough, short (a fill now would fail), or not readable. The desk also says that one maker's orders share one vault.

Filling a signed order is not offered yet. The protocol has no way to show a fill's figures before the taker pays, so the desk says this instead of offering a button. The fill follows once the contracts add that preview (#3552). The markets note and the ladder's count note now say where signed orders are listed.
