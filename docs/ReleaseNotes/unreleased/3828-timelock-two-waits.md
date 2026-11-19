## Thread — Governance timelock: two waits

The governance timelock now has two waits instead of one. Every queued change waits the standard wait, 7 days on a production chain. Only a short, fixed list of calls that restart something already built may run after the shorter restart wait of 48 hours: unpausing the platform, unpausing an asset, and the pause-epoch unpause. The timelock matches these calls exactly, with no value attached, and a batch counts only if every call in it is one of them.

An urgent fix can also run at 48 hours, but only when the Pauser Safe has approved that exact operation, by its id, before the governance Safe queues it. The approval is used up by that one operation and shortens nothing else; it can be withdrawn while unused, and it cannot be given to an operation already queued. The proposer and the urgent approver can never be the same account, so a fast change always needs both Safes.

Both waits are fixed floors set at deploy and can only be raised; the restart wait can never be raised above the standard one. The timelock deploy, the handover and the handover gate refuse a production chain whose standard wait or its floor is under 7 days, or whose Pauser Safe does not hold the urgent-approver role. Testnet rehearsals can shorten both waits.

This is what the public upgrade-lock statement promises: a change that can move user funds waits 7 days, and only restarts and jointly approved urgent fixes are faster. The switch host's start call joins the restart list when that host is built (card #3824).

Closes #3828
