## Thread — alpha05 Settings shows and changes your keeper permissions (PR #3461)

The new app's Settings page now has a Keepers section: the connected
wallet's keeper settings on its network. It shows the master switch, each
keeper the wallet approved (at most five) and the actions each may take,
with whose side each action drives (the lender side, the borrower side,
either side, or the account) and where it reaches.

Everything starts off. The section says plainly that a keeper acts only
while access is on and it holds the action. A step on a loan also needs that
loan or offer to name the keeper; an account action (filling or rolling
standing offers, or locking a protected account) needs nothing more, and the
receipt of a grant that adds one says so. It also says that a keeper never receives
funds and cannot claim, withdraw or transfer anything; that each position
follows the settings of the wallet holding it now; and when the protocol has
paused every keeper. The app names its own keeper on a network only from the
deployment record, and says so where it runs none.

Turning access off and removing a keeper are offered in either mode.
Turning access on, approving a keeper and changing its actions are in
Advanced mode. A change that gives a keeper more asks for the Terms first
where a version is in force; taking a permission away never does. Each
change is one wallet confirmation with its own receipt, built from settings
read when the review opens, refused before the wallet where the protocol
would refuse it, read again right before the wallet opens, and read back
from the chain afterwards. While the protocol is paused no change can be
made, removing included, and the section says so instead of offering one.

Advances #3180.
