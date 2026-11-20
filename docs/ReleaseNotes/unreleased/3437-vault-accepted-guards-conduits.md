## Vault code accepts earlier price guards and listing conduits (#3437 step 5, PR #3743)

A vault's code names the price guard and the listing conduit new loans use. It now also lists up to two earlier price guards and two earlier listing conduits, each conduit with its key, that open loans or their listings may still use. A listing may name any conduit the code lists, and a vault or its listing escrow may approve any of them. So when new vault code moves new listings to another conduit, an open loan's listing is not stranded. Any other guard or conduit is still refused.

Vault code cannot be built if its earlier lists are out of order, name an entry twice, repeat the current entry, or leave a conduit without its key. A fresh deploy lists nothing earlier.

The vault does not yet check prices itself, so for now the guard list is only read through `isAcceptedPriceGuard`. The vault's price checks on close-outs come with #3268 and will use a guard only when the vault code accepts it.
