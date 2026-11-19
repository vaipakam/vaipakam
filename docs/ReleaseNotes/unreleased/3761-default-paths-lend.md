## Thread — Lend opens on lending continuously, with its choices pre-selected (#3761)

The new app's Lend form now opens on Auto-lend as the pre-selected choice, with one link, "Make a one-time offer instead". A deployment can switch the form to ask instead: "Lend continuously (recommended)" and "Lend once" side by side, neither selected until the lender taps one. The device remembers the lender's last choice for that wallet and network.

The form carries each pre-selected choice as its own switch: re-lend repayments for me (the platform's keeper gets the roll action only, added to what it already holds), interest by time, and the instant market's three consents (fill instant borrows, renew loans this slot made, take over other lenders' loans at face value). A choice the contracts would refuse is off and greyed with its reason: the instant consents need interest by time, the market switched on for the network and an eligible pair, and an answer the app cannot name reads as "not known". Re-lending is never offered for the platform token, and where keeper access is off with other keepers approved it is not pre-selected; switching it on lists every keeper and the actions it would regain, and needs that list confirmed. Rate auction bids, advances and buying existing loans stay visible and off.

The slot's terms, its funding and every chosen consent are sent as one transaction through the batch entry, every step required, so nothing is left half set. The review states each choice as sent, what a slot fills (not a request with a prepay listing or an interest cadence), and that the instant choices are ready a few seconds after landing. Changing an Auto-lend's terms clears its instant consents in the contracts, so the change sends them again in the same transaction, or says they are cleared when the new terms cannot carry them. Nothing is lent from free vault balance.

Until the contracts carry a pair-eligibility view, the app learns whether the instant market takes a pair from a dry run that names its two refusals.

Advances #3761. The Borrow form's "Borrow now" and the card for existing Auto-lends follow.
