## Governance gates — notification billing screens the payer (PR #2774)

Charging a wallet for paid notifications now checks the payer against the sanctions oracle explicitly, before any fee leaves the vault. Before this change the check happened only indirectly, inside the vault withdrawal, and it let the charge through while the oracle could not be read. The rule is now stated where the fee is charged:
- With no oracle configured, there is no screen.
- A payer the oracle flags is refused by name.
- While the oracle cannot be read, every bill is refused instead of charging a wallet nobody could screen.

A flagged wallet's vault is frozen, not seized, and the payer's own consent to be billed does not change that. A refused bill moves nothing and leaves the side unbilled, so the billing role can retry once the wallet is de-listed or the oracle answers again. Screening is per payer, so a flagged counterparty never stops the clean side of the same loan from being billed. A side that was already billed stays a harmless no-op.

Paid-notification billing now has a facet of its own. The new screen pushed the loan facet, which hosted the charge, past the contract size limit. Billing a notification is not loan origination, so the charge moved off the loan facet and the consent setter and reader moved off the profile facet. Both now sit together in a notification-fee facet, where the consent's only reader lives beside its only writer. The function signatures are unchanged. The all-facets refresh moves the routes on its own. The curated refresh carries the new facet as well, so it can never leave billing on the old loan-facet code.

This also corrects a code comment added in #2768 that said the bill does not screen the payer. The sanctions action matrix gains a row for notification billing.

Closes #2769.
