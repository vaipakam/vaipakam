## Troubleshooting — signed offers name the event that last changed them

Each signed offer in the book now records the chain event that last changed it
(the block, the transaction's position in it and the log's position), as offer,
loan and loan-side rows already do. A cancel, a nonce burn or a full fill names
its own event. A partial match's filled amount is read from the chain at the
match's block, so the row names that block rather than the event.

A signed offer is born off chain, from the maker's signature. Until an event
changes it, the columns stay empty: no event has touched it yet, and a filled
amount taken when the offer was posted comes from a read whose block is not
named. The posting route writes nothing new, so it keeps working while the
database migration is still being applied.

A rebuild after a chain reorganisation, and a restore from the off-chain
archive, set the columns back to empty with the rest of the order's chain
state, and the replay names the event that changes it next.

Advances #3921. The reward and recycling ledgers follow, and then every
event-derived table carries the columns.
