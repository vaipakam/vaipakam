## Thread — alpha05 can close a rental (PR #<n>)

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
late fee less the protocol's share). A prepayment that cannot cover the
close is refused before the wallet opens.

The close is one wallet prompt, sent only after a dry run. Afterwards the
app checks on the chain that the rental closed, the claim recorded for the
renter (inside the range the review stated) and that the owner's vault no
longer names the renter as the NFT's user.

The rental's pause wording is corrected too: a pause moves only the
late-fee and default dates and stops daily settling; the renter's use still
ends on the date set at the start.

Advances #3180.
