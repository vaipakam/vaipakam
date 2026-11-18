## Keeper: lender intent slots and their price check

The keeper now names the intent slot in every Auto-lend read and fill. A lender
may hold several intents on one pair, one per slot, and the protocol's preview,
fill and priority reads all take the slot; the keeper passes the one each
registry row names (#3626).

Each fill from a lender intent slot is now refused while the pair has moved
past the calm bound against either of the last two hourly price checkpoints,
while either checkpoint is missing, or while a price cannot be read. The check
is on by default; a slot's owner may switch it off, and the backstop's slots
always carry it. Three keeper changes follow from it.

The price checkpoint pass now also writes the checkpoints of every pair a
lender intent slot lends in with the check on, and always the backstop's. It
reads each slot's status from the Diamond, says in its run line how many slots
it covers and how many read "no checkpoint", and raises one operator alert per
chain when a slot has read "no checkpoint" for three hours.

Auto-lend and the backstop fill skip a fill the check refuses and state the
reason in their run lines. They raise no alert per skip.

The keeper states at start-up whether the price checkpoint pass is armed
wherever a fill from intent slots is armed, and raises an operator alert every
six hours while it is not, since without it every such fill is refused. No pass
was armed or disarmed by this change.
