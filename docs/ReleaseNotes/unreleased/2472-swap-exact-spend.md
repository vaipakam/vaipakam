## Thread — Forced sales sell exactly what they offer (PR #<n>)

Every swap the protocol makes now measures what actually happened rather than
trusting what the route reported. Before this change, a liquidation route that
sold only part of the collateral was booked as if it had sold all of it. The
unsold part stayed in the protocol's balance with nothing recording whose it
was. Proceeds were also booked at the figure the route reported, even when
fewer tokens arrived. Now, on every forced sale the protocol checks two things
itself: how much collateral left its balance, and how much of the proceeds
reached it. The forced sales are Health-Factor liquidation (full, partial and
split route), time-based default, periodic-interest auto-liquidation, the
lender's fallback retry, and treasury asset conversion.

A route that sold less than it was offered, or delivered less than it
reported, is refused and undone: its partial sale is reversed and the next
route in the caller's list is tried in the same transaction, just as for a
route that failed outright. Each route now runs in a step of its own inside
the transaction, which is what lets one route's sale be reversed while the
next is tried. When no route sells the whole amount, each path's existing
handling applies unchanged: a liquidation or default enters the in-kind
fallback, which pays the lender first.

This follows the platform's lender-first principle for liquidations, decided
by the owner on 2026-10-20: the lender is paid as fully as the market allows
before the borrower receives anything. A partial sale must never leave unsold
collateral that could reach the borrower while the lender is still owed. The
refused route falls through rather than stopping the whole transaction so that
a stale quote cannot halt the routes behind it. Otherwise a borrower adding a
token's worth of collateral before each attempt could make every quote stale
and stall the liquidation indefinitely. A split-route liquidation, which
divides one sale across several venues at once, stays all-or-nothing: a short
leg reverses the whole split and the liquidation stays open to the ordinary
route list.

Swap-to-repay is the one swap that may still sell less than it is offered,
because the borrower is repaying and the offered amount is only an upper bound.
It now uses the measured spend from the same shared rule, and unsold collateral
stays pledged in the borrower's vault as before. The three swap adapters
(aggregator, Uniswap V3, Balancer V2) now hand back only what their own call
did not spend. Before, they returned their whole balance of the input token.
Under the new rule, a stray token transfer to an adapter would then look like
unsold collateral and make every exact sale through it fail.

Operators: the step that runs each route is a new Diamond component, so every
testnet Diamond needs the normal facet refresh (the all-facets refresh carries
it) before the refreshed liquidation and default code runs. A Diamond that
routes the selling facets without it stops with a named error rather than
treating every route as failed. The BNB testnet Uniswap V3 adapter needs
redeploying and re-registering to pick up the adapter change. Base Sepolia
and Arbitrum Sepolia use the test adapter, which already sells the full
amount. Closes #2472.
