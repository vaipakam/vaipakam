## Thread — alpha05: your fee-discount tier on other networks

The new app's Rewards page now shows the wallet's fee-discount tier on the protocol's other networks and lets the wallet send it there. Since the protocol's rule of #1277, the protocol pays for a cross-network message only when it lowers the discount another network grants. A higher tier, a first discount, or a tier under a new tier table reaches another network only when someone pays its message fee, so a user whose tier rose has to act, or their other networks keep the older copy.

On VPFI's home network the section reads the protocol's own status at one block: the tier recorded for sending, what each other network last received, whether that network is still owed the record, and who pays for that message. It says when the record is behind the tier the protocol applies now and offers to update it, for network gas only. Each network shows whether it is up to date, owed a lower tier the protocol sends at its own cost, or owed one that goes only with a paid send, with the fee the messenger quotes now.

The paid send is offered once the record matches the tier now and every owed network's fee is quoted. The wallet sends the sum of every owed network's quoted fee plus a 20% margin, because the protocol spends the value on owed networks in its own order, and whatever the messages do not use comes back in the same transaction. The receipt states that each fee pays one message and is not refunded once sent. The outcome is measured per network from the status at the receipt's block, together with the fees the wallet's value actually paid.

The section is shown in Basic as well as Advanced, a departure from the feature matrix, whose rows predate #1277, because acting on it is now the user's job. Away from VPFI's home network it says a higher tier is sent from there. Advances #3180 and closes #3579.

> Caveat: the tier table's version has no reader, so the app cannot tell a record that is behind only on the table version; the update stays offered and the copy says so.
> Caveat: the live testnets predate #1277 until the next fresh deploy, so there the section says this network's contracts predate the rule.
