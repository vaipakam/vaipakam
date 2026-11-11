## Thread — Treasury conversions get an on-chain minimum output (PR #<n>)

A treasury conversion used to take its minimum outputs from the admin caller, so a wrong or compromised call could set them near zero and let the swap be sandwiched at the treasury's expense. Every swapped leg is now held to a minimum the protocol works out itself: the oracle value of what the leg sells, read the way a liquidation prices its sale, less the same slippage floor a forced sale's market conditions give it (the tighter depth-tier figure when the pair is deep and calm, the full liquidation slippage cap otherwise). The caller can only ask for more, never less.

The forced-sale floor rule was split so its market half (depth, a current price, a calm pair) is shared: liquidations add the cushion test on top as before, and a conversion, which has no debt, uses the market half alone. So every swap the protocol starts follows one slippage rule rather than two.

A leg whose pair has no current price is now refused by name instead of swapped with no floor, and a price whose sources disagree refuses the conversion until they agree. Each leg records what it sold, what it got, its oracle value, the floor applied and the minimum enforced, so a conversion's price protection is on the record.

Governance can also cap, per input asset, how much one conversion call sells. A large balance is then converted in tranches, each priced and floored on its own, with the remainder left credited to the treasury.

Buybacks are unchanged: they already sell through intent auctions over a bounded window with a per-token tranche cap. VPFI has no protocol price source by design, so their minimum VPFI cannot be oracle-derived, and the specification now says so. The governance runbook records the multisig procedure the owner set: where the treasury is an external multisig, it converts only through batch or intent auctions or a time-weighted schedule, in tranches, never a plain public swap.

Closes #3414.

> Caveat: a treasury input asset with no oracle price can no longer be converted on-chain; it stays credited until it is priced.
