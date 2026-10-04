## Thread — Rate Desk says when signed offers are missing (PR #<n>)

The Rate Desk merges free signed offers, which live with the offer-book
service rather than on the blockchain, into the same view as on-chain offers.
When that service did not answer, the page quietly fell back to on-chain
offers only and looked complete. When the service had more signed offers than
it returns, the page ignored that too. In both cases the best rates and the
middle rate could leave signed offers out with nothing saying so.

The market now carries one short note above all of its views — the header's
middle rate, the offers list and the chart all draw on the same offers, and on
a phone the list or the chart can be shown alone. While signed offers are
loading or could not be loaded, the note says the rates shown come only from
offers posted on the blockchain, and an offers list that is empty on the
blockchain no longer claims the market has no offers. When the service may not
have returned every signed offer — it says it cut some, or an older service
does not say — the note says the rates and amounts shown, even at the best
rate, may leave some out, and claims nothing about which ones were included. A
deployment with no offer-book service set up says so plainly, rather than
looking like a temporary failure. A signed book
whose latest refresh failed is treated as missing instead of merging the last
copy the page saw, since those orders may have been taken or cancelled since.

Closes #2386.
