## Troubleshooting — the indexer's event history and the state at a block (PR #4016)

The indexer now keeps a full record of what the platform's contracts said on each network, so a past transaction can be explained from what was true at that moment. Advances #3921 (the build history and each row's last event follow in a second PR).

Every log from every platform contract in the deployment record is kept: the Diamond, the position token, and each standalone contract such as the VPFI token and the price guard. The testnet's mock assets are left out. A log is decoded with the platform's own ABIs where one describes it, and kept raw (its topics and data) where none does, so an event no handler reads, or one this build cannot decode, is still on record. The users' activity feed is unchanged; this is a separate, complete table beside it.

Each change to the protocol's settings is recorded with the event and the transaction that made it, and the settings themselves are read at the end of that block. A few blocks are read per pass, and only within the pass's allowance. Today's settings events do not all carry the whole new value, so the record says plainly that its values are end-of-block values. Where one block holds more than one change, every change except the last is marked as not knowing what was in force between them. A block whose state the node can no longer answer for is marked unreadable after three tries, with the reason, and is never filled with another block's values.

Each change to the Diamond's routing is recorded from its cut event, one row per function: which code served which function from which point, and which functions were removed.

All three are written by the scan in the same pass as the block they come from, before that block's handlers, as one batch per block. They are cleared and rebuilt with the chain's other rows on a reorg rebuild or a new Diamond, and they are on the off-chain restore's clear list. The list of a deployment's contracts is now one shared rule, used by both the failed transaction pass and the indexer.

> Caveat: the price guard's own settings changes are kept in the event record but do not yet start a settings history row; that is a follow-up.
> Caveat: on a busy mainnet the extra contracts add their logs to each scan, which the pass's allowance already bounds.
