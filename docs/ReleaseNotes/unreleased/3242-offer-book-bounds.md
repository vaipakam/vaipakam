## Thread — Offer-book bounds: a $10 value floor and a per-wallet open-offer cap (PR #3281)

The offer book can no longer be flooded with offers too small to be worth
servicing. Two bounds now apply to every offer a wallet posts. An offer whose
principal is worth less than $10 (in the active numeraire, the same on every
chain) is refused, at creation and whenever its amount is changed. And a
wallet may have at most 25 offers open at once, every offer type counted;
cancelling one makes room. Both are bounded governance settings, so a chain
where a keeper's work costs more can raise the floor.

The floor binds only a principal the protocol values: a liquid ERC-20 with a
price. NFTs, illiquid tokens and a liquid token whose price cannot be read at
that moment are never refused for their value. Partial fills need no check of
their own, because no fill is smaller than the offer's amount and a remainder
below that closes the offer. Offers that come from an existing loan (sale and
offset offers the protocol creates, and refinance offers) are exempt from both
bounds so no way out of a loan is closed. A signed offer meets the floor when
it is filled and never counts against the cap. There is no cancellation fee:
the owner rejected one, along with a mandatory partial fill and a $100 floor.

Offer creation was too close to the contract size limit to carry the new
checks, so the step where a new offer enters the book now has its own facet:
it applies the two bounds, records the offer as open and emits the creation
events, whose signatures are unchanged. It also answers the amount re-check
for offer edits and reports a wallet's floor, cap and open count. It is
refreshed together with offer creation and offer editing.

The open count starts with this build, so on a Diamond refreshed in place
the offers opened before the refresh are not counted. Every chain reaches
this by the next fresh deploy.

This advances #3242. The app side (a size filter, default ranking, and showing
the floor and the wallet's count before signing) follows in its own PR.

> Caveat: on a Diamond refreshed in place, offers opened before the refresh do not count against the cap.
