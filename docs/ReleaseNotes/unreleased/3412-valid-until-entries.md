## Thread — Every price-exposed action now carries a required deadline (#3412)

A transaction can wait in a public queue for a long time before it lands. When it finally does, the price or rate it commits to may no longer be what its sender wants. Every action that commits its caller to a price or a rate now takes a "valid until" time chosen by the caller, and is refused if it lands after it. The deadline is required: an action sent without one is refused too.

This covers posting an offer (with or without a Permit2 signature), changing an offer's amount, rate, collateral or terms, setting a lender intent, both swap-to-repay routes, a lender listing a loan for sale or selling it directly into a standing offer to buy, a borrower's offset offer, and a borrower handing an obligation to a standing borrower offer. Accepting an offer and a signed offer already carried a deadline. All of them share the one timing rule from part A, with the same two refusals: `DeadlinePassed` and `DeadlineRequired`.

The deadline belongs to the transaction, not to the offer. An offer's own expiry still says how long a posted offer lives; the new deadline only says how late the transaction that posts or changes it may land.

A lender's sale of a loan now always carries the figures the lender reviewed, the least the lender will net and the most the lender will pay toward a shortfall. The earlier unbound forms of the listed and direct sale are gone, and the bound forms took their plain names. In the app, the direct sale into a standing offer to buy now reads the chain's quote of those two figures when its review opens, shows them, and sends exactly them, as a listing already did; the sale is refused rather than made if either is worse when it runs.

Rescue actions are unchanged and take no deadline: repaying, a partial repayment, adding collateral, closing early by paying off, withdrawing surplus collateral and funding a lender intent. A late landing does them no harm.

The apps set every deadline 30 minutes past the chain's current time, the same window acceptances already use, and show the two refusals in plain words.

> Caveat: this changes the call shape of thirteen actions, so it reaches the testnets at the next fresh deploy. The curated facet refresh refuses a Diamond built before it.
