## Thread — a free dry run under every review, before the wallet asks

The retail app's review step now runs the exact transaction it is
about to request as a free, read-only dry run against the chain —
before the wallet prompt, before any gas. The verdict appears as one
plain line under the review: a quiet "dry run passed", or a clear
heads-up that this exact transaction just failed in rehearsal — with
the reason, and the reassurance that nothing was sent and no gas was
spent. Flows whose submission grants a token or NFT approval first
show "an approval will be requested first — expected, not a problem"
instead of a false alarm, since the rehearsal cannot see the approval
that hasn't happened yet.

The dry run is a heads-up, never a gate: it does not disable the sign
button, and when it can't reach the network it says so quietly and
steps aside. It covers posting lending and borrowing offers, listing
an NFT for rent, VPFI vault deposits and withdrawals, and listing a
loan for sale. Accepting an offer and posting a refinance request are
deliberately not previewed: their transactions embed pieces that only
exist at signing time (a signed terms attestation; live loan state
written moments earlier), so a rehearsal would routinely fail for
reasons that are not real — and a warning that cries wolf teaches
people to ignore it.
