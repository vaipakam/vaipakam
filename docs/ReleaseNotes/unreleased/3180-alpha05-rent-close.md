## Thread — alpha05 can close a rental (PR #3472)

A renter can now close a running rental in the new app. The rental's own
page offers "Close the rental" to whoever holds the renter position, in
place of the repayment a loan offers; until now it pointed to the current
app. Anyone else reading a rental is told the three ways it ends: the
renter closes it, it closes by itself once every agreed day is settled, or
it ends as a default.

Closing pays the rent owed and any late fee out of the rent and buffer the
renter prepaid into their own vault, so nothing is taken from the wallet and
no approval is asked. The review states the rent owed if the close lands now
and at a moment a short while ahead, counted by the protocol's own rule
(which the protocol publishes no figure for, so the review names the rule),
the days already settled, the late fee as the protocol quotes it, what comes
back to the renter as a claim, and what the owner receives (the rent and
late fee less the protocol's share). It says plainly that the later
moment is no deadline or limit, because the close is counted when it lands.
A prepayment that cannot cover the close is refused before the wallet
opens. Past the grace period the close is refused, and the review says the
rental then ends by its remaining days being settled or by a default,
whichever comes first.

The close is one wallet prompt, sent only after a dry run. Afterwards the
app checks on the chain that the rental closed, the claim recorded for the
renter (inside the range the review stated) and, from the close's own
log, that the renter's use of this rental was revoked.

Starting a rental, from a listing or a request, now checks the renter's use
from that transaction's own log too, instead of the owner's vault totals,
which other rentals of the same token can move in the same block.

The rental's pause wording is corrected too: a pause moves only the
late-fee and default dates and stops daily settling; the renter's use still
ends on the date set at the start.

Advances #3180.
