## alpha05 — add money to Auto-lend, take back money not lent, and stop

Each Auto-lend card on Positions in the new app now offers the steps that fit where it stands: add money while it can still lend, take back money that is not lent while some waits, and stop it while it runs. Each step opens its own review, read at one block, which is the protocol's own dry run from the wallet and states every figure the step binds and what it means: money added above the most lent at once waits until loans end, nothing promises a fill, and a stop ends new loans at once while open loans run to their end.

Adding money needs a running Auto-lend that has not reached its end date, neither asset nor the protocol paused, and an approval of exactly the amount, which is put back if the step fails. Taking money back is capped at the money not lent; it stays open while one asset is paused but closes while the whole protocol is, and its route is stated the way a vault withdrawal's is, so with protected mode on the payment waits out the delay or stays in the vault. A stop on its own stays open even while the protocol is paused. A stop can also take back the money not lent; the two go in one batched transaction, so the Auto-lend is never stopped with its take-back failing alone.

Each finish card measures the step from the transaction's own logs and the token's moves between the wallet and its own vault. The user guides in all ten languages now describe these steps. Changing the limits and starting again follow in the next part of #3624.

Advances #3624 (epic #3180).
