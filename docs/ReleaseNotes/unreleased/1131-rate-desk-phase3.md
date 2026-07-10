## Thread — Rate Desk phase 3: live updates, crossable band, gasless signed orders (PR #1131)

The Rate Desk gained its phase-3 liveness and crossing surfaces
(Closes #1131). The desk now updates live: the indexer's realtime push
channel carries the desk's query roots, so when anyone else's action
lands on the book — a new offer, an amend, a fill — the ladder, markets
list, tape, chart and history refresh within seconds of ingest instead
of waiting out the 30-second poll, and a rate level whose depth changed
plays a brief highlight flash so the change is visible rather than
silent. The poll keeps running underneath as the backstop; a deployment
without the push channel behaves exactly as before.

When the book is crossed AND the protocol itself confirms the
top-of-book pair can actually settle, the ladder's mid row shows a
"matchable" band naming the midpoint rate and amount, with an Execute
button anyone can press — execution is permissionless and the caller
earns the protocol's matcher fee share. The honesty rule is strict in
both directions: a crossed book whose offers cannot actually match (for
example, amount ranges that never overlap) shows no band at all, and
the band is also hidden whenever the governance kill switch for
matching is off or its state is unknown.

Posting from the order ticket gained a gasless mode: instead of sending
a transaction, the maker signs the order once and the signature is
published to the indexer's new signed-offer book — posting is free, and
nothing is escrowed until someone fills it. Gasless lend orders always
post as a single whole fill (all-or-nothing): a signed lend order
carries one fixed collateral requirement, so it cannot honestly be
sliced into partial fills — the ticket disables the Partial choice in
that mode and says why, rather than publishing signed depth that
partial fills could never actually consume (gasless borrow orders are
unaffected; they already post as a single fixed size). Signed orders merge into
the ladder alongside on-chain offers wearing a "Signed" badge, and any
taker can fill one in a single transaction (the taker pays that
transaction; the maker's side moves from their vault's free balance at
that moment — the ticket warns, without blocking, if the vault doesn't
currently cover the commitment). The maker's own signed orders for the
selected market are listed under Open orders, where revoking one is an
on-chain cancel — the one signed-order action that costs gas, because
an off-chain delete would merely hide a signature that anyone who saved
it could still fill.

The indexer worker backs this with the signed-offer book itself: a
public post endpoint that verifies each order's signature locally
before accepting it (spam can't reach the chain-read budget), rejects
orders the chain already knows as consumed, stores the exact replay
payload, and a market-scoped read endpoint takers consume; lifecycle
handlers retire rows as fills, cancels and nonce burns are indexed. The
fork-tier e2e harness mirrors both routes (with signature verification
against the real Diamond domain) and a new Playwright spec drives the
whole loop — post gasless with zero transactions, discover on the
ladder, fill on-chain, watch the row leave the book — plus both sides
of the crossable-band honesty rule. Follow-ups: a live gasless
post-and-cancel pass and a push-invalidation observation ride the
rate-desk live driver on its next post-deploy run.
