## Thread — Refinance requests are found wherever they were made (PR #<n>)

A refinance request ties a loan to its current amount and collateral, so the
loan page holds back taking collateral back, partial repayment and early
close-out while one is open — any of them would leave the request impossible
to fill. Until now the page only knew about a request from a note the posting
device kept for itself, so a request made on another device or through
another tool was invisible, and those actions stayed available.

The page now finds the request on the blockchain. The protocol will only
settle a request made by whoever currently holds the borrower position, so
the app searches that holder's own open offers (and expired ones, so an
expired request can still be cancelled and its approval removed). A request
from any device now shows with its cancel action and holds those actions
back. If the search cannot give a complete answer — a read failed, or the
holder has more offers than one search covers — the page says it couldn't
check and keeps those actions held back rather than assuming there is none.
The take-back-collateral confirmation repeats the search just before the
wallet opens. This needs no indexer change, which also avoids the
deploy-ordering risk a new indexer column would carry. Closes #2391.
