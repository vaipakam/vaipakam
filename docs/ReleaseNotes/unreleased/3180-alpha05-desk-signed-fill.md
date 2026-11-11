## alpha05: a signed order can be filled from the rate desk (OFF-60, second slice)

The new app's rate desk now lets a taker fill a gasless signed order that another wallet placed on the market. An open order someone else signed shows a "Review a fill" button. It opens the same acceptance review as an offer posted on the chain, so the taker sees the same receipt, consent and wallet steps.

The review's figures come from the protocol's own preview of the signed fill, not from the order as the offer book lists it. The review names the maker and the order's hash, what the fill would take from the maker's vault against what that vault holds free now, and that a fill takes the whole order in one transaction. If someone fills the order first or its maker cancels it, the fill fails, no loan opens and any approval the flow made is put back. Every refusal the preview reports is stated by name, a maker's vault that holds too little among them, and blocks the send.

The Terms the taker signs are keyed to the order's hash. The protocol cannot yet show its risk-access check for a signed order before the fill (#3577), so the review says that the dry run after signing makes it, and offers the step that clears a refusal for the order's pair. The finish card reads the new loan from the fill's own event.

A partly matched order is not offered, because a fill takes the whole order, and neither is the viewer's own. The fill needs the contracts' signed-fill preview, so it works on a chain once the next fresh deploy reaches it (#3552).
