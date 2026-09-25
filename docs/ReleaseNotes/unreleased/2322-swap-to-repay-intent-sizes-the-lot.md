## Thread — repay-from-collateral by auction puts up only what the debt needs (#2322)

The auction form of repaying a loan from its collateral — where the
borrower posts an order and a resolver fills it — used to put the loan's
entire collateral up for sale. A filled auction therefore turned every unit
of collateral into the lending asset, which is the same problem the direct
form had until #2317. The functional specification says collateral the
repayment does not need stays pledged and returns to the borrower through
their claim, and that rule covers both forms, so the auction now follows it.

When a borrower commits an order, the protocol now puts up only the lot the
debt needs. That is the least collateral whose worst-case value, under the
same borrower-facing slippage allowance the direct form uses, covers the
debt plus the auction's safety buffer. Both forms size the sale through one
shared rule, so they cannot drift apart. The order is a fixed-price order,
and the borrower sets its price by how much principal they ask for that lot:
- The least the borrower may ask is the lot's own worst-case value. When
  the collateral comes in coarse units that value can be well above the
  debt, and the minimum follows the lot rather than the debt, so no lot is
  ever sold below the worst case. Asking that minimum accepts the worst case
  the slippage allowance permits, and a resolver keeps that discount.
- Asking more prices the lot higher.
- Whatever a fill raises above the debt is paid to the borrower as surplus,
  exactly as in the direct form.

The rest of the collateral never leaves the borrower's vault and stays
pledged for the whole auction. So that this remainder cannot end up
anchored to someone who no longer holds the position, the borrower position
is locked while the auction is live. This uses the same transfer lock the
early-close and loan-sale flows use, and it is released when the auction
settles or is cancelled. A loan with a live auction is also kept out of the
protocol's internal loan-against-loan matching, because none of its
collateral is free to match. After a fill, the borrower claims the rest
through the ordinary claim, and it stays pledged until they do. A cancelled
or expired auction returns the lot and leaves the loan exactly as it was.
When even the whole collateral, at the worst case, cannot cover the debt
and buffer, the commit is refused before anything moves. A new read-only
preview shows the lot and the least principal a commit accepts. The
committed order is the one to post to the resolver network, because
interest and prices can move between the preview and the commit.

Fixing this also exposed an accounting issue in how the pledge was
restored after a fill. The old code assumed the whole collateral had been
unpledged at commit, and re-pledged the borrower's whole remaining claim on
top of whatever was still pledged. With the untouched part now pledged
throughout, that would have counted it twice. After a fill the pledge is
now topped up to cover the claim, and it equals the claim whenever the
pledge matched the loan's collateral before the auction, as loan initiation
sets it. No shipped interface drives the auction form yet, and the live
testnet still runs the previous contracts until an operator refreshes them.
Closes #2322.
