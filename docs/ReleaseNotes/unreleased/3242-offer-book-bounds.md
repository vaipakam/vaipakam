## Thread — Offer-book bounds: a $10 value floor and a per-wallet open-offer cap (PR #3283 and its app follow-up)

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

In the app, the guided lend flow sets a lender's smallest fill to 10% of the
total, which on a small offer would fall under the floor; it now raises that
fill to the floor, read live from the protocol, and never above the total. An
amount under the floor is named under the field before anything is signed, and
both new refusals read as plain sentences. The standing-intent preview reports
a slice under the floor the same way the fill would refuse it.

The offer book now ranks offers largest first by default, so the market's
real depth leads and a run of tiny offers sinks instead of crowding the top;
newest first stays one choice away. A smallest-size filter (any, or at
least 10, 100, 1,000 or 10,000 in the reference currency, which is read live
rather than assumed) hides only an offer whose size it measured below the
choice. Size is what a lending offer can still lend, or what a request asks
for, at the protocol's price. An offer in a token with no reliable price has
no measured size, so it is never hidden and is listed after the sized ones,
and the page says so. Create offer, in both the current app and the new one,
names the wallet's open count once it is within five of the cap and stops
before any signature at the cap; the new app also names an amount, or a
lending offer's smallest part, below the floor. The signed-offer book refuses
an order whose smallest amount is below the floor, since no taker could fill
it directly, and the Rate Desk says why in a sentence. Closes #3242.

> Caveat: on a Diamond refreshed in place, offers opened before the refresh do not count against the cap.
