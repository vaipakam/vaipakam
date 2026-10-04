## Thread — Refinance requests are found wherever they were made (PR #2406)

A refinance request ties a loan to its current amount and collateral, so the
loan page holds back taking collateral back, partial repayment, early
close-out, handing the loan to a new borrower and offsetting it while one is
open — any of them would leave the request impossible to fill. Until now the page only knew about a request from a note the posting
device kept for itself, so a request made on another device or through
another tool was invisible, and those actions stayed available.

The page now finds the request on the blockchain. The protocol will only
settle a request made by whoever currently holds the borrower position, and a
request can only have been made after the loan existed, so the app searches
that holder's offers posted since the loan began — a bounded search, however
long the wallet's history. An open request is preferred over an expired one,
and an expired one is still shown so it can be cancelled and its approval
removed. The card for it now shows to whoever posted it, the only wallet
that can cancel it. A request
from any device now shows with its cancel action and holds those actions
back. If the search cannot give a complete answer, the page keeps those
actions held back rather than assuming there is none, and says which of two
reasons applies: a read failed (it may answer on a later try), or the holder
has posted more offers since the loan's own offer than one search reads (a
retry will not help, so it does not suggest one; full repayment stays open).
The early-repayment chooser says the same on the rows it cannot offer, rather
than pointing at a card that is held back, and the full-repayment review warns
that a request could exist while the search has not answered. An expired
request no longer holds anything back, including posting a new request. A
wallet that posted a request and then transferred the position, or whose loan
has settled, is shown that request from any device, since only the poster can
cancel it and remove its payoff approval. If posting an offset stops after its
token approval was granted — for instance because a last check found a
refinance request — the approval is now put back, as the handover and
refinance flows already did.
Each of those actions repeats the search just before the wallet opens. One
narrow race remains and is stated in the specification: a request posted in
the moments between that last check and the transaction being mined, since the
protocol itself does not refuse those actions while a request stands. This needs no indexer change, which also avoids the
deploy-ordering risk a new indexer column would carry. Closes #2391.
