## Thread — alpha05 Settings shows and changes your risk access (PR #<n>)

The new app's Settings page now has a Risk access section. It says, in
words, which risk level counts for the connected wallet on its network, and
why that can differ from the level the wallet chose: a raise still in the
protocol's waiting period, with the time it counts, or new risk terms, under
which the level counts as blue-chip only until it is confirmed again. It
says whether the network enforces risk levels at all, and whether strict
mode is on, off, or switched off but still applying until a stated time.

A level stopped by new risk terms can be confirmed in one wallet step in
either mode. In Advanced mode the reader can raise or lower the level and
turn strict mode on or off. Each change is one wallet confirmation with its
own receipt: the level now and after, which pairs it reaches, when it takes
effect, and that no funds move. A raise still waiting is never offered
again, because a second one would start the wait over. Lowering takes
effect at once and says that pairs above the new level close to new offers
and requests, the wallet's own open ones included, while loans already open
are not affected. Switching strict mode off says it removes a check and
when it stops applying. On a network that does not enforce risk levels, the
page and the receipt say a change is only saved, and counts if the check is
switched on.

A level change names the change counter and risk-terms version it was read
with, so a change made elsewhere, or new terms published in between, makes
the transaction refuse and change nothing. Agreements to a single pair stay
in the borrow and lend flows that need them.

Advances #3180.
