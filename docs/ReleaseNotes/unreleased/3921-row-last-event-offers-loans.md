## Troubleshooting — offer and loan rows name the event that last changed them (PR #4025)

Every offer and loan row the indexer keeps now records the event that last
changed it: the block, the transaction's position in that block, and the log's
position. A wrong figure on an offer or a loan can be followed back to the one
transaction that produced it, and the transaction explainer then shows what that
transaction did. This is the first handler group of the troubleshooting design's
"a row back to its events" (TroubleshootingPictureDesign §4.6); the other
event-derived tables follow one group at a time.

The three columns say what they know. A row set from a read of the chain's state
(a heal of a stub, the settlement heal, the reconciliation repair) records the
block it was read at with no event position, which means "reflects every event
up to the end of that block". A row whose figures came from a read at the
chain's head, whose block cannot be named (the offer and loan detail reads made
as a row is first written), and a row last written before this change, record
nothing: unknown, never an event that did not produce the figures. The columns only ever move forward, by one shared
rule, because the handlers apply some events grouped by kind within a block: the
row names the latest event that wrote it in chain order, whatever order the
handlers ran in, and replaying an older block cannot move it back.

A static check now holds every write to these tables to the rule. It classifies
every table of the shared database (event-derived or not, with the reason),
keeps a list of event-derived tables still to be done that can only shrink, and
refuses any write to a finished table that neither sets the columns nor states,
in the statement itself, why it changes no figure an event produced (a review
flag cleared, a reminder's own stamp). The statements are found by parsing the
sources, so a write built outside the usual call is still found.

One cost: a match that consumes part of a borrower offer now marks that offer
with its own match's position, so a block with several such matches writes one
statement per match instead of one for the whole block.

Advances #3921. Still to do: the loan side tables (lifecycle state, rental
rights, swap-to-repay intents, prepay listings, participants), the signed offer
book, and the reward and recycling ledgers, one change each, until the pending
list is empty.

> Caveat: rows written before this change carry no last event until an event or a read next writes them; a fresh deploy's replay fills every row.
