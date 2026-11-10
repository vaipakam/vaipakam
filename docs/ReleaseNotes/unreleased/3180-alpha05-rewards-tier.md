## Thread — alpha05 Rewards shows your fee-discount tier and the tier table (PR #<n>)

The Rewards page now shows the fee-discount tier the protocol applies to the
wallet's fees, read from the protocol itself rather than worked out by the
app. While the fee-discount consent is off, it says no tier applies. On
VPFI's home network it also reads the tier the counted VPFI alone would
give, and says in one line when the holding rules keep the applied tier
below it. Away from the home network it shows the tier sent from there, or
says none applies.

The protocol does not report which holding rule holds a tier down, nor the
rules' settings, so the page names the three rules in its help without
claiming which one applies; issue #3459 asks for read views for both.

On the home network a table shows every tier: the counted VPFI it needs,
with the protocol's exact boundaries (the top tier starts just above its
figure), its discount after the 50% cap, and the loan initiation fee and
the fee on interest earned with that discount, computed exactly from the
network's live settings. Elsewhere the table is not shown, because tiers
are set on the home network.

Advances #3180.
