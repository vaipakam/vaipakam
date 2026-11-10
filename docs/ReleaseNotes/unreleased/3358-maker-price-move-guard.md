## Offers — the maker's price-move guard (PR #<n>)

An offer waits on the book while the market moves, and a taker can fill it the moment the price has moved in the taker's favour, on terms the maker set against the old price. An offer's creator can now bound that with a price-move guard: a limit on how far the collateral-to-lending asset rate may move. A guarded offer refuses a fill when the rate has moved past the creator's limit since the guard was recorded, or when the pair is not calm against the last two hourly price checkpoints (the same calm rule the forced-sale floor uses, now one shared rule rather than a copy). A price that cannot be read, or a missing checkpoint, refuses the fill too. The guard is off by default, only ever refuses a fill, and moves no funds.

The creator can arm it before posting, in the same transaction as the post, so the offer is recorded with the prices at posting and is never on the book unguarded; or set, change or clear it on an open offer later, measured from the prices at that moment. The limit lies between 0.5% and 50%, and only an offer with two priceable ERC-20 legs can carry one.

Every fill checks it at the opening of the loan, so a direct accept, every match path (both makers' guards), intent fills and refinance, offset or sale acceptances are all covered. An unguarded fill pays nothing extra for the check. The accept and match previews report a guard refusal by name, and a new read-only view says, for any offer, its limit, the prices it was measured from, how far the rate has moved since and which condition holds.

Closes #3358.

> Caveat: a gasless signed offer cannot carry a guard until its signed terms can (#3327).
> Caveat: the guard reads the hourly checkpoints, whose keeper pass ships disarmed and today covers only the pairs of active loans; a guarded offer in a pair nothing checkpoints cannot be filled until that pass covers guarded offers too (follow-up for the keeper).
> Caveat: reaches a testnet only with the next fresh deploy (a new facet, plus loan creation, the offer book and both previews).
